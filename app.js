/**
 * 界面层：读取本地 API 或内嵌样例数据，渲染全部视图。
 * 所有动态文本均通过 textContent / 转义写入，不拼接不可信字符串。
 */
import {
  prepareDataset, buildBill, compareRevisions, overspendReasons, buildInvoice,
  renderInvoiceHTML, queryDetail, fromCents, toCents, UNASSIGNED,
  monthList, shiftMonth, autoRevision,
} from '/src/engine.js';
import { parseCSV, rowsToQueries } from '/src/csv.js';
import * as V from '/src/view.js';
import { stackedDaily } from '/src/charts.js';

const state = {
  config: null,
  rawRows: null,
  prepared: null,
  month: null,
  revisionId: 'auto',
  compareRevisionId: null,
  dailyView: 'chart',
  exceptionTab: 'overview',
  highlightedTeam: null,
  drawerStack: [],
  dataSource: '',
};

const el = {
  main: document.getElementById('main'),
  month: document.getElementById('month-select'),
  revision: document.getElementById('revision-select'),
  compare: document.getElementById('compare-select'),
  filterNote: document.getElementById('filter-note'),
  kpiRow: document.getElementById('kpi-row'),
  dailyLegend: document.getElementById('daily-legend'),
  dailyChart: document.getElementById('daily-chart'),
  dailyTable: document.getElementById('daily-table'),
  dailySub: document.getElementById('daily-sub'),
  dailyFootnote: document.getElementById('daily-footnote'),
  budgetList: document.getElementById('budget-list'),
  budgetSub: document.getElementById('budget-sub'),
  datasetRank: document.getElementById('dataset-rank'),
  reasonList: document.getElementById('reason-list'),
  reasonSub: document.getElementById('reason-sub'),
  exceptionTabs: document.getElementById('exception-tabs'),
  exceptionBody: document.getElementById('exception-body'),
  billPreview: document.getElementById('bill-preview'),
  billCompare: document.getElementById('bill-compare'),
  revisionHistory: document.getElementById('revision-history'),
  budgetHistory: document.getElementById('budget-history'),
  configForms: document.getElementById('config-forms'),
  tooltip: document.getElementById('tooltip'),
  drawer: document.getElementById('drawer'),
  drawerBody: document.getElementById('drawer-body'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerBack: document.getElementById('drawer-back'),
  scrim: document.getElementById('scrim'),
  toast: document.getElementById('toast'),
  dataSource: document.getElementById('data-source'),
  orgName: document.getElementById('org-name'),
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function money(cents) { return V.formatMoney(cents); }
function teamLabel(teamId) { return V.teamName(state.config, teamId); }
function datasetLabel(id) { return V.datasetName(state.config, id); }
function slotColor(slot) {
  return slot ? `var(--series-${slot})` : 'var(--series-unassigned)';
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

async function loadData() {
  const configResp = await fetch('/api/config');
  if (!configResp.ok) throw new Error('配置加载失败，请先运行 npm run fixtures');
  state.config = await configResp.json();

  const queriesResp = await fetch('/api/queries');
  if (!queriesResp.ok) throw new Error('查询记录加载失败，请先运行 npm run fixtures');
  const payload = await queriesResp.json();
  state.dataSource = payload.source;
  if (payload.format === 'csv') {
    const rows = parseCSV(payload.csv);
    state.rawRows = rowsToQueries(rows);
  } else {
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    state.rawRows = payload.format === 'table' ? rowsToQueries(rows) : rows.map((r) => {
      if (Array.isArray(r.tables)) return r;
      return null;
    }).filter(Boolean);
    if (!state.rawRows.length) state.rawRows = rowsToQueries(rows);
  }

  rebuild();
}

function rebuild({ keepView = true } = {}) {
  const previousMonth = state.month;
  state.prepared = prepareDataset(state.rawRows, state.config);
  const months = monthList(state.prepared.records);
  if (!months.length) throw new Error('没有可用的账期数据');
  state.month = previousMonth && months.includes(previousMonth) ? previousMonth : months[months.length - 1];
  if (state.compareRevisionId === null || !state.config.revisions.some((r) => r.id === state.compareRevisionId)) {
    const active = autoRevision(state.config, state.month);
    const earlier = state.config.revisions.filter((r) => r.seq < (active?.seq ?? Infinity));
    state.compareRevisionId = earlier.length ? earlier[earlier.length - 1].id : null;
  }
  state.bill = buildBill(state.prepared, state.month, state.revisionId === 'auto' ? 'auto' : state.revisionId);
  state.series = V.buildTeamSeries(state.config, state.bill);
  renderAll();
}

/* ------------------------------------------------------------------ */
/* 渲染：筛选                                                          */
/* ------------------------------------------------------------------ */

function renderFilters() {
  const months = monthList(state.prepared.records);

  clear(el.month);
  for (const m of months.slice().reverse()) {
    const opt = h('option', { value: m, text: `${V.formatMonth(m)}${m === months[months.length - 1] ? '（当前）' : ''}` });
    el.month.append(opt);
  }
  el.month.value = state.month;

  clear(el.revision);
  const auto = h('option', { value: 'auto', text: `自动（按生效日期）· ${autoRevision(state.config, state.month)?.id || '—'}` });
  el.revision.append(auto);
  for (const rev of state.config.revisions) {
    el.revision.append(h('option', {
      value: rev.id,
      text: `${rev.id} · ${rev.effective_date}`,
    }));
  }
  el.revision.value = state.revisionId;

  clear(el.compare);
  el.compare.append(h('option', { value: '', text: '不对比' }));
  const currentRevision = state.bill.revision;
  for (const rev of state.config.revisions) {
    if (currentRevision && rev.seq >= currentRevision.seq) continue;
    el.compare.append(h('option', {
      value: rev.id,
      text: `${rev.id}（较此版重述）`,
    }));
  }
  el.compare.value = state.compareRevisionId || '';

  const rev = state.bill.revision;
  const budget = state.bill.budgetVersion;
  clear(el.filterNote);
  el.filterNote.append(
    h('span', { text: `修订 ${rev?.id || '—'} · ${budget?.version || '无预算'} · ${state.bill.totals.booked_query_count} 条计费查询` }),
  );
}

/* ------------------------------------------------------------------ */
/* 渲染：KPI                                                           */
/* ------------------------------------------------------------------ */

function renderKpis() {
  const totals = state.bill.totals;
  const budgetTotal = toCents(totals.budget_total);
  const balance = totals.budget_balance_cents;
  const known = totals.known_cents;

  const cards = [
    {
      label: '已归属成本',
      value: money(totals.attributed_cents),
      sub: `${totals.attributed_query_count} 条查询 · ${state.bill.teams.filter((t) => t.team_id !== UNASSIGNED).length} 个团队`,
      slot: 1,
    },
    {
      label: '未归属成本',
      value: money(totals.unassigned_cents),
      sub: totals.unassigned_cents > 0
        ? `${totals.unassigned_query_count} 条缺团队 · 待认领，不摊给其他团队`
        : '本期无缺归属查询',
      tone: totals.unassigned_cents > 0 ? 'warn' : null,
      dotColor: 'var(--series-unassigned)',
    },
    {
      label: '未知成本查询',
      value: `${totals.unknown_count} 条`,
      valueCompact: true,
      sub: totals.unknown_count
        ? `已知扫描 ${V.formatBytes(totals.unknown_known_bytes)} · 金额未知，未估算`
        : '计量完整',
      tone: totals.unknown_count ? 'warn' : null,
    },
    {
      label: '预算结余',
      value: money(balance),
      sub: budgetTotal > 0
        ? `总额 ${money(budgetTotal)} · 使用 ${V.formatPct(totals.utilization, 1)}`
        : '未配置预算版本',
      tone: balance < 0 ? 'bad' : null,
    },
    {
      label: '重试 / 取消',
      value: `${totals.duplicate_attempt_count} / ${state.bill.duplicateRows.filter((d) => d.status === 'cancelled').length + state.bill.rows.filter((r) => r.status === 'cancelled' && r.charge_type === 'booked').length}`,
      valueCompact: true,
      sub: `未重复记账的重试消耗 ${money(totals.retry_waste_cents)} · 取消已消耗 ${money(totals.cancelled_consumed_cents)}`,
      tone: totals.retry_waste_cents > 0 ? 'warn' : null,
    },
  ];

  clear(el.kpiRow);
  for (const c of cards) {
    el.kpiRow.append(h('div', { class: `kpi${c.tone === 'bad' ? ' is-bad' : c.tone === 'warn' ? ' is-warn' : ''}` },
      h('div', { class: 'kpi-label' },
        c.slot ? h('span', { class: 'dot', style: `background:${slotColor(c.slot)}` }) : null,
        c.dotColor ? h('span', { class: 'dot', style: `background:${c.dotColor}` }) : null,
        c.label,
      ),
      h('div', { class: `kpi-value${c.valueCompact ? ' compact' : ''}`, text: c.value }),
      h('div', { class: 'kpi-sub', text: c.sub }),
    ));
  }
}

/* ------------------------------------------------------------------ */
/* 渲染：每日                                                          */
/* ------------------------------------------------------------------ */

function renderDaily() {
  const model = V.buildDailyModel(state.bill, state.series);
  const totals = state.bill.totals;
  clear(el.dailyLegend);
  const entries = [...state.series.teams];
  if (totals.unassigned_cents > 0) entries.push(state.series.unassigned);
  if (!entries.length) {
    el.dailyLegend.append(h('span', { class: 'legend-item', text: '本期无已计费记录' }));
  }
  for (const entry of entries) {
    const sum = state.bill.teams.find((t) => t.team_id === entry.key)?.cents
      ?? (entry.kind === 'other'
        ? [...entry.members].reduce((a, id) => a + (state.bill.teams.find((t) => t.team_id === id)?.cents || 0), 0)
        : null);
    el.dailyLegend.append(h('span', { class: 'legend-item', title: entry.label },
      h('span', { class: 'swatch', style: `background:${slotColor(entry.slot)}` }),
      `${entry.label}`,
    ));
  }
  el.dailySub.textContent = `${V.formatMonth(state.month)} · 按团队堆叠 · 共 ${state.bill.totals.booked_query_count} 条计费查询`;

  if (state.dailyView === 'table') {
    el.dailyChart.hidden = true;
    el.dailyTable.hidden = false;
    renderDailyTable(model, entries);
    return;
  }
  el.dailyTable.hidden = true;
  el.dailyChart.hidden = false;
  const width = Math.max(360, el.dailyChart.clientWidth || 900);
  clear(el.dailyChart);
  if (!model.dates.length || model.max === 0) {
    el.dailyChart.append(h('div', { class: 'chart-empty', text: '本期没有可计费的资源消耗记录。' }));
    el.dailyFootnote.textContent = '';
    return;
  }
  const chart = stackedDaily(model, state.series, { width });
  el.dailyChart.innerHTML = chart.svg;

  const peak = model.values[chart.peakIndex];
  if (peak) {
    el.dailySub.textContent = `${V.formatMonth(state.month)} · 按团队堆叠 · 峰值 ${peak.date} ${money(peak.total)}`;
  }
  el.dailyFootnote.textContent = '仅统计已核实计量的已归属与未归属成本；未知成本不进入图表。悬停或聚焦柱体可查看当日各团队金额。';
  attachDailyInteractions(model, chart);
}

function attachDailyInteractions(model, chart) {
  const svg = el.dailyChart.querySelector('svg');
  if (!svg) return;
  let activeIndex = null;

  const hitFor = (index) => svg.querySelector(`.bar-group[data-index="${index}"] .bar-hit`);
  const dimOthers = (index) => {
    svg.querySelectorAll('.bar-seg').forEach((seg) => {
      const group = seg.closest('.bar-group');
      const idx = Number(group.dataset.index);
      seg.classList.toggle('is-dim', index !== null && idx !== index);
    });
  };

  const show = (index, event) => {
    const day = model.values[index];
    if (!day) return;
    activeIndex = index;
    dimOthers(index);
    const rect = svg.getBoundingClientRect();
    const scale = chart.width / rect.width;
    const x = (chart.plot.x + index * chart.band + chart.band / 2) / scale + rect.left;
    renderDailyTooltip(day, x, event?.clientY ?? rect.top + 40);
  };
  const hide = () => {
    activeIndex = null;
    dimOthers(null);
    el.tooltip.hidden = true;
  };

  el.dailyChart.addEventListener('pointermove', (event) => {
    const target = event.target.closest('.bar-group');
    if (!target) { hide(); return; }
    show(Number(target.dataset.index), event);
  });
  el.dailyChart.addEventListener('pointerleave', hide);
  el.dailyChart.addEventListener('click', (event) => {
    const target = event.target.closest('.bar-group');
    if (target) show(Number(target.dataset.index), event);
  });
  el.dailyChart.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    let next = activeIndex ?? 0;
    if (event.key === 'ArrowLeft') next = Math.max(0, next - 1);
    if (event.key === 'ArrowRight') next = Math.min(model.values.length - 1, next + 1);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = model.values.length - 1;
    event.preventDefault();
    show(next);
  });
  el.dailyChart.querySelectorAll('.bar-group').forEach((group) => {
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'button');
    group.setAttribute('aria-label', `${group.dataset.index} 日消耗`);
  });
  svg.addEventListener('focusout', (e) => {
    if (!e.relatedTarget || !svg.contains(e.relatedTarget)) hide();
  });
}

