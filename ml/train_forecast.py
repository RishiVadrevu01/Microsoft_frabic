"""
Hourly demand forecast with LightGBM, trained on the 1-hour corpus in ml/corpus/.

What it builds
  One global model across every pool and region, forecasting the next 1..168 hours (a week ahead)
  of utilized capacity units, at three quantiles: p50 (the point forecast), p80 (the level the lab
  plans at) and p95 (the peak to watch).

Why this shape
  * Global, not one model per pool: pools share a structure (a local business day, weekends, holidays,
    growth), and a global model can learn it once from all of them. Section "Does pooling help" checks that.
  * Direct multi-horizon: the horizon is a feature, so one model answers every step of the week.
  * The target is the ratio to the pool's own trailing-week mean, so pools of different size and growth
    are comparable, and a tree model never has to extrapolate a level it has not seen.
  * Quantile objectives give calibrated ranges directly instead of guessing them around a point forecast.
  * Every feature is known at forecast time. `leakage_check` proves it by corrupting all data after the
    origin and confirming no feature changes.

What it does not claim
  The corpus is generated, not measured. Accuracy here shows the pipeline works and how much structure
  a model can pick up, not how it would do on a real estate.

Run: npm run ml   (or: ml/.venv/Scripts/python ml/train_forecast.py [--fast])
"""

import argparse
import json
import platform
import time
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb
from numpy.lib.stride_tricks import sliding_window_view

ROOT = Path(__file__).resolve().parent
CORPUS = ROOT / "corpus"
OUT = ROOT / "out"

WEEK = 168
MAX_H = 168
LAGS = (0, 1, 2, 3, 5, 11, 23, 47, 71, 167, 335)          # y[i-k] at the forecast origin i
TRAIN_H = (1, 2, 3, 4, 6, 8, 12, 18, 24, 30, 36, 48, 60, 72, 96, 120, 144, 168)
QUANTILES = (0.5, 0.8, 0.95)
TEST_WEEKS = 8
VAL_WEEKS = 3
MIN_ORIGIN = 4 * WEEK                                      # four weeks of history for the profile feature
BUCKETS = ((1, 6), (7, 24), (25, 72), (73, 168))
CATEGORICAL = ["geo", "workload", "sku_class"]

BASE_PARAMS = dict(
    objective="quantile", metric="quantile", learning_rate=0.06, num_leaves=63, min_data_in_leaf=200,
    feature_fraction=0.85, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, max_bin=255,
    verbosity=-1, seed=7, deterministic=True, force_row_wise=True, num_threads=8,
)


# ---------------------------------------------------------------------------------------------- data
class Pool:
    """One pool's hourly series and everything that can be worked out from it up to each hour."""

    def __init__(self, pool_id, meta, y, lat, queue, inc_w, hour, dow, hol, ts):
        self.pool_id, self.meta = pool_id, meta
        self.y, self.lat, self.queue, self.inc_w = y, lat, queue, inc_w
        self.hour, self.dow, self.hol, self.ts = hour, dow, hol, ts            # calendar arrays run past the end of y
        self.n = len(y)
        self.capacity = float(meta["capacity_units"])
        n = self.n
        cs = np.concatenate([[0.0], np.cumsum(y)])

        def roll_mean(a, w):
            c = np.concatenate([[0.0], np.cumsum(a)])
            out = np.full(len(a), np.nan)
            out[w - 1:] = (c[w:] - c[:-w]) / w
            return out

        def roll_fn(a, w, fn):
            out = np.full(len(a), np.nan)
            out[w - 1:] = fn(sliding_window_view(a, w), axis=1)
            return out

        self.level = roll_mean(y, WEEK)
        self.roll6 = roll_mean(y, 6)
        self.roll24_mean = roll_mean(y, 24)
        self.roll24_std = roll_fn(y, 24, np.std)
        self.roll24_max = roll_fn(y, 24, np.max)
        self.roll24_min = roll_fn(y, 24, np.min)
        prior = np.full(n, np.nan)                                            # the week before the trailing week
        prior[2 * WEEK - 1:] = self.level[WEEK - 1: n - WEEK]
        self.growth = self.level / prior - 1
        lat_lvl, q_lvl = roll_mean(lat, WEEK), roll_mean(queue.astype(float), WEEK)
        self.lat_rel = lat / lat_lvl
        self.lat24_rel = roll_mean(lat, 24) / lat_lvl
        self.q_rel = (queue + 1.0) / (q_lvl + 1.0)
        self.q24_rel = (roll_mean(queue.astype(float), 24) + 1.0) / (q_lvl + 1.0)
        self.inc24 = roll_mean(inc_w, 24)
        assert len(hour) >= n + MAX_H, "the calendar must cover the week after the last hour"


