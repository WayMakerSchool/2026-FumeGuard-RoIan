import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// OpenAI 호환 응답을 흉내 내는 가짜 AI 서버. handler가 모델별 응답을 정한다.
async function withServers(handler, run) {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
      requests.push(request);
      const { status = 200, json } = handler(request);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  const app = createServer();
  const saved = { ...process.env };
  try {
    process.env.LLM_BASE_URL = `${await listen(upstream)}/v1`;
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'pinned-model';
    await run(await listen(app), requests);
  } finally {
    process.env = saved;
    app.close(); upstream.close();
  }
}

const analyze = base => fetch(`${base}/api/analyze`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pm: 80, voc: 600, co: 3, temp: 25, humidity: 50, score: 70, history: [10, 80] })
});
const reply = (content, finish_reason = 'stop') => ({ json: { choices: [{ message: { content }, finish_reason }] } });

test('정적 파일: 화면에 필요한 파일만 내주고 나머지는 404', async () => {
  const app = createServer();
  const base = await listen(app);
  try {
    for (const path of ['/', '/index.html', '/app.js', '/logic.js', '/styles.css', '/guide.css', '/assets/fonts/OFL.txt']) {
      assert.equal((await fetch(base + path)).status, 200, path);
    }
    for (const path of ['/.env', '/.env.example', '/.gitignore', '/server.mjs', '/package.json', '/README.md', '/test/logic.test.js', '/assets/../server.mjs', '/%2e%2e/%2e%2e/etc/hosts']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await fetch(base + '/', { method: 'DELETE' })).status, 405);
  } finally { app.close(); }
});

test('AI 분석: 지정한 모델과 키로 요청하고 답변을 돌려준다', async () => {
  await withServers(() => reply('  분석 결과입니다.  '), async (base, requests) => {
    const response = await analyze(base);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { insight: '분석 결과입니다.' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer test-key');
    assert.equal(requests[0].body.model, 'pinned-model');
  });
});

test('AI 분석: 지정한 모델의 답이 끊기면 auto로 한 번 더 시도한다', async () => {
  await withServers(request => request.body.model === 'auto' ? reply('대체 모델의 답변') : reply('끊긴 답', 'length'), async (base, requests) => {
    const response = await analyze(base);
    assert.deepEqual(await response.json(), { insight: '대체 모델의 답변' });
    assert.deepEqual(requests.map(request => request.body.model), ['pinned-model', 'auto']);
  });
});

test('AI 분석: 모두 실패하면 AI 서버의 오류 문구를 전달한다', async () => {
  await withServers(() => ({ status: 503, json: { error: { message: '사용 가능한 모델이 없습니다' } } }), async base => {
    const response = await analyze(base);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: '사용 가능한 모델이 없습니다' });
  });
});

test('AI 분석: 키가 없으면 503', async () => {
  const app = createServer();
  const saved = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    assert.equal((await analyze(await listen(app))).status, 503);
  } finally {
    if (saved !== undefined) process.env.LLM_API_KEY = saved;
    app.close();
  }
});
