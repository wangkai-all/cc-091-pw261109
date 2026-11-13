/**
 * 生成虚构的脱敏查询记录（CSV）与配置（JSON）。
 * 仅用于演示，不含任何真实用户、SQL 或计费数据。
 * 用法：node tools/generate_fixtures.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data');
mkdirSync(outDir, { recursive: true });

/* 可复现的线性同余随机数 */
let seed = 20261113;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
}
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function between(min, max) { return min + rand() * (max - min); }
function intBetween(min, max) { return Math.floor(between(min, max + 1)); }

const TEAMS = ['analytics', 'finance', 'growth', 'platform', 'support'];

const DATASETS = {
  sales_orders: { tables: ['dwd_orders_di', 'dws_order_agg_1d', 'dim_shop_df'], use: 0.26 },
  user_events: { tables: ['dwd_user_event_di', 'dws_dau_1d', 'ads_growth_funnel_1d'], use: 0.24 },
  finance_ledger: { tables: ['dwd_ledger_di', 'dws_cost_center_1d', 'dim_account_df'], use: 0.16 },
  ml_features: { tables: ['dwd_feature_snapshot_di', 'ads_model_sample_1d'], use: 0.18 },
  ops_inventory: { tables: ['dwd_inventory_snapshot_di', 'dws_stock_turnover_1d'], use: 0.12 },
  ad_hoc_exports: { tables: ['tmp_adhoc_export_di'], use: 0.015 },
};

const CLIENTS = ['bi-portal', 'scheduler', 'notebook', 'cli', 'realtime-api'];

function iso(ms) { return new Date(ms).toISOString(); }

const records = [];
let counter = 0;
const DAY = 86_400_000;
const startAll = Date.UTC(2026, 9, 1, 0, 0, 0); // 2026-10-01
const endAll = Date.UTC(2026, 10, 13, 8, 0, 0); // 2026-11-13

function chooseDataset() {
  const r = rand();
  let acc = 0;
  for (const [id, d] of Object.entries(DATASETS)) {
    acc += d.use;
    if (r <= acc) return id;
  }
  return 'sales_orders';
}

function addRecord({ queryId, logicalId, attempt, startMs, durationMs, status, team, datasetIds, client, meteringComplete = true, missing = [] }) {
  const finishedMs = startMs + durationMs;
  const tables = datasetIds.map((datasetId, i) => {
    const ds = DATASETS[datasetId];
    const table = ds.tables[i % ds.tables.length];
    const scan = datasetId === 'ad_hoc_exports'
      ? intBetween(2, 40) * 1024 ** 2
      : intBetween(20, 1200) * 1024 ** 3 / intBetween(1, 3);
    return {
      query_id: queryId,
      logical_query_id: logicalId,
      attempt,
      started_at: iso(startMs),
      finished_at: iso(finishedMs),
      status,
      team_id: team ?? '',
      client: client || 'bi-portal',
      user_hash: `u_${(intBetween(0, 999)).toString(16).padStart(3, '0')}`,
      sql_fingerprint: `fp_${logicalId.toLowerCase()}`,
      dataset_id: datasetId,
      table,
      scan_bytes: Math.round(scan),
      elapsed_ms: Math.round(durationMs * between(0.55, 0.95)),
      metering_complete: meteringComplete,
      missing_fields: missing.join('|'),
    };
  });
  records.push(...tables);
}

/* ---- 常规查询：2026-10 与 2026-11（截至 13 日） ---- */
const nowMs = Date.UTC(2026, 10, 13, 8, 0, 0);
for (let day = startAll; day <= endAll; day += DAY) {
  const n = intBetween(5, 9);
  for (let i = 0; i < n; i += 1) {
    counter += 1;
    const d = new Date(day);
    const id = `q-2026${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(counter).padStart(4, '0')}`;
    const logical = `lr-${id.slice(2)}`;
    const team = pick(TEAMS);
    const startMs = day + intBetween(7, 22) * 3_600_000 + intBetween(0, 59) * 60_000;
    if (startMs > nowMs) continue;
    const statusRoll = rand();
    const status = statusRoll < 0.035 ? 'failed' : statusRoll < 0.06 ? 'timeout' : statusRoll < 0.085 ? 'cancelled' : 'success';
    const durationMs = status === 'cancelled'
      ? intBetween(40, 300) * 1000
      : intBetween(4000, 240000);
    const multi = rand() < 0.38;
    const datasetIds = multi
      ? [chooseDataset(), chooseDataset()].filter((v, i, a) => a.indexOf(v) === i)
      : [chooseDataset()];
    if (!datasetIds.length) datasetIds.push('sales_orders');
    addRecord({ queryId: id, logicalId: logical, attempt: 1, startMs, durationMs, status, team, datasetIds });
  }
}

