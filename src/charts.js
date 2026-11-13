/**
 * SVG 图表构建（纯字符串，无 DOM 依赖，可直接单元测试）。
 * 颜色通过 CSS 变量引用，深浅色随主题自动切换。
 */

export function escapeXML(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function seriesColor(entry) {
  if (entry.kind === 'unassigned' || entry.slot === null || entry.slot === undefined) {
    return 'var(--series-unassigned)';
  }
  if (entry.kind === 'other') return 'var(--text-muted)';
  return `var(--series-${entry.slot})`;
}

function moneyForAxis(cents) {
  const v = cents / 100;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) {
    const k = v / 1_000;
    return `$${k >= 10 ? Math.round(k) : k.toFixed(1)}K`;
  }
  return `$${Math.round(v)}`;
}

function moneyExact(cents) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 顶部圆角、底部与基线齐平的柱段路径。 */
function segmentPath(x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, h, w / 2));
  if (r === 0) {
    return `M${x},${y} h${w} v${h} h${-w} Z`;
  }
  return [
    `M${x},${y + r}`,
    `a${r},${r} 0 0 1 ${r},${-r}`,
    `h${w - 2 * r}`,
    `a${r},${r} 0 0 1 ${r},${r}`,
    `v${h - r}`,
    `h${-w}`,
    `v${-(h - r)}`,
    'Z',
  ].join(' ');
}

export function stackedDaily(model, seriesInfo, options = {}) {
  const width = Math.max(320, Math.round(options.width || 1200));
  const height = options.height || 292;
  const margin = { top: 26, right: 16, bottom: 30, left: 56 };
  const plot = {
    x: margin.left,
    y: margin.top,
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom,
  };

  const entries = model.entries;
  const band = plot.width / Math.max(1, model.dates.length);
  const barWidth = Math.max(3, Math.min(24, band * 0.62));

  const ticks = model.ticks;
  const lastTickCents = ticks[ticks.length - 1] || 0;
  // 刻度上限高于数据峰值时，以刻度上限作为同一比例尺的域上限，避免刻度线溢出绘图区。
  const domain = Math.max(1, model.max, lastTickCents);
  const yFor = (cents) => plot.y + plot.height - (cents / domain) * plot.height;
  const tickY = (cents) => plot.y + plot.height - (cents / domain) * plot.height;

  const grid = ticks.map((t) => (
    `<line class="gridline" x1="${plot.x}" x2="${plot.x + plot.width}" y1="${tickY(t)}" y2="${tickY(t)}"/>` +
    `<text class="axis-text" x="${plot.x - 8}" y="${tickY(t) + 3.5}" text-anchor="end">${escapeXML(moneyForAxis(t))}</text>`
  )).join('');

  const peakIdx = model.values.reduce((best, v, i) => (v.total > (model.values[best]?.total ?? 0) ? i : best), 0);
  const peak = model.values[peakIdx];

  let barIndex = 0;
  const bars = model.values.map((day, i) => {
    const cx = plot.x + i * band + band / 2;
    const x = cx - barWidth / 2;
    let cum = 0;
    const visible = entries.filter((e) => (day.byKey[e.key] || 0) > 0);
    const segs = visible.map((entry, k) => {
      const cents = day.byKey[entry.key] || 0;
      const y0 = yFor(cum);
      const y1 = yFor(cum + cents);
      cum += cents;
      const isTop = k === visible.length - 1;
      // 非顶段向上收 2px，形成堆叠段之间的表面间隙
      const drawH = Math.max(0, y0 - y1 - (isTop ? 0 : 2));
      if (drawH < 0.5) return '';
      return `<path class="bar-seg" d="${segmentPath(x, y1, barWidth, drawH, isTop ? 4 : 0)}" fill="${seriesColor(entry)}" data-key="${escapeXML(entry.key)}"/>`;
    }).join('');
    const totalTop = yFor(day.total);
    const label = (i === peakIdx && day.total > 0)
      ? `<text class="peak-label axis-text" x="${cx}" y="${Math.max(plot.y - 8, totalTop - 8)}" text-anchor="middle">${escapeXML(moneyExact(day.total))}</text>`
      : '';
    const hit = `<rect class="bar-hit" x="${plot.x + i * band}" y="${plot.y}" width="${band}" height="${plot.height}" data-index="${i}" data-date="${escapeXML(day.date)}" aria-hidden="true"/>`;
    barIndex += 1;
    return `<g class="bar-group" data-index="${i}">${segs}${label}${hit}</g>`;
  }).join('');

  const labelStep = Math.max(1, Math.ceil(38 / band));
  const xLabels = model.dates.map((d, i) => {
    const isLast = i === model.dates.length - 1;
    const isFirst = i === 0;
    if (!(i % labelStep === 0 || isLast || (isFirst && model.dates.length < 8))) return '';
    if (isLast && i % labelStep !== 0 && i - Math.floor(i / labelStep) * labelStep < Math.max(1, Math.floor(labelStep / 2))) return '';
    const cx = plot.x + i * band + band / 2;
    return `<text class="axis-text" x="${cx}" y="${plot.y + plot.height + 16}" text-anchor="middle">${escapeXML(d.slice(5))}</text>`;
  }).join('');

  const zeroY = tickY(0);
  const svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="每日资源消耗堆叠柱状图">`
    + grid
    + `<line class="baseline" x1="${plot.x}" x2="${plot.x + plot.width}" y1="${zeroY}" y2="${zeroY}"/>`
    + bars
    + xLabels
    + `<line class="gridline" x1="${plot.x}" x2="${plot.x}" y1="${plot.y}" y2="${plot.y + plot.height}"/>`
    + `<text class="axis-text" x="${plot.x}" y="${plot.y + plot.height + 16}" text-anchor="start"></text>`
    + '</svg>';

  return {
    svg,
    plot,
    band,
    barWidth,
    width,
    height,
    peakIndex: peakIdx,
    peakLabel: peak ? moneyExact(peak.total) : null,
    ariaSummary: `共 ${model.dates.length} 天，峰值 ${peak ? moneyExact(peak.total) : '—'}`,
  };
}

/** 迷你横向条（预算/排名）作为 SVG 之外的 HTML 更合适；此函数只做占比计算。 */
export function barRatio(value, max) {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export { moneyForAxis, moneyExact };
