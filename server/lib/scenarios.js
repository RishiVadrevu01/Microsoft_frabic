'use strict';
// Lab scenarios: named, reversible changes to a working COPY of the data.
// The seed files are never touched. Applying a scenario just adds its id to the
// lab state; the working data is rebuilt from seed + scenarios in order.

const { addDays } = require('./dates');

const P = {
  eus: 'pool-eastus-01-intel-icx',
  weuAmd: 'pool-westeurope-01-amd-genoa',
  weuGpu: 'pool-westeurope-02-gpu-h100',
  sea: 'pool-southeastasia-01-amd-genoa',
  jpe: 'pool-japaneast-01-gpu-l40s',
};

const SCENARIOS = [
  {
    id: 'quota-surge-eastus',
    title: 'Customer quota surge in East US',
    pool_id: P.eus,
    story: 'Three large customers ask for capacity in the same quarter. Each request looks reasonable on its own; together they outrun the plan.',
    expect: 'The order grows and the pool stays overdue: the pipeline adds demand that utilization cannot see yet.',
    apply(raw) {
      const add = (n, team, title, cu, needed_by, win, source, priority) => raw.requests.push({
        request_id: `REQ-90${n}`, team, title, pool_id: P.eus, cu, needed_by, win_probability: win, source, priority, workload: 'analytics', status: 'pending',
      });
      add('01', 'fabrikam-data-platform', 'Fabrikam data platform launch', 900, '2026-11-30', 0.85, 'onboarding-queue', 'high');
      add('02', 'northwind-analytics', 'Northwind analytics estate', 700, '2026-12-21', 0.8, 'sales-pipeline', 'high');
      add('03', 'adatum-lakehouse', 'Adatum lakehouse move', 600, '2027-01-18', 0.75, 'sales-pipeline', 'medium');
    },
  },
  {
    id: 'incident-storm-weu',
    title: 'Incident storm on a healthy pool',
    pool_id: P.weuAmd,
    story: 'West Europe AMD is half empty, so utilization says all is well. Then one fabric segment starts failing.',
    expect: 'A pool that was OK now needs a replacement order, even though its headroom did not change.',
    apply(raw) {
      const sku = raw.pools.find((p) => p.pool_id === P.weuAmd).sku_id;
      const rows = [[1, 5, 8.5, 'Storage fabric brownout'], [1, 14, 10, 'Top-of-rack switch cascade'], [2, 8, 6, 'Packet loss between racks'],
        [2, 20, 5.5, 'Repeated node fencing'], [2, 31, 6.5, 'Firmware rollback'], [3, 11, 3, 'Cooling alarm'], [3, 26, 4, 'Disk failure burst'],
        [3, 38, 3, 'Slow boot on new nodes'], [4, 17, 1, 'Telemetry agent crash']];
      rows.forEach(([sev, daysAgo, mttr, title], i) => raw.incidents.push({
        incident_id: `INC-90${i + 1}`, pool_id: P.weuAmd, sku_id: sku, fabric_segment: 'weu-fabric-2', severity: sev,
        opened_on: addDays(raw.as_of, -daysAgo), mttr_hours: mttr, title,
      }));
    },
  },
  {
    id: 'vendor-delay-amd',
    title: 'AMD deliveries slip',
    pool_id: P.sea,
    story: 'The vendor that builds every AMD pool starts missing its quoted dates.',
    expect: 'Lead time grows for all AMD pools, so every raise-by date moves earlier and several pools change state.',
    apply(raw) {
      const v = raw.vendors.find((x) => x.vendor_id === 'vendor-northwind');
      v.observed_lead_weeks = [21, 23, 25, 24, 26, 27];
      v.risk_score = 0.7;
    },
  },
  {
    id: 'contract-pulled-forward-weu-gpu',
    title: 'A GPU contract is pulled forward',
    pool_id: P.weuGpu,
    story: 'The enterprise agreement for the H100 pool now starts more than two months earlier and commits 400 CU more.',
    expect: 'The contract stays the funnel that sets the date, but the date moves up so far that the order is now overdue: a contract is a hard trigger.',
    apply(raw) {
      const c = raw.contracts.find((x) => x.contract_id === 'CON-0203');
      c.effective_date = '2026-12-07';
      c.committed_cu = 2000;
    },
  },
  {
    id: 'launch-spike-japan',
    title: 'Launch expected to be twice as big',
    pool_id: P.jpe,
    story: 'Marketing revises the AI Summit forecast: the inference spike is now expected to be about 90% above normal.',
    expect: 'The temporary buffer for the launch roughly doubles.',
    apply(raw) {
      raw.events.find((e) => e.event_id === 'EVT-S01').uplift_pct = 0.9;
    },
  },
  {
    id: 'tenant-without-a-request-weu',
    title: 'A tenant moves in with no request on file',
    pool_id: P.weuAmd,
    story: 'A team starts using West Europe AMD without ever filing a request: about 900 CU of new usage appears on 9 November, and nothing in any record says why.',
    expect: 'Nothing changes today, because nothing in the records says it is coming. Advance the lab past 9 November and it shows up in the readings; about four weeks later the forecast finds the jump in the readings themselves and lifts its level.',
    apply(raw) {
      raw.unrecorded = [...(raw.unrecorded || []), { id: 'UNR-9001', pool_id: P.weuAmd, date: '2026-11-09', cu: 900, title: 'A tenant that never filed a request' }];
    },
  },
  {
    id: 'reclaim-sweep-weu',
    title: 'Execute the reclaim sweep in West Europe',
    pool_id: P.weuAmd,
    story: 'The planner reclaims the idle reservations the cost funnel has been pointing at.',
    expect: 'Idle reservations shrink to what teams really use; free capacity grows and the reclaim value falls to zero.',
    apply(raw) {
      for (const a of raw.allocations) {
        if (a.pool_id === P.weuAmd && a.low_use_weeks > 0) {
          a.allocated_units = Math.round((a.utilized_units * 1.25) / 10) * 10;
          a.low_use_weeks = 0;
        }
      }
    },
  },
];

const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

function apply(id, raw) {
  const s = byId[id];
  if (!s) throw new Error(`Unknown scenario ${id}`);
  s.apply(raw);
}

const list = () => SCENARIOS.map(({ id, title, pool_id, story, expect }) => ({ id, title, pool_id, story, expect }));

module.exports = { SCENARIOS, apply, list, has: (id) => Boolean(byId[id]) };
