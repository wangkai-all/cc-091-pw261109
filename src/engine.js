/**
 * 数仓成本账房 —— 纯计算内核
 *
 * 设计原则
 * 1. 所有金额以「分」为最小记账单位，聚合时用最大余数法保证账单合计精确。
 * 2. 未知成本永远不估算、不摊派：单列未知桶，只带可核实的扫描量/笔数。
 * 3. 重试按「逻辑查询」去重，只记一次账；取消查询已消耗的计量照实计费。
 * 4. 归属修订是版本化覆盖层；任何账单都能按任一修订版本重述。
 * 5. 跨月查询按墙钟时间在账期内的占比拆到发生月份。
 */

export const UNASSIGNED = '__unassigned__';
export const UNKNOWN = '__unknown__';

const HOUR_MS = 3_600_000;
const GB_BYTES = 1024 ** 3;
const MONTH_RE = /^\d{4}-\d{2}$/;

const STATUSES = new Set(['success', 'failed', 'cancelled', 'timeout']);

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

export function toCents(amount) {
  if (!Number.isFinite(amount)) return null;
  return Math.round((amount + Number.EPSILON) * 100);
}

export function fromCents(cents) {
  return Math.round(cents) / 100;
}

export function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthBounds(month) {
  if (!MONTH_RE.test(month)) throw new Error(`非法账期: ${month}`);
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  return { start, end, label: month, days: (end - start) / 86_400_000 };
}

export function monthList(records) {
  const months = new Set();
  for (const r of records) {
    const start = new Date(r.started_at);
    const finish = new Date(r.finished_at);
    if (Number.isNaN(start.getTime())) continue;
    const end = Number.isNaN(finish.getTime()) ? start : finish;
    let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
    while (cursor <= last) {
      const d = new Date(cursor);
      months.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
      cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }
  return [...months].sort();
}

/** 最大余数法：把 total 分给 weights，结果整数且合计等于 total。 */
export function allocateInteger(total, weights) {
  const totalInt = Math.round(total);
  const raw = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const out = raw.map(() => 0);
    if (out.length) out[0] = totalInt;
    return out;
  }
  const exact = raw.map((w) => (w / sum) * totalInt);
  const floors = exact.map(Math.floor);
  let remainder = totalInt - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder; k += 1) floors[order[k % order.length].i] += 1;
  return floors;
}

function clampNonNeg(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/* ------------------------------------------------------------------ */
/* 配置 & 修订                                                         */
/* ------------------------------------------------------------------ */

export const DEFAULT_CONFIG = {
  currency: 'USD',
  fictional: true,
  orgName: '星图数仓（虚构示例）',
  prices: {
    datasets: {},
  },
  allocation: {
    default: { method: 'bytes' },
    datasets: {},
  },
  retryPolicy: { mode: 'terminal-attempt' },
  budgets: { versions: [] },
  revisions: [],
};

export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    prices: { datasets: {}, ...(raw.prices || {}), datasets: { ...(raw.prices?.datasets || {}) } },
    allocation: {
      default: { method: 'bytes', ...(raw.allocation?.default || {}) },
      datasets: { ...(raw.allocation?.datasets || {}) },
    },
    retryPolicy: { ...DEFAULT_CONFIG.retryPolicy, ...(raw.retryPolicy || {}) },
    budgets: { versions: [...(raw.budgets?.versions || [])].sort((a, b) =>
      a.effective_month.localeCompare(b.effective_month) || a.version.localeCompare(b.version)
    ) },
    revisions: [...(raw.revisions || [])].sort((a, b) => a.seq - b.seq),
  };
}

export function getRevision(config, revisionId) {
  if (!revisionId) return null;
  return config.revisions.find((r) => r.id === revisionId) || null;
}

/** 截至某个账期结束时自动生效的修订（effective_date <= 月末）。 */
export function autoRevision(config, month) {
  const bounds = monthBounds(month);
  const cutoff = new Date(bounds.end - 1).toISOString().slice(0, 10);
  const eligible = config.revisions.filter((r) => r.effective_date <= cutoff);
  return eligible.length ? eligible[eligible.length - 1] : config.revisions[0] || null;
}

export function previousRevision(config, revisionId) {
  const idx = config.revisions.findIndex((r) => r.id === revisionId);
  if (idx > 0) return config.revisions[idx - 1];
  return config.revisions[0] || null;
}

/** 叠加到某修订为止的全部归属覆盖：Map<query_id, team_id|null>。 */
export function overridesForRevision(config, revisionId) {
  const target = getRevision(config, revisionId);
  const overrides = new Map();
  for (const rev of config.revisions) {
    if (target && rev.seq > target.seq) break;
    for (const change of rev.changes || []) {
      overrides.set(change.query_id, change.to_team_id ?? null);
    }
  }
  return overrides;
}

/** 某账期生效的预算版本（effective_month <= month 的最后一版）。 */
export function budgetForMonth(config, month) {
  const eligible = config.budgets.versions.filter((v) => v.effective_month <= month);
  return eligible.length ? eligible[eligible.length - 1] : config.budgets.versions[0] || null;
}

export function previousBudgetVersion(config, versionId) {
  const idx = config.budgets.versions.findIndex((v) => v.version === versionId);
  return idx > 0 ? config.budgets.versions[idx - 1] : null;
}

/* ------------------------------------------------------------------ */
/* 记录清洗                                                            */
/* ------------------------------------------------------------------ */

const PII_FIELDS = [
  'sql', 'sql_text', 'raw_sql', 'user_id', 'user_email', 'email', 'phone',
  'client_ip', 'ip', 'employee_id', 'name',
];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function sanitizeRecord(raw) {
  const dropped = [];
  const record = { ...raw };
  for (const field of PII_FIELDS) {
    if (record[field] !== undefined) {
      delete record[field];
      dropped.push(field);
    }
  }
  if (Array.isArray(record.tables)) {
    record.tables = record.tables.map((t) => {
      const table = { ...t };
      for (const field of ['sql', 'sql_text', 'raw_sql', 'filter', 'predicate']) {
        if (table[field] !== undefined) {
          delete table[field];
          dropped.push(`tables.${field}`);
        }
      }
      return table;
    });
  }
  return { record, dropped };
}