function renderDailyTooltip(day, x, y) {
  const entries = [...state.series.teams].filter((e) => (day.byKey[e.key] || 0) > 0);
  clear(el.tooltip);
  el.tooltip.append(h('div', { class: 'tt-title', text: day.date }));
  for (const entry of entries) {
    el.tooltip.append(h('div', { class: 'tt-row' },
      h('span', { class: 'key', style: `background:${slotColor(entry.slot)}` }),
      h('span', { class: 'name', text: entry.label }),
      h('span', { class: 'val', text: money(day.byKey[entry.key]) }),
    ));
  }
  const unassigned = day.byKey[UNASSIGNED] || 0;
  if (unassigned > 0) {
    el.tooltip.append(h('div', { class: 'tt-row' },
      h('span', { class: 'key', style: 'background:var(--series-unassigned)' }),
      h('span', { class: 'name', text: '未归属' }),
      h('span', { class: 'val', text: money(unassigned) }),
    ));
  }
  el.tooltip.append(h('div', { class: 'tt-total' }, h('span', { text: '当日合计' }), h('span', { text: money(day.total) })));
  el.tooltip.hidden = false;
  const tw = el.tooltip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - tw.width - 12, Math.max(12, x - tw.width / 2));
  const top = Math.max(12, y - tw.height - 14);
  el.tooltip.style.left = `${left}px`;
  el.tooltip.style.top = `${top}px`;
}

function renderDailyTable(model, entries) {
  const visibleEntries = entries.filter((e) => model.values.some((d) => (d.byKey[e.key] || 0) > 0));
  const table = h('table', { class: 'data' },
    h('thead', {}, h('tr', {},
      h('th', { text: '日期' }),
      ...visibleEntries.map((e) => h('th', { class: 'num', text: e.label })),
      h('th', { class: 'num', text: '合计' }),
      h('th', { class: 'num', text: '查询数' }),
    )),
    h('tbody', {}, ...model.values.map((day) => {
      return h('tr', {},
        h('td', { text: day.date }),
        ...visibleEntries.map((e) => h('td', { class: 'num', text: (day.byKey[e.key] || 0) ? money(day.byKey[e.key]) : '—' })),
        h('td', { class: 'num', text: day.total ? money(day.total) : '—' }),
        h('td', { class: 'num muted', text: String(countQueriesOn(day.date)) }),
      );
    })),
    h('tfoot', {}, h('tr', {},
      h('td', { text: '合计' }),
      ...visibleEntries.map((e) => {
        const sum = model.values.reduce((a, d) => a + (d.byKey[e.key] || 0), 0);
        return h('td', { class: 'num', text: money(sum) });
      }),
      h('td', { class: 'num', text: money(model.values.reduce((a, d) => a + d.total, 0)) }),
      h('td', { class: 'num', text: String(model.values.reduce((a, d) => a + countQueriesOn(d.date), 0) || 0) }),
    )),
  );
  clear(el.dailyTable);
  el.dailyTable.append(table);
  const shown = model.values.reduce((a, d) => a + countQueriesOn(d.date), 0);
  const extra = state.bill.totals.booked_query_count - shown;
  el.dailyFootnote.textContent = extra > 0
    ? `表格为图表的等价视图，数值一致；另有 ${extra} 条跨账期查询按发生时间计入本期份额，发生日不在本期图表范围内。`
    : '表格为图表的等价视图，数值与图表一致。';
}

function countQueriesOn(date) {
  const ids = new Set();
  for (const row of state.bill.rows) {
    if (row.started_at.slice(0, 10) === date) ids.add(row.query_id);
  }
  return ids.size;
}

/* ------------------------------------------------------------------ */
/* 渲染：预算                                                          */
/* ------------------------------------------------------------------ */