/* ---- 指定场景 ---- */
// 重试：第一次失败（消耗资源），第二次成功；只记后一次
addRecord({ queryId: 'q-retry-01-a1', logicalId: 'lr-retry-01', attempt: 1, startMs: Date.UTC(2026, 9, 4, 9, 10, 0), durationMs: 92000, status: 'failed', team: 'growth', datasetIds: ['user_events', 'sales_orders'], client: 'notebook' });
addRecord({ queryId: 'q-retry-01-a2', logicalId: 'lr-retry-01', attempt: 2, startMs: Date.UTC(2026, 9, 4, 9, 12, 30), durationMs: 46000, status: 'success', team: 'growth', datasetIds: ['user_events'], client: 'notebook' });

// 取消后重试：取消前已消耗，仍计入实际成本；重试成功只记一次
addRecord({ queryId: 'q-retry-02-a1', logicalId: 'lr-retry-02', attempt: 1, startMs: Date.UTC(2026, 9, 17, 14, 0, 0), durationMs: 61000, status: 'cancelled', team: 'analytics', datasetIds: ['sales_orders', 'finance_ledger'], client: 'bi-portal' });
addRecord({ queryId: 'q-retry-02-a2', logicalId: 'lr-retry-02', attempt: 2, startMs: Date.UTC(2026, 9, 17, 14, 3, 0), durationMs: 38000, status: 'success', team: 'analytics', datasetIds: ['sales_orders'], client: 'bi-portal' });

// 三次重试，全部失败：记消耗最多的一次
addRecord({ queryId: 'q-retry-03-a1', logicalId: 'lr-retry-03', attempt: 1, startMs: Date.UTC(2026, 10, 5, 10, 0, 0), durationMs: 30000, status: 'timeout', team: 'platform', datasetIds: ['ml_features'] });
addRecord({ queryId: 'q-retry-03-a2', logicalId: 'lr-retry-03', attempt: 2, startMs: Date.UTC(2026, 10, 5, 10, 2, 0), durationMs: 88000, status: 'failed', team: 'platform', datasetIds: ['ml_features', 'user_events'] });
addRecord({ queryId: 'q-retry-03-a3', logicalId: 'lr-retry-03', attempt: 3, startMs: Date.UTC(2026, 10, 5, 10, 5, 0), durationMs: 45000, status: 'timeout', team: 'platform', datasetIds: ['ml_features'] });

// 单独取消（非重试）：按已发生计量计费
addRecord({ queryId: 'q-cancel-01', logicalId: 'lr-cancel-01', attempt: 1, startMs: Date.UTC(2026, 9, 22, 16, 30, 0), durationMs: 190000, status: 'cancelled', team: 'support', datasetIds: ['ops_inventory', 'sales_orders'], client: 'cli' });

// 缺归属：3 条
for (let i = 1; i <= 3; i += 1) {
  addRecord({ queryId: `q-noteam-0${i}`, logicalId: `lr-noteam-0${i}`, attempt: 1, startMs: Date.UTC(2026, 9, 11 + i, 11, 0, 0), durationMs: 70000, status: 'success', team: null, datasetIds: [i === 2 ? 'finance_ledger' : 'user_events'], client: 'scheduler' });
}
// 11 月新增一条未归属（随后被修订认领）
addRecord({ queryId: 'q-noteam-04', logicalId: 'lr-noteam-04', attempt: 1, startMs: Date.UTC(2026, 10, 3, 9, 30, 0), durationMs: 125000, status: 'success', team: null, datasetIds: ['sales_orders', 'ml_features'], client: 'notebook' });

// 计量缺失：扫描量缺失 → 未知成本，不估算
addRecord({ queryId: 'q-unmetered-01', logicalId: 'lr-unmetered-01', attempt: 1, startMs: Date.UTC(2026, 9, 8, 10, 20, 0), durationMs: 55000, status: 'success', team: 'finance', datasetIds: ['finance_ledger'], meteringComplete: false, missing: ['scan_bytes'] });
// 只有一部分表缺扫描量：整条未知，不在已知部分上猜
addRecord({ queryId: 'q-unmetered-02', logicalId: 'lr-unmetered-02', attempt: 1, startMs: Date.UTC(2026, 10, 7, 13, 5, 0), durationMs: 91000, status: 'success', team: 'analytics', datasetIds: ['sales_orders', 'user_events'], meteringComplete: false, missing: ['tables.scan_bytes'] });

// 未配置单价的数据集：成本未知（不按默认价假装知道）
addRecord({ queryId: 'q-unpriced-01', logicalId: 'lr-unpriced-01', attempt: 1, startMs: Date.UTC(2026, 9, 26, 15, 0, 0), durationMs: 14000, status: 'success', team: 'growth', datasetIds: ['ad_hoc_exports'], client: 'cli' });
addRecord({ queryId: 'q-unpriced-02', logicalId: 'lr-unpriced-02', attempt: 1, startMs: Date.UTC(2026, 10, 9, 10, 40, 0), durationMs: 22000, status: 'success', team: 'platform', datasetIds: ['ad_hoc_exports', 'sales_orders'], client: 'cli' });

