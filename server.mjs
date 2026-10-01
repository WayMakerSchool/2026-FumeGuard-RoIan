import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
// 브라우저에 내줄 파일만 허용한다. 서버 코드, 설정, .env 같은 나머지는 404로 응답한다.
const publicFiles = new Set(['index.html', 'app.js', 'logic.js', 'styles.css', 'guide.css']);
const publicDirectory = 'assets/';

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50000) reject(new Error('요청이 너무 큽니다'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ── AI 정밀 분석 ──────────────────────────────────────────────
// OpenAI 호환 chat/completions 엔드포인트를 호출한다. 기본값은 로컬에서 실행한 FreeLLMAPI 데스크톱 앱.
function llmConfig() {
  return {
    base: (process.env.LLM_BASE_URL || 'http://127.0.0.1:31415/v1').replace(/\/+$/, ''),
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || 'auto'
  };
}

function analysisPrompt(sensor) {
  return `당신은 조리흄 안전 모니터링 보조 AI입니다. 아래 센서 데이터를 분석해 한국어 2문장으로만 답하세요.
첫 문장은 데이터 변화와 위험도가 높아진 원인을 설명하고, 둘째 문장은 지금 바로 할 행동을 말하세요.
데이터에 없는 기준치나 수치를 지어내지 말고, 진단이나 치료 표현은 피하고, 불확실하면 불확실하다고 명시하세요.

필드 설명:
- pm: 초미세먼지 PM2.5 (µg/m³), voc: 휘발성 유기화합물 (ppb), co: 일산화탄소 (ppm)
- temp: 온도 (°C), humidity: 습도 (%)
- score: 앱이 계산한 종합 위험도 0~100 (30 미만 안전, 30~54 주의, 55~74 위험, 75 이상 매우 위험)
- history: 최근 PM2.5 값을 1초 간격으로 나열한 것 (마지막이 현재)
- source: simulation이면 시연용 가상 데이터

데이터: ${JSON.stringify(sensor)}`;
}

// 추론 모델은 생각하는 데도 토큰을 쓰므로 max_tokens를 넉넉히 준다. 잘린 응답은 실패로 처리한다.
async function askModel(model, prompt, timeoutMs) {
  const { base, key } = llmConfig();
  let api;
  try {
    api = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 2000 })
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError'
      ? 'AI 서버 응답 시간이 초과됐습니다'
      : `AI 서버(${base})에 연결하지 못했습니다. FreeLLMAPI가 실행 중인지 확인하세요`);
  }
  const data = await api.json().catch(() => ({}));
  if (!api.ok) throw new Error(data.error?.message || `AI 서버 요청에 실패했습니다 (${api.status})`);
  const choice = data.choices?.[0];
  const insight = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
  if (!insight || choice.finish_reason === 'length') throw new Error('AI 응답이 비어 있거나 중간에 끊겼습니다');
  return insight;
}

async function analyze(req, res) {
  const { key, model } = llmConfig();
  if (!key) return send(res, 503, JSON.stringify({ error: '서버에 LLM_API_KEY가 설정되지 않았습니다' }));
  try {
    const prompt = analysisPrompt(JSON.parse(await readBody(req)));
    let insight;
    // 지정한 모델이 실패하면 라우터가 고르는 auto로 한 번 더 시도한다.
    try {
      insight = await askModel(model, prompt, 14000);
    } catch (error) {
      if (model === 'auto') throw error;
      insight = await askModel('auto', prompt, 12000);
    }
    return send(res, 200, JSON.stringify({ insight }));
  } catch (error) {
    return send(res, 500, JSON.stringify({ error: error.message }));
  }
}

// ── 정적 파일 ─────────────────────────────────────────────────
function publicPath(url) {
  const pathname = decodeURIComponent(url.split('?')[0]);
  const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/\\/g, '/').replace(/^\/+/, '');
  if (relative.split('/').some(part => part === '..' || part.startsWith('.'))) return null;
  if (!publicFiles.has(relative) && !relative.startsWith(publicDirectory)) return null;
  return join(root, relative);
}

async function serveStatic(req, res) {
  try {
    const file = publicPath(req.url);
    if (!file) throw new Error('not public');
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    send(res, 404, '찾을 수 없습니다', 'text/plain; charset=utf-8');
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/analyze') return analyze(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '허용되지 않은 요청', 'text/plain; charset=utf-8');
    return serveStatic(req, res);
  });
}

// 직접 실행했을 때만 포트를 연다(테스트는 createServer만 가져다 쓴다).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4173);
  createServer().listen(port, '127.0.0.1', () => console.log(`FumeGuard AI: http://127.0.0.1:${port}`));
}
