/**
 * 无依赖本地服务：静态资源 + 数据读取 + 版本追加。
 * 配置写入策略：只允许追加预算版本 / 归属修订，服务端拒绝覆盖或删除既有版本。
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// server 不引入 engine 的计价（避免重复实现），只做存储与校验的轻量检查
const MONTH_RE = /^\d{4}-\d{2}$/;

async function readJSON(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function saveJSON(path, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const CONFIG_PATH = join(DATA_DIR, 'config.json');
const QUERIES_PATH = join(DATA_DIR, 'queries.csv');
const IMPORTED_PATH = join(DATA_DIR, 'imported.json');

async function loadConfig() {
  return readJSON(CONFIG_PATH, null);
}

function validateRevisionAppend(config, revision) {
  if (!revision || typeof revision !== 'object') return '修订内容缺失';
  const id = String(revision.id || '').trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(id)) return '修订 id 需为 3-64 位字母数字/.-_';
  if (config.revisions.some((r) => r.id === id)) return `修订 ${id} 已存在，版本只能追加不能覆盖`;
  if (!revision.effective_date || !/^\d{4}-\d{2}-\d{2}$/.test(revision.effective_date)) {
    return 'effective_date 需为 YYYY-MM-DD';
  }
  if (!Array.isArray(revision.changes) || !revision.changes.length) return '至少包含一条归属变更';
  for (const change of revision.changes) {
    if (!change.query_id) return '每条变更都需要 query_id';
    const to = change.to_team_id;
    if (to !== null && to !== undefined && !/^[A-Za-z0-9_-]{2,40}$/.test(String(to))) {
      return `非法目标团队: ${to}`;
    }
  }
  return null;
}

function validateBudgetAppend(config, version) {
  if (!version || typeof version !== 'object') return '预算版本缺失';
  if (!MONTH_RE.test(String(version.effective_month || ''))) return 'effective_month 需为 YYYY-MM';
  const id = String(version.version || '').trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(id)) return '预算版本号不合法';
  if (config.budgets.versions.some((v) => v.version === id)) return `预算版本 ${id} 已存在`;
  if (!version.teams || typeof version.teams !== 'object') return '缺少 teams 预算';
  for (const [team, amount] of Object.entries(version.teams)) {
    if (typeof amount !== 'number' || amount < 0) return `团队 ${team} 预算必须是非负数字`;
  }
  return null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const config = await loadConfig();
    if (!config) return send(res, 404, { error: '未找到 data/config.json，请先运行 npm run fixtures' });
    return send(res, 200, config);
  }

  if (url.pathname === '/api/queries' && req.method === 'GET') {
    try {
      const imported = await readJSON(IMPORTED_PATH, null);
      if (imported) {
        return send(res, 200, { source: 'imported.json', rows: imported.rows });
      }
    } catch (err) {
      return send(res, 500, { error: `读取导入数据失败: ${err.message}` });
    }
    try {
      const csv = await readFile(QUERIES_PATH, 'utf8');
      return send(res, 200, { source: 'queries.csv', format: 'csv', csv });
    } catch (err) {
      return send(res, 404, { error: '未找到 data/queries.csv，请先运行 npm run fixtures' });
    }
  }

  if (url.pathname === '/api/import' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const rows = body.rows;
      if (!Array.isArray(rows) || !rows.length) return send(res, 400, { error: '没有可导入的记录' });
      if (rows.length > 20_000) return send(res, 400, { error: '单次导入上限 20,000 条' });
      await saveJSON(IMPORTED_PATH, {
        imported_at: new Date().toISOString(),
        source: body.source || 'upload',
        rows,
      });
      return send(res, 200, { ok: true, imported: rows.length });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/config/revision' && req.method === 'POST') {
    try {
      const config = await loadConfig();
      if (!config) return send(res, 404, { error: '缺少配置基线' });
      const body = await readBody(req);
      const problem = validateRevisionAppend(config, body);
      if (problem) return send(res, 400, { error: problem });
      const revision = {
        id: String(body.id).trim(),
        seq: (config.revisions.at(-1)?.seq || 0) + 1,
        effective_date: body.effective_date,
        author: String(body.author || '未署名').slice(0, 80),
        note: String(body.note || '').slice(0, 300),
        created_at: new Date().toISOString(),
        changes: body.changes.map((c) => ({
          query_id: String(c.query_id),
          from_team_id: c.from_team_id ?? null,
          to_team_id: c.to_team_id ?? null,
          reason: String(c.reason || '').slice(0, 200),
        })),
      };
      const next = { ...config, revisions: [...config.revisions, revision] };
      await saveJSON(CONFIG_PATH, next);
      return send(res, 201, { ok: true, revision, config: next });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/config/budget' && req.method === 'POST') {
    try {
      const config = await loadConfig();
      if (!config) return send(res, 404, { error: '缺少配置基线' });
      const body = await readBody(req);
      const problem = validateBudgetAppend(config, body);
      if (problem) return send(res, 400, { error: problem });
      const version = {
        version: String(body.version).trim(),
        effective_month: body.effective_month,
        note: String(body.note || '').slice(0, 300),
        created_at: new Date().toISOString(),
        teams: Object.fromEntries(
          Object.entries(body.teams).map(([k, v]) => [k, Math.round(Number(v) * 100) / 100]),
        ),
      };
      const next = {
        ...config,
        budgets: { versions: [...config.budgets.versions, version].sort((a, b) =>
          a.effective_month.localeCompare(b.effective_month) || a.version.localeCompare(b.version)
        ) },
      };
      await saveJSON(CONFIG_PATH, next);
      return send(res, 201, { ok: true, budget: version, config: next });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/config/reset-import' && req.method === 'POST') {
    const { rm } = await import('node:fs/promises');
    await rm(IMPORTED_PATH, { force: true });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: '未知 API' });
}

async function serveStatic(req, res, url) {
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!extname(pathname)) pathname += '.html';
  const target = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const s = await stat(target);
    if (!s.isFile()) throw new Error('not a file');
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Cache-Control': extname(target) === '.html' ? 'no-store' : 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (err) {
      send(res, 500, { error: err.message, request_id: randomUUID() });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const app = createApp();
  app.listen(port, () => {
    console.log(`数仓成本看板: http://localhost:${port}`);
  });
}
