/**
 * 视图模型：纯函数，负责形成图表数据、格式化和例外归类。
 * 不触碰 DOM，便于单元测试。
 */
import { monthBounds, monthKey, UNASSIGNED, UNKNOWN, fromCents, toCents } from './engine.js';

export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export const NEUTRAL = { light: '#898781', dark: '#898781' };
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

export function formatMoney(cents, { sign = false } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const v = cents / 100;
  const abs = Math.abs(v);
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prefix = v < 0 ? '-' : (sign && v > 0 ? '+' : '');
  return `${prefix}$${body}`;
}

export function formatMoneyCompact(cents) {
  if (cents === null || cents === undefined) return '—';
  const v = Math.abs(cents) / 100;
  const sign = cents < 0 ? '-' : '';
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${sign}$${(v / 1_000).toFixed(0)}K`;
  if (v >= 1_000) return `${sign}$${(v / 1_000).toFixed(1)}K`;
  return `${sign}$${v.toFixed(0)}`;
}

export function formatPct(ratio, digits = 0) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m ${rest}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatDateISO(dateStr) {
  return String(dateStr || '').slice(0, 10);
}

export function formatMonth(month) {
  const [y, m] = month.split('-');
  return `${y} 年 ${Number(m)} 月`;
}

export function formatSignedMoney(cents) {
  return formatMoney(cents, { sign: true });
}

export function statusLabel(status) {
  return ({
    success: '成功',
    failed: '失败',
    cancelled: '已取消',
    timeout: '超时',
  })[status] || status || '未知';
}

export function statusTone(status) {
  return ({
    success: 'good',
    failed: 'critical',
    cancelled: 'serious',
    timeout: 'warning',
  })[status] || 'neutral';
}

/* ------------------------------------------------------------------ */
/* 团队序列                                                            */
/* ------------------------------------------------------------------ */

export function teamName(config, teamId) {
  if (teamId === UNASSIGNED) return '未归属';
  return config?.teams?.[teamId]?.name || teamId || '未知团队';
}

export function datasetName(config, datasetId) {
  return config?.prices?.datasets?.[datasetId]?.name || datasetId;
}

/** 团队 → 固定色位。颜色跟随团队实体，不随排名变化。 */
export function buildTeamSeries(config, bill) {
  const known = bill.teams.filter((t) => t.team_id !== UNASSIGNED);
  const configured = config?.teams || {};
  const slots = new Map();
  for (const [id, meta] of Object.entries(configured)) {
    if (Number.isInteger(meta.color_slot) && meta.color_slot >= 1 && meta.color_slot <= 8) {
      slots.set(id, meta.color_slot);
    }
  }
  let nextSlot = 1;
  const ordered = [...known].sort((a, b) => a.team_id.localeCompare(b.team_id));
  for (const t of ordered) {
    if (slots.has(t.team_id)) continue;
    while ([...slots.values()].includes(nextSlot)) nextSlot += 1;
    slots.set(t.team_id, Math.min(nextSlot, 8));
    nextSlot += 1;
  }
  const overflow = ordered.filter((t) => slots.get(t.team_id) === 8 && !configured[t.team_id] && ordered.length > 8);
  const overflowIds = new Set(overflow.map((t) => t.team_id));
  const teams = ordered
    .filter((t) => !overflowIds.has(t.team_id))
    .map((t) => ({
      key: t.team_id,
      label: teamName(config, t.team_id),
      slot: slots.get(t.team_id),
      kind: 'team',
    }));
  const hasOverflow = overflowIds.size > 0;
  if (hasOverflow) {
    teams.push({ key: '__other__', label: '其他团队', slot: 8, kind: 'other', members: [...overflowIds] });
  }
  return {
    teams,
    unassigned: { key: UNASSIGNED, label: '未归属', slot: null, kind: 'unassigned' },
    overflowIds,
  };
}

/* ------------------------------------------------------------------ */
/* 按日期堆叠                                                          */
/* ------------------------------------------------------------------ */

export function niceTicks(maxCents, target = 4) {
  if (!(maxCents > 0)) return [0];
  const raw = maxCents / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  const ticks = [];
  for (let v = 0; v <= maxCents + step * 0.001; v += step) ticks.push(Math.round(v));
  if (ticks[ticks.length - 1] < maxCents) ticks.push(Math.round(ticks[ticks.length - 1] + step));
  return ticks;
}

/**
 * 每日堆叠柱状图模型。
 * 返回 dates、series、values（cents）、max、ticks；缺数据的日期以 0 补足。
 */
export function buildDailyModel(bill, seriesInfo, { maxDate = null } = {}) {
  const bounds = monthBounds(bill.month);
  // 结束日取「账期内最后一个有数据的日期」，使图表与数据快照一致，不依赖系统时钟。
  let last = null;
  for (const d of bill.days) {
    const t = new Date(d.date).getTime();
    if (t >= bounds.start && t < bounds.end) last = d.date;
  }
  if (maxDate && (!last || maxDate < last)) last = maxDate;
  const end = last ? Math.min(bounds.end, new Date(last).getTime() + 86_400_000) : bounds.start;
  const dates = [];
  for (let t = bounds.start; t < end; t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }

  const entries = [...seriesInfo.teams, seriesInfo.unassigned];
  const values = dates.map((date) => {
    const source = bill.days.find((d) => d.date === date);
    const row = { date, total: 0, byKey: {} };
    for (const entry of entries) {
      let cents = 0;
      if (source) {
        if (entry.kind === 'other') {
          for (const id of entry.members) cents += source.teams[id] || 0;
        } else {
          cents = source.teams[entry.key] || 0;
        }
      }
      row.byKey[entry.key] = cents;
      row.total += cents;
    }
    return row;
  });

  const max = Math.max(0, ...values.map((v) => v.total));
  return { dates, entries, values, max, ticks: niceTicks(max) };
}

/* ------------------------------------------------------------------ */
/* 拆分中间值                                                          */
/* ------------------------------------------------------------------ */

export function allocationFormula(row) {
  if (row.method === 'duration') return '按耗时占比';
  if (row.method === 'weighted') {
    const bytesW = 0.6;
    const durationW = 0.4;
    return `按字节×${bytesW} + 时长×${durationW} 加权`;
  }
  return '按扫描字节占比';
}

export function allocationRuleLabel(config, datasetId) {
  const rule = config?.allocation?.datasets?.[datasetId];
  if (!rule) return '字节占比（默认）';
  if (rule.method === 'duration') return '时长占比';
  if (rule.method === 'weighted') {
    return `字节×${rule.bytes_weight} + 时长×${rule.duration_weight}`;
  }
  return '字节占比';
}

/* ------------------------------------------------------------------ */
/* 例外归类                                                            */
/* ------------------------------------------------------------------ */

function monthTouches(record, month) {
  const start = new Date(record.started_at).getTime();
  const finish = record.finished_at ? new Date(record.finished_at).getTime() : start;
  const b = monthBounds(month);
  return Math.max(finish, start) > b.start && start < b.end;
}

export function buildExceptions(prepared, bill, config) {
  const month = bill.month;
  const overrides = new Map();
  const groups = [];

  for (const [key, decision] of prepared.decisions) {
    if (!decision.retried) continue;
    if (!decision.attempts.some((p) => monthTouches(p.record, month))) continue;
    const booked = decision.booked;
    groups.push({
      logical_query_id: key,
      booked: {
        query_id: booked.record.query_id,
        status: booked.record.status,
        started_at: booked.record.started_at,
        cents: booked.price.totalCents,
        state: booked.price.state,
        team: booked.record.team_id,
      },
      attempts: decision.attempts.map((p) => ({
        query_id: p.record.query_id,
        attempt: p.record.attempt,
        status: p.record.status,
        started_at: p.record.started_at,
        cents: p.price.totalCents,
        state: p.price.state,
        booked: p === booked,
        charged: p === booked || p.record.status === 'cancelled',
        reasons: p.price.reasons,
      })),
      dropped_cents: decision.duplicateCents,
      cancelled_consumed_cents: decision.cancelledConsumedCents,
    });
  }
  const retries = groups.sort((a, b) => b.dropped_cents - a.dropped_cents);

  const cancelMap = new Map();
  for (const row of bill.rows) {
    if (row.status !== 'cancelled') continue;
    if (!cancelMap.has(row.query_id)) {
      cancelMap.set(row.query_id, {
        query_id: row.query_id,
        logical_query_id: row.logical_query_id,
        team: row.team,
        started_at: row.started_at,
        cents: 0,
        cross_month: row.cross_month,
        retried: prepared.decisions.get(row.logical_query_id)?.retried || false,
        datasets: new Set(),
      });
    }
    const entry = cancelMap.get(row.query_id);
    entry.cents += row.cents;
    entry.datasets.add(row.dataset_id);
  }
  const cancels = [...cancelMap.values()].sort((a, b) => b.cents - a.cents);

  const unassignedMap = new Map();
  for (const row of bill.rows) {
    if (row.team !== UNASSIGNED) continue;
    if (!unassignedMap.has(row.query_id)) {
      unassignedMap.set(row.query_id, {
        query_id: row.query_id,
        logical_query_id: row.logical_query_id,
        status: row.status,
        started_at: row.started_at,
        cents: 0,
        datasets: new Set(),
        reason: row.team_reported ? '日志团队为空' : '缺团队归属',
      });
    }
    const entry = unassignedMap.get(row.query_id);
    entry.cents += row.cents;
    entry.datasets.add(row.dataset_id);
  }
  const unassigned = [...unassignedMap.values()].sort((a, b) => b.cents - a.cents);

  const unknown = bill.unknownQueries
    .map((q) => ({
      ...q,
      team_label: teamName(config, q.team),
      reason_group: q.reasons[0]?.startsWith('数据集未配置单价') ? 'missing_price' : 'missing_metering',
    }))
    .sort((a, b) => a.query_id.localeCompare(b.query_id));

  const crossMonth = new Map();
  for (const row of bill.rows) {
    if (!row.cross_month) continue;
    const key = row.query_id;
    if (!crossMonth.has(key)) {
      crossMonth.set(key, {
        query_id: key,
        team: row.team,
        status: row.status,
        started_at: row.started_at,
        splits: row.splits,
        total_cents: row.month_cents * row.splits.length,
        this_month_cents: 0,
      });
    }
    const entry = crossMonth.get(key);
    entry.this_month_cents += row.cents;
  }

  return {
    retries,
    cancels,
    unassigned,
    unknown,
    crossMonth: [...crossMonth.values()],
  };
}

/* ------------------------------------------------------------------ */
/* 账单对比辅助                                                        */
/* ------------------------------------------------------------------ */

/** 对比摘要：金额一律以「分」为单位，供 UI 统一格式化。 */
export function compareSummary(compare) {
  return [
    {
      key: 'attributed',
      label: '已归属总额',
      base: compare.totals.base_attributed_cents,
      target: compare.totals.target_attributed_cents,
      delta: compare.totals.attributed_delta_cents,
    },
    {
      key: 'unassigned',
      label: '未分配余额',
      base: compare.totals.base_unassigned_cents,
      target: compare.totals.target_unassigned_cents,
      delta: compare.totals.unassigned_delta_cents,
    },
    {
      key: 'balance',
      label: '预算未分配余额',
      base: compare.totals.base_balance_cents,
      target: compare.totals.target_balance_cents,
      delta: compare.totals.balance_delta_cents,
    },
  ];
}

export function teamAmountDelta(baseBill, targetBill) {
  const baseMap = new Map(baseBill.teams.map((t) => [t.team_id, t.cents]));
  const targetMap = new Map(targetBill.teams.map((t) => [t.team_id, t.cents]));
  const ids = new Set([...baseMap.keys(), ...targetMap.keys()]);
  return [...ids].map((id) => ({
    team_id: id,
    base_cents: baseMap.get(id) || 0,
    target_cents: targetMap.get(id) || 0,
    delta_cents: (targetMap.get(id) || 0) - (baseMap.get(id) || 0),
  })).sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents));
}

/* ------------------------------------------------------------------ */
/* 图表几何                                                            */
/* ------------------------------------------------------------------ */

export function stackedGeometry(model, plot, { bandRatio = 0.62, gap = 2 } = {}) {
  const { width, height } = plot;
  const y = (cents) => height - (model.max > 0 ? (cents / model.max) * height : 0);
  const band = width / Math.max(1, model.dates.length);
  const barWidth = Math.min(24, band * bandRatio);
  return model.values.map((day, i) => {
    const x = i * band + (band - barWidth) / 2;
    let cum = 0;
    const segments = [];
    for (const entry of model.entries) {
      const cents = day.byKey[entry.key] || 0;
      if (cents <= 0) continue;
      const y0 = y(cum);
      const y1 = y(cum + cents);
      segments.push({
        key: entry.key,
        label: entry.label,
        kind: entry.kind,
        slot: entry.slot,
        cents,
        x,
        width: barWidth,
        top: y1,
        bottom: y0 - (segments.length > 0 ? 0 : 0),
        height: Math.max(0, y0 - y1),
        isTop: false,
      });
      cum += cents;
    }
    if (segments.length) segments[segments.length - 1].isTop = true;
    return {
      date: day.date,
      x,
      band,
      barWidth,
      cents: day.total,
      top: segments.length ? segments[segments.length - 1].top : y(0),
      segments: segments.map((s, idx) => ({
        ...s,
        height: Math.max(0, s.height - (idx > 0 ? gap : 0)),
        bottom: s.bottom - (idx > 0 ? gap : 0),
      })),
    };
  });
}

export function tickLabels(ticks) {
  return ticks.map((t) => ({
    value: t,
    label: formatMoneyCompact(t),
  }));
}

/** 数据集排名（单序列、单色）。 */
export function datasetRanking(bill, config) {
  const items = bill.datasets.map((d) => ({
    key: d.dataset_id,
    label: datasetName(config, d.dataset_id),
    cents: d.cents,
    queryCount: d.query_count,
    teams: d.team_count,
    cancelled: d.cancelled_cents,
    scanBytes: d.scan_bytes,
    elapsedMs: d.elapsed_ms,
    unknownPrice: !config?.prices?.datasets?.[d.dataset_id],
  }));
  const max = Math.max(0, ...items.map((i) => i.cents));
  return items.map((i) => ({ ...i, ratio: max ? i.cents / max : 0, max }));
}

/** 团队预算条：预算轨道 + 超支段。 */
export function teamBudgetModel(bill) {
  const rows = bill.teams.filter((t) => t.team_id !== UNASSIGNED);
  const maxUtil = Math.max(1, ...rows.map((t) => t.utilization || 0)) * 1.02;
  return rows.map((t) => {
    const util = t.utilization;
    const over = Math.max(0, (util || 0) - 1);
    return {
      ...t,
      scale: maxUtil,
      spendRatio: Math.min(1, (util || 0)) / maxUtil,
      overRatio: Math.min(over, maxUtil - 1) / maxUtil,
      overPct: over > 0 ? over : 0,
    };
  });
}

export function monthOptions(prepared) {
  return prepared.stats.months.slice();
}

export function revisionOptions(config, month) {
  return config.revisions.map((r) => ({
    id: r.id,
    label: `${r.id} · ${r.effective_date}`,
    note: r.note,
    changes: (r.changes || []).length,
    active: r.id === (billRevisionFor(config, month)?.id || ''),
  }));
}

export function billRevisionFor(config, month) {
  const bounds = monthBounds(month);
  const cutoff = new Date(bounds.end - 1).toISOString().slice(0, 10);
  const eligible = config.revisions.filter((r) => r.effective_date <= cutoff);
  return eligible.length ? eligible[eligible.length - 1] : config.revisions[0] || null;
}

export function budgetLabel(version) {
  return version ? `${version.version} · 自 ${version.effective_month} 生效` : '未配置预算';
}

export function percentOf(part, whole) {
  if (!whole) return 0;
  return part / whole;
}

export function sumTeamAmounts(bill) {
  return bill.teams.filter((t) => t.team_id !== UNASSIGNED).reduce((a, t) => a + t.cents, 0);
}

export { UNASSIGNED, UNKNOWN, fromCents, toCents };
