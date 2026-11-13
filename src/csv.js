/** 最小 CSV 解析：支持引号、转义、CRLF 与 BOM。 */
export function parseCSV(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else { inQuotes = false; }
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = cells[i] ?? ''; });
    return obj;
  });
}

const TABLE_KEYS = new Set(['dataset_id', 'dataset', 'table', 'table_name', 'scan_bytes', 'bytes_scanned', 'elapsed_ms', 'duration_ms']);

/** 把「表访问级」CSV 行按 query_id 合并成查询记录。 */
export function rowsToQueries(rows, warnings = []) {
  const byQuery = new Map();
  for (const row of rows) {
    const id = (row.query_id || row.queryId || '').trim();
    if (!id) continue;
    if (!byQuery.has(id)) {
      const record = {};
      for (const [k, v] of Object.entries(row)) {
        if (!TABLE_KEYS.has(k)) record[k] = v;
      }
      if (record.status === undefined && row.status) record.status = row.status;
      record.tables = [];
      record.query_id = id;
      byQuery.set(id, record);
    }
    const record = byQuery.get(id);
    const hasTable = (row.table || row.table_name || '').trim() || (row.dataset_id || row.dataset || '').trim();
    if (!hasTable) continue;
    record.tables.push({
      dataset_id: (row.dataset_id || row.dataset || '').trim(),
      table: (row.table || row.table_name || '').trim(),
      scan_bytes: row.scan_bytes !== undefined && row.scan_bytes !== '' ? Number(row.scan_bytes) : (row.bytes_scanned !== undefined && row.bytes_scanned !== '' ? Number(row.bytes_scanned) : null),
      elapsed_ms: row.elapsed_ms !== undefined && row.elapsed_ms !== '' ? Number(row.elapsed_ms) : (row.duration_ms !== undefined && row.duration_ms !== '' ? Number(row.duration_ms) : null),
    });
  }
  const queries = [...byQuery.values()];
  const missing = queries.filter((q) => q.tables.length === 0);
  if (missing.length) warnings.push(`${missing.length} 条记录没有表访问明细，将作为未知成本处理`);
  return queries.map((q) => {
    const missing_fields = (q.missing_fields || '').split('|').filter(Boolean);
    const metering_complete = q.metering_complete === undefined || q.metering_complete === ''
      ? missing_fields.length === 0
      : String(q.metering_complete).toLowerCase() !== 'false';
    return { ...q, missing_fields, metering_complete };
  });
}

/** 把「查询级」JSON（含 tables 数组）亦兼容进来。 */
export function rowsToQueriesLoose(input) {
  if (Array.isArray(input)) {
    if (input.some((x) => x && typeof x === 'object' && Array.isArray(x.tables))) {
      return input;
    }
    return rowsToQueries(input);
  }
  return [];
}