function renderBudget() {
  const budget = state.bill.budgetVersion;
  el.budgetSub.textContent = budget
    ? `按 ${budget.version} 执行 · ${budget.note || '无说明'}`
    : '当前账期没有生效的预算版本';

  clear(el.budgetList);
  const rows = V.teamBudgetModel(state.bill).filter((t) => t.team_id !== UNASSIGNED);
  if (!rows.length) {
    el.budgetList.append(h('div', { class: 'empty-hint', text: '本期没有已归属的团队成本。' }));
    return;
  }
  for (const team of rows) {
    const hasBudget = team.budget !== null;
    const util = team.utilization;
    const over = (util || 0) > 1;
    const scale = Math.max(1, ...rows.map((t) => t.utilization || 0));
    const spendPct = Math.min(100, ((util || 0) / scale) * 100);
    const overPct = Math.max(0, ((util || 0) - 1) / scale) * 100;
    const budgetMarkPct = (1 / scale) * 100;

    const track = h('div', { class: 'budget-track', role: 'img', title: hasBudget
      ? `预算 ${money(toCents(team.budget))}，已用 ${money(team.cents)}`
      : '该团队未配置预算' },
      ...(hasBudget ? [
        h('div', { class: 'budget-spend', style: `width:${spendPct}%; background:${slotColor(team.slot ?? 1)}` }),
        overPct > 0 ? h('div', { class: 'budget-over', style: `width:${overPct}%` }) : null,
        h('div', { class: 'budget-mark', style: `left:${budgetMarkPct}%`, title: '预算线' }),
      ] : []),
    );

    el.budgetList.append(h('div', {
      class: 'budget-row',
      tabindex: '0',
      role: 'button',
      'aria-label': `查看 ${teamLabel(team.team_id)} 的查询`,
      onclick: () => openTeamDrawer(team.team_id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTeamDrawer(team.team_id); } },
    },
      h('div', { class: 'budget-top' },
        h('span', { class: 'budget-name' },
          h('span', { class: 'dot', style: `background:${slotColor(team.slot ?? 1)}` }),
          teamLabel(team.team_id),
          hasBudget ? h('span', { class: `util-pill ${over ? 'over' : 'ok'}`, text: V.formatPct(util, 0) }) : h('span', { class: 'util-pill', text: '无预算' }),
        ),
        h('span', { class: 'budget-amount' },
          h('strong', { text: money(team.cents) }),
          hasBudget ? ` / ${money(toCents(team.budget))}` : '',
        ),
      ),
      track,
      h('div', { class: 'budget-foot' },
        h('span', { text: over ? `超出 ${money(team.cents - toCents(team.budget))}` : (hasBudget ? `剩余 ${money(toCents(team.budget) - team.cents)}` : '—') }),
        h('span', { text: `${team.query_count} 条查询 · ${team.dataset_count} 个数据集` }),
      ),
    ));
  }
}

/* ------------------------------------------------------------------ */
/* 渲染：数据集排名                                                    */
/* ------------------------------------------------------------------ */

function renderDatasetRank() {
  clear(el.datasetRank);
  const items = V.datasetRanking(state.bill, state.config);
  if (!items.length) {
    el.datasetRank.append(h('div', { class: 'empty-hint', text: '本期没有已归属的数据集消耗。' }));
    return;
  }
  for (const item of items) {
    el.datasetRank.append(h('button', {
      class: 'rank-row',
      type: 'button',
      onclick: () => openDatasetDrawer(item.key),
    },
      h('span', { class: 'rank-name', title: item.label },
        item.label,
        item.unknownPrice ? h('span', { class: 'warn-dot', title: '未配置单价：相关查询成本未知', text: '⚠' }) : null,
      ),
      h('span', { class: 'rank-bar' },
        h('span', { class: 'rank-fill', style: `width:${Math.max(2, item.ratio * 100)}%` }),
      ),
      h('span', { class: 'rank-amount' },
        h('strong', { text: V.formatMoneyCompact(item.cents) }),
      ),
    ));
  }
}

/* ------------------------------------------------------------------ */
/* 渲染：超额原因                                                      */
/* ------------------------------------------------------------------ */

// 原因类别固定色位：同一原因在各团队间保持同色，不随出现顺序变化。
const REASON_COLORS = {
  dataset_growth: 'var(--series-1)',
  cancelled: 'var(--series-2)',
  attribution_in: 'var(--series-5)',
  budget_cut: 'var(--series-3)',
  cross_month: 'var(--series-7)',
  other: 'var(--text-muted)',
};

function renderReasons() {
  const reasons = overspendReasons(state.prepared, state.month, state.revisionId === 'auto' ? 'auto' : state.revisionId);
  el.reasonSub.textContent = `${V.formatMonth(state.month)} · 与预算版本及上月用量对比`;

  clear(el.reasonList);
  const over = reasons.filter((r) => r.overage_cents > 0);
  if (!over.length) {
    el.reasonList.append(h('div', { class: 'reason-empty', text: '本账期没有团队超出月预算。' }));
    return;
  }
  for (const entry of over) {
    const team = state.bill.teams.find((t) => t.team_id === entry.team_id);
    const color = slotColor(state.series.teams.find((t) => t.key === entry.team_id)?.slot ?? 1);
    const total = entry.overage_cents;
    el.reasonList.append(h('div', { class: 'reason-team' },
      h('div', { class: 'reason-head' },
        h('span', { class: 'who' },
          h('span', { class: 'dot', style: `background:${color}` }),
          teamLabel(entry.team_id),
          h('span', { class: 'over', text: `超 ${V.formatPct(entry.utilization ? entry.utilization - 1 : 0, 0)}` }),
        ),
        h('span', { class: 'amt' }, '超出 ', h('strong', { text: money(total) }), ` · 预算 ${money(toCents(entry.budget))}`),
      ),
      h('div', { class: 'reason-stack' },
        ...entry.reasons.map((r) => {
          const pct = (r.cents / total) * 100;
          return h('div', {
            class: 'reason-seg',
            style: `flex:${pct} 1 0; background:${reasonColor(r.key)}`,
            title: `${r.label} ${money(r.cents)}（${V.formatPct(r.share, 1)}）`,
          });
        }),
      ),
      h('div', { class: 'reason-list-items' },
        ...entry.reasons.map((r) => h('div', { class: 'reason-item' },
          h('span', { class: 'sq', style: `background:${reasonColor(r.key)}` }),
          h('span', {}, h('strong', { text: r.label }), h('span', { style: 'color:var(--text-muted);font-size:11px', text: ` · ${V.formatPct(r.share, 1)}` })),
          h('span', { class: 'money', text: money(r.cents) }),
          h('span', { class: 'detail', text: r.detail }),
        )),
      ),
    ));
  }
}

function reasonColor(key) {
  return REASON_COLORS[key] || 'var(--text-muted)';
}

/* ------------------------------------------------------------------ */
/* 渲染：异常                                                          */
/* ------------------------------------------------------------------ */

function renderExceptions() {
  const exceptions = V.buildExceptions(state.prepared, state.bill, state.config);
  const tabs = [
    { key: 'overview', label: '总览' },
    { key: 'retries', label: '重试', count: exceptions.retries.length },
    { key: 'cancels', label: '取消', count: exceptions.cancels.length },
    { key: 'unassigned', label: '缺归属', count: exceptions.unassigned.length },
    { key: 'unknown', label: '未知成本', count: exceptions.unknown.length },
    { key: 'crossMonth', label: '跨月', count: exceptions.crossMonth.length },
  ];

  clear(el.exceptionTabs);
  for (const tab of tabs) {
    el.exceptionTabs.append(h('button', {
      class: `seg-btn${state.exceptionTab === tab.key ? ' is-active' : ''}`,
      role: 'tab',
      'aria-selected': String(state.exceptionTab === tab.key),
      type: 'button',
      onclick: () => { state.exceptionTab = tab.key; renderExceptions(); },
    }, tab.label, tab.count !== undefined ? h('span', { class: 'count', text: String(tab.count) }) : null));
  }

  clear(el.exceptionBody);
  if (state.exceptionTab === 'overview') {
    renderExceptionOverview(exceptions);
  } else {
    renderExceptionList(state.exceptionTab, exceptions);
  }
}

