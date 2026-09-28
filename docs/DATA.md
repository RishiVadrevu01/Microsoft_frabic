# Data dictionary

Everything in `data/` is **synthetic**. It mirrors the structure of a capacity-planning estate so the engine, the API and the screens can be demonstrated without any real data. `npm run seed` regenerates it byte for byte (`data/seed.js`, seeded PRNG).

Every file carries `source: "synthetic"` and a `dataset_version`. The loader (`server/lib/data.js`) refuses a file that does not say so, refuses a field of the wrong type, and checks that the records agree with each other (reservations add up to the pool's reading, every reference resolves, the SKU successor chain ends).

This is the dataset the Engineering Requirements ask for (section 4): infrastructure and SKU records across several regions, allocation and utilization series with growth, seasonality and intentional pockets of waste, a SKU lifecycle table with several end-of-life SKUs each mapped to a successor and an equivalence factor, incidents correlated to a fabric segment, and at least a light record for every one of the 14 funnels.

## The files

| File | What a record is | Key fields | Read by funnels |
|---|---|---|---|
| `meta.json` | The dataset itself | `as_of` (the engine's "today"), `dataset_version` | all |
| `policy.json` | Every threshold and bound, versioned | floor by workload, buffer, cover window, severity limits, `overview` (region watch 80% and at-risk 95%, and the 13 weeks that "vs last quarter" compares against) | all |
| `infrastructure.json` | A capacity pool in one region and SKU | `pool_id`, `datacenter_id`, `region`, `geo` (north-america, europe, asia-pacific, latin-america: how the Overview groups regions), `lat` and `lon` (the data centre's place, for the Overview map), `sku_id`, `capacity_units`, `segments` | 2 (segments); the capacity every plan is measured against |
| `utilization.json` | 52 weekly readings per pool | `week_start`, `utilized_units` | 1 |
| `allocations.json` | What a team has reserved and really uses | `allocated_units`, `utilized_units`, `low_use_weeks` | 4 |
| `sku_catalogue.json` | A hardware SKU and its lifecycle | `status`, `replaced_by_sku`, `capacity_equivalence_factor`, `unit_cost_usd`, `gco2_per_cu_hour`, `security_support_ends` | 7, 9, lifecycle |
| `vendors.json` | A vendor's quote and real delivery history | `quoted_lead_weeks`, `observed_lead_weeks`, `risk_score` | 8 |
| `supply_pipeline.json` | An order already in flight | `cu`, `lands_on`, `status` | 1, plan sizing |
| `incidents.json` | An incident with severity and fabric segment | `severity`, `fabric_segment`, `opened_on`, `mttr_hours` | 2 |
| `requests.json` | A capacity request: pending ones are demand in the pipeline, approved, completed and declined ones are history | `cu`, `needed_by`, `win_probability`, `source` (onboarding queue, sales pipeline, growth forecast), `status` (pending, approved, declined, completed). Optional, for the Product Team view: `org`, `submitted_on`, `decided_on`, `delivered_on`, `environment` (production, staging, development), `use_case`, `revenue_at_risk_usd`, `customer_commitment`, `sla_impact` (low, medium, high), `strategic_importance` (medium, high, critical). Checked on load: dates in order, a decided status needs `decided_on`, a completed one needs `delivered_on`. | 1 (pending only); the Product Team view |
| `contracts.json` | An enterprise-agreement commitment | `committed_cu`, `provisioned_cu`, `effective_date` | 12 |
| `events.json` | A dated external event, keyed by `signal` (seasonal, strategic, competitive, technology-shift, geopolitical) | `signal`, `scope`, `date`, `confidence`, `uplift_pct` or `magnitude_cu` | 5, 10, 11, 13, 14 |
| `dependencies.json` | Critical services on a pool | `critical_services[].tier`, `failover_pool_id` | 6 |
| `performance.json` | Latency and queue strain | `p95_latency_ms`, `queue_depth_p95`, `knee_util_pct` | 3 |
| `feeds.json` | The register of data feeds and who owns them | `owner_team`, `cadence_days`, `last_delivered` | health of every funnel |

Every field the engine reads is checked when the data loads: its type, its range (a share is 0 to 1, a capacity is above 0, a reading is not negative) and, inside a list, each element (a critical service needs a `tier`, a segment needs `units`, a lead-time sample must be a number). An event must carry what its funnel reads: a seasonal event `duration_weeks` and `uplift_pct`, a regional relocation or a roadmap step-up `magnitude_cu`, a technology shift `from_share` and `to_share`. The exact rules are in [CONTRACTS.md](CONTRACTS.md), generated from the code, and `policy.json` and `meta.json` are checked the same way.

That is 13 record files plus `meta.json` and `policy.json`, 15 in all. They feed 14 funnels, because one file can serve several funnels and a funnel can read several files. Anything a person does in the lab (scenarios, requests, decisions) is kept in `runtime/state.json` at the project root and layered on top of the seed at load. The seed files are never written. `npm run reset` deletes that file. That file also holds how far the lab's "today" has been moved (`advance.weeks`) and the record of what was predicted and planned each time it moved (`ledger`); the advanced world itself is not stored, it is replayed from the seed by `server/lib/clock.js`, so it is always reproducible. See [CONTRACTS.md](CONTRACTS.md), section 6.

## The seven ontology layers

The **Ontology** page (`GET /api/ontology`) shows these seven layers with their live value for every pool. It adds no data: each value is read from a record, or from the plan the engine already produced, so it agrees with the pool pages and the Overview. Four layers are recorded as they arrive; three are derived. Idle capacity below the flag threshold is shown on the gap and waste layer but is not counted as a reclaim opportunity, so the reclaim total matches the Overview.

| Layer | Where it lives |
|---|---|
| Infrastructure | `infrastructure.json` (`datacenter_id`, `sku_id`, `region`, `capacity_units`, racks and fabric segments) |
| Allocation | `allocations.json` (`allocated_units`, `reserved_by`, `allocation_date`) |
| Utilization | `utilization.json` (`utilized_units`, `week_start`) and `workload_type` on the pool |
| Gap / Waste | Derived from allocation minus utilization: idle reservations and the reclaimable amount (funnel 4) |
| SKU lifecycle and substitution | `sku_catalogue.json` (`status`, `replaced_by_sku`, `capacity_equivalence_factor`) |
| Reliability / health score | Derived from `incidents.json`: severity-weighted score per fabric segment, time to mitigate (funnel 2) |
| Planning horizon | Derived by the engine per pool: exhaustion date, recommended order quantity, lead time |

## What Capacity Planning is built from

`GET /api/planning` adds no data files. It is the one page where supply and demand meet, and every figure is arithmetic over the pool assessments the engine already computed, so it agrees with the pool pages and the Overview (`test/planning.test.js` checks that it does).

| Figure | Where it comes from |
|---|---|
| Capacity available, pool capacity, utilization | `infrastructure.json` (installed capacity, plus any landed orders) and `allocations.json` (what teams reserved), against the latest reading in `utilization.json`. |
| Headroom | Per pool, the working ceiling (`policy.json` floors, lowered by the performance funnel) times usable capacity, less usage. A pool above its ceiling contributes nothing; it does not borrow from another. |
| Health | The reliability, performance and dependency funnels' flags, and the incidents in `incidents.json` in the last 90 days. |
| Cost | Installed capacity at each SKU's `unit_cost_usd` (`sku_catalogue.json`), a one-off purchase figure; idle reservations that could be reclaimed; and the cost of the orders the plans draft. |
| Product demand, workload forecast, growth | The demand we plan for (forecast p80, weighted pipeline, dated adds, any seasonal spike), the forecast's middle path on its own, and the slope of each pool's fitted trend, all from `utilization.json` through the forecast. |
| Pipeline | Pending requests in `requests.json` due within the horizon, each at its `win_probability` and less the overlap discount (`policy.json`). Requests that have gone live or lapsed (written by the lab clock) are not pipeline. |
| Business events | `contracts.json` (the part of each commitment not yet provisioned) and `events.json` (seasonal spikes, sized launches and relocations, and signals that add no demand), dated within the horizon. |
| Capacity requests | Pending requests, and how many are at risk: the same assessment the Product Team view uses. |
| Balance | Per pool at the horizon: supply (installed plus landed orders) at the working ceiling, less demand. |

## What the Product Team view is built from

`GET /api/requester` adds no data files either. It is the request block of the Capacity Planning demand view. Each part is a record, the planner's own assessment, or a rule over the plan:

| Part | Where it comes from |
|---|---|
| Requests table, status | `requests.json`, and for pending ones `assessRequests` (`server/lib/requests.js`): served in need-by order from free capacity, idle reservations, supply in flight, then a new order. **At risk** when the part needing a new order lands after the need date. |
| Current usage, utilization | `allocations.json`: what the requesting team reserved in the pool (`reserved_by` is the request's `team`) and really uses. |
| Total demand, chart | The team's usage grown at the pool's forecast (`utilization.json`, p80), plus the ask from its need date. The capacity line is what the team holds plus what the assessment can serve, stepping up on each landing date (`supply_pipeline.json`, or the drafted order). |
| Additional required, est. cost | The assessment's `needs_order`, at the order SKU's `unit_cost_usd` (`sku_catalogue.json`). One-off purchase cost. |
| Revenue at risk, commitment, SLA, importance, use case | The request record, as the requester stated it. Never estimated. |
| Demand drivers | Derived: growth of the team's existing usage, the request's `source`, and any seasonal uplift (`events.json`). Shares add to 100. |
| Options, risks | Rules over the pool's plan, its request queue, the other pools' free capacity, and the funnels flagging the pool. |
| Timeline | `submitted_on`, `decided_on`, `delivered_on`, and the phases of the assessment. |

The organisation is `org` on the request, or the first word of `team` when a request made through the API does not name one.

## What the Overview screen is built from

The Overview (`GET /api/overview`, `GET /api/actions`) adds no data files. It is computed from the same records, per pool and then summed, so the numbers on it always agree with the pool pages.

| Widget | Where it comes from |
|---|---|
| Total demand, region demand | Each pool's demand at the chosen horizon (forecast at p80, weighted pipeline, dated contract and relocation step-ups, any seasonal spike), combined as one distribution: the pools' p80 spreads are joined through the correlation of their week-to-week movements (from `utilization.json`, floored at zero) and the dated parts add exactly. Lower than adding the pools' p80s by the diversification, which the API reports. |
| Projected shortfall | Per pool, demand above effective capacity. A surplus in one pool never offsets a deficit in another, so this is not combined. |
| Peak check (optional) | `ml/out/peak_profile.json`, built from the hourly corpus and the hourly forecast: each pool's busiest-hour-to-weekly-mean ratio (52 weekly values, aligned with `utilization.json`) and next week's forecast busiest hour. The engine refuses it unless it is for this dataset (same `as_of`, same pools, and a last-week mean equal to the lab's latest reading). It is never part of `data/`. |
| vs last quarter | The same forecast refitted 13 weeks earlier, with every other record held as it is now. Labelled in each card's (i) text. |
| Capacity health by region | The pools grouped by `geo`; utilization projected at the horizon, Watch from 80%, At Risk above 95% (`policy.overview`). |
| Effective capacity | Provisioned capacity (installed plus orders in flight) times the pool's working ceiling. There is no disaster-recovery figure in the data. |
| Top capacity constraints, Signals | The funnels' own results (severity, the date each proposes, lead time). Nothing is inferred beyond them. |
| Recommendations, Action queue | The verdicts: order, replace, reclaim and relocate actions, ranked P0 (critical), P1 (high), P2 (the rest). |
| Confidence | Not produced by the engine. A seasonal, strategic or geopolitical event shows the confidence recorded on that event; everything else says what kind of planning set the date. |
| Optimization opportunities, Inventory | Idle reservations (funnel 4) and the pools by SKU. GPU and Compute only; the data has no storage or networking. |

## The hourly corpus (optional)

`ml/corpus/` holds a second, hourly view of the same estate: two years of 1-hour readings for every pool, with the funnel signals that are naturally hourly (utilization, latency, queue depth, incidents, carbon) and each region's local calendar. It is generated from the files above, adds nothing to them, and the lab never reads it. The last 52 weeks add up to the weekly readings in `utilization.json` exactly (a weekly reading is the mean of the 168 hours ending at its `week_start`). See [ml/README.md](../ml/README.md).

## The six pools and what each one is for

| Pool | What the data is scripted to show |
|---|---|
| East US, Intel ICX | Demand sets the date; an end-of-life SKU; a vendor slower than it quotes; a contract; a single point of failure. Overdue. |
| West Europe, AMD Genoa | A calm pool with idle reservations. Nothing to order; reclaim instead. |
| West Europe, GPU H100 | A contract is a hard trigger and sets the date; the mix is shifting toward AI. |
| Southeast Asia, AMD Genoa | Utilization is fine; one fabric segment is failing. Reliability overrides headroom. |
| Japan East, GPU L40S | Strain below the floor, a launch spike, a soft competitor signal. |
| Brazil South, AMD Genoa | A data-residency mandate moves demand into the region. |

## Going live: what real data would take

1. **The minimum.** Seven files are enough to run the demand story: `infrastructure`, `utilization`, `allocations`, `requests`, `supply_pipeline`, `vendors`, `sku_catalogue` (plus `meta` and `policy`). Funnels that have no record for a pool say "no data"; they do not pretend to be quiet.
2. **Same shape.** Extract each source into the shapes above. The engine, the API and the screens do not change.
3. **A deliberate policy change.** The loader requires `source: "synthetic"` on purpose. Accepting real data means changing `server/lib/validate.js` to accept a customer label, and changing the "Synthetic data" chip and colophon on every screen to say so. That is a decision to take once, on purpose, not a flag to flip.
4. **Policy review.** `policy.json` says `approved_by: awaits review`. Floors, buffers, cover windows and lead-time rules are choices for the planners who own them, and the values here are illustrative.
5. **Calibration.** Check the engine's dates and quantities against what the planners would have decided on the same data before anyone relies on them.