def load_corpus():
    hourly = pd.read_csv(CORPUS / "hourly_pool_metrics.csv")
    pools = pd.read_csv(CORPUS / "pools.csv")
    future = pd.read_csv(CORPUS / "calendar_future.csv")
    codes = {c: {v: i for i, v in enumerate(sorted(pools[c].unique()))} for c in ("geo", "workload_type", "sku_class")}
    out = []
    for _, meta in pools.iterrows():
        pid = meta["pool_id"]
        g = hourly[hourly["pool_id"] == pid].sort_values("ts_utc")
        f = future[future["pool_id"] == pid].sort_values("ts_utc")
        ts = pd.DatetimeIndex(pd.to_datetime(pd.concat([g["ts_utc"], f["ts_utc"]]), utc=True))
        assert ((ts[1:] - ts[:-1]) == pd.Timedelta(hours=1)).all(), f"{pid}: the hours are not contiguous"
        p = Pool(
            pid, meta.to_dict(), g["utilized_units"].to_numpy(float), g["p95_latency_ms"].to_numpy(float),
            g["queue_depth_p95"].to_numpy(float), g["incident_weight_active"].to_numpy(float),
            np.concatenate([g["local_hour"], f["local_hour"]]).astype(float),
            np.concatenate([g["local_dow"], f["local_dow"]]).astype(float),
            np.concatenate([g["is_holiday"], f["is_holiday"]]).astype(float), ts,
        )
        p.codes = dict(geo=codes["geo"][meta["geo"]], workload=codes["workload_type"][meta["workload_type"]], sku_class=codes["sku_class"][meta["sku_class"]])
        out.append(p)
    return out


# ---------------------------------------------------------------------------------------------- features
CORE = (
    [f"lag{k}" for k in LAGS]
    + ["roll6", "roll24_mean", "roll24_std", "roll24_max", "roll24_min", "growth", "o_hour", "fullness",
       "sn168", "r2", "r3", "r4", "prof4", "sn_hol", "prof_hol_n", "last_same_hour", "sn_hour_shift",
       "t_hour", "t_dow", "t_hol", "t_how", "horizon"]
    + CATEGORICAL
)
SIGNALS = ["lat_rel", "lat24_rel", "q_rel", "q24_rel", "inc_now", "inc24"]