/** 校验并标准化单条查询记录。返回 { record } 或 { error }。 */
export function normalizeRecord(raw, index = 0) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { error: `第 ${index + 1} 条不是对象` };
  const query_id = String(raw.query_id || raw.queryId || '').trim();
  if (!query_id) errors.push('缺少 query_id');

  const logicalRaw = raw.logical_query_id || raw.logicalQueryId || raw.request_id || query_id;
  const logical_query_id = String(logicalRaw).trim();
  const attempt = Number(raw.attempt ?? 1);
  if (!Number.isInteger(attempt) || attempt < 1) errors.push('attempt 必须是 >=1 的整数');

  const status = String(raw.status || '').toLowerCase();
  if (!STATUSES.has(status)) errors.push(`status 非法: ${raw.status || '(空)'}`);

  const started_at = new Date(raw.started_at || raw.start_time || raw.submitted_at);
  if (Number.isNaN(started_at.getTime())) errors.push('started_at 不是合法时间');
  const finishedRaw = raw.finished_at || raw.end_time;
  const finished_at = new Date(finishedRaw);
  const hasFinish = !Number.isNaN(finished_at.getTime());

  if (hasFinish && finished_at.getTime() < started_at.getTime()) {
    errors.push('finished_at 早于 started_at');
  }

  const team_id = raw.team_id === undefined || raw.team_id === null || raw.team_id === ''
    ? null
    : String(raw.team_id);

  const tablesRaw = Array.isArray(raw.tables) ? raw.tables : null;
  if (!tablesRaw || tablesRaw.length === 0) errors.push('tables 不能为空');
  const tables = (tablesRaw || []).map((t, i) => ({
    dataset_id: String(t.dataset_id || t.dataset || '').trim(),
    table: String(t.table || t.table_name || '').trim(),
    scan_bytes: num(t.scan_bytes ?? t.bytes_scanned ?? t.scanBytes),
    elapsed_ms: num(t.elapsed_ms ?? t.duration_ms ?? t.elapsedMs),
    _index: i,
  }));
  for (const t of tables) {
    if (!t.dataset_id) errors.push(`tables[${t._index}] 缺 dataset_id`);
    if (!t.table) errors.push(`tables[${t._index}] 缺 table`);
  }

  const missing_fields = Array.isArray(raw.missing_fields) ? [...raw.missing_fields] : [];
  const metering_complete = raw.metering_complete !== false && missing_fields.length === 0;

  if (errors.length) return { error: `第 ${index + 1} 条：${errors.join('；')}` };

  const wallMs = hasFinish ? finished_at.getTime() - started_at.getTime() : null;
  const sumScan = tables.every((t) => t.scan_bytes !== null)
    ? tables.reduce((a, t) => a + t.scan_bytes, 0)
    : null;
  const sumElapsed = tables.every((t) => t.elapsed_ms !== null)
    ? tables.reduce((a, t) => a + t.elapsed_ms, 0)
    : null;

  return {
    record: {
      query_id,
      logical_query_id,
      attempt,
      request_id: raw.request_id ? String(raw.request_id) : query_id,
      submitted_at: new Date(raw.submitted_at || started_at).toISOString(),
      started_at: started_at.toISOString(),
      finished_at: hasFinish ? finished_at.toISOString() : null,
      status,
      team_id,
      team_id_reported: team_id,
      user_hash: raw.user_hash ? String(raw.user_hash) : null,
      sql_fingerprint: raw.sql_fingerprint ? String(raw.sql_fingerprint) : null,
      client: raw.client ? String(raw.client) : 'unknown',
      tables,
      metering_complete,
      missing_fields,
      note: raw.note ? String(raw.note) : '',
      wall_ms: wallMs,
      sum_scan_bytes: sumScan,
      sum_table_elapsed_ms: sumElapsed,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 计价 & 分摊                                                         */
/* ------------------------------------------------------------------ */

export function allocationRule(config, datasetId) {
  const rule = config.allocation.datasets?.[datasetId] || {};
  return {
    method: rule.method || config.allocation.default.method || 'bytes',
    bytes_weight: rule.bytes_weight ?? config.allocation.default.bytes_weight ?? 1,
    duration_weight: rule.duration_weight ?? config.allocation.default.duration_weight ?? 0,
  };
}

function tableBaseCost(table, config) {
  const price = config.prices.datasets?.[table.dataset_id];
  if (!price) return { error: `数据集未配置单价: ${table.dataset_id}` };
  if (table.scan_bytes === null) return { error: '缺扫描字节' };
  if (table.elapsed_ms === null) return { error: '缺耗时' };
  const scan = (table.scan_bytes / GB_BYTES) * (price.scan_usd_per_gb || 0);
  const compute = (table.elapsed_ms / HOUR_MS) * (price.compute_usd_per_cpu_hour || 0);
  return {
    scan,
    compute,
    amount: scan + compute,
    price: {
      scan_usd_per_gb: price.scan_usd_per_gb || 0,
      compute_usd_per_cpu_hour: price.compute_usd_per_cpu_hour || 0,
    },
  };
}

/**
 * 查询计价与多表分摊。
 * 返回 { state, reasons, totalCents, tables:[{...分摊中间值}] }
 */
export function priceQuery(record, config) {
  if (!record.metering_complete || record.missing_fields.length) {
    return {
      state: 'unknown',
      reasons: ['计量字段缺失：' + (record.missing_fields.join(',') || 'metering_complete=false')],
      known_scan_bytes: record.sum_scan_bytes,
      tables: [],
    };
  }
  if (!record.tables.length) return { state: 'unknown', reasons: ['无表访问'], tables: [] };

  const components = [];
  for (const table of record.tables) {
    const base = tableBaseCost(table, config);
    if (base.error) {
      return {
        state: 'unknown',
        reasons: [base.error],
        known_scan_bytes: record.sum_scan_bytes,
        tables: [],
      };
    }
    components.push({ table, base });
  }

  const totalAmount = components.reduce((a, c) => a + c.base.amount, 0);
  const totalCents = toCents(totalAmount);

  // 每个表的分摊权重：按数据集配置（bytes / duration / weighted）
  const rows = components.map(({ table, base }) => {
    const rule = allocationRule(config, table.dataset_id);
    const bytesShare = sumOf(components, (c) => c.table.scan_bytes) > 0
      ? table.scan_bytes / sumOf(components, (c) => c.table.scan_bytes) : 0;
    const durationShare = sumOf(components, (c) => c.table.elapsed_ms) > 0
      ? table.elapsed_ms / sumOf(components, (c) => c.table.elapsed_ms) : 0;
    let weight;
    if (rule.method === 'duration') weight = durationShare;
    else if (rule.method === 'weighted') {
      const bw = clampNonNeg(rule.bytes_weight);
      const dw = clampNonNeg(rule.duration_weight);
      weight = bytesShare * bw + durationShare * dw;
    } else weight = bytesShare;
    return {
      dataset_id: table.dataset_id,
      table: table.table,
      scan_bytes: table.scan_bytes,
      elapsed_ms: table.elapsed_ms,
      scan_cost: base.scan,
      compute_cost: base.compute,
      base_amount: base.amount,
      price: base.price,
      method: rule.method,
      bytes_share: bytesShare,
      duration_share: durationShare,
      weight,
      allocated_cents: 0,
      allocated_amount: 0,
    };
  });

  const weightSum = rows.reduce((a, r) => a + r.weight, 0);
  if (!(totalCents > 0) || !(weightSum > 0)) {
    return {
      state: totalCents === 0 ? 'zero' : 'unknown',
      reasons: totalCents === 0 ? [] : ['分摊权重为 0'],
      totalCents: totalCents || 0,
      tables: rows,
    };
  }

  const cents = allocateInteger(totalCents, rows.map((r) => r.weight));
  rows.forEach((r, i) => {
    r.allocated_cents = cents[i];
    r.allocated_amount = fromCents(cents[i]);
  });

  return { state: 'priced', reasons: [], totalCents, tables: rows };
}

function sumOf(arr, fn) {
  return arr.reduce((a, x) => a + (fn(x) || 0), 0);
}

/** 按墙钟重合时长把一笔成本拆到自然月；最后一次拆走余数。 */
export function splitAcrossMonths(record, totalCents) {
  if (totalCents === null) return [];
  const start = new Date(record.started_at).getTime();
  const finish = record.finished_at ? new Date(record.finished_at).getTime() : start;
  const end = Math.max(finish, start);
  if (end === start) {
    return [{ month: monthKey(record.started_at), duration_ms: 0, weight: 1, cents: totalCents }];
  }
  const shards = [];
  let cursorMonth = Date.UTC(
    new Date(start).getUTCFullYear(),
    new Date(start).getUTCMonth(),
    1,
  );
  while (cursorMonth < end) {
    const d = new Date(cursorMonth);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const overlapStart = Math.max(start, cursorMonth);
    const overlapEnd = Math.min(end, next);
    if (overlapEnd > overlapStart) {
      shards.push({
        month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        duration_ms: overlapEnd - overlapStart,
        weight: overlapEnd - overlapStart,
      });
    }
    cursorMonth = next;
  }
  if (!shards.length) return [];
  const cents = allocateInteger(totalCents, shards.map((s) => s.weight));
  return shards.map((s, i) => ({
    ...s,
    total_duration_ms: end - start,
    fraction: s.weight / (end - start),
    cents: cents[i],
  }));
}

/* ------------------------------------------------------------------ */
/* 逻辑查询去重（重试不重复记账）                                        */
/* ------------------------------------------------------------------ */

export function buildLogicalGroups(records, config) {
  const groups = new Map();
  for (const r of records) {
    const key = r.logical_query_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const decisions = new Map();

  for (const [key, attempts] of groups) {
    const sorted = attempts.slice().sort((a, b) =>
      (a.submitted_at || '').localeCompare(b.submitted_at || '') || a.attempt - b.attempt
    );
    const priced = sorted.map((r) => ({ record: r, price: priceQuery(r, config) }));
    // 优先记账到最后一个成功尝试；全部失败/取消时，记消耗最多的尝试。
    let bookedIdx = -1;
    for (let i = priced.length - 1; i >= 0; i -= 1) {
      if (priced[i].price.state === 'priced' && priced[i].record.status === 'success') {
        bookedIdx = i;
        break;
      }
    }
    if (bookedIdx === -1) {
      bookedIdx = priced
        .map((p, i) => ({ i, cents: p.price.totalCents || 0 }))
        .sort((a, b) => b.cents - a.cents || a.i - b.i)[0]?.i ?? 0;
    }
    const booked = priced[bookedIdx];
    const duplicates = priced.filter((_, i) => i !== bookedIdx);
    const failedDuplicates = duplicates.filter((p) => p.record.status !== 'cancelled');
    const cancelledDuplicates = duplicates.filter((p) => p.record.status === 'cancelled');
    decisions.set(key, {
      key,
      attempts: priced,
      booked,
      duplicates,
      failedDuplicates,
      cancelledDuplicates,
      // 失败/超时重试不重复记账，仅作透明展示
      duplicateCents: failedDuplicates.reduce((a, p) => a + (p.price.totalCents || 0), 0),
      // 取消前已消耗的资源照实计入实际成本
      cancelledConsumedCents: cancelledDuplicates.reduce((a, p) => a + (p.price.totalCents || 0), 0),
      unknownDuplicates: duplicates.filter((p) => p.price.state === 'unknown').length,
      retried: priced.length > 1,
    });
  }
  return { groups, decisions };
}

/* ------------------------------------------------------------------ */
/* 核心：准备数据集                                                     */
/* ------------------------------------------------------------------ */

export function prepareDataset(rawRecords, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const accepted = [];
  const rejected = [];
  const sanitizedFields = [];
  const seen = new Set();
  let duplicateIds = 0;

  rawRecords.forEach((raw, index) => {
    const { record: cleaned, dropped } = sanitizeRecord(raw);
    if (dropped.length) sanitizedFields.push({ index, query_id: cleaned.query_id || null, dropped });
    const result = normalizeRecord(cleaned, index);
    if (result.error) {
      rejected.push({ index, error: result.error });
      return;
    }
    if (seen.has(result.record.query_id)) {
      duplicateIds += 1;
      rejected.push({ index, error: `重复 query_id: ${result.record.query_id}`, code: 'duplicate_query_id' });
      return;
    }
    seen.add(result.record.query_id);
    accepted.push(result.record);
  });

  const { groups, decisions } = buildLogicalGroups(accepted, config);

  const prepared = accepted.map((record) => {
    const group = groups.get(record.logical_query_id);
    const decision = decisions.get(record.logical_query_id);
    const price = priceQuery(record, config);
    const booked = decision.booked.record.query_id === record.query_id;
    const cancelledDuplicate = !booked
      && record.status === 'cancelled'
      && price.state === 'priced';
    let chargeType = 'dropped';
    if (booked) chargeType = 'booked';
    else if (cancelledDuplicate) chargeType = 'cancelled-consumption';
    return {
      ...record,
      group_size: group.length,
      is_booked: booked,
      is_duplicate: !booked,
      charge_type: chargeType,
      charged: booked || cancelledDuplicate,
      attempt_of: group.length > 1
        ? [...group].sort((a, b) => a.attempt - b.attempt).map((a) => a.query_id)
        : null,
      computed: price,
      duplicate_cents: booked ? decision.duplicateCents : 0,
      cancelled_consumed_cents: booked ? decision.cancelledConsumedCents : 0,
      retried: decision.retried,
      has_unknown_attempts: decision.unknownDuplicates > 0,
    };
  });

  return {
    config,
    records: prepared,
    groups,
    decisions,
    rejected,
    stats: {
      received: rawRecords.length,
      accepted: prepared.length,
      rejected: rejected.length,
      duplicate_ids: duplicateIds,
      sanitized: sanitizedFields.length,
      sanitized_fields: sanitizedFields,
      unassigned: prepared.filter((r) => r.team_id === null).length,
      unknown_cost: prepared.filter((r) => r.computed.state === 'unknown').length,
      retried_groups: [...decisions.values()].filter((d) => d.retried).length,
      duplicate_attempts: [...decisions.values()].reduce((a, d) => a + d.duplicates.length, 0),
      months: monthList(prepared),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 账单                                                                */
/* ------------------------------------------------------------------ */

function teamCostMap(prepared, config, revisionId) {
  const overrides = overridesForRevision(config, revisionId);
  const map = new Map();
  for (const r of prepared.records) {
    const team = overrides.has(r.query_id) ? overrides.get(r.query_id) : r.team_id;
    const effective = team || UNASSIGNED;
    if (!map.has(r.query_id)) map.set(r.query_id, effective);
  }
  return map;
}

export function buildBill(prepared, month, revisionId, options = {}) {
  const config = prepared.config;
  const resolvedRevision = revisionId === 'auto' || revisionId == null
    ? autoRevision(config, month)
    : getRevision(config, revisionId);
  if (revisionId && revisionId !== 'auto' && !resolvedRevision) {
    throw new Error(`未知归属修订: ${revisionId}`);
  }
  const revision = resolvedRevision || config.revisions[0] || null;
  const overrides = overridesForRevision(config, revision?.id);
  const bounds = monthBounds(month);
  const budgetVersion = budgetForMonth(config, month);
  const budgets = budgetVersion?.teams || {};

  const rows = []; // 每条已记账查询在当月的分摊行
  const unknownQueries = [];
  const duplicateRows = [];
  const notes = [];

  for (const r of prepared.records) {
    if (options.throughDay && new Date(r.started_at).getUTCDate() > options.throughDay) continue;
    const team = (overrides.has(r.query_id) ? overrides.get(r.query_id) : r.team_id) || UNASSIGNED;
    const touchesMonth = touches(r, bounds);
    if (!touchesMonth) continue;

    if (r.computed.state === 'unknown') {
      if (r.is_booked && monthKey(r.started_at) === month) {
        unknownQueries.push({
          query_id: r.query_id,
          logical_query_id: r.logical_query_id,
          team,
          started_at: r.started_at,
          status: r.status,
          known_scan_bytes: r.computed.known_scan_bytes,
          reasons: r.computed.reasons,
          missing_fields: r.missing_fields,
          is_booked: r.is_booked,
        });
      }
      continue;
    }

    if (!r.is_booked && !r.charged) {
      if (monthKey(r.started_at) !== month) continue;
      duplicateRows.push({
        query_id: r.query_id,
        logical_query_id: r.logical_query_id,
        booked_query_id: prepared.decisions.get(r.logical_query_id)?.booked.record.query_id,
        attempt: r.attempt,
        status: r.status,
        consumed_cents: r.computed.state === 'priced' ? r.computed.totalCents : null,
        state: r.computed.state,
        team,
        started_at: r.started_at,
      });
      continue;
    }

    const shards = splitAcrossMonths(r, r.computed.totalCents);
    const shard = shards.find((s) => s.month === month);
    if (!shard) continue;
    const splitIndex = shards.indexOf(shard);

    const tableCents = allocateInteger(shard.cents, r.computed.tables.map((t) => t.weight));
    r.computed.tables.forEach((t, i) => {
      rows.push({
        query_id: r.query_id,
        logical_query_id: r.logical_query_id,
        attempt: r.attempt,
        team,
        team_reported: r.team_id,
        dataset_id: t.dataset_id,
        table: t.table,
        month,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        client: r.client,
        method: t.method,
        scan_bytes: t.scan_bytes,
        elapsed_ms: t.elapsed_ms,
        bytes_share: t.bytes_share,
        duration_share: t.duration_share,
        weight: t.weight,
        scan_cost: t.scan_cost,
        compute_cost: t.compute_cost,
        cents: tableCents[i],
        month_fraction: shard.fraction,
        month_cents: shard.cents,
        cross_month: shards.length > 1,
        split_index: splitIndex,
        splits: shards,
        allocation: r.computed.tables,
        charge_type: r.charge_type,
        duplicate_cents: r.duplicate_cents,
        cancelled_consumed_cents: r.cancelled_consumed_cents,
        attribution_source: overrides.has(r.query_id) ? 'revision' : (r.team_id ? 'log' : 'missing'),
        revision_id: revision?.id || null,
      });
    });
  }

  const attributed = rows.filter((r) => r.team !== UNASSIGNED);
  const unassigned = rows.filter((r) => r.team === UNASSIGNED);

  const attributedCents = sum(attributed, 'cents');
  const unassignedCents = sum(unassigned, 'cents');
  const totalCents = attributedCents + unassignedCents;

  const teamMap = new Map();
  const datasetMap = new Map();
  const dailyMap = new Map();
  const statusMap = new Map();

  for (const row of rows) {
    if (!teamMap.has(row.team)) {
      teamMap.set(row.team, {
        team_id: row.team,
        cents: 0,
        queries: new Set(),
        datasets: new Set(),
        cancelled_cents: 0,
        cross_month_cents: 0,
        revision_cents: 0,
      });
    }
    const t = teamMap.get(row.team);
    t.cents += row.cents;
    t.queries.add(row.query_id);
    t.datasets.add(row.dataset_id);
    if (row.status === 'cancelled') t.cancelled_cents += row.cents;
    if (row.cross_month) t.cross_month_cents += row.cents;
    if (row.attribution_source === 'revision') t.revision_cents += row.cents;

    if (!datasetMap.has(row.dataset_id)) {
      datasetMap.set(row.dataset_id, {
        dataset_id: row.dataset_id,
        cents: 0,
        queries: new Set(),
        teams: new Set(),
        cancelled_cents: 0,
        scan_bytes: 0,
        elapsed_ms: 0,
        tables: new Set(),
      });
    }
    const d = datasetMap.get(row.dataset_id);
    d.cents += row.cents;
    d.queries.add(row.query_id);
    d.teams.add(row.team);
    d.tables.add(row.table);
    d.scan_bytes += row.scan_bytes || 0;
    d.elapsed_ms += row.elapsed_ms || 0;
    if (row.status === 'cancelled') d.cancelled_cents += row.cents;

    const day = row.started_at.slice(0, 10);
    if (!dailyMap.has(day)) dailyMap.set(day, { date: day, teams: new Map(), cents: 0 });
    const dayEntry = dailyMap.get(day);
    dayEntry.cents += row.cents;
    dayEntry.teams.set(row.team, (dayEntry.teams.get(row.team) || 0) + row.cents);

    const st = row.status;
    if (!statusMap.has(st)) statusMap.set(st, { status: st, cents: 0, queries: new Set() });
    statusMap.get(st).cents += row.cents;
    statusMap.get(st).queries.add(row.query_id);
  }

  const teams = [...teamMap.values()]
    .map((t) => {
      const budget = budgets[t.team_id] ?? null;
      return {
        ...t,
        query_count: t.queries.size,
        dataset_count: t.datasets.size,
        amount: fromCents(t.cents),
        budget,
        utilization: budget ? t.cents / 100 / budget : null,
        budget_balance_cents: budget !== null ? toCents(budget) - t.cents : null,
      };
    })
    .sort((a, b) => b.cents - a.cents);

  const datasets = [...datasetMap.values()]
    .map((d) => ({
      ...d,
      query_count: d.queries.size,
      team_count: d.teams.size,
      amount: fromCents(d.cents),
    }))
    .sort((a, b) => b.cents - a.cents);

  const days = [...dailyMap.values()]
    .map((d) => ({ ...d, teams: Object.fromEntries(d.teams) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const statuses = [...statusMap.values()]
    .map((s) => ({ ...s, query_count: s.queries.size, amount: fromCents(s.cents) }))
    .sort((a, b) => b.cents - a.cents);

  const budgetTotal = Object.values(budgets).reduce((a, b) => a + b, 0);
  const budgetBalance = fromCents(toCents(budgetTotal) - attributedCents);

  const cancelledCents = rows.filter((r) => r.status === 'cancelled').reduce((a, r) => a + r.cents, 0);
  const wastedRetryCents = duplicateRows.filter((d) => d.status !== 'cancelled')
    .filter((d) => {
      const t = new Date(d.started_at).getTime();
      return t >= bounds.start && t < bounds.end;
    })
    .reduce((a, d) => a + (d.consumed_cents || 0), 0);
  const unknownKnownBytes = unknownQueries.reduce((a, q) => a + (q.known_scan_bytes || 0), 0);

  const crossMonthRows = rows.filter((r) => r.cross_month);
  const crossMonthCents = crossMonthRows.reduce((a, r) => a + r.cents, 0);

  const queryCosts = new Map();
  for (const row of rows) {
    const key = row.query_id;
    if (!queryCosts.has(key)) {
      queryCosts.set(key, {
        query_id: key,
        logical_query_id: row.logical_query_id,
        team: row.team,
        status: row.status,
        started_at: row.started_at,
        cents: 0,
        datasets: new Set(),
        cross_month: false,
      });
    }
    const q = queryCosts.get(key);
    q.cents += row.cents;
    q.datasets.add(row.dataset_id);
    q.cross_month ||= row.cross_month;
  }

  const queries = [...queryCosts.values()]
    .map((q) => ({ ...q, amount: fromCents(q.cents), dataset_count: q.datasets.size, datasets: [...q.datasets] }))
    .sort((a, b) => b.cents - a.cents);

  return {
    month,
    period: {
      start: new Date(bounds.start).toISOString(),
      end: new Date(bounds.end).toISOString(),
      days: bounds.days,
      complete: Date.now() >= bounds.end,
    },
    revision,
    budgetVersion,
    teams,
    datasets,
    days,
    statuses,
    rows,
    queries,
    unknownQueries,
    duplicateRows,
    totals: {
      attributed_cents: attributedCents,
      unassigned_cents: unassignedCents,
      known_cents: totalCents,
      attributed: fromCents(attributedCents),
      unassigned: fromCents(unassignedCents),
      known: fromCents(totalCents),
      budget_total: budgetTotal,
      budget_balance: budgetBalance,
      budget_balance_cents: toCents(budgetTotal) - attributedCents,
      cancelled_cents: cancelledCents,
      cancelled_amount: fromCents(cancelledCents),
      retry_waste_cents: wastedRetryCents,
      retry_waste: fromCents(wastedRetryCents),
      cancelled_consumed_cents: cancelledCents,
      cancelled_consumed: fromCents(cancelledCents),
      cross_month_cents: crossMonthCents,
      cross_month_amount: fromCents(crossMonthCents),
      unknown_count: unknownQueries.length,
      unknown_known_bytes: unknownKnownBytes,
      booked_query_count: queries.length,
      duplicate_attempt_count: duplicateRows.length,
      duplicate_consumed_cents: duplicateRows.reduce((a, d) => a + (d.consumed_cents || 0), 0),
      duplicate_consumed: fromCents(duplicateRows.reduce((a, d) => a + (d.consumed_cents || 0), 0)),
      attributed_query_count: attributed.length ? new Set(attributed.map((r) => r.query_id)).size : 0,
      unassigned_query_count: new Set(unassigned.map((r) => r.query_id)).size,
      utilization: budgetTotal > 0 ? (attributedCents / 100) / budgetTotal : null,
    },
    notes,
  };
}

function sum(arr, key) {
  return arr.reduce((a, x) => a + (x[key] || 0), 0);
}

function touches(record, bounds) {
  const start = new Date(record.started_at).getTime();
  const finish = record.finished_at ? new Date(record.finished_at).getTime() : start;
  const end = Math.max(finish, start);
  // 零时长查询：按开始时刻归属
  if (end === start) return start >= bounds.start && start < bounds.end;
  return end > bounds.start && start < bounds.end;
}

/* ------------------------------------------------------------------ */
/* 团队查询现金流（用于下钻）                                            */
/* ------------------------------------------------------------------ */

export function queriesForTeam(bill, teamId) {
  const rows = bill.rows.filter((r) => r.team === teamId);
  const byQuery = new Map();
  for (const row of rows) {
    if (!byQuery.has(row.query_id)) byQuery.set(row.query_id, []);
    byQuery.get(row.query_id).push(row);
  }
  return byQuery;
}

/* ------------------------------------------------------------------ */
/* 修订对比                                                             */
/* ------------------------------------------------------------------ */

export function compareRevisions(prepared, month, baseRevisionId, targetRevisionId) {
  const base = buildBill(prepared, month, baseRevisionId);
  const target = buildBill(prepared, month, targetRevisionId);
  if (!base.revision || !target.revision) throw new Error('缺少归属修订版本');

  const baseQuery = new Map(base.queries.map((q) => [q.query_id, q]));
  const targetQuery = new Map(target.queries.map((q) => [q.query_id, q]));
  const ids = new Set([...baseQuery.keys(), ...targetQuery.keys()]);
  const changes = [];

  for (const id of ids) {
    const before = baseQuery.get(id);
    const after = targetQuery.get(id);
    const beforeCents = before?.cents ?? 0;
    const afterCents = after?.cents ?? 0;
    const teamBefore = before?.team ?? null;
    const teamAfter = after?.team ?? null;
    if (beforeCents === afterCents && teamBefore === teamAfter) continue;
    changes.push({
      query_id: id,
      logical_query_id: (after || before)?.logical_query_id,
      team_before: teamBefore,
      team_after: teamAfter,
      cents_before: beforeCents,
      cents_after: afterCents,
      delta_cents: afterCents - beforeCents,
      amount_before: fromCents(beforeCents),
      amount_after: fromCents(afterCents),
      delta: fromCents(afterCents - beforeCents),
      status: (after || before)?.status,
      moved: teamBefore !== teamAfter,
      datasets: (after || before)?.datasets || [],
    });
  }

  // 金额变化优先；金额相同的归属迁移排在其后，再按查询号稳定排序。
  changes.sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents)
    || (b.moved ? 1 : 0) - (a.moved ? 1 : 0)
    || (a.query_id < b.query_id ? -1 : 1));

  const teamDelta = new Map();
  for (const t of target.teams) teamDelta.set(t.team_id, t.cents - (base.teams.find((b) => b.team_id === t.team_id)?.cents || 0));
  for (const b of base.teams) {
    if (!teamDelta.has(b.team_id)) teamDelta.set(b.team_id, -b.cents);
  }

  return {
    month,
    base,
    target,
    totals: {
      base_attributed: base.totals.attributed,
      target_attributed: target.totals.attributed,
      base_attributed_cents: base.totals.attributed_cents,
      target_attributed_cents: target.totals.attributed_cents,
      attributed_delta_cents: target.totals.attributed_cents - base.totals.attributed_cents,
      attributed_delta: fromCents(target.totals.attributed_cents - base.totals.attributed_cents),
      base_unassigned: base.totals.unassigned,
      target_unassigned: target.totals.unassigned,
      base_unassigned_cents: base.totals.unassigned_cents,
      target_unassigned_cents: target.totals.unassigned_cents,
      unassigned_delta_cents: target.totals.unassigned_cents - base.totals.unassigned_cents,
      unassigned_delta: fromCents(target.totals.unassigned_cents - base.totals.unassigned_cents),
      base_balance: base.totals.budget_balance,
      target_balance: target.totals.budget_balance,
      base_balance_cents: base.totals.budget_balance_cents,
      target_balance_cents: target.totals.budget_balance_cents,
      balance_delta_cents: target.totals.budget_balance_cents - base.totals.budget_balance_cents,
      balance_delta: fromCents(target.totals.budget_balance_cents - base.totals.budget_balance_cents),
    },
    changes,
    team_delta: [...teamDelta.entries()].map(([team_id, cents]) => ({
      team_id,
      delta_cents: cents,
      delta: fromCents(cents),
    })).sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents)),
  };
}

/* ------------------------------------------------------------------ */
/* 超额原因                                                             */
/* ------------------------------------------------------------------ */

const REASON_LABELS = {
  dataset_growth: '数据集用量增长',
  cancelled: '取消查询已消耗资源',
  attribution_in: '归属修订转入',
  budget_cut: '预算版本下调',
  cross_month: '跨月查询落入本期',
  other: '用量/单价变化（其他）',
};

/**
 * 对每个超预算团队拆解超额原因。各项金额合计严格等于超额金额，
 * 余量归入「其他」，不做无依据估算。
 */
export function overspendReasons(prepared, month, revisionId = 'auto') {
  const bill = buildBill(prepared, month, revisionId);
  const prevMonth = shiftMonth(month, -1);
  // 与上月「同期」对比：本账期最后一天有数据的日期，避免半月与整月直接比较。
  let lastDay = 0;
  for (const d of bill.days) {
    const day = new Date(d.date).getUTCDate();
    if (day > lastDay) lastDay = day;
  }
  let prevBill = null;
  try {
    prevBill = buildBill(prepared, prevMonth, revisionId, lastDay ? { throughDay: lastDay } : {});
  } catch {
    prevBill = null;
  }

  const config = prepared.config;
  const budgetVersion = bill.budgetVersion;
  const prevBudgetVersion = budgetVersion ? previousBudgetVersion(config, budgetVersion.version) : null;
  const baseRevision = bill.revision ? previousRevision(config, bill.revision.id) : null;
  const baseBill = baseRevision ? buildBill(prepared, month, baseRevision.id) : bill;

  const results = [];
  for (const team of bill.teams) {
    if (team.team_id === UNASSIGNED || team.budget === null) continue;
    const overageCents = Math.max(0, team.cents - toCents(team.budget));
    if (overageCents <= 0) {
      results.push({
        team_id: team.team_id, overage_cents: 0, overage: 0, reasons: [],
        attributed_cents: team.cents, budget: team.budget, utilization: team.utilization,
      });
      continue;
    }

    const teamDatasets = new Map();
    const teamCancelled = { count: 0, cents: 0 };
    let crossMonthCents = 0;
    for (const row of bill.rows) {
      if (row.team !== team.team_id) continue;
      teamDatasets.set(row.dataset_id, (teamDatasets.get(row.dataset_id) || 0) + row.cents);
      if (row.status === 'cancelled') {
        teamCancelled.count += 1;
        teamCancelled.cents += row.cents;
      }
      if (row.cross_month) crossMonthCents += row.cents;
    }
    let growth = 0;
    const growthDatasets = [];
    for (const [datasetId, cents] of teamDatasets) {
      const prev = prevBill?.rows.filter((r) => r.team === team.team_id && r.dataset_id === datasetId)
        .reduce((a, r) => a + r.cents, 0) || 0;
      const delta = cents - prev;
      if (delta > 0) {
        growth += delta;
        growthDatasets.push({ dataset_id: datasetId, delta_cents: delta });
      }
    }
    growthDatasets.sort((a, b) => b.delta_cents - a.delta_cents);

    const attributionIn = Math.max(0, team.cents - (baseBill.teams.find((t) => t.team_id === team.team_id)?.cents || 0));
    const budgetCutCents = prevBudgetVersion?.teams?.[team.team_id] !== undefined && team.budget !== null
      ? Math.max(0, toCents(prevBudgetVersion.teams[team.team_id]) - toCents(team.budget)) : 0;

    const candidates = [
      ['dataset_growth', growth, growthDatasets.length
        ? `较上月同期增长，主要来自 ${growthDatasets.slice(0, 2).map((d) => d.dataset_id).join('、')}` : '无同比增长'],
      ['attribution_in', attributionIn, `较修订 ${baseRevision?.id || '上一版'} 净转入`],
      ['cancelled', teamCancelled.cents, `${teamCancelled.count} 个计费行来自取消查询，取消前已消耗`],
      ['cross_month', crossMonthCents, '跨账期查询按发生时间拆入本期'],
      ['budget_cut', budgetCutCents, prevBudgetVersion
        ? `预算版本 ${prevBudgetVersion.version} → ${budgetVersion.version}，该团队月预算下调` : '无预算版本变化'],
    ];

    let remaining = overageCents;
    const reasons = [];
    for (const [key, amount, detail] of candidates) {
      if (remaining <= 0) break;
      if (!(amount > 0)) continue;
      const used = Math.min(remaining, Math.round(amount));
      reasons.push({
        key,
        label: REASON_LABELS[key],
        cents: used,
        amount: fromCents(used),
        share: used / overageCents,
        detail,
      });
      remaining -= used;
    }
    if (remaining > 0) {
      reasons.push({
        key: 'other',
        label: REASON_LABELS.other,
        cents: remaining,
        amount: fromCents(remaining),
        share: remaining / overageCents,
        detail: '现有维度无法完全解释的用量/单价波动',
      });
    }
    reasons.sort((a, b) => b.cents - a.cents);

    results.push({
      team_id: team.team_id,
      overage_cents: overageCents,
      overage: fromCents(overageCents),
      attributed_cents: team.cents,
      budget: team.budget,
      utilization: team.utilization,
      reasons,
    });
  }
  return results;
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 虚构账单                                                             */
/* ------------------------------------------------------------------ */

export function invoiceNumber(month) {
  return `INV-FIC-${month.replace('-', '')}-01`;
}

export function buildInvoice(prepared, month, revisionId = 'auto') {
  const bill = buildBill(prepared, month, revisionId);
  const lines = bill.teams.map((team) => ({
    kind: 'team',
    team_id: team.team_id,
    description: team.team_id === UNASSIGNED
      ? '未归属查询成本（待认领，不计入团队预算）'
      : `团队 ${team.team_id} · ${team.query_count} 条查询 · ${team.dataset_count} 个数据集`,
    detail_rows: [...queriesForTeam(bill, team.team_id).keys()].length,
    queries: team.query_count,
    cents: team.cents,
    amount: fromCents(team.cents),
    budget: team.budget,
    utilization: team.utilization,
  }));

  const attributedLines = lines.filter((l) => l.team_id !== UNASSIGNED);
  const unassignedLines = lines.filter((l) => l.team_id === UNASSIGNED);

  const subtotalCents = lines.reduce((a, l) => a + l.cents, 0);
  const attributedCents = attributedLines.reduce((a, l) => a + l.cents, 0);

  const unknown = {
    count: bill.totals.unknown_count,
    known_scan_bytes: bill.totals.unknown_known_bytes,
    note: bill.totals.unknown_count
      ? `${bill.totals.unknown_count} 条查询计量缺失或缺少单价，成本未知，未计入账单，也未平摊。`
      : '本期无未知成本查询。',
  };

  return {
    fictional: true,
    invoice_no: invoiceNumber(month),
    issued_at: new Date().toISOString().slice(0, 10),
    billed_to: '星图数仓运营中心（虚构账期结算）',
    period: { month, start: bill.period.start.slice(0, 10), end: shiftDay(bill.period.end, -1) },
    bill,
    lines,
    unassigned_lines: unassignedLines,
    attributed_lines: attributedLines,
    subtotal_cents: subtotalCents,
    attributed_cents: attributedCents,
    unassigned_cents: bill.totals.unassigned_cents,
    budget_balance: bill.totals.budget_balance,
    unknown,
    revision: bill.revision?.id || null,
    note: '本账单为虚构演示数据，不对应任何真实计费 API、合同或付款义务。',
    payment_terms: '虚构账期：账期结束后 15 日内核对，演示环境不产生实际应收。',
  };
}

function shiftDay(iso, delta) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 生成账单 HTML（可下载的虚构账单）。 */
export function renderInvoiceHTML(invoice, money) {
  const rows = invoice.lines.map((l) => `
      <tr>
        <td>${escapeHTML(l.description)}</td>
        <td class="num">${escapeHTML(money(l.amount))}</td>
        <td class="num">${l.budget !== null ? escapeHTML(money(l.budget)) : '—'}</td>
      </tr>`).join('');
  const unknownBlock = invoice.unknown.count
    ? `<div class="notice"><strong>待计量 ${invoice.unknown.count} 条</strong>${escapeHTML(invoice.unknown.note)} 已知扫描量 ${(invoice.unknown.known_scan_bytes / GB_BYTES).toFixed(2)} GB。</div>`
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHTML(invoice.invoice_no)} · 虚构账单</title>
<style>
  body{margin:0;background:#f9f9f7;color:#0b0b0b;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  .sheet{max-width:780px;margin:32px auto;background:#fcfcfb;border:1px solid rgba(11,11,11,.1);border-radius:16px;padding:40px 44px;position:relative}
  h1{font-size:24px;margin:0 0 4px} .brand{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e1e0d9;padding-bottom:24px;margin-bottom:24px}
  .stamp{position:absolute;top:34px;right:40px;border:2px solid #d03b3b;color:#d03b3b;padding:4px 10px;border-radius:4px;font-size:12px;letter-spacing:.18em;transform:rotate(-6deg)}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;color:#52514e;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:24px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e1e0d9}
  th{font-size:12px;color:#52514e;font-weight:600} .num{text-align:right;font-variant-numeric:tabular-nums}
  .total{display:flex;justify-content:space-between;font-size:18px;font-weight:650;border-top:2px solid #0b0b0b;margin-top:8px;padding-top:14px}
  .notice{margin-top:20px;padding:12px 14px;border-radius:8px;background:#fff4d6;border:1px solid #fab219;color:#52514e;font-size:13px}
  .foot{margin-top:30px;color:#898781;font-size:12px;border-top:1px solid #e1e0d9;padding-top:16px}
</style></head><body><div class="sheet">
  <div class="stamp">虚构 FICTIONAL</div>
  <div class="brand"><div><h1>数仓资源结算单</h1><div style="color:#52514e">星图数仓 · 资源与成本治理</div></div>
    <div style="text-align:right;color:#52514e;font-size:13px"><div>${escapeHTML(invoice.invoice_no)}</div><div>${escapeHTML(invoice.issued_at)}</div></div></div>
  <div class="meta">
    <div>账单周期：${escapeHTML(invoice.period.start)} — ${escapeHTML(invoice.period.end)}</div>
    <div>归属修订：${escapeHTML(invoice.revision || '—')}</div>
    <div>账单抬头：${escapeHTML(invoice.billed_to)}</div>
    <div>币种：USD（虚构）</div>
  </div>
  <table><thead><tr><th>结算项目</th><th class="num">本期金额</th><th class="num">月预算</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="total"><span>本期账单合计（含未归属）</span><span>${escapeHTML(money(invoice.subtotal_cents / 100))}</span></div>
  <div class="meta" style="margin-top:10px"><div>已归属：${escapeHTML(money(invoice.attributed_cents / 100))}</div><div>未归属：${escapeHTML(money(invoice.unassigned_cents / 100))}</div><div>预算未分配余额：${escapeHTML(money(invoice.budget_balance))}</div></div>
  ${unknownBlock}
  <div class="foot">${escapeHTML(invoice.note)} ${escapeHTML(invoice.payment_terms)}</div>
</div></body></html>`;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------------------------------------------ */
/* 视图辅助                                                             */
/* ------------------------------------------------------------------ */

/** 某查询在账单中的展示详情：分摊中间值、跨月拆分、重试链。 */
export function queryDetail(prepared, bill, queryId) {
  const rows = bill.rows.filter((r) => r.query_id === queryId);
  if (!rows.length) {
    const unknown = bill.unknownQueries.find((q) => q.query_id === queryId);
    if (unknown) return { kind: 'unknown', unknown };
    return null;
  }
  const record = prepared.records.find((r) => r.query_id === queryId);
  const group = prepared.decisions.get(record.logical_query_id);
  return {
    kind: 'billed',
    query_id: queryId,
    logical_query_id: record.logical_query_id,
    record,
    log_team: record.team_id,
    effective_team: rows[0].team,
    attribution_source: rows[0].attribution_source,
    revision_id: rows[0].revision_id,
    status: record.status,
    started_at: record.started_at,
    finished_at: record.finished_at,
    wall_ms: record.wall_ms,
    method: rows[0].method,
    month_fraction: rows[0].month_fraction,
    month_cents: rows[0].month_cents,
    total_cents: record.computed.totalCents,
    cross_month: rows[0].cross_month,
    splits: rows[0].splits,
    allocation: rows[0].allocation,
    rows,
    attempts: group ? group.attempts.map((p) => ({
      query_id: p.record.query_id,
      attempt: p.record.attempt,
      status: p.record.status,
      started_at: p.record.started_at,
      cents: p.price.totalCents,
      state: p.price.state,
      booked: p.record.query_id === group.booked.record.query_id,
      reasons: p.price.reasons,
    })) : [],
    duplicate_cents: group ? group.duplicateCents : 0,
    revision_history: prepared.config.revisions
      .filter((rev) => (rev.changes || []).some((c) => c.query_id === queryId))
      .map((rev) => ({
        revision: rev.id,
        effective_date: rev.effective_date,
        author: rev.author,
        note: rev.note,
        change: rev.changes.find((c) => c.query_id === queryId),
      })),
  };
}

/** 团队下钻：返回该团队本期查询（按成本降序）。 */
export function teamQueries(bill, teamId) {
  return bill.queries.filter((q) => q.team === teamId);
}

/** 总览统计：用作页头摘要。 */
export function summaryMetrics(bill) {
  return [
    { key: 'attributed', label: '已归属成本', cents: bill.totals.attributed_cents, tone: 'neutral' },
    { key: 'unassigned', label: '未归属成本', cents: bill.totals.unassigned_cents, tone: 'warning' },
    { key: 'retry', label: '未重复记账的重试消耗', cents: bill.totals.retry_waste_cents, tone: 'warning' },
    { key: 'cancelled', label: '取消前已消耗（照实计费）', cents: bill.totals.cancelled_consumed_cents, tone: 'serious' },
  ];
}