function renderExceptionOverview(exceptions) {
  const totals = state.bill.totals;
  const retryDropped = exceptions.retries.reduce((a, r) => a + r.dropped_cents, 0);
  const retryCancelled = exceptions.retries.reduce((a, r) => a + r.cancelled_consumed_cents, 0);
  const panels = [
    {
      key: 'retries',
      title: '重试（按逻辑请求去重）',
      amount: `${exceptions.retries.length} 组`,
      desc: `重复尝试的消耗 ${money(retryDropped)} 未重复记账；其中取消尝试已发生的 ${money(retryCancelled)} 仍计入实际成本。`,
      tag: exceptions.retries.length ? 'bad' : null,
    },
    {
      key: 'cancels',
      title: '取消查询',
      amount: money(totals.cancelled_consumed_cents),
      desc: `${exceptions.cancels.length} 条已取消查询，取消前已消耗的计量照实计费。`,
      tag: exceptions.cancels.length ? 'serious' : null,
    },
    {
      key: 'unassigned',
      title: '缺归属',
      amount: money(totals.unassigned_cents),
      desc: `${exceptions.unassigned.length} 条查询没有团队归属，单列待认领，不平均摊给其他团队。`,
      tag: exceptions.unassigned.length ? 'warn' : null,
    },
    {
      key: 'unknown',
      title: '未知成本',
      amount: `${exceptions.unknown.length} 条`,
      desc: `金额未知，未估算、未摊派；仅列可核实扫描量 ${V.formatBytes(totals.unknown_known_bytes)}。`,
      tag: exceptions.unknown.length ? 'warn' : null,
    },
    {
      key: 'crossMonth',
      title: '跨月查询',
      amount: money(totals.cross_month_cents),
      desc: `${exceptions.crossMonth.length} 条查询跨账期，按墙钟时间拆分；本期只计入属于本期的部分。`,
    },
    {
      key: 'unknownPrice',
      title: '缺单价数据集',
      amount: String(new Set([...state.bill.rows.map((r) => r.dataset_id), ...exceptions.unknown.map((u) => u.reasons.join(''))]).size ? state.bill.datasets.filter((d) => !state.config.prices.datasets[d.dataset_id]).length : 0),
      desc: '未配置单价的数据集使相关查询成本不可核实；补充单价后可重算账单。',
      tag: 'warn',
    },
  ];

  const grid = h('div', { class: 'exception-grid' });
  for (const p of panels) {
    grid.append(h('button', {
      class: 'exception-panel',
      style: 'border:0;border-radius:0;text-align:left;cursor:pointer;font:inherit;color:inherit;background:var(--surface-1)',
      type: 'button',
      onclick: () => { state.exceptionTab = p.key === 'unknownPrice' ? 'unknown' : p.key; renderExceptions(); },
    },
      h('h3', {}, h('span', { text: p.title }), p.tag ? h('span', { class: `tag ${p.tag}`, text: p.key === 'unknownPrice' ? '需配置' : '需关注' }) : null),
      h('div', { class: 'amount', text: p.amount }),
      h('div', { class: 'desc', text: p.desc }),
    ));
  }
  el.exceptionBody.append(grid);
}

function renderExceptionList(tab, exceptions) {
  const table = h('table', { class: 'data' });
  clear(el.exceptionBody);

  if (tab === 'retries') {
    table.append(
      h('thead', {}, h('tr', {},
        h('th', { text: '逻辑请求' }),
        h('th', { text: '尝试链' }),
        h('th', { class: 'num', text: '记账金额' }),
        h('th', { class: 'num', text: '未重复记账' }),
        h('th', { class: 'num', text: '取消已消耗' }),
      )),
      h('tbody', {}, ...exceptions.retries.map((r) => h('tr', { class: 'clickable', onclick: () => openQueryDrawer(r.booked.query_id) },
        h('td', { text: r.logical_query_id }),
        h('td', {}, ...r.attempts.map((a) => h('span', { class: 'tag', style: 'margin-right:4px', text: `#${a.attempt} ${V.statusLabel(a.status)}${a.booked ? '·记账' : ''}` }))),
        h('td', { class: 'num', text: r.booked.cents === null ? '未知' : money(r.booked.cents) }),
        h('td', { class: 'num', text: r.dropped_cents ? money(r.dropped_cents) : '—' }),
        h('td', { class: 'num', text: r.cancelled_consumed_cents ? money(r.cancelled_consumed_cents) : '—' }),
      ))),
    );
  } else if (tab === 'cancels') {
    table.append(
      h('thead', {}, h('tr', {},
        h('th', { text: '查询' }), h('th', { text: '团队' }), h('th', { text: '数据集' }), h('th', { class: 'num', text: '已消耗计费' }),
      )),
      h('tbody', {}, ...exceptions.cancels.map((c) => h('tr', { class: 'clickable', onclick: () => openQueryDrawer(c.query_id) },
        h('td', { text: c.query_id }),
        h('td', { text: teamLabel(c.team) }),
        h('td', { text: [...c.datasets].map(datasetLabel).join('、') }),
        h('td', { class: 'num', text: money(c.cents) }),
      ))),
    );
  } else if (tab === 'unassigned') {
    table.append(
      h('thead', {}, h('tr', {},
        h('th', { text: '查询' }), h('th', { text: '状态' }), h('th', { text: '数据集' }), h('th', { class: 'num', text: '成本' }),
      )),
      h('tbody', {}, ...exceptions.unassigned.map((u) => h('tr', { class: 'clickable', onclick: () => openQueryDrawer(u.query_id) },
        h('td', { text: u.query_id }),
        h('td', { text: V.statusLabel(u.status) }),
        h('td', { text: [...u.datasets].map(datasetLabel).join('、') }),
        h('td', { class: 'num', text: money(u.cents) }),
      ))),
    );
  } else if (tab === 'unknown') {
    table.append(
      h('thead', {}, h('tr', {},
        h('th', { text: '查询' }), h('th', { text: '团队' }), h('th', { text: '原因' }), h('th', { class: 'num', text: '已知扫描量' }),
      )),
      h('tbody', {}, ...exceptions.unknown.map((u) => h('tr', { class: 'clickable', onclick: () => openQueryDrawer(u.query_id) },
        h('td', { text: u.query_id }),
        h('td', { text: teamLabel(u.team) }),
        h('td', { text: u.reasons.join('；') }),
        h('td', { class: 'num', text: u.known_scan_bytes ? V.formatBytes(u.known_scan_bytes) : '—' }),
      ))),
    );
  } else if (tab === 'crossMonth') {
    table.append(
      h('thead', {}, h('tr', {},
        h('th', { text: '查询' }), h('th', { text: '团队' }), h('th', { text: '拆分' }), h('th', { class: 'num', text: '本期计入' }),
      )),
      h('tbody', {}, ...exceptions.crossMonth.map((c) => h('tr', { class: 'clickable', onclick: () => openQueryDrawer(c.query_id) },
        h('td', { text: c.query_id }),
        h('td', { text: teamLabel(c.team) }),
        h('td', { text: c.splits.map((s) => `${s.month} ${V.formatPct(s.fraction, 1)}`).join(' · ') }),
        h('td', { class: 'num', text: money(c.this_month_cents) }),
      ))),
    );
  }

  if (!table.querySelector('tbody')?.children.length) {
    el.exceptionBody.append(h('div', { class: 'empty-hint', text: '本账期没有此类记录。' }));
    return;
  }
  el.exceptionBody.append(table);
}

/* ------------------------------------------------------------------ */
/* 渲染：账单                                                          */
/* ------------------------------------------------------------------ */

function renderBill() {
  const invoice = buildInvoice(state.prepared, state.month, state.revisionId === 'auto' ? 'auto' : state.revisionId);
  clear(el.billPreview);

  const byTeam = invoice.attributed_lines;
  el.billPreview.append(
    h('div', { class: 'invoice-head' },
      h('div', {},
        h('div', { class: 'invoice-title', text: '数仓资源结算单' }),
        h('div', { class: 'invoice-sub', text: `${state.config.orgName} · 虚构演示账单` }),
      ),
      h('div', { class: 'invoice-no' }, invoice.invoice_no, h('br'), invoice.issued_at),
    ),
    h('div', { class: 'invoice-meta' },
      h('div', { text: `账期：${invoice.period.start} — ${invoice.period.end}` }),
      h('div', { text: `归属修订：${invoice.revision}` }),
      h('div', { text: `币种：USD（虚构）` }),
      h('div', { text: `预算版本：${invoice.bill.budgetVersion?.version || '—'}` }),
    ),
  );

  const rows = [...byTeam];
  if (invoice.unassigned_lines.length) rows.push(...invoice.unassigned_lines);

  const table = h('table', { class: 'invoice-table' },
    h('thead', {}, h('tr', {},
      h('th', { text: '结算项目' }), h('th', { class: 'num', text: '金额' }), h('th', { class: 'num', text: '预算' }), h('th', { class: 'num', text: '使用率' }),
    )),
    h('tbody', {}, ...rows.map((line) => {
      const isUnassigned = line.team_id === UNASSIGNED;
      return h('tr', { class: `clickable${isUnassigned ? ' unassigned-row' : ''}`, onclick: () => openTeamDrawer(line.team_id) },
        h('td', { class: 'desc-cell' },
          line.team_id === UNASSIGNED ? '未归属查询成本' : teamLabel(line.team_id),
          h('span', { class: 'sub', text: line.team_id === UNASSIGNED ? `${line.queries} 条 · 待认领，不计入团队预算` : `${line.queries} 条查询` }),
        ),
        h('td', { class: 'num', text: money(line.cents) }),
        h('td', { class: 'num', text: line.budget !== null ? money(toCents(line.budget)) : '—' }),
        h('td', { class: 'num', text: line.utilization !== null ? V.formatPct(line.utilization, 0) : '—' }),
      );
    })),
  );

  el.billPreview.append(table);
  el.billPreview.append(
    h('div', { class: 'invoice-total' },
      h('span', { class: 'label', text: '本期合计（含未归属）' }),
      h('span', { class: 'value', text: money(invoice.subtotal_cents) }),
    ),
    h('div', { class: 'invoice-meta' },
      h('div', { text: `已归属 ${money(invoice.attributed_cents)} / 未归属 ${money(invoice.unassigned_cents)}` }),
      h('div', { text: `预算未分配余额 ${money(invoice.budget_balance)}` }),
    ),
    invoice.unknown.count
      ? h('div', { class: 'invoice-notice' },
        h('strong', { text: `待计量 ${invoice.unknown.count} 条。` }),
        `未知成本未计入账单，也未平摊给团队。已知扫描量 ${V.formatBytes(invoice.unknown.known_scan_bytes)}。`,
      )
      : null,
    h('div', { class: 'invoice-foot', text: `${invoice.note} ${invoice.payment_terms}` }),
  );

  renderBillCompare();

  document.getElementById('download-invoice').onclick = () => downloadInvoice(invoice);
  document.getElementById('download-lines').onclick = () => downloadLines();
}

