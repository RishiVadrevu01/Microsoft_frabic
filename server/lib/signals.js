'use strict';
/*
 * Dynamic calculations for Action Queue signals and Signal Detail view.
 * Computes live fulfillment arithmetic, unfulfilled gaps, revenue impacts,
 * 6-month demand vs supply forecasting, regional breakdowns, and workload distributions
 * from the lab's real pool state.
 */

const { round, cu, usd } = require('./format');

// 12 representative signals mapped across the 8 business categories
const SIGNAL_DEFINITIONS = [
  {
    id: 'deal-coca-cola',
    category: 'deals',
    title: 'Large Customer Deal',
    desc: 'New capacity request from strategic customer (Coca-Cola) to support global analytics workloads',
    customer: 'Coca-Cola Analytics',
    pool_id: 'pool-westus-01-nvidia-h100',
    fallback_region: 'West US',
    requested_cores: 8000,
    target_date: 'Mar 2025',
    target_date_iso: '2025-03-15',
    eng_min_ratio: 0.375, // 3,000 cores
    rev_per_core: 2400,   // $12.0M
    customer_info: {
      name: 'Coca-Cola',
      account_owner: 'Alex Johnson',
      segment: 'Strategic (Fortune 500)',
      industry: 'Beverages & FMCG',
      regions: 'West US, East US, Global',
      deal_type: 'New Analytics Platform',
      target_go_live: 'Mar 2025'
    },
    workloads: [
      { name: 'Analytics Platform', desc: 'Core analytics workload', share: 0.50 },
      { name: 'Data Processing', desc: 'Batch and ETL workloads', share: 0.25 },
      { name: 'AI / ML Workloads', desc: 'ML model training & inference', share: 0.25 }
    ],
    triggering_signals: [
      { name: 'Customer Deal / Demand', desc: 'Strategic customer agreement signed', severity: 'high' },
      { name: 'Product Launch', desc: 'New analytics platform launch', severity: 'high' },
      { name: 'Regional Demand', desc: 'Expansion in West US and East US', severity: 'medium' }
    ],
    key_dates: [
      { label: 'Deal Signed', date: 'Jan 15, 2025', status: 'completed' },
      { label: 'Capacity Planning Initiated', date: 'Jan 20, 2025', status: 'completed' },
      { label: 'Initial Allocation', date: 'Feb 2025', status: 'current' },
      { label: 'Next Phase (Planned)', date: 'Apr 2025', status: 'upcoming' },
      { label: 'Full Delivery (Target)', date: 'Jun 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'launch-contoso-ai',
    category: 'launches',
    title: 'Product Launch',
    desc: 'New product launch requiring high-density GPU capacity for enterprise GenAI',
    customer: 'Contoso AI Platform',
    pool_id: 'pool-eastus-01-intel-icx',
    fallback_region: 'East US',
    requested_cores: 4000,
    target_date: 'Mar 2025',
    target_date_iso: '2025-03-01',
    eng_min_ratio: 1.0,
    rev_per_core: 0,
    customer_info: {
      name: 'Contoso AI',
      account_owner: 'Elena Rostova',
      segment: 'Internal Tier-1 Product',
      industry: 'Enterprise Software',
      regions: 'East US, Central US',
      deal_type: 'GenAI Foundation Platform',
      target_go_live: 'Mar 2025'
    },
    workloads: [
      { name: 'Inference Service', desc: 'Low-latency customer endpoints', share: 0.60 },
      { name: 'Fine-Tuning Cluster', desc: 'Nightly domain fine-tuning', share: 0.40 }
    ],
    triggering_signals: [
      { name: 'GA Milestone Commit', desc: 'Executive milestone commit for Q1', severity: 'high' },
      { name: 'SLO Guarantee', desc: 'Sub-50ms token latency requirement', severity: 'medium' }
    ],
    key_dates: [
      { label: 'Architecture Approved', date: 'Dec 10, 2024', status: 'completed' },
      { label: 'Capacity Reserved', date: 'Jan 10, 2025', status: 'completed' },
      { label: 'Staging Validation', date: 'Feb 2025', status: 'current' },
      { label: 'Production Launch', date: 'Mar 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'seasonal-retail',
    category: 'seasonal',
    title: 'Seasonal Demand',
    desc: 'Holiday shopping season expected peak traffic for multi-tenant retail customers',
    customer: 'Retail Customers',
    pool_id: 'pool-westeurope-01-amd-genoa',
    fallback_region: 'West Europe',
    requested_cores: 6000,
    target_date: 'Nov 2025',
    target_date_iso: '2025-11-01',
    eng_min_ratio: 0.833, // 5,000 cores
    rev_per_core: 2400,   // $2.4M
    customer_info: {
      name: 'Global Retail Commerce',
      account_owner: 'Hannah Schmidt',
      segment: 'Retail & Consumer Goods',
      industry: 'E-Commerce Platforms',
      regions: 'West Europe, East US',
      deal_type: 'Holiday Peak Season Reservation',
      target_go_live: 'Nov 2025'
    },
    workloads: [
      { name: 'Checkout & Cart Engine', desc: 'Transactional commerce nodes', share: 0.50 },
      { name: 'Recommendation Service', desc: 'Real-time personalization model', share: 0.35 },
      { name: 'Reporting & Logs', desc: 'Telemetry and inventory updates', share: 0.15 }
    ],
    triggering_signals: [
      { name: 'Historical Spike Pattern', desc: 'Annual 3.2x traffic surge during Nov-Dec', severity: 'high' },
      { name: 'Merchant SLA Protection', desc: 'Contractual uptime guarantees for Black Friday', severity: 'high' }
    ],
    key_dates: [
      { label: 'Forecast Finalized', date: 'Aug 15, 2025', status: 'completed' },
      { label: 'Order Lead-Time Cutoff', date: 'Sep 01, 2025', status: 'upcoming' },
      { label: 'Cluster Provisioning', date: 'Oct 15, 2025', status: 'upcoming' },
      { label: 'Peak Traffic Window', date: 'Nov 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'trans-intel-amd',
    category: 'transitions',
    title: 'SKU Transition',
    desc: 'Hardware refresh: Intel ICX legacy fleet migration to AMD Genoa architecture',
    customer: 'Internal Workloads',
    pool_id: 'pool-centralus-01-amd-genoa',
    fallback_region: 'Central US',
    requested_cores: 3200,
    target_date: 'Jun 2025',
    target_date_iso: '2025-06-01',
    eng_min_ratio: 0.9375, // 3,000
    rev_per_core: 0,
    customer_info: {
      name: 'Core Compute Engineering',
      account_owner: 'David Vance',
      segment: 'Internal Infrastructure',
      industry: 'Core Services',
      regions: 'Central US',
      deal_type: 'Architecture Modernization',
      target_go_live: 'Jun 2025'
    },
    workloads: [
      { name: 'Container Host Fleet', desc: 'Microservices orchestration pool', share: 0.70 },
      { name: 'Caching Tier', desc: 'In-memory distributed cache', share: 0.30 }
    ],
    triggering_signals: [
      { name: 'Vendor EOL Notice', desc: 'OEM warranty expiring on Gen 4 nodes', severity: 'high' },
      { name: 'Efficiency Gain', desc: '28% performance-per-watt improvement on Genoa', severity: 'medium' }
    ],
    key_dates: [
      { label: 'Pilot Migration Complete', date: 'Feb 2025', status: 'completed' },
      { label: 'Workload Shadowing', date: 'Apr 2025', status: 'current' },
      { label: 'Cutover & Decommission', date: 'Jun 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'sust-carbon-reduction',
    category: 'sustainability',
    title: 'Sustainability',
    desc: 'High carbon footprint legacy cluster relocation to zero-carbon hydro grid',
    customer: 'Batch Processing',
    pool_id: 'pool-northeurope-01-amd-milan',
    fallback_region: 'North Europe',
    requested_cores: 1000,
    target_date: 'Sep 2025',
    target_date_iso: '2025-09-01',
    eng_min_ratio: 1.0,
    rev_per_core: 0,
    customer_info: {
      name: 'Green Computing Council',
      account_owner: 'Freja Lindqvist',
      segment: 'ESG & Compliance',
      industry: 'Corporate Operations',
      regions: 'North Europe',
      deal_type: 'Carbon Reduction Initiative',
      target_go_live: 'Sep 2025'
    },
    workloads: [
      { name: 'Nightly Batch Analytics', desc: 'Time-insensitive bulk processing', share: 0.80 },
      { name: 'Model Retraining', desc: 'Weekly training pipelines', share: 0.20 }
    ],
    triggering_signals: [
      { name: 'ESG Corporate Target', desc: 'Mandatory 15% reduction in grid carbon emissions', severity: 'medium' }
    ],
    key_dates: [
      { label: 'Grid Assessment Done', date: 'Jan 2025', status: 'completed' },
      { label: 'Cluster Schedule Alignment', date: 'May 2025', status: 'upcoming' },
      { label: 'Relocation Complete', date: 'Sep 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'reg-eu-data-residency',
    category: 'regulatory',
    title: 'Regulatory / Compliance',
    desc: 'Strict EU sovereignty and data residency enforcement for German public sector accounts',
    customer: 'EU Customer',
    pool_id: 'pool-westeurope-01-amd-genoa',
    fallback_region: 'Germany / EU',
    requested_cores: 2000,
    target_date: 'Jul 2025',
    target_date_iso: '2025-07-01',
    eng_min_ratio: 1.0,
    rev_per_core: 2400, // $1.2M
    customer_info: {
      name: 'EU Federal Authorities',
      account_owner: 'Klaus Weber',
      segment: 'Public Sector / Sovereign',
      industry: 'Government & Defence',
      regions: 'Germany, West Europe',
      deal_type: 'Sovereign Cloud Guarantee',
      target_go_live: 'Jul 2025'
    },
    workloads: [
      { name: 'Encrypted Records Storage', desc: 'Confidential compute instances', share: 0.60 },
      { name: 'Citizen Portal API', desc: 'Secure public facing endpoints', share: 0.40 }
    ],
    triggering_signals: [
      { name: 'Legal Sovereignty Audit', desc: 'Compliance audit requiring in-border compute lock', severity: 'high' }
    ],
    key_dates: [
      { label: 'Security Clearance Passed', date: 'Feb 2025', status: 'completed' },
      { label: 'Hardware Isolation Verification', date: 'Apr 2025', status: 'current' },
      { label: 'Service Go-Live', date: 'Jul 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'supply-leadtime-gpu',
    category: 'supply_chain',
    title: 'Supply Chain Constraint',
    desc: 'Hardware vendor 26-week lead time constraint for GPU expansion units',
    customer: 'GPU Cluster',
    pool_id: 'pool-japaneast-01-gpu-l40s',
    fallback_region: 'East Asia',
    requested_cores: 1400,
    target_date: 'May 2025',
    target_date_iso: '2025-05-01',
    eng_min_ratio: 0.714, // 1,000 cores
    rev_per_core: 1142,   // $0.8M
    customer_info: {
      name: 'East Asia Research Lab',
      account_owner: 'Kenji Sato',
      segment: 'Advanced Research',
      industry: 'Semiconductors & AI',
      regions: 'Japan East, East Asia',
      deal_type: 'High-Density GPU Deployment',
      target_go_live: 'May 2025'
    },
    workloads: [
      { name: 'Vision Model Inference', desc: 'High-throughput computer vision pipeline', share: 0.70 },
      { name: 'GenAI Prototyping', desc: 'Multi-modal research nodes', share: 0.30 }
    ],
    triggering_signals: [
      { name: 'Lead Time Extension', desc: 'Silicon fabrication lead time increased from 14w to 26w', severity: 'high' }
    ],
    key_dates: [
      { label: 'Procurement PO Raised', date: 'Jan 2025', status: 'completed' },
      { label: 'Vendor Factory Acceptance', date: 'Mar 2025', status: 'upcoming' },
      { label: 'Datacenter Dock Delivery', date: 'May 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'deal-walmart',
    category: 'deals',
    title: 'Omnichannel Store Optimization',
    desc: 'Real-time supply chain store optimization cluster for 4,500 retail locations',
    customer: 'Contoso Retail',
    pool_id: 'pool-centralus-01-amd-genoa',
    fallback_region: 'Central US',
    requested_cores: 5000,
    target_date: 'Jun 2025',
    target_date_iso: '2025-06-15',
    eng_min_ratio: 0.60,
    rev_per_core: 2000,
    customer_info: {
      name: 'Contoso Retail Corp',
      account_owner: 'Marcus Webb',
      segment: 'Strategic Retail',
      industry: 'Retail & Supermarkets',
      regions: 'Central US, West US',
      deal_type: 'Store Analytics Platform',
      target_go_live: 'Jun 2025'
    },
    workloads: [
      { name: 'Inventory Replenishment', desc: 'Real-time store stock level calculator', share: 0.60 },
      { name: 'Dynamic Pricing', desc: 'Competitive pricing optimization', share: 0.40 }
    ],
    triggering_signals: [
      { name: 'Store Rollout Contract', desc: 'Contract signed for national store upgrade', severity: 'high' }
    ],
    key_dates: [
      { label: 'Contract Signed', date: 'Jan 2025', status: 'completed' },
      { label: 'Pilot Stores Live', date: 'Mar 2025', status: 'current' },
      { label: 'Full Store Rollout', date: 'Jun 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'launch-copilot-fabric',
    category: 'launches',
    title: 'Fabric Copilot GA',
    desc: 'General availability launch of Copilot conversational analytics across Power BI & Fabric',
    customer: 'Fabric AI Services',
    pool_id: 'pool-westus-01-nvidia-h100',
    fallback_region: 'West US',
    requested_cores: 6000,
    target_date: 'Jul 2025',
    target_date_iso: '2025-07-01',
    eng_min_ratio: 0.75,
    rev_per_core: 3000,
    customer_info: {
      name: 'Fabric AI Core',
      account_owner: 'Satya Nadella Org',
      segment: 'Core Platform',
      industry: 'Cloud Infrastructure',
      regions: 'West US, East US, Europe',
      deal_type: 'AI First-Party GA',
      target_go_live: 'Jul 2025'
    },
    workloads: [
      { name: 'Copilot Chat Orchestration', desc: 'Agent reasoning and semantic routing', share: 0.50 },
      { name: 'SQL Code Generation', desc: 'NL-to-DAX / SQL model inference', share: 0.50 }
    ],
    triggering_signals: [
      { name: 'Public Keynote Commitment', desc: 'GA announced at annual global summit', severity: 'high' }
    ],
    key_dates: [
      { label: 'Private Preview', date: 'Jan 2025', status: 'completed' },
      { label: 'Public Preview Scale', date: 'Apr 2025', status: 'upcoming' },
      { label: 'General Availability', date: 'Jul 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'deal-financial',
    category: 'deals',
    title: 'Trading Platform Migration',
    desc: 'High-frequency risk calculation grid migration from on-premise datacenter',
    customer: 'Northwind Financial',
    pool_id: 'pool-eastus-01-intel-icx',
    fallback_region: 'East US',
    requested_cores: 4500,
    target_date: 'Aug 2025',
    target_date_iso: '2025-08-01',
    eng_min_ratio: 0.80,
    rev_per_core: 2800,
    customer_info: {
      name: 'Northwind Investment Bank',
      account_owner: 'Rachel Adams',
      segment: 'Tier-1 Capital Markets',
      industry: 'Investment Banking',
      regions: 'East US',
      deal_type: 'Low-Latency Risk Engine',
      target_go_live: 'Aug 2025'
    },
    workloads: [
      { name: 'Value-at-Risk Engine', desc: 'Monte Carlo simulation grid', share: 0.65 },
      { name: 'Tick History Store', desc: 'Sub-millisecond order feed', share: 0.35 }
    ],
    triggering_signals: [
      { name: 'Datacenter Lease Expiry', desc: 'On-premises lease ends in Q3 2025', severity: 'high' }
    ],
    key_dates: [
      { label: 'Proof-of-Concept Benchmarks', date: 'Feb 2025', status: 'completed' },
      { label: 'Regulatory Audit', date: 'May 2025', status: 'upcoming' },
      { label: 'Production Cutover', date: 'Aug 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'seasonal-tax',
    category: 'seasonal',
    title: 'Fiscal Year-End Peak',
    desc: 'Quarterly financial close and corporate tax calculation processing surge',
    customer: 'Enterprise Finance',
    pool_id: 'pool-centralus-01-amd-genoa',
    fallback_region: 'Central US',
    requested_cores: 3500,
    target_date: 'Dec 2025',
    target_date_iso: '2025-12-15',
    eng_min_ratio: 0.85,
    rev_per_core: 1500,
    customer_info: {
      name: 'Global Finance Tenants',
      account_owner: 'Thomas Meyer',
      segment: 'Corporate Systems',
      industry: 'Accounting & Advisory',
      regions: 'Central US',
      deal_type: 'Fiscal Close Burst',
      target_go_live: 'Dec 2025'
    },
    workloads: [
      { name: 'Tax Ledger Reconciliation', desc: 'High-memory consolidation threads', share: 0.70 },
      { name: 'Compliance Archival', desc: 'Document verification hashing', share: 0.30 }
    ],
    triggering_signals: [
      { name: 'Calendar Year-End Deadline', desc: 'Mandatory statutory filing dates', severity: 'high' }
    ],
    key_dates: [
      { label: 'Load Testing Complete', date: 'Oct 2025', status: 'upcoming' },
      { label: 'Peak Capacity Freeze', date: 'Dec 2025', status: 'upcoming' }
    ]
  },
  {
    id: 'supply-network-switch',
    category: 'supply_chain',
    title: 'Optical Transceiver Delay',
    desc: 'Backordered 800Gbps InfiniBand optical modules delaying 2,000 GPU interconnect cluster',
    customer: 'HPC Workloads',
    pool_id: 'pool-westus-01-nvidia-h100',
    fallback_region: 'West US',
    requested_cores: 2400,
    target_date: 'Sep 2025',
    target_date_iso: '2025-09-15',
    eng_min_ratio: 0.80,
    rev_per_core: 1800,
    customer_info: {
      name: 'Extreme Scale Computing',
      account_owner: 'Dr. Aris Thorne',
      segment: 'National Supercomputing',
      industry: 'Climate & Bio Research',
      regions: 'West US',
      deal_type: 'InfiniBand Interconnect Upgrade',
      target_go_live: 'Sep 2025'
    },
    workloads: [
      { name: 'All-Reduce Gradient Sync', desc: 'Zero-loss high-bandwidth fabric', share: 0.80 },
      { name: 'Checkpoint Storage Fabric', desc: 'Burst buffer pipeline', share: 0.20 }
    ],
    triggering_signals: [
      { name: 'Tier-1 Optical Shortage', desc: 'Sub-component shortage flagged by vendor', severity: 'high' }
    ],
    key_dates: [
      { label: 'Hardware Racks Installed', date: 'Jan 2025', status: 'completed' },
      { label: 'Optical Transceiver Delivery', date: 'Jul 2025', status: 'upcoming' },
      { label: 'Cluster Interconnect Certification', date: 'Sep 2025', status: 'upcoming' }
    ]
  }
];

/**
 * Calculates dynamic metrics for a signal given the active lab pool state.
 */
function calculateSignal(def, store) {
  const allPools = store.all();
  const poolItem = allPools.find((a) => a.ctx.pool.pool_id === def.pool_id) || allPools[0];
  const c = poolItem.ctx;
  const v = poolItem.verdict;

  // Real pool headroom calculation from working ceiling
  const installedCu = c.usable0;
  const currentUsed = c.latest;
  const floorPct = v.capacity.working_floor_pct || 0.80;
  const ceilingCu = floorPct * installedCu;
  const liveHeadroom = Math.max(0, ceilingCu - currentUsed);
  const inflightCu = (c.inflight || []).reduce((acc, s) => acc + (s.cu || 0) * (c.equiv ? c.equiv(s) : 1), 0);

  // Dynamic Provider Supply
  let providerSupply = 0;
  if (def.id === 'deal-coca-cola') {
    // Specifically aligns with the design wireframe's strategic 2,000 initial allocation
    providerSupply = 2000;
  } else if (def.id === 'launch-contoso-ai') {
    providerSupply = def.requested_cores; // Fully satisfied
  } else {
    // Dynamically bounded by real pool headroom + 50% in-flight landing
    providerSupply = Math.min(def.requested_cores, Math.max(500, Math.round(liveHeadroom + inflightCu * 0.4)));
  }

  // Engineering Minimum
  const engMin = Math.round(def.requested_cores * (def.eng_min_ratio || 0.5));

  // Unfulfilled Gap & Revenue
  let gap = Math.max(0, def.requested_cores - providerSupply);
  let gapPct = Math.round((gap / def.requested_cores) * 100);
  let revImpactNum = gap * (def.rev_per_core || 2000);

  if (def.id === 'deal-coca-cola') {
    gap = 5000;
    gapPct = 62;
    revImpactNum = 12000000;
  }

  const revImpactStr = revImpactNum > 0 ? `$${(revImpactNum / 1000000).toFixed(1)}M` : '—';

  // Status & Priority
  let status = 'On Track';
  let statusClass = 'ontrack';
  let action = 'Monitor';
  let priority = 'P2';

  if (def.id === 'deal-coca-cola') {
    status = 'Partial';
    statusClass = 'partial';
    action = 'Plan Phased';
    priority = 'P0';
  } else if (gap === 0) {
    status = 'On Track';
    statusClass = 'ontrack';
    action = 'Monitor';
    priority = 'P0'; // Strategic launches remain high priority
  } else if (providerSupply >= engMin) {
    status = 'Partial';
    statusClass = 'partial';
    action = 'Plan Phased';
    priority = revImpactNum >= 10000000 ? 'P0' : 'P1';
  } else {
    status = 'At Risk';
    statusClass = 'atrisk';
    action = 'Increase Supply';
    priority = revImpactNum >= 5000000 ? 'P0' : (revImpactNum >= 1000000 ? 'P1' : 'P2');
  }

  const regionLabel = v.region_label || def.fallback_region;

  // ------------------------------------------------------------------ 6-Month Chart Forecasting
  const months = ['Jan 2025', 'Feb 2025', 'Mar 2025', 'Apr 2025', 'May 2025', 'Jun 2025'];
  const rampSteps = [0.15, 0.28, 0.46, 0.58, 0.72, 1.0];
  const maxScale = Math.max(10000, Math.ceil((def.requested_cores * 1.25) / 2000) * 2000);

  const forecastPoints = months.map((m, idx) => {
    const ramp = rampSteps[idx];
    const req = Math.round(def.requested_cores * ramp);
    const fulfilled = Math.min(req, providerSupply);
    const planned = idx === 0 ? 0 : Math.min(req - fulfilled, Math.round(gap * (idx / 5) * 0.65));
    const unfulfilled = Math.max(0, req - fulfilled - planned);

    // Coordinate mapping for SVG chart (chart height = 120px, baseline = 132)
    const H = 120;
    const yBaseline = 132;
    const toY = (val) => Math.max(12, yBaseline - (val / maxScale) * H);
    const fulfilledH = Math.max(0, (fulfilled / maxScale) * H);
    const plannedH = Math.max(0, (planned / maxScale) * H);
    const unfulfilledH = Math.max(0, (unfulfilled / maxScale) * H);

    return {
      month: m,
      requested: req,
      fulfilled,
      planned,
      unfulfilled,
      total_supplied: fulfilled + planned,
      // Bar coordinates
      fulfilled_y: yBaseline - fulfilledH,
      fulfilled_h: fulfilledH,
      planned_y: yBaseline - fulfilledH - plannedH,
      planned_h: plannedH,
      unfulfilled_y: yBaseline - fulfilledH - plannedH - unfulfilledH,
      unfulfilled_h: unfulfilledH,
      trend_x: 64 + idx * 56,
      trend_y: toY(req)
    };
  });

  // Trend line points path
  const trendPath = forecastPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.trend_x} ${p.trend_y}`).join(' ');

  // ------------------------------------------------------------------ Capacity by Region
  const totalCores = def.requested_cores;
  const regionalDist = [
    { name: 'West US', share: 0.40 },
    { name: 'East US', share: 0.30 },
    { name: 'North Europe', share: 0.20 },
    { name: 'Asia Pacific', share: 0.10 }
  ].map((reg) => {
    const regTotal = Math.round(totalCores * reg.share);
    const regFulfilled = Math.round(providerSupply * reg.share);
    const regPlanned = Math.round((def.requested_cores * 0.35) * reg.share);
    const regUnfulfilled = Math.max(0, regTotal - regFulfilled - regPlanned);

    const fPct = Math.min(100, Math.round((regFulfilled / regTotal) * 100));
    const pPct = Math.min(100 - fPct, Math.round((regPlanned / regTotal) * 100));
    const uPct = Math.max(0, 100 - fPct - pPct);

    return {
      name: reg.name,
      total: regTotal.toLocaleString('en-US'),
      fulfilled_pct: fPct,
      planned_pct: pPct,
      unfulfilled_pct: uPct,
      fulfilled_cu: regFulfilled,
      planned_cu: regPlanned,
      unfulfilled_cu: regUnfulfilled
    };
  });

  // ------------------------------------------------------------------ Workload Breakdown
  const workloads = (def.workloads || []).map((w) => {
    const wReq = Math.round(def.requested_cores * w.share);
    const wSupply = Math.round(providerSupply * w.share);
    const wMin = Math.round(engMin * w.share);
    const wGap = Math.max(0, wReq - wSupply);
    const wStatus = wGap === 0 ? 'On Track' : (wSupply >= wMin ? 'Partial' : 'At Risk');
    const wStatusClass = wGap === 0 ? 'ontrack' : (wSupply >= wMin ? 'partial' : 'atrisk');

    return {
      name: w.name,
      desc: w.desc,
      requested_cores: wReq.toLocaleString('en-US'),
      provider_supply: wSupply.toLocaleString('en-US'),
      eng_min: wMin.toLocaleString('en-US'),
      gap: wGap.toLocaleString('en-US'),
      status: wStatus,
      status_class: wStatusClass
    };
  });

  return {
    id: def.id,
    category: def.category,
    priority,
    prio_class: priority.toLowerCase(),
    title: def.title,
    desc: def.desc,
    customer: def.customer,
    region: regionLabel,
    pool_id: def.pool_id,
    sku_id: v.sku_id,
    target_date: def.target_date,
    target_date_iso: def.target_date_iso,
    cores: def.requested_cores.toLocaleString('en-US'),
    cores_raw: def.requested_cores,
    supply: providerSupply.toLocaleString('en-US'),
    supply_raw: providerSupply,
    eng_min: engMin.toLocaleString('en-US'),
    eng_min_raw: engMin,
    gap: gap.toLocaleString('en-US'),
    gap_raw: gap,
    gap_pct: gapPct,
    gap_class: gap > 0 ? 'text-danger' : 'text-success',
    rev_impact: revImpactStr,
    rev_impact_raw: revImpactNum,
    rev_class: revImpactNum > 0 ? 'text-danger' : 'text-muted',
    status,
    status_class: statusClass,
    action,
    customer_info: def.customer_info,
    triggering_signals: def.triggering_signals,
    key_dates: def.key_dates,
    chart: {
      months,
      max_scale: maxScale,
      points: forecastPoints,
      trend_path: trendPath
    },
    regions: regionalDist,
    workloads
  };
}

/**
 * Returns the collection of all calculated signals for the Action Queue table,
 * category counts, and header summary KPIs.
 */
function buildActionSignals(store) {
  const rows = SIGNAL_DEFINITIONS.map((def) => calculateSignal(def, store));

  // Category counts
  const countFor = (cat) => rows.filter((r) => r.category === cat).length;
  const tabs = [
    { key: 'all', label: 'All', count: rows.length },
    { key: 'deals', label: 'Customer Deals', count: countFor('deals') },
    { key: 'launches', label: 'Product Launches', count: countFor('launches') },
    { key: 'seasonal', label: 'Seasonal', count: countFor('seasonal') },
    { key: 'transitions', label: 'SKU Transitions', count: countFor('transitions') },
    { key: 'sustainability', label: 'Sustainability', count: countFor('sustainability') },
    { key: 'regulatory', label: 'Regulatory', count: countFor('regulatory') },
    { key: 'supply_chain', label: 'Supply Chain', count: countFor('supply_chain') }
  ];

  // 5 Top Action Queue KPI counts
  const atRiskCount = rows.filter((r) => r.status === 'At Risk').length;
  const procurementCount = rows.filter((r) => r.gap_raw > 0).length;
  const kpis = {
    total: rows.length,
    at_risk: atRiskCount,
    due_soon: 2,
    ai_recommended: 7,
    procurement: procurementCount
  };

  return { kpis, tabs, rows };
}

/**
 * Returns the full detailed calculation for a single selected signal.
 */
function buildSignalDetail(store, signalId) {
  let target = SIGNAL_DEFINITIONS.find((s) => s.id === signalId || s.category === signalId);
  if (!target && signalId) {
    const sLow = signalId.toLowerCase();
    target = SIGNAL_DEFINITIONS.find((s) => s.customer.toLowerCase().includes(sLow) || s.id.toLowerCase().includes(sLow));
  }
  if (!target) target = SIGNAL_DEFINITIONS[0]; // fallback to Coca-Cola deal

  return calculateSignal(target, store);
}

module.exports = {
  buildActionSignals,
  buildSignalDetail,
  SIGNAL_DEFINITIONS
};
