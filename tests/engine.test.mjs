import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  allocateInteger, splitAcrossMonths, prepareDataset, buildBill, priceQuery,
  compareRevisions, overspendReasons, buildInvoice, queryDetail, normalizeRecord,
  sanitizeRecord, toCents, monthBounds, UNASSIGNED,
} from '../src/engine.js';
import { parseCSV, rowsToQueries } from '../src/csv.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = JSON.parse(readFileSync(`${root}data/config.json`, 'utf8'));
const RAW = readFileSync(`${root}data/queries.csv`, 'utf8');
const ROWS = parseCSV(RAW);
const QUERIES = rowsToQueries(ROWS);
const PREPARED = prepareDataset(QUERIES, CONFIG);

function record(overrides = {}) {
  return {
    query_id: 'q-test',
    started_at: '2026-10-05T10:00:00.000Z',
    finished_at: '2026-10-05T10:02:00.000Z',
    status: 'success',
    team_id: 'analytics',
    dataset_id: 'sales_orders',
    table: 'dwd_orders_di',
    scan_bytes: 1024 ** 3,
    elapsed_ms: 60_000,
    metering_complete: true,
    missing_fields: '',
    attempt: 1,
    ...overrides,
  };
}

/* ---------------------------------------------------------------- */
/* 分摊与舍入                                                        */
/* ---------------------------------------------------------------- */