def features(p, oi, hi):
    """Features for forecasting hour oi+hi from origin oi. Everything used is at or before oi, except the
    calendar of the target hour, which is known in advance."""
    ti = oi + hi
    lvl = p.level[oi]
    f = {}
    for k in LAGS:
        f[f"lag{k}"] = p.y[oi - k] / lvl
    f["roll6"] = p.roll6[oi] / lvl
    f["roll24_mean"] = p.roll24_mean[oi] / lvl
    f["roll24_std"] = p.roll24_std[oi] / lvl
    f["roll24_max"] = p.roll24_max[oi] / lvl
    f["roll24_min"] = p.roll24_min[oi] / lvl
    f["growth"] = p.growth[oi]
    f["o_hour"] = p.hour[oi]
    f["fullness"] = lvl / p.capacity
    # The same hour of each of the last four weeks, as a ratio to THAT week's own mean. The week m back is the
    # trailing week as seen from origin oi - 168*(m-1), so each ratio is a shape, free of the pool's growth.
    # Their mean times the current level is the seasonal profile, scaled to where the pool is now.
    r = [p.y[ti - WEEK * m] / p.level[oi - WEEK * (m - 1)] for m in (1, 2, 3, 4)]
    f["sn168"], f["r2"], f["r3"], f["r4"] = r
    f["prof4"] = (r[0] + r[1] + r[2] + r[3]) / 4
    f["sn_hol"] = p.hol[ti - WEEK]
    f["prof_hol_n"] = sum(p.hol[ti - WEEK * m] for m in (1, 2, 3, 4))
    f["last_same_hour"] = p.y[ti - 24 * ((hi + 23) // 24)] / lvl
    shift = p.hour[ti - WEEK] - p.hour[ti]                                   # non-zero across a daylight-saving change
    f["sn_hour_shift"] = (shift + 12) % 24 - 12
    f["t_hour"], f["t_dow"], f["t_hol"] = p.hour[ti], p.dow[ti], p.hol[ti]
    f["t_how"] = p.dow[ti] * 24 + p.hour[ti]
    f["horizon"] = hi.astype(float)
    for c in CATEGORICAL:
        f[c] = np.full(len(oi), p.codes[c])
    f["lat_rel"], f["lat24_rel"] = p.lat_rel[oi], p.lat24_rel[oi]
    f["q_rel"], f["q24_rel"] = p.q_rel[oi], p.q24_rel[oi]
    f["inc_now"], f["inc24"] = p.inc_w[oi], p.inc24[oi]
    return pd.DataFrame({k: np.asarray(v, dtype=np.float32 if k not in CATEGORICAL else np.int32) for k, v in f.items()})


def pairs(p, origins, horizons, last_target):
    """All (origin, horizon) pairs whose target hour is at most last_target."""
    o = np.asarray(origins)
    oi = np.concatenate([o[o + h <= last_target] for h in horizons])
    hi = np.concatenate([np.full((o + h <= last_target).sum(), h) for h in horizons])
    return oi, hi


def dataset(pools, spec, feature_names):
    """Stack the rows every pool contributes under one split. Returns X, ratio target, and the bookkeeping."""
    frames, ys, lv, hs, pid = [], [], [], [], []
    for k, p in enumerate(pools):
        oi, hi = spec(p)
        if len(oi) == 0:
            continue
        X = features(p, oi, hi)
        frames.append(X)
        lvl = p.level[oi]
        ys.append(p.y[oi + hi] / lvl)
        lv.append(lvl)
        hs.append(hi)
        pid.append(np.full(len(oi), k))
    X = pd.concat(frames, ignore_index=True)
    return dict(X=X[feature_names], full=X, y=np.concatenate(ys), level=np.concatenate(lv), h=np.concatenate(hs), pool=np.concatenate(pid))


# ---------------------------------------------------------------------------------------------- splits
def splits(pools, stride):
    n = pools[0].n
    t0 = n - TEST_WEEKS * WEEK               # first hour of the test window: nothing at or after it is trained on
    v0 = t0 - VAL_WEEKS * WEEK               # first hour of the validation window, used only to stop training
    train = lambda p: pairs(p, np.arange(MIN_ORIGIN, v0 - 1, stride), TRAIN_H, v0 - 1)
    val = lambda p: pairs(p, np.arange(v0 - 1, t0 - 1, stride), TRAIN_H, t0 - 1)
    full_train = lambda p: pairs(p, np.arange(MIN_ORIGIN, n - 1, stride), TRAIN_H, n - 1)     # everything, for the production refit

    def test(p):
        origins = np.arange(t0 - 1, n - 1 - MAX_H + 1, 6)
        return np.repeat(origins, MAX_H), np.tile(np.arange(1, MAX_H + 1), len(origins))

    return dict(train=train, val=val, full_train=full_train, test=test, t0=t0, v0=v0)


# ---------------------------------------------------------------------------------------------- model
def fit(train, val, alpha, feature_names, rounds=None, max_rounds=1500):
    params = dict(BASE_PARAMS, alpha=alpha)
    cats = [c for c in CATEGORICAL if c in feature_names]
    dtr = lgb.Dataset(train["X"][feature_names], train["y"], categorical_feature=cats, free_raw_data=False)
    if rounds is None:
        dva = lgb.Dataset(val["X"][feature_names], val["y"], reference=dtr, categorical_feature=cats)
        return lgb.train(params, dtr, num_boost_round=max_rounds, valid_sets=[dva], callbacks=[lgb.early_stopping(60, verbose=False)])
    return lgb.train(params, dtr, num_boost_round=rounds)


def predict(model, X):
    return model.predict(X, num_iteration=model.best_iteration or None)


def pinball(y, q, a):
    d = y - q
    return float(np.mean(np.maximum(a * d, (a - 1) * d)))


def wape(y, yhat):
    return float(np.abs(y - yhat).sum() / y.sum())


def bucket_of(h):
    return np.select([(h >= lo) & (h <= hi) for lo, hi in BUCKETS], range(len(BUCKETS)))


# ---------------------------------------------------------------------------------------------- checks
def leakage_check(pools):
    """Rebuild a pool with everything after one origin replaced by junk and confirm no feature moves."""
    p = pools[0]
    rng = np.random.default_rng(3)
    o = p.n - 3 * WEEK
    junk = lambda a: np.concatenate([a[: o + 1], rng.uniform(0.2, 5.0, len(a) - o - 1) * a.mean()])
    q = Pool(p.pool_id, p.meta, junk(p.y), junk(p.lat), junk(p.queue), junk(p.inc_w), p.hour, p.dow, p.hol, p.ts)
    q.codes = p.codes
    hi = np.arange(1, MAX_H + 1)
    oi = np.full(MAX_H, o)
    a, b = features(p, oi, hi), features(q, oi, hi)
    moved = [c for c in a.columns if not np.allclose(a[c].to_numpy(), b[c].to_numpy(), equal_nan=True)]
    assert not moved, f"features changed when the future changed: {moved}"
    return True


# ---------------------------------------------------------------------------------------------- run
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true", help="a smaller, quicker run for checking the pipeline")
    args = ap.parse_args()
    t_start = time.time()
    log = lambda *a: print(f"[{time.time() - t_start:6.0f}s]", *a, flush=True)

    pools = load_corpus()
    N = pools[0].n
    stride = 12 if args.fast else 3
    max_rounds = 150 if args.fast else 1500
    log(f"corpus: {len(pools)} pools x {N:,} hours; LightGBM {lgb.__version__}; train stride {stride}")
    log("leakage check:", leakage_check(pools))

    sp = splits(pools, stride)
    names_core, names_all = CORE, CORE + SIGNALS
    train = dataset(pools, sp["train"], names_all)
    val = dataset(pools, sp["val"], names_all)
    test = dataset(pools, sp["test"], names_all)
    log(f"rows: train {len(train['y']):,}, validation {len(val['y']):,}, test {len(test['y']):,} "
        f"(test = the last {TEST_WEEKS} weeks; nothing at or after hour {sp['t0']:,} is trained on)")

    # ---- do the funnel signals help? decided on validation, reported on test
    log("fitting p50 with and without the funnel signals")
    m_core = fit(train, val, 0.5, names_core, max_rounds=max_rounds)
    m_sig = fit(train, val, 0.5, names_all, max_rounds=max_rounds)
    v_core = pinball(val["y"], predict(m_core, val["X"][names_core]), 0.5)
    v_sig = pinball(val["y"], predict(m_sig, val["X"][names_all]), 0.5)
    # A gain under 1% is inside the run-to-run noise of training: the same comparison came out at +0.2% and +0.7%
    # on two runs that differed only in a feature change elsewhere. So the signals are used only for a clear win.
    use_signals = v_sig < 0.99 * v_core
    features_used = names_all if use_signals else names_core
    log(f"validation pinball p50: calendar+lags {v_core:.5f}, + funnel signals {v_sig:.5f} -> using {'signals' if use_signals else 'calendar+lags only'}")

    # ---- the three quantile models
    models = {0.5: m_sig if use_signals else m_core}
    for a in QUANTILES[1:]:
        log(f"fitting p{round(a * 100)}")
        models[a] = fit(train, val, a, features_used, max_rounds=max_rounds)
    iters = {a: int(m.best_iteration) for a, m in models.items()}
    log("best iterations:", iters)

    # ---- range calibration (split conformal): one scale per range, learned on the validation weeks only.
    # Quantile models are usually a little too tight; this stretches p80 and p95 until they cover as promised
    # on data the model was not fitted to. The median is left alone.
    rawv = np.sort(np.column_stack([predict(models[a], val["X"][features_used]) for a in QUANTILES]), axis=1)
    scale = {a: 1.0 for a in QUANTILES}
    for i, a in enumerate(QUANTILES):
        if a != 0.5:
            scale[a] = float(np.quantile(val["y"] / rawv[:, i], a))
    log("range calibration, learned on validation:", {f"p{round(a * 100)}": round(s, 4) for a, s in scale.items()})
    scales = np.array([scale[a] for a in QUANTILES])

    # ---- held-out test: LightGBM against two honest baselines
    Xt = test["X"][features_used]
    lvl = test["level"]
    raw = np.sort(np.column_stack([predict(models[a], Xt) for a in QUANTILES]), axis=1)      # quantiles must not cross
    raw_cal = np.sort(raw * scales, axis=1)
    pred_raw = {a: raw[:, i] * lvl for i, a in enumerate(QUANTILES)}
    pred = {a: raw_cal[:, i] * lvl for i, a in enumerate(QUANTILES)}
    y = test["y"] * lvl
    base_naive = test["full"]["sn168"].to_numpy() * lvl
    base_prof = test["full"]["prof4"].to_numpy() * lvl
    # the profile baseline's ranges: its own empirical error ratios on the training rows, per pool
    prof_tr = train["full"]["prof4"].to_numpy()
    ratio_tr = train["y"] / prof_tr
    base_q = {a: np.zeros(len(y)) for a in QUANTILES}
    for k in range(len(pools)):
        qv = np.quantile(ratio_tr[train["pool"] == k], QUANTILES)
        for i, a in enumerate(QUANTILES):
            base_q[a][test["pool"] == k] = base_prof[test["pool"] == k] * qv[i]

    h = test["h"]
    bk = bucket_of(h)
    def block(mask):
        return dict(seasonal_naive=wape(y[mask], base_naive[mask]), profile_4wk=wape(y[mask], base_prof[mask]), lightgbm=wape(y[mask], pred[0.5][mask]),
                    mae_lightgbm=float(np.abs(y[mask] - pred[0.5][mask]).mean()), n=int(mask.sum()))
    overall = block(np.ones(len(y), bool))
    by_horizon = {f"{lo}-{hi}h": block(bk == i) for i, (lo, hi) in enumerate(BUCKETS)}
    by_pool = {pools[k].pool_id: block(test["pool"] == k) for k in range(len(pools))}
    calibration = {
        f"p{round(a * 100)}": dict(
            target=a, scale=scale[a], lightgbm=float(np.mean(y <= pred[a])), lightgbm_uncalibrated=float(np.mean(y <= pred_raw[a])), profile_4wk=float(np.mean(y <= base_q[a])),
            pinball_lightgbm=pinball(y, pred[a], a) / float(y.mean()), pinball_lightgbm_uncalibrated=pinball(y, pred_raw[a], a) / float(y.mean()),
            pinball_profile_4wk=pinball(y, base_q[a], a) / float(y.mean()),
        ) for a in QUANTILES[1:]
    }
    calibration["by_horizon_p80"] = {f"{lo}-{hi}h": float(np.mean((y <= pred[0.8])[bk == i])) for i, (lo, hi) in enumerate(BUCKETS)}
    log(f"TEST wape: repeat last week {overall['seasonal_naive']:.4f}, seasonal profile {overall['profile_4wk']:.4f}, LightGBM {overall['lightgbm']:.4f}")

    # ---- the busiest hour of each day, which is what capacity has to cover
    peaks = dict(actual=[], lightgbm=[], profile=[], p95=[])
    for k in range(len(pools)):
        m = test["pool"] == k
        shape = (-1, MAX_H)
        ya, p50, pf, p95 = y[m].reshape(shape), pred[0.5][m].reshape(shape), base_prof[m].reshape(shape), pred[0.95][m].reshape(shape)
        for d in range(7):
            sl = slice(24 * d, 24 * (d + 1))
            peaks["actual"].append(ya[:, sl].max(axis=1)); peaks["lightgbm"].append(p50[:, sl].max(axis=1))
            peaks["profile"].append(pf[:, sl].max(axis=1)); peaks["p95"].append(p95[:, sl].max(axis=1))
    peaks = {k: np.concatenate(v) for k, v in peaks.items()}
    daily_peak = dict(
        wape_lightgbm=wape(peaks["actual"], peaks["lightgbm"]), wape_profile_4wk=wape(peaks["actual"], peaks["profile"]),
        covered_by_p95=float(np.mean(peaks["actual"] <= peaks["p95"])), n_days=int(len(peaks["actual"])),
    )

    extras = {}
    if not args.fast:
        # ---- does pooling help? one global model against a model per pool
        log("global model versus one model per pool")
        local_wape = {}
        for k, p in enumerate(pools):
            tr = dict(X=train["X"][train["pool"] == k], y=train["y"][train["pool"] == k])
            va = dict(X=val["X"][val["pool"] == k], y=val["y"][val["pool"] == k])
            names = [c for c in features_used if c not in CATEGORICAL]
            m = fit(tr, va, 0.5, names, max_rounds=max_rounds)
            mk = test["pool"] == k
            local_wape[p.pool_id] = wape(y[mk], predict(m, test["X"][mk][names]) * lvl[mk])
        extras["global_vs_per_pool"] = {pid: dict(per_pool_model=local_wape[pid], global_model=by_pool[pid]["lightgbm"]) for pid in local_wape}

        # ---- a pool the model has never seen
        log("leave one pool out: a brand-new pool and region")
        lopo = {}
        for k, p in enumerate(pools):
            keep = train["pool"] != k
            tr = dict(X=train["X"][keep], y=train["y"][keep])
            m = fit(tr, None, 0.5, features_used, rounds=iters[0.5])
            mk = test["pool"] == k
            lopo[p.pool_id] = dict(unseen_pool_model=wape(y[mk], predict(m, test["X"][mk][features_used]) * lvl[mk]),
                                   seen_pool_model=by_pool[p.pool_id]["lightgbm"], profile_4wk=by_pool[p.pool_id]["profile_4wk"],
                                   others_share_its_workload=int(sum(1 for q in pools if q.meta["workload_type"] == p.meta["workload_type"]) - 1))
        extras["leave_one_pool_out"] = lopo

    extras["funnel_signals"] = dict(
        validation_pinball_p50_calendar_and_lags=v_core, validation_pinball_p50_with_signals=v_sig, used_signals=bool(use_signals),
        test_wape_calendar_and_lags=wape(y, predict(m_core, test["X"][names_core]) * lvl),
        test_wape_with_signals=wape(y, predict(m_sig, test["X"][names_all]) * lvl),
    )

    # ---- what the model relies on
    imp = pd.DataFrame({"feature": features_used, "gain": models[0.5].feature_importance("gain")})
    imp["share"] = imp["gain"] / imp["gain"].sum()
    imp = imp.sort_values("gain", ascending=False)

    # ---- refit on everything up to the last hour, then forecast the week after it
    log("refitting on all data and forecasting the next 168 hours")
    full = dataset(pools, sp["full_train"], features_used)
    final = {}
    for a in QUANTILES:
        final[a] = fit(full, None, a, features_used, rounds=max(50, int(iters[a] * 1.1)))
    rows = []
    OUT.mkdir(exist_ok=True)
    (OUT / "models").mkdir(exist_ok=True)
    for k, p in enumerate(pools):
        oi, hi = np.full(MAX_H, N - 1), np.arange(1, MAX_H + 1)
        Xf = features(p, oi, hi)[features_used]
        r = np.sort(np.sort(np.column_stack([final[a].predict(Xf) for a in QUANTILES]), axis=1) * scales, axis=1) * p.level[N - 1]
        for j in range(MAX_H):
            rows.append(dict(pool_id=p.pool_id, ts_utc=p.ts[N + j].strftime("%Y-%m-%dT%H:00:00Z"), horizon_h=j + 1,
                             local_hour=int(p.hour[N + j]), p50=round(r[j, 0], 1), p80=round(r[j, 1], 1), p95=round(r[j, 2], 1)))
    fc = pd.DataFrame(rows)
    fc.to_csv(OUT / "forecast_next_168h.csv", index=False, lineterminator="\n")
    for a, m in final.items():
        m.save_model(str(OUT / "models" / f"lightgbm_p{round(a * 100)}.txt"))
    imp.to_csv(OUT / "feature_importance.csv", index=False, lineterminator="\n")

    next_week = []
    for p in pools:
        d = fc[fc.pool_id == p.pool_id]
        top = d.loc[d["p95"].idxmax()]
        next_week.append(dict(pool_id=p.pool_id, capacity_units=p.capacity, last_week_mean=float(p.level[N - 1]),
                              next_week_mean_p50=float(d["p50"].mean()), busiest_hour_p80=float(d["p80"].max()), busiest_hour_p95=float(top["p95"]),
                              busiest_hour_p95_at_utc=top["ts_utc"], busiest_hour_p95_local_hour=int(top["local_hour"]),
                              busiest_hour_p95_share_of_capacity=float(top["p95"] / p.capacity)))

    result = dict(
        generated_with=dict(lightgbm=lgb.__version__, numpy=np.__version__, pandas=pd.__version__, python=platform.python_version(), fast=bool(args.fast)),
        corpus=(lambda m: {k: m[k] for k in ("generator_version", "as_of", "frequency", "starts_utc", "ends_before_utc", "hours_per_pool", "rows", "files")})(json.loads((CORPUS / "meta.json").read_text())),
        setup=dict(pools=len(pools), hours_per_pool=N, test_weeks=TEST_WEEKS, validation_weeks=VAL_WEEKS, horizons_trained=list(TRAIN_H),
                   forecast_horizon_hours=MAX_H, quantiles=list(QUANTILES), rows=dict(train=len(train["y"]), validation=len(val["y"]), test=len(test["y"])),
                   features=features_used, best_iterations={f"p{round(a * 100)}": v for a, v in iters.items()}, params={k: v for k, v in BASE_PARAMS.items() if k != "num_threads"},
                   first_test_hour=int(sp["t0"]), leakage_check_passed=True),
        test=dict(overall=overall, by_horizon=by_horizon, by_pool=by_pool, calibration=calibration, daily_peak=daily_peak),
        extras=extras,
        feature_importance=imp.head(15).to_dict("records"),
        next_week=next_week,
        seconds=round(time.time() - t_start),
    )
    (OUT / "backtest.json").write_text(json.dumps(result, indent=2, default=float) + "\n")
    write_report(result)
    log("done: ml/out/backtest.json, ml/out/report.md, ml/out/forecast_next_168h.csv, ml/out/models/")


# ---------------------------------------------------------------------------------------------- report
def write_report(r):
    t = r["test"]
    o = t["overall"]
    pct = lambda x: f"{x * 100:.1f}%"
    best_base = min(o["seasonal_naive"], o["profile_4wk"])
    better = (1 - o["lightgbm"] / best_base) * 100
    L = []
    L += ["# Hourly demand forecast: LightGBM on the 1-hour corpus", "",
          "Generated by `npm run ml` from the corpus in `ml/corpus/`. Do not edit by hand.", "",
          "**The corpus is generated, not measured.** These results show that the pipeline works and how much structure a model can pick up from a realistic hourly series. They do not show how well it would forecast a real estate.", "",
          "## The answer", "",
          f"On the last {r['setup']['test_weeks']} weeks, which the model never saw, the LightGBM median forecast misses by **{pct(o['lightgbm'])}** of demand (WAPE). Repeating last week misses by {pct(o['seasonal_naive'])}, and the seasonal profile (the same hour of the last four weeks, scaled to the latest level) by {pct(o['profile_4wk'])}. "
          f"That is {abs(better):.0f}% {'better' if better >= 0 else 'worse'} than the stronger of the two.", ""]
    hb = t["by_horizon"]
    edge = {k: 1 - v["lightgbm"] / v["profile_4wk"] for k, v in hb.items()}
    first, last = list(hb)[0], list(hb)[-1]
    L += [f"Against the seasonal profile, LightGBM's edge is {edge[first] * 100:.0f}% in hours {first[:-1]} ({pct(hb[first]['lightgbm'])} against {pct(hb[first]['profile_4wk'])}) and {edge[last] * 100:.0f}% in hours {last[:-1]} ({pct(hb[last]['lightgbm'])} against {pct(hb[last]['profile_4wk'])}). "
          + ("Right after the last reading the recent history still carries information, so that is where the model helps most." if edge[first] > edge[last]
           else "The edge does not shrink with distance here, so it comes from the profile and calendar features rather than from the latest readings."), ""]
    L += ["## Accuracy by how far ahead", "", "WAPE = total absolute error divided by total demand. Lower is better.", "",
          "| Hours ahead | Repeat last week | Seasonal profile | LightGBM p50 |", "|---|--:|--:|--:|"]
    for k, v in hb.items():
        L.append(f"| {k} | {pct(v['seasonal_naive'])} | {pct(v['profile_4wk'])} | **{pct(v['lightgbm'])}** |")
    L += ["", "## Accuracy by pool", "", "| Pool | Repeat last week | Seasonal profile | LightGBM p50 | Mean miss (CU) |", "|---|--:|--:|--:|--:|"]
    for k, v in t["by_pool"].items():
        L.append(f"| {k} | {pct(v['seasonal_naive'])} | {pct(v['profile_4wk'])} | **{pct(v['lightgbm'])}** | {v['mae_lightgbm']:.0f} |")
    c = t["calibration"]
    L += ["", "## Are the ranges honest?", "",
          "A p80 forecast should sit above the actual value 80% of the time, and a p95 forecast 95%. The lab plans at p80.", "",
          "Each range is stretched by one factor, learned on the three validation weeks before the test weeks and never on the test weeks themselves. "
          + " ".join(f"The stretch moved {k} coverage from {pct(c[k]['lightgbm_uncalibrated'])} to {pct(c[k]['lightgbm'])}, "
                     f"{'closer to' if abs(c[k]['lightgbm'] - c[k]['target']) < abs(c[k]['lightgbm_uncalibrated'] - c[k]['target']) else 'further from'} the target." for k in ("p80", "p95"))
          + " Three weeks is a noisy window to learn from, and coverage is very sensitive here (a 0.5% change in level moves it by several points), so read the two columns together as the range of what to expect.", "",
          "| Range | Should cover | LightGBM as trained | LightGBM stretched | Stretch factor | Seasonal profile | Pinball loss, stretched | Pinball loss, seasonal profile |", "|---|--:|--:|--:|--:|--:|--:|--:|"]
    for k in ("p80", "p95"):
        L.append(f"| {k} | {pct(c[k]['target'])} | {pct(c[k]['lightgbm_uncalibrated'])} | **{pct(c[k]['lightgbm'])}** | {c[k]['scale']:.3f} | {pct(c[k]['profile_4wk'])} | {c[k]['pinball_lightgbm']:.4f} | {c[k]['pinball_profile_4wk']:.4f} |")
    L += ["", "p80 coverage by how far ahead: " + ", ".join(f"{k} {pct(v)}" for k, v in c["by_horizon_p80"].items()) + ".", ""]
    d = t["daily_peak"]
    L += ["## The busiest hour of each day", "",
          f"Capacity has to cover the peak, not the average. Over {d['n_days']:,} forecast days, the daily peak from the LightGBM median misses by {pct(d['wape_lightgbm'])} (seasonal profile: {pct(d['wape_profile_4wk'])}), and the p95 forecast's peak sat above the real peak on {pct(d['covered_by_p95'])} of days.", ""]
    ex = r["extras"]
    L += ["## Does using the funnel signals help?", ""]
    fs = ex["funnel_signals"]
    L += [f"Latency, queue depth and open-incident weight at the forecast origin were added as features. Test WAPE {pct(fs['test_wape_calendar_and_lags'])} without them, {pct(fs['test_wape_with_signals'])} with them. "
          f"The final model uses **{'them' if fs['used_signals'] else 'calendar and lags only'}**, chosen on validation data before the test weeks were looked at.",
          "In this corpus latency and queue depth are generated from utilization, so they cannot carry information the utilization history does not already hold. On real telemetry they could lead utilization; this test says nothing about that.", ""]
    if "global_vs_per_pool" in ex:
        gp = ex["global_vs_per_pool"]
        wins = sum(1 for v in gp.values() if v["global_model"] < v["per_pool_model"])
        L += ["## Does pooling help?", "", f"One model trained on all six pools against six separate models, one per pool (test WAPE, median forecast). The global model is better on {wins} of {len(gp)} pools.", "",
              "| Pool | One model per pool | One global model |", "|---|--:|--:|"]
        for k, v in gp.items():
            L.append(f"| {k} | {pct(v['per_pool_model'])} | **{pct(v['global_model'])}** |")
        L += ["", "### A pool the model has never seen", "",
              "The model is retrained without one pool and asked to forecast it. This is what a new pool or region would get on day one.", "",
              "| Pool | Never seen | Seen in training | Seasonal profile | Other pools like it |", "|---|--:|--:|--:|--:|"]
        for k, v in ex["leave_one_pool_out"].items():
            L.append(f"| {k} | {pct(v['unseen_pool_model'])} | {pct(v['seen_pool_model'])} | {pct(v['profile_4wk'])} | {v['others_share_its_workload']} |")
        lp = ex["leave_one_pool_out"]
        with_sib = [v for v in lp.values() if v["others_share_its_workload"] > 0]
        alone = [v for v in lp.values() if v["others_share_its_workload"] == 0]
        avg = lambda vs, key: sum(v[key] for v in vs) / len(vs)
        L += ["", f"Pools with siblings of the same workload type: {pct(avg(with_sib, 'unseen_pool_model'))} when never seen, {pct(avg(with_sib, 'seen_pool_model'))} when seen, {pct(avg(with_sib, 'profile_4wk'))} for the seasonal profile."
              + (f" Pools with no sibling: {pct(avg(alone, 'unseen_pool_model'))} when never seen, {pct(avg(alone, 'seen_pool_model'))} when seen, {pct(avg(alone, 'profile_4wk'))} for the profile." if alone else ""), ""]
    L += ["## What the model relies on", "", "Share of the median model's total gain.", "", "| Feature | Share |", "|---|--:|"]
    for f in r["feature_importance"][:10]:
        L.append(f"| {f['feature']} | {pct(f['share'])} |")
    L += ["", "## The next 7 days", "", "From the last hour of the corpus. Share of installed capacity is the p95 forecast for the busiest hour.", "",
          "| Pool | This week's mean (CU) | Next week's mean, p50 | Busiest hour, p95 | Share of capacity | When (UTC, local hour) |", "|---|--:|--:|--:|--:|---|"]
    for n in r["next_week"]:
        L.append(f"| {n['pool_id']} | {n['last_week_mean']:.0f} | {n['next_week_mean_p50']:.0f} | {n['busiest_hour_p95']:.0f} | {pct(n['busiest_hour_p95_share_of_capacity'])} | {n['busiest_hour_p95_at_utc']}, {n['busiest_hour_p95_local_hour']}:00 |")
    L += ["", "## How it was tested", "",
          f"- **No peeking.** Nothing at or after hour {r['setup']['first_test_hour']:,} (the start of the last {r['setup']['test_weeks']} weeks) was used to train. The {r['setup']['validation_weeks']} weeks before it were used only to decide when to stop training and whether the funnel signals help.",
          "- **No leaked features.** Every feature is known at forecast time. A check corrupts all data after a forecast origin and confirms no feature changes.",
          f"- **Rolling origins.** Forecasts are issued every 6 hours through the test window, each for the full next {r['setup']['forecast_horizon_hours']} hours: {r['setup']['rows']['test']:,} forecasts.",
          "- **Fixed settings.** The model settings were not tuned on the test weeks.",
          "- **A disclosure.** The range stretch was added after a first run showed slightly narrow ranges, so the decision to have it was informed by looking at test coverage, although its size is learned from the validation weeks only. The seasonal profile was also made a fairer baseline (scaled to the latest level) after a first run showed it lagging a growing pool.", "",
          "## What this does not tell you", "",
          "- **The data is generated.** Real workloads have surprises, outages and step changes the generator does not. A model that learns this corpus well has learned the generator.",
          "- **It is a week ahead, not a year.** This is an operational forecast. The lab's capacity plan looks 3 to 12 months ahead, and 104 weeks of history cannot support a model of that horizon better than the trend-and-wave fit the lab already uses. The two fit together: the hourly model says how the load sits inside a week, and the busiest hour is what the weekly plan should be checked against.",
          "- **Six pools.** Cross-pool learning is shown, but on very few pools.",
          "- **Known events are not modelled.** Launches, contracts and relocations stay as dated rules in the lab, because there is no history of them to learn from.", ""]
    (OUT / "report.md").write_text("\n".join(L))


if __name__ == "__main__":
    main()