function renderBillCompare() {
  clear(el.billCompare);
  if (!state.compareRevisionId) {
    el.billCompare.append(h('div', { class: 'compare-empty', text: '选择一个较早的归属修订，可对比总额、未分配余额与变化最大的查询。' }));
    return;
  }
  let compare;
  try {
    compare = compareRevisions(state.prepared, state.month, state.compareRevisionId,
      state.revisionId === 'auto' ? state.bill.revision.id : state.revisionId);
  } catch (err) {
    el.billCompare.append(h('div', { class: 'compare-empty', text: err.message }));
    return;
  }

  el.billCompare.append(
    h('div', { class: 'compare-head' },
      h('span', { text: `对比：${compare.base.revision.id} → ${compare.target.revision.id}` }),
      h('span', { text: V.formatMonth(state.month) }),
    ),
  );

  const cards = V.compareSummary(compare);
  const wrap = h('div', { class: 'compare-cards' });
  for (const c of cards) {
    const dir = c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'flat';
    wrap.append(h('div', { class: 'compare-card' },
      h('div', { class: 'label' }, h('span', { text: c.label }), h('span', { text: '旧 → 新' })),
      h('div', { class: 'values' },
        h('span', { class: 'from', text: money(c.base) }),
        h('span', { class: 'arrow', text: '→' }),
        h('span', { class: 'to', text: money(c.target) }),
        h('span', { class: `delta ${dir}`, text: dir === 'flat' ? '无变化' : V.formatSignedMoney(c.delta) }),
      ),
    ));
  }
  el.billCompare.append(wrap);

  const changes = compare.changes.slice(0, 6);
  const list = h('div', { class: 'compare-list' }, h('h3', { text: '变化最大的查询' }));
  if (!changes.length) {
    list.append(h('div', { class: 'compare-empty', style: 'padding:8px 0', text: '两个修订在本账期没有差异。' }));
  }
  for (const change of changes) {
    const moved = change.moved && change.team_before !== change.team_after;
    const deltaLabel = change.delta_cents === 0
      ? '金额不变'
      : `${change.delta_cents > 0 ? '+' : ''}${money(change.delta_cents)}`;
    list.append(h('button', { class: 'compare-change', type: 'button', onclick: () => openQueryDrawer(change.query_id) },
      h('span', { class: 'qid', text: change.query_id }),
      h('span', { class: `delta ${change.delta_cents > 0 ? 'up' : change.delta_cents < 0 ? 'down' : 'flat'}`, text: deltaLabel }),
      h('span', { class: 'teamflow', text: moved
        ? `仅归属迁移：${teamLabel(change.team_before)} → ${teamLabel(change.team_after)}`
        : `金额 ${money(change.cents_before)} → ${money(change.cents_after)}` }),
    ));
  }
  if (compare.changes.length > changes.length) {
    list.append(h('div', { class: 'compare-more', text: `另有 ${compare.changes.length - changes.length} 条变化未展示。` }));
  }
  el.billCompare.append(list);
}

function download(content, filename, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadInvoice(invoice) {
  const html = renderInvoiceHTML(invoice, (v) => V.formatMoney(toCents(v)));
  download(html, `${invoice.invoice_no}.html`, 'text/html;charset=utf-8');
  toast(`已下载虚构账单 ${invoice.invoice_no}.html`);
}

function downloadLines() {
  const columns = ['query_id', 'logical_query_id', 'attempt', 'team_id', 'dataset_id', 'table', 'status', 'method', 'scan_bytes', 'elapsed_ms', 'bytes_share', 'duration_share', 'weight', 'month_fraction', 'amount_usd', 'started_at'];
  const lines = [`# ${state.bill.month} 计费行（虚构示例），金额单位 USD`, columns.join(',')];
  for (const row of state.bill.rows) {
    lines.push([
      row.query_id, row.logical_query_id, row.attempt, row.team, row.dataset_id, row.table, row.status,
      row.method, row.scan_bytes, row.elapsed_ms,
      row.bytes_share.toFixed(6), row.duration_share.toFixed(6), row.weight.toFixed(6),
      row.month_fraction.toFixed(6), fromCents(row.cents).toFixed(2), row.started_at,
    ].join(','));
  }
  download(`${lines.join('\n')}\n`, `bill-lines-${state.bill.month}.csv`, 'text/csv;charset=utf-8');
  toast(`已导出 ${state.bill.rows.length} 条计费行`);
}

/* ------------------------------------------------------------------ */
/* 渲染：版本历史                                                      */
/* ------------------------------------------------------------------ */

function renderHistory() {
  clear(el.revisionHistory);
  clear(el.budgetHistory);

  const current = state.bill.revision;
  el.revisionHistory.append(h('h3', { text: '归属修订（版本只追加）' }));
  const timeline = h('div', { class: 'timeline' });
  for (const rev of state.config.revisions.slice().reverse()) {
    const isActive = current && rev.id === current.id;
    const isFuture = rev.effective_date > state.bill.period.start.slice(0, 10) && !isActive;
    timeline.append(h('div', { class: `tl-item${isActive ? ' is-active' : ''}${isFuture ? ' is-future' : ''}` },
      h('div', { class: 'tl-head' },
        h('span', { class: 'tl-id', text: `${rev.id}${isActive ? ' · 当前' : ''}` }),
        h('span', { class: 'tl-date', text: `自 ${rev.effective_date}` }),
      ),
      h('div', { class: 'tl-note', text: rev.note || '无说明' }),
      h('div', { class: 'tl-meta' },
        h('span', { text: `作者 ${rev.author || '—'}` }),
        h('span', { text: `序号 #${rev.seq}` }),
        h('span', { text: `${(rev.changes || []).length} 条变更` }),
      ),
      h('div', { class: 'tl-changes' },
        ...(rev.changes || []).slice(0, 6).map((c) => h('div', { class: 'tl-change' },
          h('span', { class: 'qid', text: c.query_id }),
          h('span', { class: 'arrow', text: '·' }),
          h('span', { text: `${teamLabel(c.from_team_id)} → ${teamLabel(c.to_team_id)}` }),
          c.reason ? h('span', { class: 'reason', text: `（${c.reason}）` }) : null,
        )),
        (rev.changes || []).length > 6 ? h('div', { class: 'tl-change reason', text: `另有 ${rev.changes.length - 6} 条…` }) : null,
      ),
      h('div', { class: 'tl-actions' },
        !isActive ? h('button', { class: 'link-btn', type: 'button', onclick: () => { state.revisionId = rev.id; rebuild(); toast(`账单已按 ${rev.id} 重述`); } }, '按此版本重述账单') : null,
      ),
    ));
  }
  if (!state.config.revisions.length) timeline.append(h('div', { class: 'timeline-empty', text: '尚无归属修订。' }));
  el.revisionHistory.append(timeline);

  el.budgetHistory.append(h('h3', { text: '预算版本（按月生效）' }));
  const budgetTimeline = h('div', { class: 'timeline' });
  const currentBudget = state.bill.budgetVersion;
  for (const ver of state.config.budgets.versions.slice().reverse()) {
    const isActive = currentBudget && ver.version === currentBudget.version;
    const total = Object.values(ver.teams).reduce((a, b) => a + b, 0);
    budgetTimeline.append(h('div', { class: `tl-item${isActive ? ' is-active' : ''}` },
      h('div', { class: 'tl-head' },
        h('span', { class: 'tl-id', text: `${ver.version}${isActive ? ' · 本账期生效' : ''}` }),
        h('span', { class: 'tl-date', text: `自 ${ver.effective_month}` }),
      ),
      h('div', { class: 'tl-note', text: ver.note || '无说明' }),
      h('div', { class: 'tl-meta' }, h('span', { text: `总额 ${money(toCents(total))}` }), h('span', { text: `${Object.keys(ver.teams).length} 个团队` })),
      h('div', { class: 'tl-changes' },
        ...Object.entries(ver.teams).map(([team, amount]) => h('div', { class: 'tl-change' },
          h('span', { class: 'qid', text: teamLabel(team) }),
          h('span', { class: 'arrow', text: '·' }),
          h('span', { text: money(toCents(amount)) }),
        )),
      ),
    ));
  }
  if (!state.config.budgets.versions.length) budgetTimeline.append(h('div', { class: 'timeline-empty', text: '尚无预算版本。' }));
  el.budgetHistory.append(budgetTimeline);
}

/* ------------------------------------------------------------------ */
/* 渲染总控                                                            */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderFilters();
  renderKpis();
  renderDaily();
  renderBudget();
  renderDatasetRank();
  renderReasons();
  renderExceptions();
  renderBill();
  renderHistory();
  el.orgName.textContent = `${state.config.orgName} · 资源与成本治理`;
  el.dataSource.textContent = `数据来源：${state.dataSource === 'queries.csv' ? '本地脱敏样例 CSV' : state.dataSource}`;
}

