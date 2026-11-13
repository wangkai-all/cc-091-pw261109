/**
 * 服务冒烟测试：起一个临时端口，验证静态资源与只读 API，以及会写入的动作在
 * 校验失败时不会落盘（重复修订 id / 非法预算）。运行：node tests/smoke.mjs
 */
import { createApp } from '../server.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, '..', 'data', 'config.json');

const app = createApp();
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const port = app.address().port;
const base = `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function get(path) {
  const res = await fetch(base + path);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const configBefore = await readFile(CONFIG_PATH, 'utf8');

const page = await get('/');
check('GET / 返回页面', page.status === 200 && page.text.includes('数仓成本账房'), `status=${page.status}`);

const css = await get('/styles.css');
check('GET /styles.css', css.status === 200 && css.headers.get('content-type').includes('text/css'));

const appJs = await get('/app.js');
check('GET /app.js', appJs.status === 200 && appJs.headers.get('content-type').includes('javascript'));

const configResp = await get('/api/config');
const config = JSON.parse(configResp.text);
check('GET /api/config', configResp.status === 200 && Array.isArray(config.revisions) && config.teams);

const queriesResp = await get('/api/queries');
const queries = JSON.parse(queriesResp.text);
check('GET /api/queries 有数据源', queriesResp.status === 200 && typeof queries.source === 'string');
check('查询数据非空', (queries.csv ? queries.csv.split('\n').length : (queries.rows || []).length) > 10);

const missing = await get('/api/not-a-real-endpoint');
check('未知 API 返回 404 JSON', missing.status === 404 && JSON.parse(missing.text).error);

const traversal = await get('/%2e%2e/%2e%2e/etc/passwd');
check('目录穿越被拒绝', traversal.status === 403 || traversal.status === 404, `status=${traversal.status}`);

// 校验失败的写入：重复修订 id 必须被拒绝，且不能改动 config.json
const dupRevision = await post('/api/config/revision', {
  id: config.revisions[config.revisions.length - 1].id,
  effective_date: '2026-11-20',
  changes: [{ query_id: 'q-202611-0215', to_team_id: 'growth' }],
});
check('重复修订 id 被拒绝', dupRevision.status === 400 && /已存在/.test(dupRevision.json?.error || ''));

const badBudget = await post('/api/config/budget', {
  version: 'BUD-SMOKE-BAD',
  effective_month: '2026-12',
  teams: { analytics: -1 },
});
check('负预算被拒绝', badBudget.status === 400 && /非负/.test(badBudget.json?.error || ''));

const emptyRevision = await post('/api/config/revision', {
  id: 'ATT-SMOKE-EMPTY',
  effective_date: '2026-11-20',
  changes: [],
});
check('空变更修订被拒绝', emptyRevision.status === 400 && /至少包含一条/.test(emptyRevision.json?.error || ''));

const configAfter = await readFile(CONFIG_PATH, 'utf8');
check('校验失败不写入配置文件', configBefore === configAfter);

await new Promise((resolve) => app.close(resolve));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
