# Fabric Capacity Planning Lab

A hands-on proof of concept for capacity planning: a synthetic estate, the 14 independent funnels from the Engineering Requirements, one planning horizon, a human approval step, and a guided lab that lets you change things and watch the plan react.

**Synthetic data only.** Every record is generated, labelled `source: "synthetic"`, and validated on load. Names are fictional. Nothing here is Microsoft data.

## The story

A product team asks for capacity. The system says **how much fits now, what to order, when to raise it, what it costs and why**. A named planner decides. The decision is recorded.

Or, as the first screen puts it: *are we good for the next 3, 6 and 12 months?*

## Run it

You need Node 20 or newer. There is nothing to install: no packages, no build step.

```powershell
.\start-lab.ps1          # Windows: finds Node, starts on http://127.0.0.1:4400
.\start-lab.ps1 -Demo    # clean start: resets the lab first and opens the browser
```

```bash
npm start                # http://127.0.0.1:4400
npm run demo             # reset to the baseline, start, open the browser
```

`PORT=4500 npm start` changes the port. `HOST=0.0.0.0 npm start` exposes it to your network.

## What is in it

| Page | What it answers |
|---|---|
| **Capacity Planning** | One page for supply and demand, in three views, replacing the two pages (a Central Capacity provider view and a Product Team requester view) that showed the same numbers to two people. **Balance / plan** opens first: are we good for 3, 6 and 12 months? Six KPIs, **supply against demand pool by pool** (a bar per pool with its working ceiling and demand marked, the balance, and the plan that closes the gap), capacity health by region on a world map (an offline outline, no tile service), a demand-versus-capacity forecast, top constraints, critical recommendations, signals, procurement, the action queue, and **Is the plan safe at the busiest hour?** (needs the optional ML profile, see below). **Supply view**: capacity available, pool capacity, utilization, headroom, health and cost, then every pool, the inventory by SKU and the optimization opportunities. **Demand view**: product demand, workload forecast, growth, pipeline, business events and capacity requests, then demand by pool, the dated business events, and below them the request a team asked about (*will it arrive when it is needed?*: an answer line, six KPIs, a recommendation, a chart with the need date called out, a timeline, the team's requests, details, options, cost and risks). One set of filters (horizon, SKU, region) applies to all three; regions and the total are forecast as one combined distribution, not by adding each pool's p80. `GET /api/planning`, `GET /api/overview`, `GET /api/requester`. The old `#/overview` and `#/team` addresses still open the matching view. |
| **Outcome** | The end of the loop. Move the lab's "today" forward (1, 4 or 13 weeks, up to 26 in all), and see what really happened against what was predicted and planned: the demand the plan counted against actual for every pool, the requests, contracts and events that fell due and what became of them, supply that arrived or slipped, what became of the orders you approved, and each plan then and now. `GET /api/outcome`, `POST /api/lab/advance`. |
| **Action Queue** | Every action across the estate, ranked P0 first, with Procurement, Allocation and Other tabs. Also opened from the header Actions button. |
| **Pools** | One pool: the plan, a forecast chart, *why now* (every funnel's effect and evidence), how the order was sized line by line, **options** for the open order (each measured by re-running the plan, with what approving it would need), a what-if panel, and the decision. |
| **Requests** | The request form, and what a product team asks for across the estate: how much of it fits without buying anything, and what changes when you submit one. An optional **About this request** section takes the context the Product Team view shows (organisation, environment, use case, revenue at risk, customer commitment, SLA impact, strategic importance). Anything left blank is shown as "Not stated", never guessed, and the confirmation links to the new request in the Capacity Planning demand view (`#/planning/demand?org=..&request=..`). |
| **Funnels** | The 14 funnels: a card per funnel showing which pools it flags and why, a 14 by 6 matrix, and who owns each data feed. |
| **Ontology** | The seven layers (infrastructure, allocation, utilization, gap and waste, SKU lifecycle, reliability and health, planning horizon): a 7 by 6 matrix of live values, and for a selected pool every value behind each layer, the file it comes from and the funnels that read it. `GET /api/ontology`. |
| **SKU lifecycle** | Active, end-of-life and successor SKUs, and the conversion calculator. |
| **Decisions** | The hash-chained decision log (each record keeps what it was based on), the budget committed and waiting, and which funnels planners dispute. |
| **Lab** | Seven short exercises (crawl, walk, run) with server-verified checkpoints, and six scenarios you can apply to a working copy of the data. |

A **View as** dropdown (Executive, Operations, Engineering) sets how much detail each page shows. The numbers are identical in every view.

### Capacity Planning and its API

Capacity Planning reads three calls, so a screen, a script or a test all read the same numbers. All three take the same filters:

```
GET /api/planning?horizon=13|26|52&sku=all|gpu|compute&region=all|north-america|europe|asia-pacific|latin-america
GET /api/overview?horizon=13|26|52&sku=all|gpu|compute&region=all|north-america|europe|asia-pacific|latin-america
GET /api/actions?category=procurement|allocation|other
```

`/api/planning` is the new one: the six supply figures, the six demand figures (each with its own `definition`, note and unit), a row per pool for supply, demand and the balance, and the dated business events. Nothing in it is a new model: every figure is arithmetic over the same pool assessments as the pool pages, and `test/planning.test.js` pins that it agrees with the Overview (Product demand is the Overview's total demand and the balance's shortfall is its projected shortfall, at every horizon). A pool's balance is its supply at the working ceiling less its demand at the horizon, and a surplus in one pool never covers a shortfall in another. `/api/overview` still serves the chart, constraints, recommendations, inventory and the rest of what the balance and supply views show.

```
GET /api/peak            each pool's plan against its busiest hour (optional: needs the peak profile)
```

A bad filter value is a 400, not a silent fallback. Each KPI carries its own `definition` (the (i) on the card), so the screen never has to guess how a number was made. Total demand, shortfall, reclaim, investment and critical signals always look 12 months ahead; the horizon filter changes the chart and the region health (and so the regions-at-risk count). Every figure is computed per pool from the same verdicts as the pool pages and then summed, so the Overview cannot disagree with them.

**Combining pools.** Each pool plans at p80. A region or the total is *not* the sum of its pools' p80s: for a group to miss at its p80, all its pools would have to miss on the high side together, and pools whose errors do not move together partly cancel. `server/lib/aggregate.js` combines the pools' forecast spreads through how much their week-to-week movements go together (measured, never taken below zero); the dated parts of demand (pipeline, contracts, launches) add exactly. One pool on its own, every pool's own plan, and the shortfall (which stays per pool) are unchanged. On simulated estates the combined p80 covers about 80% of outcomes whether the pools' errors are unrelated or move together, where adding p80s over-covers and assuming the pools are unrelated under-covers when they share shocks (`test/aggregate.test.js`).

**The busiest hour.** The plan is sized on weekly readings, which are means, but capacity has to cover the busiest hour of the week, which runs about 6% above the mean for a flat AI-training pool and about 18% above for a business-hours pool. The peak check plans each pool a second time with the same engine, reading its history as the busiest hour (the weekly mean times a ratio measured from the hourly corpus), and shows the two plans side by side on the Overview and on each pool page, with where the busiest hour sits against the working ceiling now, for how many weeks, and what the hourly model forecasts for next week. It is a check, not a change: nothing on any plan moves, it is not a funnel (there are exactly 14), and whether the working ceiling is meant for the busiest hour is a policy decision for planners. It needs `ml/out/peak_profile.json` (built by `npm run ml`); without it, or if it does not match the dataset, the screens say so and everything else is unchanged.

Where the customer wireframe shows something this lab has no data for, the lab leaves it out rather than inventing it (see Honest limits).

### The planner and the approval rules

```
GET /api/pools/{id}/options                        the options for the open order, and the rule that recommends one
GET /api/pools/{id}/approval?quantity_cu=N         what approving that quantity would need (also on the pool detail)
POST /api/pools/{id}/decision                      approve, decline or defer, as before; now with the rules below
```

**Options** (`server/lib/options.js`). The plan engine recommends one order. The planner turns it into the choices a person can take: order as drafted; phase it (size for half the cover window, offered only when that orders less and the second order would not already be late); order what the budget allows (offered only when the drafted order does not fit); and wait four weeks (shown so its cost is visible, never recommended). Every number is the engine's own: an option that places an order is measured by running the plan again with that order in flight, so its preview is what approving it produces (`test/options.test.js` checks this against a real approval). The recommendation follows a stated rule that is returned with the options and shown on the page: order what closes the gap if the budget allows; if not, the most whole racks it allows, saying what is left; never wait.

**Approval rules** (`server/lib/approval.js`, `policy.json` `approval`). Spend over the budget needs a written reason and is allowed with one. An order costing more than the threshold needs a second, different named person to countersign it: the first approval places nothing and the plan still shows the need; the second person agrees to the same quantity, and only then is the order placed. Declining or deferring withdraws a waiting approval. **The budget ($8.0M) and the threshold ($1.5M) are synthetic, and the lab has no sign-in:** a named person is a name that was typed, and "different" means a different name. This is a control on the record and the workflow, not authentication. The screen asks the same function the write path uses, so what a person is told is what is enforced.

**What a decision keeps** (`server/lib/basis.js`). Each record stores the dataset, the forecast (with a fingerprint of the exact history and settings), a fingerprint of the whole plan, and every funnel's status. The engine refits on every load, so without it the forecast the planner saw could not be recovered afterwards. It is inside the hash chain: editing it breaks the log.

**The AI advisor** (`server/lib/advisor.js`). Its answer is unchanged, and so is the check that every figure in it is in the plan. What it is given has grown: what changed since the last decision or since the lab moved, the options and the rule, what approving would need, the budget, the same plan under two assumptions, what waiting costs, and why this priority. All of it is produced by the engine, the planner and the rules and handed over as strings to copy. It explains; it never ranks or chooses. The ranking is fixed by the engine, and the prompt says so.

### Outcome and feedback: the lab's clock

```
POST /api/lab/advance   {"weeks": 4}     move today forward; returns what arrived, what slipped, what changed
GET  /api/outcome                         the comparison, and how far the lab can still go
```

The engine never reads the wall clock, so moving "today" is a transformation of your working copy of the data (the shipped files are never written), and it is a pure function of the data and the number of weeks: advancing 4 weeks then 4 more is the same as advancing 8, and reset puts today back. `server/lib/clock.js` is the whole of it.

1. **Written down first.** Before the world moves, the lab records for every pool the forecast (with a fingerprint of the data it was fitted on) and the plan as they stand. The engine refits on every load, so without this there would be nothing left to hold the actuals against. It is kept in `runtime/state.json`.
2. **The pools get new readings.** Each pool follows its own recent trend, with a hidden growth surprise between -25% and +35% that the forecast never sees, plus noise as large as its own history.
3. **What falls due becomes usage, or does not.** A pending request goes live with the likelihood it was given, and 60% to 100% of what it asked for shows up, in full, from the week it is needed. A contract takes effect and 70% to 100% of what it still had to add shows up. A demand step from an event happens with the event's confidence; a seasonal spike raises usage while it runs. Whether each happens is drawn from the record's own id, so the plan never sees it and the same record always meets the same fate. Once settled, a request leaves the pipeline (`live` or `lapsed`) and a contract is fully provisioned, so nothing is counted twice. A pool cannot use more than has landed: a full pool reads its capacity and the demand it turned away is reported. The team whose request went live holds what it now uses.
4. **Supply moves.** An approved order is placed on its date. An order that reaches its planned day lands, or slips, by however far the vendor's own delivery history strays from its typical delivery. A landed order adds capacity; a slipped one gets a new date, which is what the plan then sees.
5. **The difference.** Each generated week is held against the demand the plan counted (the forecast with the pipeline, the dated adds and the seasonal spike on top: what the orders were sized for), from the plan recorded most recently before it. The trend model on its own is held against the trend plus the steps that had already happened when the plan was written, and shown beside it. A pool can be close on average and still break out of its p80 band too often; the page says so instead of calling it close.

**What this is not.** The readings are generated, so the loop is real and the accuracy is not evidence about real usage. Which requests go live is drawn, not measured (the salt was chosen once, by a stated rule: see `clock.js`). The clock may move 26 weeks in all. It refuses a scenario, or anything else, that would change what has already happened in the weeks lived through, and a request made after the lab moved counts only from the next reading. **What the forecast can and cannot see.** A step that has happened (a request going live, a contract taking effect) and a seasonal spike that has come and gone are taken out of the history before the forecast is fitted (`server/lib/shifts.js`), so they are not read as growth. It only looks where a record names one, it measures the size from the readings themselves (never from what the lab generated), and it counts one only when it clears 3 noise deviations. So a 466 CU step no longer speeds East US's trend up (89 CU a week against 94 without it; it was 128) and its order rises by one rack (5,184 against 4,800; it was 6,720), the H100 forecast starts at 4,180 for a pool that just read 4,173 (it was 3,635), and a seasonal spike no longer makes a half-used West Europe pool order 6,144 CU. What it cannot do: a step or spike that no record names is still read as growth, a step under about 3 noise deviations is left as noise (East US's 275 CU and 296 CU ones are), and a spike still running counts only the weeks so far. Incidents and feed deliveries are carried forward unchanged in age (the lab invents no new ones). The busiest-hour check switches off once the lab has moved, because its profile was measured on the shipped weeks. The exercises on the Lab page compare with the shipped data, so reset before doing them.

### The Product Team view and its API

```
GET /api/requester?org=contoso&request=REQ-1004&region=all|north-america|europe|asia-pacific|latin-america&horizon=13|26|52
```

Everything is optional. With nothing given it opens on the organisation that has a request at risk, and on that request. A choice that does not exist is a 400 with the valid values. The view adds no model. It is the planner's own request assessment (`server/lib/requests.js`) read for one requester: requests are served in need-by order from free capacity, then idle reservations, then supply already in flight, and what is left needs a new order. That gives a request up to three **phases**: what it can have now, what lands from supply already ordered, and what waits for a new order. The recommendation, the options, the timeline, the cost and the chart's capacity line all read from those phases, so they cannot disagree.

- **At risk** means the part that needs a new order would arrive after the need date. The date is the drafted order's landing date, an order already placed, or a new order placed today.
- **Additional required** is the part of the ask with no capacity today. **Est. cost** is that part at the order SKU's unit cost: a one-off purchase, not an annual figure (the lab has no operating-cost data). Free capacity, idle reservations and supply already ordered are not new spend.
- **Demand** is the team's usage in the pool grown at the pool's p80 forecast, plus the ask from its need date, counted in full (the planner's own view weights it by win probability). The change is against the same forecast fitted 13 weeks ago.
- **Revenue at risk, customer commitment, SLA impact and strategic importance** are what the requester wrote on the request. The lab shows them as stated and never estimates them. The recommendation, options and risks are rules over the plan and the funnels, written out in words; there is no AI confidence percentage because the engine produces none.
- The chart is drawn from a weekly series (`forecast.weekly`) so the ask lands on its need week and capacity steps on each landing week; `forecast.points` has the same values by month for the table.

It follows the lab: apply a scenario, approve an order or submit a request and the view changes with it (`test/requester.test.js`).

## How it works

```
synthetic records (15 JSON files, validated)             OBSERVE
   -> forecast              weekly utilization -> p50, p80 and trend, backtested      FORECAST
   -> planning timeline     demand (forecast + pipeline + dated adds) and capacity (as supply lands), week by week
   -> 14 funnels            each reads its own records and proposes a date, a size or a warning
   -> composition           earliest date wins; lead time from what the vendor really delivers; sizes add up
   -> planning horizon      need becomes an order: less supply in flight, plus buffer, whole racks, costed
   -> options               the planner turns the plan into choices, each measured by re-running the plan
   -> human decision        a named person approves, changes or declines; the engine cannot approve itself;
                            spend over the budget needs a reason; a large order needs a second, different person
   -> action                the order joins the pipeline and the plan updates
   -> outcome, feedback     move today forward: what arrived, what the readings were, forecast against actual
```

- **Deterministic.** The same data always gives the same plan. The engine never reads the wall clock; "today" is `as_of` in `data/meta.json`.
- **One fitted model.** The demand forecast (a straight line or Holt smoothing, chosen by a rolling backtest, planned at p80). The other 13 funnels are rules on a record. There is no LLM in the decision path; an optional one only re-tells the finished plan (see below).
- **Every flagged item is traceable** to the funnel, the records it read and the feed (and owning team) behind it. Stale feeds are marked.
- **The seed data is never modified.** Scenarios, requests and decisions live in `runtime/state.json` on top of it. `npm run reset` deletes that file.

**The contracts between the stages.** Each arrow above has an exact contract, in [docs/CONTRACTS.md](docs/CONTRACTS.md), generated from the code and checked by `test/contracts.test.js`:
- **Input.** Every field the engine reads is declared in `server/lib/validate.js`, including each kind of event, `policy.json`, `meta.json` and `utilization.json`. A missing or impossible value stops the boot and names the file and field. Without this, a missing number became NaN, NaN compared false, and a funnel quietly proposed nothing (a plan lost an event and said "no order needed").
- **Forecast.** A versioned shape (`forecast/1`) and a fingerprint of the exact history and settings, carried on every plan.
- **Planning timeline.** `GET /api/pools/{id}/timeline` returns demand and capacity for weeks 0 to 104. It defines "demand at week h" once, with the three rules the funnels, the plan engine and the fleet views use, and where they differ. `test/fixtures/planning-golden.json` pins every series, so a refactor that moves a number fails.
- **Funnels to plan.** `server/lib/contracts.js` defines the result and the 11 proposal kinds. Every result is checked; a funnel that breaks the contract is shown as "no data" with the reason, and the plan is built from the rest. Before, a mistyped kind was skipped and its date silently dropped out of the plan.

All 14 funnels, what they read and where they flag today are in [docs/FUNNELS.md](docs/FUNNELS.md). The data files are in [docs/DATA.md](docs/DATA.md), with what going live would take. A five-minute walk-through with the live numbers is in [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md).

## AI plain-words explainer (optional)

On any pool page, **In plain words** writes a short summary, the reasons in order, what to watch out for, and a draft of the request to send. It is the only place a language model is used, and it comes **after** the decision: the engine has already fixed every date, quantity, cost and SKU.

- **It cannot change the plan.** It is given the plan's facts as strings to copy, and is told never to round, recompute or suggest a different date, quantity or SKU.
- **Its figures are checked.** Every date, SKU and number in the text must appear in the plan. Text that fails is **withheld** and the rules-based text is shown instead, with the reason. The check confirms a figure exists in the plan; it does not prove it sits in the right sentence, so a planner still reads a draft before sending it.
- **It is optional.** With no key, or if the call fails, times out or answers badly, the same panel writes rules-based text from the same facts. Everything else in the lab works without it.
- **Nothing is sent until you click**, and only that pool's synthetic plan facts. The key stays on the server and is never sent to the browser.

To switch it on, copy `.env.example` to `.env` and set `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` and, if different, `AZURE_OPENAI_CHAT_DEPLOYMENT` (default `gpt-4.1-mini`). Settings already in your environment win over the file. The startup line says whether it is on. `node scripts/try-ai.js` makes one real call from the command line and prints the result.

## Optional: an hourly corpus and a LightGBM forecast

`ml/` holds a two-year, 1-hour data corpus for every pool (generated from this lab's own data, and tied to its weekly readings exactly) and a LightGBM model that forecasts the next week hour by hour across all pools and regions, at p50, p80 and p95. The lab does not read it and needs none of it.

```powershell
npm run ml:setup     # once: a Python virtual environment with LightGBM (needs Python 3.10+)
npm run ml           # generate the corpus, then train and back-test: writes ml/out/report.md
```

See [ml/README.md](ml/README.md) for what is in the corpus and how the model is tested, and `ml/out/report.md` for the results. The corpus is generated, so the results show that the method works, not how well it would forecast a real estate.

## The lab

Open the **Lab** page and start with **Reset lab data**. Each exercise has steps, a "what you should see" line computed from the engine, and a **Check** button. The server verifies from the real state, so the guide cannot drift from the data.

| # | Level | You will |
|--:|---|---|
| 1 | Crawl | Read the answer and name the most urgent pool |
| 2 | Crawl | Trace a decision back to the funnel that set its date |
| 3 | Walk | Change the lead time in the what-if panel |
| 4 | Walk | Inject a customer quota surge and watch the order grow |
| 5 | Walk | Make a half-empty pool urgent with an incident storm |
| 6 | Run | Approve as a named person, change the quantity, meet the guardrails |
| 7 | Run | Reset and return to the baseline |

## Checks

```powershell
npm test                 # data guards, forecast, all 14 funnels, composition, decisions, scenarios, API, docs
npm run verify:ui        # drives headless Chrome or Edge through every page and flow (Node 22+)
npm run verify:ui -- --shots shots    # also saves a screenshot of each page
npm run docs             # regenerates docs/FUNNELS.md, docs/DEMO-SCRIPT.md and docs/CONTRACTS.md from the engine
npm run golden           # rewrites test/fixtures/planning-golden.json: only when a change to the planning numbers is intended
npm run corpus           # regenerates the hourly corpus in ml/corpus/ (npm test checks the files match the code)
npm run worldmap         # redraws the Overview's world outline (web/app/worldmap.js) from scripts/data/ne_110m_land.geojson
node scripts/inspect.js  # prints every pool's verdict; add --pool <id> for the full trace
node scripts/try-ai.js   # one real call to your Azure OpenAI deployment for one pool (needs .env)
```

`npm test` also fails if the generated docs or the seed files drift from the code.

## Layout

```
data/            the synthetic dataset (seed.js regenerates it) and policy.json
server/lib/      engine: forecast, context, funnels (the 14 funnels), verdict, requests, decisions, store;
                 overview.js builds the Overview and the action queue from the verdicts;
                 ontology.js builds the seven layers and their live values per pool;
                 aggregate.js combines pools into regions and a total; peak.js checks each plan against its busiest hour;
                 geo.js is the map projection that draws the outline and places each region's dot;
                 explain.js and env.js are the optional AI explainer and its settings
server/app.js    HTTP routes (node:http only)
web/             the UI: AngularJS 1.8 (vendored), Fluent 2 tokens, inline-SVG chart, no build step
test/            node:test suites
scripts/         seed, reset, demo, inspect, docs generator, UI verifier, ml launcher
docs/            FUNNELS.md and DEMO-SCRIPT.md (generated), DATA.md
ml/              optional: the hourly corpus generator and LightGBM forecast (Node and Python, self-contained)
```

## Honest limits

- The data is synthetic and the policy values (floors, buffers, unit costs) are illustrative. Nothing has been calibrated against real planners' decisions.
- Six pools, one date. It shows the method, not a fleet.
- The forecast is only as good as 52 weeks of history; the backtest is reported on the pool page, not hidden.
- The Overview follows the customer wireframe, but every figure is this lab's own synthetic data, not the mockup's. Where the lab has no data it says so instead of inventing: four regions (no Middle East pools), no confidence percentage (the engine does not produce one), no disaster-recovery figure (effective capacity is provisioned times the working ceiling), GPU and Compute inventory only (no storage or networking), a simple world outline with a dot per region rather than a street map, no "last 12 weeks" filter, no Methodology or Settings page.
- Governance is illustrated, not enforced against real identity. The budget and the second-approver threshold are synthetic numbers with no budget system behind them, "who approved" is a typed name, and there are no roles: anyone can be the second person if their name differs. The options are four fixed shapes (as drafted, phased, fit the budget, wait) over one order; they are not a search across SKUs, vendors or regions. "Wait" uses the plan's own dates and does not use the lab's generated future, which no plan may see.
- The Product Team (Requester) view is its own page and follows a wireframe too. It shows no AI confidence percentage (its recommendation is rules over the plan, and says so), and its cost is a one-off purchase cost, not an annual or monthly run-rate, because the lab has no operating-cost data. Current usage has no "vs last month" change (no team usage history is kept); demand is compared with the forecast as it stood a quarter ago. Revenue at risk, customer commitment, SLA impact and strategic importance are what the requester wrote, never estimated. Whether a workload can run in another region is not known, so those options say so. A request needs an organisation to be grouped under; without one it is filed under the first word of its team name.
- The peak check's ratios and next-week forecast come from a generated hourly corpus, so they show what the method would do, not what a real estate's busiest hour looks like. It also assumes installed capacity was constant over the history.
- Combining pools measures how much their weekly movements go together from 51 weekly movements per pool; on this estate the pools are nearly unrelated, so the combined total is only about 2% below adding the p80s. The saving grows with more, and more independent, pools.
- "vs last quarter" is not a stored history. It refits the forecast as of 13 weeks ago and holds every other record constant, and each card says so.
- The AI explainer's figures check is token-level: it catches an invented date, SKU or number, not a real number in the wrong sentence.
- The lab does not route work to the teams that own each feed. It shows who owns each input; it does not hand anything to them.
- It measures nothing about time saved. There is no before-and-after data to support a claim like "this used to take weeks".
- Accepting real data is a deliberate change (see docs/DATA.md), not a setting.

## Origin

This is a fresh build from the engineering requirements (14 funnels, seven-layer ontology, planning horizon, synthetic-only data, multi-audience dashboard), with the Overview reshaped to the customer's Central Capacity (Provider) wireframe. It is not a copy of any earlier prototype.