/* ------------------------------------------------------------------ */
/* 抽屉                                                                */
/* ------------------------------------------------------------------ */

function openDrawer(title, build) {
  state.drawerStack = [{ title, build }];
  renderDrawer();
  el.drawer.hidden = false;
  el.scrim.hidden = false;
  document.body.style.overflow = 'hidden';
  el.drawerCloseFocus = el.drawer.querySelector('#drawer-close');
  setTimeout(() => el.drawer.querySelector('#drawer-close').focus(), 40);
}

function closeDrawer() {
  state.drawerStack = [];
  el.drawer.hidden = true;
  el.scrim.hidden = true;
  document.body.style.overflow = '';
  el.tooltip.hidden = true;
}

function pushDrawer(title, build) {
  state.drawerStack.push({ title, build });
  renderDrawer();
}

function renderDrawer() {
  const entry = state.drawerStack[state.drawerStack.length - 1];
  if (!entry) return;
  el.drawerTitle.textContent = entry.title;
  el.drawerBack.hidden = state.drawerStack.length < 2;
  clear(el.drawerBody);
  entry.build(el.drawerBody);
  el.drawerBody.scrollTop = 0;
}

function openTeamDrawer(teamId) {
  const bill = state.bill;
  const queries = bill.queries.filter((q) => q.team === teamId);
  openDrawer(teamId === UNASSIGNED ? '未归属查询' : `${teamLabel(teamId)} · 本期查询`, (body) => {
    const summary = teamId === UNASSIGNED
      ? { cents: bill.totals.unassigned_cents, queries: queries.length, budget: null }
      : bill.teams.find((t) => t.team_id === teamId);
    body.append(h('div', { class: 'query-teaser' },
      h('div', { class: 'big', text: money(summary?.cents || 0) }),
      h('div', { class: 'sub', text: `${queries.length} 条已记账查询${teamId === UNASSIGNED ? ' · 未归属不计入团队预算' : ''}` }),
    ));
    body.append(h('h3', { text: '查询明细（按成本降序）' }));
    const table = h('table', { class: 'split-table' },
      h('thead', {}, h('tr', {}, h('th', { text: '查询' }), h('th', { text: '状态' }), h('th', { text: '数据集' }), h('th', { class: 'num', text: '金额' }))),
      h('tbody', {}, ...queries.map((q) => h('tr', { class: 'clickable', style: 'cursor:pointer', onclick: () => openQueryDrawer(q.query_id) },
        h('td', { text: q.query_id }),
        h('td', { text: V.statusLabel(q.status) }),
        h('td', { text: q.datasets.map(datasetLabel).join('、') }),
        h('td', { class: 'num', text: money(q.cents) }),
      ))),
    );
    body.append(table);
    if (!queries.length) body.append(h('div', { class: 'empty-hint', text: '本期没有属于该团队的已计费查询。' }));
  });
}

function openDatasetDrawer(datasetId) {
  const bill = state.bill;
  const rows = bill.rows.filter((r) => r.dataset_id === datasetId);
  const byQuery = new Map();
  for (const row of rows) {
    if (!byQuery.has(row.query_id)) byQuery.set(row.query_id, { crew: row.team, cents: 0, bytes: 0, ms: 0, started: row.started_at });
    const q = byQuery.get(row.query_id);
    q.cents += row.cents; q.bytes += row.scan_bytes || 0; q.ms += row.elapsed_ms || 0;
  }
  const meta = state.config.prices.datasets[datasetId];
  openDrawer(`${datasetLabel(datasetId)} · 数据集`, (body) => {
    body.append(h('div', { class: 'query-teaser' },
      h('div', { class: 'big', text: money(bill.datasets.find((d) => d.dataset_id === datasetId)?.cents || 0) }),
      h('div', { class: 'sub', text: `${byQuery.size} 条查询 · ${new Set([...byQuery.values()].map((q) => q.crew)).size} 个团队` }),
    ));
    body.append(h('h3', { text: '单价与分摊规则' }));
    body.append(h('dl', { class: 'kv' },
      h('dt', { text: '扫描单价' }), h('dd', { class: 'mono', text: meta ? `$${meta.scan_usd_per_gb} / GB` : '未配置（成本未知）' }),
      h('dt', { text: '计算单价' }), h('dd', { class: 'mono', text: meta ? `$${meta.compute_usd_per_cpu_hour} / CPU·小时` : '未配置' }),
      h('dt', { text: '分摊规则' }), h('dd', { text: V.allocationRuleLabel(state.config, datasetId) }),
    ));
    body.append(h('h3', { text: '查询' }));
    body.append(h('table', { class: 'split-table' },
      h('thead', {}, h('tr', {}, h('th', { text: '查询' }), h('th', { text: '团队' }), h('th', { class: 'num', text: '扫描' }), h('th', { class: 'num', text: '金额' }))),
      h('tbody', {}, ...[...byQuery.entries()].sort((a, b) => b[1].cents - a[1].cents).map(([qid, q]) => h('tr', { style: 'cursor:pointer', onclick: () => openQueryDrawer(qid) },
        h('td', { text: qid }), h('td', { text: teamLabel(q.crew) }),
        h('td', { class: 'num', text: V.formatBytes(q.bytes) }),
        h('td', { class: 'num', text: money(q.cents) }),
      ))),
    ));
  });
}