// 跨月查询：10/31 23:35 → 11/01 00:25，按时间落入两期
addRecord({ queryId: 'q-crossmonth-01', logicalId: 'lr-crossmonth-01', attempt: 1, startMs: Date.UTC(2026, 9, 31, 23, 35, 0), durationMs: 50 * 60 * 1000, status: 'success', team: 'finance', datasetIds: ['finance_ledger', 'sales_orders'], client: 'scheduler' });
addRecord({ queryId: 'q-crossmonth-02', logicalId: 'lr-crossmonth-02', attempt: 1, startMs: Date.UTC(2026, 9, 31, 22, 50, 0), durationMs: 78 * 60 * 1000, status: 'success', team: 'growth', datasetIds: ['user_events'], client: 'scheduler' });

// 现场按自然顺序排序并写出
records.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.query_id.localeCompare(b.query_id));

const columns = ['query_id', 'logical_query_id', 'attempt', 'started_at', 'finished_at', 'status', 'team_id', 'client', 'user_hash', 'sql_fingerprint', 'dataset_id', 'table', 'scan_bytes', 'elapsed_ms', 'metering_complete', 'missing_fields'];
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = [columns.join(','), ...records.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n');
writeFileSync(join(outDir, 'queries.csv'), `${csv}\n`);

/* ---- 配置：单价、分摊、预算版本、归属修订 ---- */
const config = {
  currency: 'USD',
  fictional: true,
  orgName: '星图数仓（虚构示例）',
  teams: {
    analytics: { name: '分析平台组', color_slot: 1 },
    finance: { name: '财务数据组', color_slot: 2 },
    growth: { name: '增长分析组', color_slot: 3 },
    platform: { name: '数据平台组', color_slot: 4 },
    support: { name: '业务支持组', color_slot: 5 },
  },
  prices: {
    datasets: {
      sales_orders: { name: '销售订单域', scan_usd_per_gb: 0.024, compute_usd_per_cpu_hour: 0.34 },
      user_events: { name: '用户行为域', scan_usd_per_gb: 0.017, compute_usd_per_cpu_hour: 0.28 },
      finance_ledger: { name: '财务总账域', scan_usd_per_gb: 0.043, compute_usd_per_cpu_hour: 0.52 },
      ml_features: { name: '特征样本域', scan_usd_per_gb: 0.020, compute_usd_per_cpu_hour: 0.40 },
      ops_inventory: { name: '仓储库存域', scan_usd_per_gb: 0.030, compute_usd_per_cpu_hour: 0.30 },
      // ad_hoc_exports 故意不配置单价 → 成本未知
    },
  },
  allocation: {
    default: { method: 'bytes' },
    datasets: {
      finance_ledger: { method: 'weighted', bytes_weight: 0.6, duration_weight: 0.4 },
      ml_features: { method: 'duration' },
    },
  },
  retryPolicy: { mode: 'terminal-attempt' },
  budgets: {
    versions: [
      {
        version: 'BUD-2026-10-v1',
        effective_month: '2026-10',
        note: '10 月初版团队月预算（虚构）',
        teams: { analytics: 480, finance: 640, growth: 380, platform: 560, support: 430 },
      },
      {
        version: 'BUD-2026-11-v2',
        effective_month: '2026-11',
        note: '11 月调整：增长组预算下调，平台组上调（虚构）',
        teams: { analytics: 400, finance: 500, growth: 210, platform: 620, support: 240 },
      },
    ],
  },
  revisions: [
    {
      id: 'ATT-2026-10-v1',
      seq: 1,
      effective_date: '2026-10-01',
      author: '数据治理',
      note: '初始归属：以查询日志中的团队字段为准',
      changes: [],
    },
    {
      id: 'ATT-2026-11-v2',
      seq: 2,
      effective_date: '2026-11-01',
      author: '财务数据组 · 林某',
      note: '11 月起：增长组两个共享报表查询改由平台组承担；认领一条缺归属查询',
      changes: [
        { query_id: 'q-retry-01-a2', from_team_id: 'growth', to_team_id: 'platform', reason: '共享报表由平台组承担' },
        { query_id: 'q-crossmonth-02', from_team_id: 'growth', to_team_id: 'platform', reason: '调度任务归属修正' },
        { query_id: 'q-noteam-04', from_team_id: null, to_team_id: 'growth', reason: '补录团队归属' },
      ],
    },
    {
      id: 'ATT-2026-11-v3',
      seq: 3,
      effective_date: '2026-11-10',
      author: '分析平台组 · 周某',
      note: '更正：q-retry-01 最终归属分析平台组；撤回一条误改',
      changes: [
        { query_id: 'q-retry-01-a2', from_team_id: 'platform', to_team_id: 'analytics', reason: '更正共享报表归属' },
        { query_id: 'q-crossmonth-02', from_team_id: 'platform', to_team_id: 'growth', reason: '撤回误改' },
        { query_id: 'q-noteam-01', from_team_id: null, to_team_id: 'support', reason: '支持组认领' },
      ],
    },
  ],
};

writeFileSync(join(outDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

console.log(`queries.csv: ${records.length} 行（表访问级）`);
console.log(`config.json: ${config.revisions.length} 个归属修订、${config.budgets.versions.length} 个预算版本`);
