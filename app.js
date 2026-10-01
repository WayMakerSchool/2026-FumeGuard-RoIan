import {
  SERVICE_UUID, SENSOR_UUID, CONTROL_UUID, MAX_RECONNECTS,
  clamp, sensorKeys, validSensor, contributions as riskContributions, calculateScore, level,
  fanModes, normalizeFanSetting, stepAutoLevel, targetFanLevel, fanCommand, reportedFan, reconnectDelay
} from './logic.js';

const $ = id => document.getElementById(id);
const metrics = {
  pm: { name: 'PM2.5', unit: 'µg/m³', color: '#86dfb4', threshold: 35, minScale: 50, decimals: 0 },
  voc: { name: 'VOC', unit: 'ppb', color: '#8bb9d8', threshold: 500, minScale: 600, decimals: 0 },
  co: { name: 'CO', unit: 'ppm', color: '#e9b296', threshold: 7, minScale: 10, decimals: 1 }
};
function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
const storedHistory = readStored('fg-history', []);
const realHistory = Array.isArray(storedHistory) ? storedHistory.filter(row => validSensor(row) && Number.isFinite(row.time) && Number.isFinite(row.score)).slice(-900) : [];
const storedCount = Number(readStored('fg-count', 0));
const state = {
  pm: 0, voc: 0, co: 0, temp: 0, humidity: 0, score: 0,
  demo: true, connected: false, connecting: false, hasData: false,
  history: [], realHistory, count: Number.isFinite(storedCount) ? Math.max(0, storedCount) : 0,
  range: 60, metric: 'pm', exposure: 0, scenario: false, demoStep: 0,
  device: null, lastReceived: 0, revision: 0, apiInsight: '', apiExpires: 0,
  sound: false, previousLevel: 0, reconnectAttempt: 0,
  fan: { ...normalizeFanSetting(readStored('fg-fan', null)), auto: { level: 0, lowerSince: null }, sentKey: null, status: 'idle', failures: 0, reported: null }
};
const timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function contributions(data = state, history = state.history) { return riskContributions(data, history); }
function hasCurrentData() {
  return state.hasData && (state.demo || (state.connected && Date.now() - state.lastReceived < 10000));
}
function assignReadings(data) { for (const key of sensorKeys) state[key] = data[key]; }
function saveRealData() {
  try {
    localStorage.setItem('fg-count', String(state.count));
    localStorage.setItem('fg-history', JSON.stringify(state.realHistory.slice(-900)));
  } catch { /* Monitoring remains available when local storage is unavailable. */ }
}
function addSample(data, time = Date.now()) {
  const previous = state.history.at(-1);
  const row = { ...data, time, score: calculateScore({ ...data, time }, state.history) };
  if (previous && previous.score >= 30) state.exposure += clamp((time - previous.time) / 1000, 0, 2);
  state.history.push(row);
  if (state.history.length > 900) state.history.shift();
  if (!state.demo) {
    state.realHistory = state.history;
    state.count++;
    if (state.count % 5 === 0) saveRealData();
  }
  assignReadings(data);
  state.hasData = true;
  state.lastReceived = time;
  if (level(state.score).name !== level(row.score).name) clearInsight();
  state.score = row.score;
}
function seedDemo() {
  state.history = [];
  state.exposure = 0;
  const now = Date.now();
  for (let i = 0; i < 900; i++) {
    const cooking = Math.exp(-Math.pow((i - 470) / 100, 2));
    const recent = Math.exp(-Math.pow((i - 848) / 18, 2));
    const wave = Math.sin(i / 15) * 1.4 + Math.sin(i / 5) * .65;
    addSample({ pm: 13 + cooking * 71 + recent * 16 + wave, voc: 176 + cooking * 560 + recent * 68 + wave * 5, co: 1.2 + cooking * 3.6 + recent * .2, temp: 24.6 + cooking * 1.8, humidity: 48 + cooking * 6 }, now - (899 - i) * 1000);
  }
  state.demoStep = 0;
  state.previousLevel = state.score >= 55 ? 1 : 0;
}
function clearInsight() { state.apiInsight = ''; state.apiExpires = 0; state.revision++; }
function setDemo(enabled) {
  if (enabled && state.connected) { toast('실제 센서 연결을 해제한 뒤 시연 모드를 켜세요.'); return; }
  if (enabled) cancelReconnect();
  state.demo = enabled;
  state.scenario = false;
  state.hasData = false;
  state.exposure = 0;
  state.fan.auto = { level: 0, lowerSince: null };
  clearInsight();
  if (enabled) seedDemo(); else state.history = state.realHistory;
  render();
}
function demoTick() {
  state.demoStep++;
  const t = state.demoStep;
  const target = state.scenario
    ? { pm: 122 + Math.sin(t / 4) * 6, voc: 1190 + Math.sin(t / 6) * 30, co: 8.4, temp: 27.2, humidity: 56 }
    : { pm: 13 + Math.sin(t / 9) * 2 + Math.sin(t / 3) * .7, voc: 179 + Math.sin(t / 12) * 17, co: 1.2 + Math.sin(t / 13) * .08, temp: 24.6 + Math.sin(t / 30) * .2, humidity: 48 + Math.sin(t / 25) * 1.5 };
  const data = {};
  for (const key of sensorKeys) data[key] = state[key] + (target[key] - state[key]) * (state.scenario ? .23 : .15);
  addSample(data);
}
function setStatus(id, name, color) {
  const element = $(id);
  element.textContent = name;
  element.style.color = color;
  element.style.backgroundColor = `${color}15`;
}
function render() {
  const current = hasCurrentData();
  const l = level(state.score);
  document.documentElement.style.setProperty('--risk', current ? l.color : '#75857b');
  document.body.classList.toggle('danger', current && state.score >= 55);
  document.body.classList.toggle('idle', !current);
  $('riskScore').textContent = current ? state.score : '—';
  $('gaugeFill').style.strokeDasharray = `${current ? state.score : 0} 100`;
  const angle = Math.PI * (1 - (current ? state.score : 0) / 100);
  $('gaugeDot').setAttribute('cx', 130 + 100 * Math.cos(angle));
  $('gaugeDot').setAttribute('cy', 135 - 100 * Math.sin(angle));
  $('riskPill').textContent = current ? l.name : '측정 대기';
  $('riskPill').style.backgroundColor = `${current ? l.color : '#75857b'}15`;
  $('riskPill').style.borderColor = `${current ? l.color : '#75857b'}40`;
  $('riskTitle').textContent = current ? l.title : state.connected ? '센서 데이터를 기다리고 있어요' : '센서를 연결해 공기를 확인하세요';
  $('riskDescription').textContent = current ? l.desc : '측정 전에는 공기질과 위험도를 판단하지 않습니다.';
  $('aiInsight').textContent = current ? (state.apiInsight && Date.now() < state.apiExpires ? state.apiInsight : l.insight) : 'ESP32 센서를 연결하거나 시연 모드를 켜면 분석을 시작합니다.';
  $('actionTitle').textContent = current ? l.action : '센서 연결 상태를 확인하세요';
  $('actionDescription').textContent = current ? l.actionDesc : '측정값이 수신되면 공기 상태에 맞는 환기 행동을 안내합니다.';
  for (const key of ['pm', 'voc', 'co']) $(key + 'Value').textContent = current ? state[key].toFixed(metrics[key].decimals) : '—';
  $('tempValue').textContent = current ? state.temp.toFixed(1) : '—';
  $('humidityValue').textContent = current ? Math.round(state.humidity) : '—';
  const pmStage = state.pm < 16 ? 0 : state.pm < 36 ? 1 : state.pm < 76 ? 2 : 3;
  const vocStage = state.voc < 150 ? 0 : state.voc < 500 ? 1 : state.voc < 1000 ? 2 : 3;
  const coStage = state.co < 3 ? 0 : state.co < 7 ? 1 : 3;
  const colors = ['#86dfb4', '#d6c584', '#e9b296', '#e68d8d'];
  setStatus('pmStatus', current ? ['좋음', '보통', '나쁨', '매우 나쁨'][pmStage] : '대기', current ? colors[pmStage] : '#83938a');
  setStatus('vocStatus', current ? ['좋음', '보통', '나쁨', '위험'][vocStage] : '대기', current ? colors[vocStage] : '#83938a');
  setStatus('coStatus', current ? ['좋음', '주의', '', '위험'][coStage] : '대기', current ? colors[coStage] : '#83938a');
  $('connectionBadge').classList.toggle('connected', state.connected);
  $('connectionBadge').querySelector('span').textContent = state.demo ? '시뮬레이션' : state.connected ? current ? 'ESP32 연결됨' : '센서 수신 대기' : state.reconnectAttempt ? `재연결 중 ${state.reconnectAttempt}/${MAX_RECONNECTS}` : '센서 미연결';
  $('connectButton').querySelector('span').textContent = state.connecting ? '연결 중…' : state.connected ? '센서 연결 해제' : state.reconnectAttempt ? '재연결 취소' : '센서 연결';
  $('connectButton').disabled = state.connecting;
  $('demoButton').setAttribute('aria-pressed', String(state.demo));
  $('demoNotice').hidden = !state.demo;
  $('samplingLabel').textContent = state.demo ? '시뮬레이션 · 1초 간격' : state.connected ? 'ESP32 · 실시간 수신' : state.reconnectAttempt ? '센서 재연결 시도 중' : '센서 연결 대기';
  $('scenarioButton').classList.toggle('running', state.scenario);
  $('scenarioButton').querySelector('span').textContent = state.scenario ? '환기 회복 시연' : '위험 상황 시연';
  $('airflowState').textContent = current ? state.demo ? '시연 데이터 수신 중' : '센서 데이터 수신 중' : '측정 대기';
  $('ventilationStatus').textContent = current ? l.vent : '센서 연결 필요';
  $('ventilationStatus').style.color = current ? l.color : '#83938a';
  $('dataCount').textContent = state.demo ? `${state.history.length.toLocaleString()}건 · 시연` : `${state.count.toLocaleString()}건 · 센서`;
  drawCharts();
  renderContributions(current);
  renderExposure();
  renderFan();
  if (current && state.score >= 55 && state.previousLevel === 0 && state.sound) playAlert();
  state.previousLevel = current && state.score >= 55 ? 1 : 0;
}
function renderContributions(current) {
  const values = current ? contributions() : { pm: 0, voc: 0, co: 0, rise: 0 };
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  $('contributionTotal').textContent = current ? total.toFixed(1) : '—';
  const palette = { pm: '#86dfb4', voc: '#8bb9d8', co: '#e9b296', rise: '#b1a1d6' };
  let start = 0;
  const segments = Object.entries(values).map(([key, value]) => {
    $(key + 'Contribution').textContent = current ? `${value.toFixed(1)}점` : '—';
    const end = start + (total > 0 ? value / total * 360 : 0);
    const part = `${palette[key]} ${start}deg ${end}deg`;
    start = end;
    return part;
  });
  $('contributionDonut').style.background = total > 0 ? `conic-gradient(${segments.join(',')})` : '#2d3e32';
  $('contributionDonut').setAttribute('role', 'img');
  $('contributionDonut').setAttribute('aria-label', current ? `오염 기여 점수 합계 ${total.toFixed(1)}점` : '기여 분석 측정 대기');
}
const timelineCells = Array.from({ length: 15 }, () => {
  const cell = document.createElement('span');
  $('exposureTimeline').appendChild(cell);
  return cell;
});
function renderExposure() {
  const now = Date.now();
  for (let i = 0; i < 15; i++) {
    const begin = now - (15 - i) * 60000;
    const rows = state.history.filter(row => row.time >= begin && row.time < begin + 60000);
    const score = rows.length ? rows.reduce((sum, row) => sum + row.score, 0) / rows.length : null;
    timelineCells[i].style.background = score === null ? '#27362b' : level(score).color;
    timelineCells[i].style.opacity = score === null ? '.6' : '.65';
    timelineCells[i].title = `${15 - i}분 전: ${score === null ? '미측정' : '평균 위험도 ' + Math.round(score)}`;
  }
  let recentTotal = 0, risky = 0;
  for (let i = 0; i < state.history.length - 1; i++) {
    const row = state.history[i], next = state.history[i + 1];
    if (next.time <= now - 900000 || row.time > now) continue;
    const duration = clamp((Math.min(next.time, now) - Math.max(row.time, now - 900000)) / 1000, 0, 2);
    recentTotal += duration;
    if (row.score >= 30) risky += duration;
  }
  const percent = recentTotal ? Math.round(risky / recentTotal * 100) : 0;
  $('exposureMinutes').textContent = Math.floor(state.exposure / 60);
  $('exposureSeconds').textContent = `${Math.floor(state.exposure % 60)}초`;
  $('exposurePercent').textContent = `${percent}%`;
  $('exposureProgress').style.width = `${percent}%`;
}
const liveChart = $('liveChart');
const liveContext = liveChart.getContext('2d');
let plottedPoints = [];
let hoveredTime = null;
function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}
function drawSpark(key) {
  const { context: ctx, width: w, height: h } = prepareCanvas($(key + 'Spark'));
  const rows = state.history.filter(row => row.time >= Date.now() - 60000);
  if (rows.length < 2) return;
  const values = rows.map(row => row[key]);
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, key === 'co' ? .2 : 3);
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i / (values.length - 1) * (w - 2) + 1, y = h - 4 - (v - min) / span * (h - 8);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = metrics[key].color;
  ctx.lineWidth = 1.35;
  ctx.stroke();
}
function drawCharts() {
  for (const key of ['pm', 'voc', 'co']) drawSpark(key);
  drawLiveChart();
}
function drawLiveChart() {
  const { context: ctx, width: w, height: h } = prepareCanvas(liveChart);
  if (!w || !h) return;
  const config = metrics[state.metric], now = Date.now(), begin = now - state.range * 1000;
  const rows = state.history.filter(row => row.time >= begin && row.time <= now);
  if (!rows.length) { hoveredTime = null; $('chartTooltip').style.display = 'none'; }
  $('chartUnit').textContent = config.unit;
  liveChart.setAttribute('aria-label', `${config.name} 최근 ${state.range / 60}분 추이, 단위 ${config.unit}`);
  $('chartEmpty').hidden = rows.length > 0;
  const left = 40, right = 12, top = 16, bottom = 30;
  const pw = w - left - right, ph = h - top - bottom;
  const rawMax = Math.max(config.minScale, config.threshold * 1.2, ...rows.map(row => row[state.metric] * 1.2));
  const step = config.decimals ? .5 : rawMax > 200 ? 100 : 10;
  const max = Math.ceil(rawMax / step) * step;
  ctx.font = '12px Pretendard, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = top + i * ph / 4;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right, y);
    ctx.strokeStyle = '#2c3d314d'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#718876';
    ctx.fillText((max * (1 - i / 4)).toFixed(config.decimals), left - 8, y + 4);
  }
  const thresholdY = top + ph * (1 - config.threshold / max);
  ctx.fillStyle = '#e9b29605'; ctx.fillRect(left, top, pw, thresholdY - top);
  ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(left, thresholdY); ctx.lineTo(w - right, thresholdY);
  ctx.strokeStyle = '#c6ad754f'; ctx.stroke(); ctx.setLineDash([]);
  ctx.textAlign = 'right'; ctx.fillStyle = '#aa9971'; ctx.font = '11px Pretendard, sans-serif';
  ctx.fillText(`모델 주의 기준 ${config.threshold}`, w - right - 3, thresholdY - 6);
  plottedPoints = rows.map(row => ({ row, x: left + (row.time - begin) / (state.range * 1000) * pw, y: top + ph * (1 - row[state.metric] / max) }));
  // Separate paths at missing-data intervals so gaps never appear as continuous monitoring.
  const groups = [];
  for (const point of plottedPoints) {
    const previous = groups.at(-1)?.at(-1);
    if (!previous || point.row.time - previous.row.time > 10000) groups.push([]);
    groups.at(-1).push(point);
  }
  const gradient = ctx.createLinearGradient(0, top, 0, h - bottom);
  gradient.addColorStop(0, config.color + '30'); gradient.addColorStop(1, config.color + '00');
  for (const group of groups) {
    ctx.beginPath(); group.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.lineTo(group.at(-1).x, h - bottom); ctx.lineTo(group[0].x, h - bottom); ctx.closePath();
    ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); group.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.strokeStyle = config.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
  }
  const last = plottedPoints.at(-1);
  if (last) {
    ctx.beginPath(); ctx.arc(last.x, last.y, 6, 0, Math.PI * 2); ctx.fillStyle = config.color + '20'; ctx.fill();
    ctx.beginPath(); ctx.arc(last.x, last.y, 2.8, 0, Math.PI * 2); ctx.fillStyle = config.color; ctx.fill();
  }
  ctx.fillStyle = '#718876'; ctx.font = '11px Pretendard, sans-serif';
  for (let i = 0; i <= 4; i++) {
    ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
    const ago = state.range * (1 - i / 4);
    const label = i === 4 ? '현재' : ago >= 60 ? `${Number((ago / 60).toFixed(1))}분 전` : `${ago}초 전`;
    ctx.fillText(label, left + i * pw / 4, h - 7);
  }
  if (hoveredTime !== null && plottedPoints.length) {
    const point = plottedPoints.reduce((best, p) => Math.abs(p.row.time - hoveredTime) < Math.abs(best.row.time - hoveredTime) ? p : best);
    drawHover(point, ctx, h, w);
  }
  const values = rows.map(row => row[state.metric]);
  $('chartCurrent').textContent = hasCurrentData() ? state[state.metric].toFixed(config.decimals) : '—';
  $('chartAverage').textContent = values.length ? (values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(config.decimals) : '—';
  $('chartPeak').textContent = values.length ? Math.max(...values).toFixed(config.decimals) : '—';
  $('updatedTime').textContent = state.history.length ? timeFormat.format(new Date(state.history.at(-1).time)) : '—';
}
function drawHover(point, ctx, h, w) {
  ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(point.x, 16); ctx.lineTo(point.x, h - 30);
  ctx.strokeStyle = '#8da78f70'; ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2); ctx.fillStyle = metrics[state.metric].color; ctx.fill();
  const tooltip = $('chartTooltip');
  tooltip.innerHTML = `<span>${timeFormat.format(new Date(point.row.time))}</span><br>${metrics[state.metric].name} <b>${point.row[state.metric].toFixed(metrics[state.metric].decimals)}</b> ${metrics[state.metric].unit}`;
  tooltip.style.display = 'block';
  tooltip.style.left = `${clamp(point.x + 12, 0, Math.max(0, w - tooltip.offsetWidth))}px`;
  tooltip.style.top = `${clamp(point.y - 54, 0, h - 50)}px`;
}
liveChart.addEventListener('pointermove', event => {
  if (!plottedPoints.length) return;
  const x = event.clientX - liveChart.getBoundingClientRect().left;
  hoveredTime = plottedPoints.reduce((best, p) => Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best).row.time;
  drawLiveChart();
});
liveChart.addEventListener('pointerleave', () => { hoveredTime = null; $('chartTooltip').style.display = 'none'; drawLiveChart(); });
for (const selector of ['[data-chart]', '[data-range]']) {
  document.querySelectorAll(selector).forEach(button => button.addEventListener('click', () => {
    if (button.dataset.chart) state.metric = button.dataset.chart;
    if (button.dataset.range) state.range = Number(button.dataset.range);
    document.querySelectorAll(selector).forEach(item => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    hoveredTime = null; $('chartTooltip').style.display = 'none'; drawCharts();
  }));
}
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').classList.add('show');
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
}
$('demoButton').addEventListener('click', () => setDemo(!state.demo));
$('scenarioButton').addEventListener('click', () => {
  if (state.connected) { toast('위험 상황 시연은 센서 연결 해제 후 사용할 수 있습니다.'); return; }
  if (!state.demo) setDemo(true);
  state.scenario = !state.scenario;
  clearInsight();
  toast(state.scenario ? '시연: 조리흄 증가 → 위험도 상승 → 환기 권장' : '시연: 환기를 통해 공기질이 서서히 회복됩니다.');
  render();
});
$('resetButton').addEventListener('click', () => {
  state.history = []; state.exposure = 0; clearInsight();
  if (!state.demo) { state.realHistory = []; state.count = 0; saveRealData(); }
  render(); toast(state.demo ? '시연 기록을 초기화했습니다.' : '이 기기에 저장된 센서 기록을 초기화했습니다.');
});
$('exportButton').addEventListener('click', () => {
  if (!state.history.length) { toast('내보낼 측정 기록이 없습니다.'); return; }
  const rows = ['source,time,pm_ug_m3,voc_ppb,co_ppm,temp_c,humidity_percent,risk_score'];
  for (const row of state.history) rows.push([state.demo ? 'simulation' : 'sensor', new Date(row.time).toISOString(), row.pm.toFixed(2), row.voc.toFixed(2), row.co.toFixed(2), row.temp.toFixed(2), row.humidity.toFixed(2), row.score].join(','));
  const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `fumeguard-${state.demo ? 'simulation' : 'sensor'}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`최근 ${state.history.length}건을 CSV로 내보냈습니다.`);
});
let audioContext;
function playAlert() {
  try {
    if (!audioContext || audioContext.state !== 'running') return;
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(.07, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .35);
    oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + .35);
  } catch { /* Visual alerts continue if the browser blocks audio. */ }
}
$('soundButton').addEventListener('click', async () => {
  try {
    if (!state.sound) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('이 브라우저에서 알림음을 지원하지 않습니다.');
      audioContext ||= new Audio(); await audioContext.resume();
    }
    state.sound = !state.sound;
    $('soundButton').setAttribute('aria-pressed', String(state.sound));
    $('soundButton').setAttribute('aria-label', `위험 알림음 ${state.sound ? '끄기' : '켜기'}`);
    if (state.sound) playAlert();
    toast(`위험 단계 알림음을 ${state.sound ? '켰습니다' : '껐습니다'}.`);
  } catch (error) { toast(error.message); }
});
$('aiAnalyzeButton').addEventListener('click', async () => {
  if (!hasCurrentData()) { toast('센서를 연결하거나 시연 모드를 켜세요.'); return; }
  const button = $('aiAnalyzeButton'), revision = state.revision;
  button.disabled = true; button.querySelector('span').textContent = '분석 중…';
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ pm: state.pm, voc: state.voc, co: state.co, temp: state.temp, humidity: state.humidity, score: state.score, source: state.demo ? 'simulation' : 'sensor', history: state.history.slice(-30).map(row => row.pm) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '분석에 실패했습니다.');
    if (revision !== state.revision) return;
    state.apiInsight = data.insight; state.apiExpires = Date.now() + 30000;
    render(); toast(`${state.demo ? '시연 데이터의 ' : ''}AI 정밀 분석이 완료됐습니다.`);
  } catch (error) { toast(error.name === 'TimeoutError' ? '분석 시간이 초과됐습니다. 다시 시도하세요.' : error.message); }
  finally { button.disabled = false; button.querySelector('span').textContent = 'AI 정밀 분석'; }
});
// ── 에어커튼 바람 제어 ─────────────────────────────────────────
let controlCharacteristic = null;
let writeChain = Promise.resolve();
function fanTarget() { return targetFanLevel(state.fan.mode, state.fan.level, state.fan.auto.level); }
function saveFan() {
  try { localStorage.setItem('fg-fan', JSON.stringify({ mode: state.fan.mode, level: state.fan.level })); } catch { /* 저장하지 못해도 제어는 계속된다. */ }
}
// 자동 단계를 갱신하고, 기기에 마지막으로 보낸 값과 달라졌으면 제어 특성에 쓴다.
function syncFan() {
  if (hasCurrentData()) stepAutoLevel(state.fan.auto, state.score, Date.now());
  const target = fanTarget(), key = `${state.fan.mode}:${target}`;
  if (!state.demo && state.connected && controlCharacteristic && key !== state.fan.sentKey && state.fan.failures < 3) {
    const characteristic = controlCharacteristic;
    const payload = new TextEncoder().encode(fanCommand(state.fan.mode, target));
    state.fan.sentKey = key; state.fan.status = 'sending';
    // GATT 쓰기는 한 번에 하나만 가능하므로 순서대로 이어 붙인다.
    writeChain = writeChain.then(() => characteristic.writeValueWithResponse(payload)).then(
      () => { state.fan.failures = 0; if (state.fan.sentKey === key) state.fan.status = 'sent'; },
      () => { state.fan.failures++; if (state.fan.sentKey === key) { state.fan.sentKey = null; state.fan.status = 'error'; } }
    ).then(renderFan);
  }
  renderFan();
}
function fanStatusText(target) {
  if (state.demo) return '시연 모드에서는 바람 단계를 화면에만 표시하고 기기로 보내지 않습니다.';
  if (!state.connected) return '센서를 연결하면 이 설정을 에어커튼으로 전송합니다.';
  if (!controlCharacteristic) return '연결된 기기에 바람 제어 특성이 없습니다. ESP32 펌웨어를 확인하세요.';
  if (state.fan.status === 'error') return state.fan.failures >= 3 ? '전송에 실패했습니다. 버튼을 다시 누르면 재시도합니다.' : '전송에 실패해 다시 시도하고 있습니다.';
  if (state.fan.status === 'sending') return '에어커튼으로 전송 중…';
  if (state.fan.reported !== null && state.fan.reported !== target) return `에어커튼으로 전송했지만 기기는 ${state.fan.reported ? state.fan.reported + '단' : '꺼짐'}으로 보고하고 있습니다.`;
  return state.fan.status === 'sent' ? '에어커튼으로 전송했습니다.' : '에어커튼과 연결되어 있습니다.';
}
function renderFan() {
  const target = fanTarget(), fan = state.fan;
  $('fanNow').textContent = target ? `${target}단` : '꺼짐';
  $('fanSection').classList.toggle('running', target > 0);
  $('fanBars').querySelectorAll('i').forEach((bar, i) => bar.classList.toggle('on', i < target));
  document.querySelectorAll('[data-fan-mode]').forEach(button => {
    const active = button.dataset.fanMode === fan.mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-fan-level]').forEach(button => {
    const active = Number(button.dataset.fanLevel) === target;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  let desc = fanModes[fan.mode].desc;
  if (fan.mode === 'auto' && !hasCurrentData()) desc += ' 측정값이 들어오면 단계를 정합니다.';
  if (fan.mode === 'always') desc += target > fan.level ? ` 지금은 기본 ${fan.level}단에서 ${target}단으로 올렸습니다.` : ` 기본 ${fan.level}단.`;
  $('fanModeDesc').textContent = desc;
  $('fanStatus').textContent = fanStatusText(target);
  $('fanStatus').classList.toggle('error', !state.demo && state.connected && (fan.status === 'error' || !controlCharacteristic));
}
function fanChanged() { state.fan.failures = 0; saveFan(); syncFan(); }
document.querySelectorAll('[data-fan-mode]').forEach(button => button.addEventListener('click', () => {
  state.fan.mode = button.dataset.fanMode; fanChanged();
}));
// 끄기·자동 상태에서 단계를 누르면 그 단계의 수동 모드로 바꾼다. 상시 가동에서는 기본 단계를 바꾼다.
document.querySelectorAll('[data-fan-level]').forEach(button => button.addEventListener('click', () => {
  state.fan.level = Number(button.dataset.fanLevel);
  if (state.fan.mode !== 'always') state.fan.mode = 'manual';
  fanChanged();
}));

// ── ESP32 BLE 연결 ────────────────────────────────────────────
let reconnectTimer = null;
let userDisconnect = false;
function onSensorValue(event) {
  try {
    const data = JSON.parse(new TextDecoder().decode(event.target.value));
    if (!validSensor(data)) { toast('센서 데이터 형식을 확인하세요.'); return; }
    if (state.demo || !state.connected) return;
    state.fan.reported = reportedFan(data);
    addSample(data); render();
  } catch { toast('센서 데이터를 읽지 못했습니다.'); }
}
// GATT 연결을 열고 센서 알림을 구독한다. 바람 제어 특성은 없어도 모니터링은 계속된다.
async function openGatt(device) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const sensor = await service.getCharacteristic(SENSOR_UUID);
  let control = null;
  try { control = await service.getCharacteristic(CONTROL_UUID); } catch { /* 구형 펌웨어 */ }
  // Subscribe before enabling notifications so the first valid reading is retained.
  sensor.addEventListener('characteristicvaluechanged', onSensorValue);
  controlCharacteristic = control;
  state.fan.sentKey = null; state.fan.failures = 0; state.fan.status = 'idle'; state.fan.reported = null;
  state.connected = true;
  try { await sensor.startNotifications(); }
  catch (error) { abandon(device); throw error; }
}
// 연결 상태를 먼저 내려 두면 뒤따르는 gattserverdisconnected 이벤트가 재연결을 시작하지 않는다.
function abandon(device) {
  state.connected = false; controlCharacteristic = null;
  try { if (device?.gatt.connected) device.gatt.disconnect(); } catch { /* 이미 끊김 */ }
}
function cancelReconnect() {
  clearTimeout(reconnectTimer); reconnectTimer = null;
  if (!state.connected) state.device = null;
  state.reconnectAttempt = 0;
}
function scheduleReconnect(device, attempt) {
  if (attempt > MAX_RECONNECTS) {
    cancelReconnect(); render();
    toast('센서에 다시 연결하지 못했습니다. 센서 연결을 눌러 다시 시도하세요.');
    return;
  }
  state.reconnectAttempt = attempt; render();
  reconnectTimer = setTimeout(async () => {
    try {
      await openGatt(device);
      // 기다리는 사이 사용자가 취소했거나 다른 기기를 골랐으면 이 연결은 버린다.
      if (state.device !== device || state.demo) { abandon(device); return; }
      state.reconnectAttempt = 0; syncFan(); render();
      toast('센서에 다시 연결되었습니다.');
    } catch {
      abandon(device);
      if (state.device === device && !state.demo) scheduleReconnect(device, attempt + 1);
    }
  }, reconnectDelay(attempt));
}
function onDisconnected(event) {
  const device = event.target;
  if (!state.connected || state.device !== device) return;
  state.connected = false; state.hasData = false; controlCharacteristic = null;
  clearInsight(); saveRealData();
  if (userDisconnect) {
    userDisconnect = false; state.device = null; render();
    toast('센서 연결이 해제되었습니다.');
    return;
  }
  toast('센서 연결이 끊겼습니다. 다시 연결을 시도합니다.');
  scheduleReconnect(device, 1);
}
$('connectButton').addEventListener('click', async () => {
  if (state.connected) { userDisconnect = true; state.device?.gatt.disconnect(); return; }
  if (state.reconnectAttempt) { cancelReconnect(); render(); toast('재연결을 취소했습니다.'); return; }
  if (!navigator.bluetooth) { toast('BLE 연결은 Web Bluetooth를 지원하는 Chrome에서 사용하세요.'); return; }
  state.connecting = true; render();
  let device;
  const previousDemo = state.demo;
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'FumeGuard' }], optionalServices: [SERVICE_UUID] });
    setDemo(false);
    userDisconnect = false; state.device = device;
    device.addEventListener('gattserverdisconnected', onDisconnected);
    await openGatt(device);
    syncFan();
    toast(controlCharacteristic ? 'ESP32 센서와 직접 연결되었습니다.' : 'ESP32 센서와 연결되었습니다. 이 기기는 바람 제어를 지원하지 않습니다.');
  } catch (error) {
    if (device) { abandon(device); state.device = null; if (previousDemo) setDemo(true); }
    if (error.name !== 'NotFoundError') toast('연결하지 못했습니다: ' + error.message);
  } finally { state.connecting = false; render(); }
});
const guides = {
  before: { title: '조리 전, 공기부터 준비하세요', items: ['후드를 먼저 켜고 정상 작동 여부를 확인하세요.', '창문이나 급기구를 열어 공기가 들어올 길을 만드세요.', 'ESP32 센서가 연결되고 수치가 갱신되는지 확인하세요.', '기름과 식재료의 물기를 줄여 연기와 튐을 최소화하세요.'] },
  cooking: { title: '조리 중에도 쾌적하게', items: ['후드는 조리 내내 작동시키고 흡입구 가까이에서 조리하세요.', '기름에서 연기가 나기 시작하면 즉시 화력을 낮추세요.', 'PM2.5와 VOC가 계속 상승하면 뚜껑을 사용하고 추가 환기하세요.', '어린이와 호흡기 민감자는 조리 공간에서 떨어져 있도록 하세요.'] },
  danger: { title: '위험 경보, 이렇게 행동하세요', items: ['가능하면 조리를 중단하고 가열 기구의 전원을 끄세요.', '후드를 최대로 작동하고 창문과 출입문을 열어 환기하세요.', '오염된 공간에서 벗어나 신선한 공기가 있는 곳으로 이동하세요.', '어지럼증·두통·호흡곤란이 있으면 즉시 119 또는 의료기관에 도움을 요청하세요.'] },
  after: { title: '조리 후, 깨끗한 마무리', items: ['수치가 정상 범위로 돌아올 때까지 후드를 계속 작동하세요.', '팬과 필터의 기름때를 정기적으로 청소하세요.', '측정 기록에서 정상화 시간과 최고 위험도를 확인하세요.', '평소보다 회복이 느리면 필터와 환기 통로를 점검하세요.'] }
};
let modalTrigger;
document.querySelectorAll('.guide-item').forEach(button => button.addEventListener('click', () => {
  const guide = guides[button.dataset.guide]; modalTrigger = button;
  $('guideTitle').textContent = guide.title;
  $('guideList').replaceChildren(...guide.items.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
  $('guideModal').classList.add('open'); $('guideModal').setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  document.querySelector('.main-shell').inert = true; document.querySelector('.sidebar').inert = true;
  $('modalClose').focus();
}));
function closeGuide() {
  $('guideModal').classList.remove('open'); $('guideModal').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  document.querySelector('.main-shell').inert = false; document.querySelector('.sidebar').inert = false;
  modalTrigger?.focus();
}
$('modalClose').addEventListener('click', closeGuide);
$('guideModal').addEventListener('click', event => { if (event.target === $('guideModal')) closeGuide(); });
document.addEventListener('keydown', event => {
  if (!$('guideModal').classList.contains('open')) return;
  if (event.key === 'Escape') closeGuide();
  if (event.key === 'Tab') { event.preventDefault(); $('modalClose').focus(); }
});
document.querySelectorAll('.nav-item').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === link));
}));
function updateClock() {
  const now = new Date();
  $('currentClock').textContent = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' }).format(now) + '  ' + timeFormat.format(now);
}
new ResizeObserver(() => drawCharts()).observe(document.querySelector('.chart-wrap'));
window.addEventListener('resize', drawCharts);
document.fonts?.ready.then(drawCharts);
window.addEventListener('pagehide', saveRealData);
seedDemo(); updateClock(); render();
setInterval(() => { updateClock(); if (state.demo) demoTick(); syncFan(); render(); }, 1000);