function openQueryDrawer(queryId) {
  const detail = queryDetail(state.prepared, state.bill, queryId);
  if (!detail) { toast(`查询 ${queryId} 不在当前账期账单中`); return; }

  if (detail.kind === 'unknown') {
    const u = detail.unknown;
    openDrawer(`查询 ${queryId} · 成本未知`, (body) => {
      body.append(h('div', { class: 'invoice-notice' }, h('strong', { text: '成本未知。' }), '该查询不会被估算，也不会摊入任何团队。')),
      body.append(h('h3', { text: '原因' }));
      body.append(h('dl', { class: 'kv' },
        ...u.reasons.flatMap((r) => [h('dt', { text: '计量问题' }), h('dd', { text: r })]),
        h('dt', { text: '团队' }), h('dd', { text: teamLabel(u.team) }),
        h('dt', { text: '状态' }), h('dd', { text: V.statusLabel(u.status) }),
        h('dt', { text: '开始时间' }), h('dd', { class: 'mono', text: V.formatDateTime(u.started_at) }),
        h('dt', { text: '已知扫描量' }), h('dd', { class: 'mono', text: u.known_scan_bytes ? V.formatBytes(u.known_scan_bytes) : '缺失' }),
      ));
    });
    return;
  }

  const d = detail;
  openDrawer(`查询 ${queryId}`, (body) => {
    const pills = h('div', { class: 'pill-row' });
    pills.append(h('span', { class: `tag ${d.status === 'cancelled' ? 'serious' : d.status === 'success' ? '' : 'bad'}`, text: V.statusLabel(d.status) }));
    pills.append(h('span', { class: 'tag', text: teamLabel(d.effective_team) }));
    if (d.attribution_source === 'revision') pills.append(h('span', { class: 'tag serious', text: `归属由修订 ${d.revision_id} 调整` }));
    if (d.cross_month) pills.append(h('span', { class: 'tag warn', text: '跨月拆分' }));
    if (d.attempts.length > 1) pills.append(h('span', { class: 'tag bad', text: `重试 ${d.attempts.length} 次` }));
    body.append(pills);

    body.append(h('div', { class: 'query-teaser' },
      h('div', { class: 'big', text: money(d.total_cents) }),
      h('div', { class: 'sub', text: d.cross_month
        ? `查询总成本 · 本期仅计入 ${money(d.month_cents)}（${V.formatPct(d.month_fraction, 1)}）`
        : '查询总成本' }),
    ));

    body.append(h('h3', { text: '基本信息' }));
    body.append(h('dl', { class: 'kv' },
      h('dt', { text: '逻辑请求' }), h('dd', { class: 'mono', text: d.logical_query_id }),
      h('dt', { text: '开始 / 结束' }), h('dd', { class: 'mono', text: `${V.formatDateTime(d.started_at)} → ${V.formatDateTime(d.finished_at)}` }),
      h('dt', { text: '墙钟时长' }), h('dd', { class: 'mono', text: V.formatDuration(d.wall_ms) }),
      h('dt', { text: '日志团队' }), h('dd', { text: d.log_team ? teamLabel(d.log_team) : '（空）' }),
      h('dt', { text: '账单团队' }), h('dd', { text: teamLabel(d.effective_team) }),
    ));

    if (d.cross_month) {
      body.append(h('h3', { text: '跨月拆分（按墙钟时间）' }));
      body.append(h('table', { class: 'split-table' },
        h('thead', {}, h('tr', {}, h('th', { text: '账期' }), h('th', { class: 'num', text: '时长' }), h('th', { class: 'num', text: '占比' }), h('th', { class: 'num', text: '金额' }))),
        h('tbody', {}, ...d.splits.map((s) => h('tr', {},
          h('td', { text: s.month }),
          h('td', { class: 'num', text: V.formatDuration(s.duration_ms) }),
          h('td', { class: 'num', text: V.formatPct(s.fraction, 2) }),
          h('td', { class: 'num', text: money(s.cents) }),
        ))),
      ));
    }

    body.append(h('h3', { text: '多表分摊（中间值）' }));
    const alloc = d.rows;
    const allocTable = h('table', { class: 'split-table alloc-table' },
      h('thead', {}, h('tr', {},
        h('th', { text: '表 / 规则' }),
        h('th', { class: 'num', text: '扫描' }), h('th', { class: 'num', text: '耗时' }),
        h('th', { class: 'num', text: '字节占比' }), h('th', { class: 'num', text: '时长占比' }),
        h('th', { class: 'num', text: '权重' }), h('th', { class: 'num', text: '分摊' }),
      )),
      h('tbody', {}, ...alloc.map((t) => {
        const row = d.rows.find((r) => r.dataset_id === t.dataset_id && r.table === t.table);
        return h('tr', {},
          h('td', { class: 'alloc-name' },
            h('div', { class: 'tname', text: t.table }),
            h('div', { class: 'sub', text: `${datasetLabel(t.dataset_id)} · ${V.allocationRuleLabel(state.config, t.dataset_id)}` }),
          ),
          h('td', { class: 'num', text: V.formatBytes(t.scan_bytes) }),
          h('td', { class: 'num', text: V.formatDuration(t.elapsed_ms) }),
          h('td', { class: 'num', text: V.formatPct(t.bytes_share, 1) }),
          h('td', { class: 'num', text: V.formatPct(t.duration_share, 1) }),
          h('td', { class: 'num', text: t.weight.toFixed(3) }),
          h('td', { class: 'num strong', text: money(row?.cents ?? 0) }),
        );
      })),
    );
    body.append(h('div', { class: 'table-wrap' }, allocTable));
    body.append(h('div', { class: 'formula' },
      '单表基础成本 = 扫描字节 ÷ 1 GiB × 扫描单价 + 表耗时 ÷ 1 小时 × CPU 小时单价。',
      h('br'),
      '分摊 = 表基础成本按权重占比，用最大余数法拆到分；各表合计等于查询总额。',
      h('br'),
      `本例：扫描成本合计 ${money(toCents(alloc.reduce((a, t) => a + t.scan_cost, 0)))}，计算成本合计 ${money(toCents(alloc.reduce((a, t) => a + t.compute_cost, 0)))}。`,
    ));

    if (d.attempts.length > 1) {
      body.append(h('h3', { text: '重试链（同一逻辑请求只记一次）' }));
      const list = h('div', { class: 'attempt-list' });
      for (const a of d.attempts) {
        const label = a.state === 'unknown' ? '未知' : money(a.cents);
        list.append(h('div', { class: `attempt${a.booked ? ' is-booked' : ''}${a.charged && !a.booked ? ' is-charged' : ''}` },
          h('span', { class: 'no', text: `#${a.attempt}` }),
          h('span', { class: 'st' }, h('span', { class: 'tag', text: V.statusLabel(a.status) })),
          h('span', { class: 'money', text: label }),
          h('span', { class: 'tag', text: a.booked ? '记账' : (a.charged ? '取消已消耗·计费' : '未重复记账') }),
        ));
      }
      body.append(list);
      if (d.duplicate_cents) {
        body.append(h('div', { class: 'formula', text: `失败/超时重试消耗 ${money(d.duplicate_cents)} 未重复记账。` }));
      }
      if (d.record.cancelled_consumed_cents) {
        body.append(h('div', { class: 'formula', text: `其中取消尝试已发生的 ${money(d.record.cancelled_consumed_cents)} 仍计入实际成本（按取消时的计量）。` }));
      }
    }

    if (d.revision_history.length) {
      body.append(h('h3', { text: '归属修订历史' }));
      for (const rev of d.revision_history) {
        body.append(h('div', { class: 'tl-change', style: 'padding:6px 0;border-bottom:1px solid var(--border)' },
          h('span', { class: 'qid', text: rev.revision }),
          h('span', { class: 'reason', text: `${rev.effective_date} · ${rev.author}` }),
          h('span', { text: `${teamLabel(rev.change.from_team_id)} → ${teamLabel(rev.change.to_team_id)}` }),
          rev.change.reason ? h('span', { class: 'reason', text: `（${rev.change.reason}）` }) : null,
        ));
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

function openImportModal() {
  const scrim = h('div', { class: 'modal-scrim', onclick: closeModal });
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'import-title' });
  const input = h('input', { type: 'file', class: 'file-input', accept: '.csv,text/csv,.json,application/json' });
  const zone = h('div', { class: 'upload-zone', tabindex: '0', role: 'button', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
    h('strong', { text: '选择 CSV 或 JSON 文件' }),
    h('div', { style: 'margin-top:4px', text: '支持表访问级（每行一张表）或查询级（含 tables 数组）。SQL、用户邮箱等字段会被丢弃。' }),
  );
  const preview = h('div', { class: 'import-preview' });
  const errors = h('div', { class: 'import-errors', hidden: true });
  let parsed = null;

  const handleFile = async (file) => {
    try {
      const text = await file.text();
      let rows;
      let format;
      if (file.name.endsWith('.json')) {
        const data = JSON.parse(text);
        rows = parsedJSON(data);
        format = 'json';
      } else {
        rows = rowsToQueries(parseCSV(text));
        format = 'csv';
      }
      parsed = { rows, format, name: file.name };
      const prepared = prepareDataset(rows, state.config);
      clear(preview);
      preview.append(
        statTile('记录数', String(prepared.stats.accepted)),
        statTile('未知成本', String(prepared.stats.unknown_cost)),
        statTile('缺归属', String(prepared.stats.unassigned)),
        statTile('重试组', String(prepared.stats.retried_groups)),
        statTile('字段脱敏', String(prepared.stats.sanitized)),
        statTile('被拒记录', String(prepared.stats.rejected)),
      );
      clear(errors);
      if (prepared.rejected.length) {
        errors.hidden = false;
        for (const r of prepared.rejected.slice(0, 40)) errors.append(h('div', { text: r.error }));
      } else {
        errors.hidden = true;
      }
      importBtn.disabled = false;
    } catch (err) {
      parsed = null;
      importBtn.disabled = true;
      errors.hidden = false;
      clear(errors);
      errors.append(h('div', { text: `解析失败：${err.message}` }));
    }
  };

  input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('is-drag');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  const importBtn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: async () => {
    if (!parsed) return;
    try {
      const resp = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsed.rows, source: parsed.name }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '导入失败');
      state.rawRows = parsed.rows;
      state.dataSource = parsed.name;
      closeModal();
      rebuild();
      toast(`已导入 ${json.imported} 条查询记录`);
    } catch (err) {
      errors.hidden = false; clear(errors); errors.append(h('div', { text: err.message }));
    }
  } }, '导入并重算');

  const resetBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
    await fetch('/api/config/reset-import', { method: 'POST' });
    closeModal();
    await loadData();
    toast('已恢复为样例数据');
  } }, '恢复样例数据');

  modal.append(
    h('div', { class: 'modal-head' },
      h('div', {}, h('h2', { id: 'import-title', text: '导入脱敏查询记录' }),
        h('div', { class: 'modal-sub', text: '导入只作用于本机 data/ 目录；不会发送到任何外部服务。' })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', text: '×', onclick: closeModal }),
    ),
    zone, input, preview, errors,
    h('div', { class: 'modal-actions' }, resetBtn,
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '取消'),
      importBtn,
    ),
  );

  document.body.append(scrim, modal);
  window.__closeModal = closeModal;
  setTimeout(() => zone.focus(), 40);
}

