# ML: an hourly corpus and a LightGBM forecast

This folder is optional. The lab itself is Node built-ins only and never reads anything here. It holds two things:

1. **An hourly data corpus**: two years of hourly readings for every pool, generated from the lab's own data.
2. **A LightGBM model** trained on it that forecasts the next week, hour by hour, across all pools and regions.

**The corpus is generated, not measured.** What the model shows is that the method works and how much structure it can learn. It does not show how well it would forecast a real estate.

## Run it

```powershell
npm run ml:setup     # once: creates ml/.venv and installs LightGBM, NumPy, pandas, SciPy (needs Python 3.10+ and a network)
npm run corpus       # generate ml/corpus/  (under a second)
npm run ml:train     # train, back-test, forecast: writes ml/out/  (a few minutes)
npm run ml           # corpus, then train
npm run ml -- --fast # a quick check of the pipeline (about ten seconds, rougher numbers)
```

Then read `ml/out/report.md`. The numbers in this README would go stale; the report is regenerated every run.

## The corpus (`ml/corpus/`)

| File | What it is |
|---|---|
| `hourly_pool_metrics.csv` | One row per pool per hour, 6 pools x 17,472 hours (2024-09-23 to 2026-09-21, UTC) |
| `pools.csv` | What each pool is: region, geo, SKU, workload type, capacity, time zone |
| `calendar_future.csv` | Local hour, weekday and holiday for the 8 days after the last hour, so a forecast knows what it has not seen |
| `meta.json` | What every column means, the assumptions, per-pool statistics and each file's checksum |

Columns in the hourly file: `utilized_units` (the target), `p95_latency_ms` and `queue_depth_p95` (performance funnel), `incidents_opened` and `incident_weight_active` (reliability funnel), `carbon_kg` (sustainability funnel), and the local calendar (`local_hour`, `local_dow`, `is_holiday`).

**How it ties to the lab**

- The last 52 weeks add up to the lab's weekly readings *exactly*: the 168 hours ending at a week's `week_start` sum to 168 x that week's reading in `utilization.json`. So the corpus ends at the dataset's "today".
- The 52 weeks before that are a backcast, fitted from the observed series (a two-part trend and a yearly wave, with fresh noise). It gives a model two winters and two holiday seasons to see.
- Latency and queue depth average to `performance.json` over the last week. Incidents in the last 90 days are exactly `incidents.json`, placed at a fixed hour of their day. Carbon is the SKU's intensity times the load.
- Load follows each region's local clock: business hours, weekends, illustrative public holidays and real daylight-saving rules (US and EU switch on different Sundays). A model that uses UTC hours alone is misled, which is the point of a multi-region corpus.

`npm test` checks all of this (`test/corpus.test.js`), including that the files on disk are the ones the generator produces.

## The model (`train_forecast.py`)

- **LightGBM, one global model for every pool and region**, forecasting hours 1 to 168 ahead. The horizon is a feature, so one model answers every step of the week.
- **Quantile objectives** at p50, p80 and p95. p80 is the level the lab plans at. Ranges come from the model, not from guessing around a point forecast.
- **The target is a ratio** to the pool's own trailing-week mean, so pools of different size and growth are comparable and a tree model never has to extrapolate a level it has not seen.
- **Features** are recent lags and rolling statistics, the same hour in previous weeks, the target hour's local clock and holiday flag, day of year, region and workload type, and (tested, kept only if they help) the funnel signals.
- **Honest testing**: the last 8 weeks are held out; the 3 weeks before are used only to stop training; a leakage check corrupts everything after a forecast origin and confirms no feature moves; the model is compared to repeating last week and to a four-week profile.

Outputs in `ml/out/`: `report.md`, `backtest.json`, `forecast_next_168h.csv` (p50, p80 and p95 for every pool and hour), `feature_importance.csv`, and the models in `models/` (LightGBM text files).

## The peak profile (`ml/out/peak_profile.json`)

`npm run ml` finishes by building a small file the lab's engine can read without knowing anything about hourly data (`npm run peak-profile` rebuilds it from the corpus and the last forecast). For each pool it holds:

- `busiest_hour_ratio`: the busiest hour of a week divided by that week's mean, averaged over the lab's 52 weeks. The lab plans on weekly readings, and a reading is a mean.
- `weekly_ratio`: the same ratio week by week, aligned with `utilization.json`, so the engine can say how long a pool has been over its working ceiling at the peak.
- `next_week`: the model's forecast for the coming 168 hours: the mean, and the busiest hour at p80 and p95.

The engine uses it for the **peak check**: each plan is re-run with the history read as the busiest hour, and set beside the normal plan. The check changes nothing, and it is optional. The engine refuses a profile that does not match the dataset (a different `as_of`, a missing pool, or a last-week mean that is not the lab's latest reading), and `make-peak-profile.js` refuses to build one if the forecast was trained on a different corpus from the one on disk. A `--fast` training run does not build a profile, because its forecast is only a check of the pipeline.

## Where it fits, and where it does not

The lab's capacity plan looks 3 to 12 months ahead. Two years of hourly data cannot support a model that far out better than the trend-and-wave fit the lab already uses, so this model is a week ahead. The two fit together: the weekly plan says how big the pool has to be; the hourly forecast says how the load sits inside the week, and how high the busiest hour goes.

The engine does not run this model. It reads one small file derived from it, the peak profile above, to check the weekly plan against the busiest hour. That check shows what the plan would ask for; it does not change the plan.