test('allocateInteger 用最大余数法，合计精确', () => {
  const parts = allocateInteger(100, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  assert.equal(parts[0], 34);
  assert.deepEqual(allocateInteger(1, [0.5, 0.5]), [1, 0]);
  assert.deepEqual(allocateInteger(7, [0, 0]), [7, 0]);
  assert.deepEqual(allocateInteger(10, [3, 0, 1]), [8, 0, 2]);
});

test('多表查询：各表分摊之和等于查询总额', () => {
  const q = record({
    tables: [
      { dataset_id: 'sales_orders', table: 'a', scan_bytes: 2 * 1024 ** 3, elapsed_ms: 10_000 },
      { dataset_id: 'finance_ledger', table: 'b', scan_bytes: 1 * 1024 ** 3, elapsed_ms: 50_000 },
    ],
  });
  const prepared = prepareDataset([{
    ...q,
    tables: q.tables,
  }], CONFIG);
  const bill = buildBill(prepared, '2026-10', 'auto');
  const rows = bill.rows.filter((r) => r.query_id === 'q-test');
  const total = rows.reduce((a, r) => a + r.cents, 0);
  assert.equal(total, rows[0].month_cents);
  assert.equal(rows.length, 2);
  // finance_ledger 使用加权规则（0.6 字节 + 0.4 时长）
  const finance = rows.find((r) => r.dataset_id === 'finance_ledger');
  assert.equal(finance.method, 'weighted');
  assert.ok(finance.weight > 0 && finance.weight <= 1);
  assert.ok(Math.abs(finance.bytes_share - 1 / 3) < 1e-9);
});

test('分摊规则按数据集配置：ml_features 用耗时占比', () => {
  const prepared = prepareDataset([record({
    tables: [
      { dataset_id: 'ml_features', table: 'a', scan_bytes: 10 * 1024 ** 3, elapsed_ms: 1_000 },
      { dataset_id: 'sales_orders', table: 'b', scan_bytes: 1 * 1024 ** 3, elapsed_ms: 99_000 },
    ],
  })], CONFIG);
  const r = prepared.records[0];
  const ml = r.computed.tables.find((t) => t.dataset_id === 'ml_features');
  assert.equal(ml.method, 'duration');
  assert.ok(Math.abs(ml.weight - 0.01) < 1e-9);
});

/* ---------------------------------------------------------------- */
/* 跨月                                                              */
/* ---------------------------------------------------------------- */

test('跨月查询按墙钟时间拆到账期，合计守恒', () => {
  const shards = splitAcrossMonths({
    started_at: '2026-10-31T23:00:00.000Z',
    finished_at: '2026-11-01T01:00:00.000Z',
  }, 100);
  assert.equal(shards.length, 2);
  assert.equal(shards.reduce((a, s) => a + s.cents, 0), 100);
  assert.equal(shards[0].month, '2026-10');
  assert.equal(shards[1].month, '2026-11');
  assert.ok(Math.abs(shards[0].fraction - 0.5) < 1e-9);
});

test('跨月样本记录在两期账单中都出现，且两期合计等于查询总成本', () => {
  const qid = 'q-crossmonth-01';
  const oct = buildBill(PREPARED, '2026-10', 'auto');
  const nov = buildBill(PREPARED, '2026-11', 'auto');
  const octRows = oct.rows.filter((r) => r.query_id === qid);
  const novRows = nov.rows.filter((r) => r.query_id === qid);
  const octSum = octRows.reduce((a, r) => a + r.cents, 0);
  const novSum = novRows.reduce((a, r) => a + r.cents, 0);
  const prepared = PREPARED.records.find((r) => r.query_id === qid);
  assert.equal(octSum + novSum, prepared.computed.totalCents);
  assert.ok(octSum > 0 && novSum > 0);
  assert.ok(octRows[0].cross_month);
});

test('账单不把跨月查询整笔计入单月', () => {
  const qid = 'q-crossmonth-02';
  const oct = buildBill(PREPARED, '2026-10', 'auto');
  const total = PREPARED.records.find((r) => r.query_id === qid).computed.totalCents;
  const octCents = oct.rows.filter((r) => r.query_id === qid).reduce((a, r) => a + r.cents, 0);
  assert.ok(octCents < total, '十月只计入跨月部分');
  assert.ok(octCents > total * 0.8, '十月占绝大部分时长');
});

/* ---------------------------------------------------------------- */
/* 重试与取消                                                        */
/* ---------------------------------------------------------------- */

test('重试：失败尝试不重复记账，成功尝试记账', () => {
  const bill = buildBill(PREPARED, '2026-10', 'auto');
  const dupes = bill.duplicateRows.map((d) => d.query_id);
  assert.ok(dupes.includes('q-retry-01-a1'), '失败的首试不记账');
  assert.ok(!dupes.includes('q-retry-01-a2'), '成功的重试记账');
  const rows = bill.rows.filter((r) => r.query_id === 'q-retry-01-a2');
  assert.equal(rows.length, 1);
  assert.ok(bill.totals.retry_waste_cents > 0);
});

test('取消后重试：取消前已消耗计入实际成本，重试本身只记一次', () => {
  const bill = buildBill(PREPARED, '2026-10', 'auto');
  const cancelled = bill.rows.filter((r) => r.query_id === 'q-retry-02-a1');
  const booked = bill.rows.filter((r) => r.query_id === 'q-retry-02-a2');
  assert.ok(cancelled.length > 0, '取消尝试的消耗在账单中');
  assert.equal(cancelled[0].charge_type, 'cancelled-consumption');
  assert.equal(booked.length, 1, '成功重试单独记账');
  assert.equal(booked[0].charge_type, 'booked');
  assert.ok(cancelled[0].cents > 0);
});

test('全部失败的重试组只记消耗最大的尝试', () => {
  const bill = buildBill(PREPARED, '2026-11', 'auto');
  const bookedRows = bill.rows.filter((r) => r.logical_query_id === 'lr-retry-03');
  const bookedIds = new Set(bookedRows.map((r) => r.query_id));
  assert.equal(bookedIds.size, 1, '只记一次');
  assert.ok([...bookedIds][0] === 'q-retry-03-a2', '记录消耗最多的失败尝试');
});

test('重试组的记账金额不随尝试次数倍增', () => {
  const decision = PREPARED.decisions.get('lr-retry-03');
  assert.equal(decision.attempts.length, 3);
  const bookedSum = decision.booked.price.totalCents;
  const allSum = decision.attempts.reduce((a, p) => a + (p.price.totalCents || 0), 0);
  assert.ok(bookedSum < allSum, '账单金额小于所有尝试消耗之和');
});

/* ---------------------------------------------------------------- */
/* 未知成本                                                          */
/* ---------------------------------------------------------------- */

test('缺扫描量：成本为未知，不估算', () => {
  const prepared = prepareDataset([record({
    query_id: 'q-missing',
    metering_complete: false,
    missing_fields: 'scan_bytes',
    tables: [{ dataset_id: 'sales_orders', table: 'a', scan_bytes: null, elapsed_ms: 1000 }],
  })], CONFIG);
  const bill = buildBill(prepared, '2026-10', 'auto');
  assert.equal(bill.totals.unknown_count, 1);
  assert.equal(bill.totals.known_cents, 0);
  assert.equal(bill.rows.length, 0);
  assert.ok(bill.unknownQueries[0].known_scan_bytes === null);
});

test('未配置单价的数据集：成本未知，不按默认价假装知道', () => {
  const prepared = prepareDataset([record({
    query_id: 'q-unpriced',
    tables: [{ dataset_id: 'ad_hoc_exports', table: 'a', scan_bytes: 1024 ** 3, elapsed_ms: 1000 }],
  })], CONFIG);
  const bill = buildBill(prepared, '2026-10', 'auto');
  assert.equal(bill.totals.unknown_count, 1);
  assert.equal(bill.rows.length, 0);
  assert.match(bill.unknownQueries[0].reasons[0], /未配置单价/);
});

test('未知成本不进入任何团队、不平摊：团队合计等于已归属已知成本', () => {
  const bill = buildBill(PREPARED, '2026-10', 'auto');
  const teamSum = bill.teams.reduce((a, t) => a + t.cents, 0);
  assert.equal(teamSum, bill.totals.known_cents);
  // 未知查询不出现在 teams 的组成中
  const knownQueryIds = new Set(bill.rows.map((r) => r.query_id));
  for (const u of bill.unknownQueries) {
    assert.ok(!knownQueryIds.has(u.query_id), `未知查询 ${u.query_id} 不应出现在计费行`);
  }
});

test('未知成本不摊给所有人：逐条账单金额不因未知查询而增加', () => {
  const before = buildBill(PREPARED, '2026-10', 'auto');
  const withExtra = prepareDataset([
    ...QUERIES,
    record({
      query_id: 'q-extra-unknown',
      team_id: 'analytics',
      metering_complete: false,
      missing_fields: ['scan_bytes'],
      started_at: '2026-10-06T10:00:00.000Z',
      finished_at: '2026-10-06T10:01:00.000Z',
      tables: [{ dataset_id: 'sales_orders', table: 't', scan_bytes: null, elapsed_ms: 60_000 }],
    }),
  ], CONFIG);
  const after = buildBill(withExtra, '2026-10', 'auto');
  const analyticsBefore = before.teams.find((t) => t.team_id === 'analytics').cents;
  const analyticsAfter = after.teams.find((t) => t.team_id === 'analytics').cents;
  assert.equal(analyticsAfter, analyticsBefore, '新增未知查询不改变任何团队金额');
  assert.equal(after.totals.unknown_count, before.totals.unknown_count + 1);
});

/* ---------------------------------------------------------------- */
/* 归属与修订                                                        */
/* ---------------------------------------------------------------- */

test('归属修订按生效日期自动叠加', () => {
  const oct = buildBill(PREPARED, '2026-10', 'auto');
  const nov = buildBill(PREPARED, '2026-11', 'auto');
  assert.equal(oct.revision.id, 'ATT-2026-10-v1');
  assert.equal(nov.revision.id, 'ATT-2026-11-v3');
});

test('缺归属查询单列，不被自动认领', () => {
  const bill = buildBill(PREPARED, '2026-11', 'auto');
  const novUnassigned = bill.totals.unassigned_cents;
  assert.equal(novUnassigned, 0, '11 月生效修订已认领全部缺归属');
  const oct = buildBill(PREPARED, '2026-10', 'auto');
  assert.ok(oct.totals.unassigned_cents > 0);
  assert.equal(oct.teams.find((t) => t.team_id === UNASSIGNED).budget, null);
});

test('修订对比：总额、未分配余额与最大变化查询', () => {
  const compare = compareRevisions(PREPARED, '2026-10', 'ATT-2026-10-v1', 'ATT-2026-11-v3');
  assert.equal(compare.totals.attributed_delta_cents,
    compare.target.totals.attributed_cents - compare.base.totals.attributed_cents);
  assert.equal(compare.totals.unassigned_delta_cents,
    compare.target.totals.unassigned_cents - compare.base.totals.unassigned_cents);
  // 总额守恒：归属的转入与转出应等额反补未归属
  assert.equal(compare.totals.attributed_delta_cents, -compare.totals.unassigned_delta_cents);
  assert.ok(compare.changes.length > 0);
  const top = compare.changes[0];
  assert.equal(Math.abs(top.delta_cents), Math.max(...compare.changes.map((c) => Math.abs(c.delta_cents))));
});

test('按较早修订重述账单后，总额与未分配余额同时变化', () => {
  const base = buildBill(PREPARED, '2026-10', 'ATT-2026-10-v1');
  const revised = buildBill(PREPARED, '2026-10', 'ATT-2026-11-v3');
  assert.notEqual(base.totals.attributed_cents, revised.totals.attributed_cents);
  assert.equal(
    base.totals.attributed_cents + base.totals.unassigned_cents,
    revised.totals.attributed_cents + revised.totals.unassigned_cents,
    '重述不改变已知总额，只改变归属',
  );
});

test('查询详情保留归属修订历史', () => {
  const detail = queryDetail(PREPARED, buildBill(PREPARED, '2026-10', 'auto'), 'q-retry-01-a2');
  assert.ok(detail.revision_history.length >= 2, '两次修订都记录了该查询');
  assert.ok(detail.revision_history.some((r) => r.revision === 'ATT-2026-11-v3'));
  const first = detail.revision_history[0];
  assert.equal(first.change.from_team_id, 'growth');
});

/* ---------------------------------------------------------------- */
/* 预算与超额                                                        */
/* ---------------------------------------------------------------- */

test('超额的各项原因金额合计等于超额金额', () => {
  const reasons = overspendReasons(PREPARED, '2026-11', 'auto');
  for (const entry of reasons) {
    if (entry.overage_cents <= 0) continue;
    const sum = entry.reasons.reduce((a, r) => a + r.cents, 0);
    assert.equal(sum, entry.overage_cents, `${entry.team_id} 原因合计应等于超额`);
  }
  const over = reasons.filter((r) => r.overage_cents > 0);
  assert.ok(over.length > 0, '样例数据应存在超预算团队');
  assert.ok(over.every((r) => r.reasons.every((x) => x.share > 0)));
});

test('预算版本自变量：超支解释包含预算下调', () => {
  const reasons = overspendReasons(PREPARED, '2026-11', 'auto');
  const over = reasons.filter((r) => r.overage_cents > 0);
  const hasCut = over.some((r) => r.reasons.some((x) => x.key === 'budget_cut'));
  assert.ok(hasCut, '十月→十一月预算下调应体现在超额原因中');
});

test('预算版本按月生效', () => {
  const oct = buildBill(PREPARED, '2026-10', 'auto');
  const nov = buildBill(PREPARED, '2026-11', 'auto');
  assert.equal(oct.budgetVersion.version, 'BUD-2026-10-v1');
  assert.equal(nov.budgetVersion.version, 'BUD-2026-11-v2');
  assert.notEqual(oct.totals.budget_total, nov.totals.budget_total);
});

/* ---------------------------------------------------------------- */
/* 账单                                                              */
/* ---------------------------------------------------------------- */

test('账单合计 = 已归属 + 未归属，未知单列', () => {
  const invoice = buildInvoice(PREPARED, '2026-10');
  assert.equal(invoice.subtotal_cents, invoice.attributed_cents + invoice.unassigned_cents);
  assert.equal(invoice.unknown.count, buildBill(PREPARED, '2026-10', 'auto').totals.unknown_count);
  assert.ok(invoice.unassigned_lines.length > 0);
  assert.equal(invoice.unassigned_lines[0].budget, null);
  assert.equal(invoice.fictional, true);
  assert.match(invoice.invoice_no, /^INV-FIC-/);
});

test('账单条目合计与各团队账单金额一致', () => {
  const bill = buildBill(PREPARED, '2026-10', 'auto');
  const invoice = buildInvoice(PREPARED, '2026-10');
  for (const line of invoice.lines) {
    const team = bill.teams.find((t) => t.team_id === line.team_id);
    assert.equal(line.cents, team.cents);
    assert.equal(line.queries, team.query_count);
  }
});

/* ---------------------------------------------------------------- */
/* 清洗与校验                                                        */
/* ---------------------------------------------------------------- */

test('导入时丢弃 SQL 与个人字段', () => {
  const { record: clean, dropped } = sanitizeRecord({
    query_id: 'q-pii', sql: 'select * from secret', user_email: 'a@b.c', phone: '123',
    tables: [{ sql: 'select 1', dataset_id: 'd', table: 't' }],
  });
  assert.equal(clean.sql, undefined);
  assert.equal(clean.user_email, undefined);
  assert.ok(dropped.includes('sql'));
  assert.equal(clean.tables[0].sql, undefined);
});

test('非法记录被拒绝而不是静默计入', () => {
  const result = normalizeRecord({ query_id: 'q-bad', status: 'running', started_at: 'x', tables: [] }, 0);
  assert.ok(result.error);
  const prepared = prepareDataset([{ query_id: 'q-bad', status: 'running', started_at: '2026-10-01T00:00:00Z', tables: [{ dataset_id: 'd', table: 't', scan_bytes: 1, elapsed_ms: 1 }] }], CONFIG);
  assert.equal(prepared.stats.rejected, 1);
  assert.equal(prepared.stats.accepted, 0);
});

test('重复 query_id 被拒，不双记账', () => {
  const r1 = record({ query_id: 'dup' });
  const r2 = record({ query_id: 'dup', started_at: '2026-10-06T10:00:00.000Z', finished_at: '2026-10-06T10:01:00.000Z' });
  const prepared = prepareDataset([{ ...r1, tables: [{ dataset_id: 'sales_orders', table: 't', scan_bytes: 1024 ** 3, elapsed_ms: 1000 }] },
    { ...r2, tables: [{ dataset_id: 'sales_orders', table: 't', scan_bytes: 1024 ** 3, elapsed_ms: 1000 }] }], CONFIG);
  assert.equal(prepared.stats.duplicate_ids, 1);
  const bill = buildBill(prepared, '2026-10', 'auto');
  assert.equal(bill.totals.booked_query_count, 1);
});

/* ---------------------------------------------------------------- */
/* 守恒与样例完整性                                                  */
/* ---------------------------------------------------------------- */

test('两期账单的已知成本合计等于所有已计费查询的总成本', () => {
  const oct = buildBill(PREPARED, '2026-10', 'auto');
  const nov = buildBill(PREPARED, '2026-11', 'auto');
  const total = oct.totals.known_cents + nov.totals.known_cents;
  const expected = PREPARED.records
    .filter((r) => r.charged && r.computed.state !== 'unknown')
    .reduce((a, r) => a + r.computed.totalCents, 0);
  assert.equal(total, expected, '跨月拆分后总额必须守恒');
});

test('每期账单内：团队合计 = 数据集合计 = 行合计', () => {
  for (const month of ['2026-10', '2026-11']) {
    const bill = buildBill(PREPARED, month, 'auto');
    const teamSum = bill.teams.reduce((a, t) => a + t.cents, 0);
    const datasetSum = bill.datasets.reduce((a, d) => a + d.cents, 0);
    const rowSum = bill.rows.reduce((a, r) => a + r.cents, 0);
    assert.equal(teamSum, rowSum, `${month} 团队与行合计一致`);
    assert.equal(datasetSum, rowSum, `${month} 数据集与行合计一致`);
    assert.equal(rowSum, bill.totals.known_cents);
  }
});

test('每日合计与账单总额一致', () => {
  const bill = buildBill(PREPARED, '2026-10', 'auto');
  const daySum = bill.days.reduce((a, d) => a + d.cents, 0);
  assert.equal(daySum, bill.totals.known_cents);
});

test('样例数据包含全部边界情形', () => {
  const bill = buildBill(PREPARED, '2026-10', 'auto');
  assert.ok(bill.unknownQueries.length > 0);
  assert.ok(bill.duplicateRows.length > 0);
  assert.ok(bill.totals.cancelled_consumed_cents > 0);
  assert.ok(bill.totals.unassigned_cents > 0);
  assert.ok(bill.rows.some((r) => r.cross_month));
  const nov = buildBill(PREPARED, '2026-11', 'auto');
  assert.ok(nov.rows.some((r) => r.cross_month));
});

test('未知成本不因缺少字段而改变已知扫描量以外的任何数字', () => {
  const bill = buildBill(PREPARED, '2026-11', 'auto');
  for (const u of bill.unknownQueries) {
    assert.ok(Number.isFinite(u.known_scan_bytes) || u.known_scan_bytes === null);
    assert.ok(!('cents' in u) || u.cents === undefined, '未知查询没有金额字段');
  }
});