function statTile(label, value) {
  return h('div', { class: 'mini-stat' }, h('div', { class: 'l', text: label }), h('div', { class: 'v', text: value }));
}

function parsedJSON(data) {
  if (Array.isArray(data)) {
    if (data.some((x) => x && Array.isArray(x.tables))) return data;
    return rowsToQueries(data);
  }
  if (data && Array.isArray(data.queries)) {
    if (data.queries.some((x) => Array.isArray(x.tables))) return data.queries;
    return rowsToQueries(data.queries);
  }
  if (data && Array.isArray(data.rows)) return rowsToQueries(data.rows);
  throw new Error('JSON 需为数组，或含 queries/rows 数组');
}

function closeModal() {
  document.querySelectorAll('.modal, .modal-scrim').forEach((n) => n.remove());
}

/* ------------------------------------------------------------------ */
/* 新增修订 / 预算                                                     */
/* ------------------------------------------------------------------ */

function openRevisionForm() {
  const form = buildRevisionForm();
  clear(el.configForms);
  el.configForms.hidden = false;
  el.configForms.append(form);
  el.configForms.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildRevisionForm() {
  const idInput = h('input', { placeholder: 'ATT-2026-11-v4' });
  const dateInput = h('input', { placeholder: '2026-11-13', value: state.bill.period.start.slice(0, 10) });
  const authorInput = h('input', { placeholder: '团队/姓名' });
  const noteInput = h('textarea', { placeholder: '修订说明' });
  const changesInput = h('textarea', {
    id: 'rev-changes',
    placeholder: '每行一条：query_id,目标团队,原因\nq-noteam-04,growth,补录归属\nq-202610-0006,,（留空=回到未归属）',
  });
  const errorNode = h('div', { class: 'form-error' });

  const submit = h('button', { class: 'btn', type: 'button', onclick: async () => {
    clear(errorNode);
    const changes = changesInput.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [qid, to, ...reason] = line.split(',').map((s) => s.trim());
      return { query_id: qid, to_team_id: to || null, reason: reason.join(',') };
    });
    if (!changes.length) { errorNode.textContent = '至少填写一条变更'; return; }
    const body = {
      id: idInput.value.trim(),
      effective_date: dateInput.value.trim(),
      author: authorInput.value.trim(),
      note: noteInput.value.trim(),
      changes,
    };
    try {
      const resp = await fetch('/api/config/revision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '保存失败');
      state.config = json.config;
      el.configForms.hidden = true;
      rebuild();
      toast(`已追加归属修订 ${json.revision.id}`);
    } catch (err) { errorNode.textContent = err.message; }
  } }, '追加修订');

  return h('div', { class: 'form-card' },
    h('h3', { text: '新增归属修订（只追加，不覆盖历史）' }),
    h('div', { class: 'hint', text: '生效日期决定自动叠加顺序；每条变更记录原团队、新团队与原因，查询详情页会显示这条历史。' }),
    h('div', { class: 'form-grid' },
      field('修订 ID', idInput),
      field('生效日期', dateInput),
      field('作者', authorInput),
      field('说明', noteInput),
      h('div', { class: 'field', style: 'grid-column:1/-1' }, h('label', { text: '归属变更（每行：query_id,目标团队,原因）' }), changesInput),
    ),
    h('div', { class: 'form-actions' }, errorNode, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { el.configForms.hidden = true; } }, '取消'), submit),
  );
}

function openBudgetForm() {
  const teams = Object.keys(state.config.teams || {});
  const idInput = h('input', { placeholder: 'BUD-2026-12-v3' });
  const monthInput = h('input', { placeholder: '2026-12', value: shiftMonth(state.bill.month, 1) });
  const noteInput = h('input', { placeholder: '调整说明' });
  const inputs = new Map();
  const grid = h('div', { class: 'budget-inputs' });
  for (const team of teams) {
    const v = state.bill.budgetVersion?.teams?.[team];
    const input = h('input', { type: 'number', min: '0', step: '1', value: v !== undefined ? String(v) : '' });
    inputs.set(team, input);
    grid.append(field(V.teamName(state.config, team), input));
  }
  const errorNode = h('div', { class: 'form-error' });

  const submit = h('button', { class: 'btn', type: 'button', onclick: async () => {
    clear(errorNode);
    const teamBudgets = {};
    for (const [team, input] of inputs) {
      if (input.value === '') continue;
      const num = Number(input.value);
      if (!Number.isFinite(num) || num < 0) { errorNode.textContent = `${team} 预算非法`; return; }
      teamBudgets[team] = num;
    }
    try {
      const resp = await fetch('/api/config/budget', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: idInput.value.trim(), effective_month: monthInput.value.trim(), note: noteInput.value.trim(), teams: teamBudgets }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '保存失败');
      state.config = json.config;
      el.configForms.hidden = true;
      rebuild();
      toast(`已追加预算版本 ${json.budget.version}`);
    } catch (err) { errorNode.textContent = err.message; }
  } }, '追加预算版本');

  clear(el.configForms);
  el.configForms.hidden = false;
  el.configForms.append(h('div', { class: 'form-card' },
    h('h3', { text: '新增预算版本（按月生效）' }),
    h('div', { class: 'hint', text: '版本按 effective_month 生效；账期对比会显示预算下调对超额的影响。' }),
    h('div', { class: 'form-grid' }, field('预算版本号', idInput), field('生效月份', monthInput), field('说明', noteInput)),
    h('div', { style: 'margin-top:10px' }, grid),
    h('div', { class: 'form-actions' }, errorNode, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { el.configForms.hidden = true; } }, '取消'), submit),
  ));
  el.configForms.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function field(label, control) {
  const input = control;
  return h('div', { class: 'field' }, h('label', { text: label }), input);
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

el.month.addEventListener('change', () => {
  state.month = el.month.value;
  state.series = V.buildTeamSeries(state.config, buildBill(state.prepared, state.month, state.revisionId === 'auto' ? 'auto' : state.revisionId));
  rebuild();
});
el.revision.addEventListener('change', () => {
  state.revisionId = el.revision.value;
  rebuild();
});
el.compare.addEventListener('change', () => {
  state.compareRevisionId = el.compare.value || null;
  renderBill();
});

document.querySelectorAll('[data-daily-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.dailyView = btn.dataset.dailyView;
    document.querySelectorAll('[data-daily-view]').forEach((b) => {
      const active = b.dataset.dailyView === state.dailyView;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    renderDaily();
  });
});

document.getElementById('open-import').addEventListener('click', openImportModal);
document.getElementById('open-revision-form').addEventListener('click', openRevisionForm);
document.getElementById('open-budget-form').addEventListener('click', openBudgetForm);

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-back').addEventListener('click', () => {
  state.drawerStack.pop();
  renderDrawer();
});
el.scrim.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.drawer.hidden) { closeDrawer(); return; }
  if (document.querySelector('.modal')) closeModal();
});

document.getElementById('toggle-theme').addEventListener('click', () => {
  const root = document.documentElement;
  const isDark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = isDark ? 'light' : 'dark';
  try { localStorage.setItem('wcb-theme', root.dataset.theme); } catch { /* 忽略 */ }
});

try {
  const saved = localStorage.getItem('wcb-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* 忽略 */ }

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderDaily(), 120);
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

loadData().catch((err) => {
  el.main.append(h('div', { class: 'card', style: 'margin-top:24px' },
    h('h2', { text: '无法加载数据' }),
    h('p', { class: 'card-sub', text: err.message }),
    h('p', { class: 'card-sub', text: '请先运行 npm run fixtures 生成样例数据，再启动 npm start。' }),
  ));
});
