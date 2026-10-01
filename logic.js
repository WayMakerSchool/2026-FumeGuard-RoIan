// DOM과 BLE에 의존하지 않는 순수 로직. 브라우저(app.js)와 테스트(node --test)가 함께 사용한다.

export const SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
export const SENSOR_UUID = '87654321-4321-4321-4321-cba987654321';
export const CONTROL_UUID = '87654321-4321-4321-4321-cba987654322';

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// ── 센서 데이터와 위험도 ───────────────────────────────────────

export const sensorKeys = ['pm', 'voc', 'co', 'temp', 'humidity'];

export function validSensor(data) {
  return Boolean(data) && sensorKeys.every(key => typeof data[key] === 'number' && Number.isFinite(data[key]))
    && data.pm >= 0 && data.voc >= 0 && data.co >= 0 && data.temp >= -50 && data.temp <= 150
    && data.humidity >= 0 && data.humidity <= 100;
}

// 위험도 점수를 구성하는 항목별 기여 점수. rise는 약 7초 전 대비 PM2.5 상승분이다.
export function contributions(data, history) {
  const baseline = history.findLast(row => row.time <= (data.time || Date.now()) - 7000);
  return {
    pm: clamp((data.pm - 10) / 90, 0, 1) * 48,
    voc: clamp((data.voc - 150) / 850, 0, 1) * 26,
    co: clamp((data.co - 1) / 9, 0, 1) * 20,
    rise: baseline ? clamp((data.pm - baseline.pm) * .35, 0, 92) : 0
  };
}

export function calculateScore(data, history) {
  return Math.round(clamp(8 + Object.values(contributions(data, history)).reduce((sum, v) => sum + v, 0), 0, 100));
}

export function level(score) {
  if (score < 30) return { name: '안전', color: '#86dfb4', title: '공기 상태가 안정적이에요', desc: '측정값이 낮은 위험 범위에 있습니다.', insight: '측정된 오염물질의 농도가 안정적입니다. 조리 중에는 후드를 계속 가동하세요.', action: '현재 환기 상태를 유지하세요', actionDesc: '조리 중에는 후드를 켜고, 조리 후에도 잔류 오염이 줄어들 때까지 환기하세요.', vent: '현재 환기 유지' };
  if (score < 55) return { name: '주의', color: '#d6c584', title: '조리흄 농도를 확인하세요', desc: '오염물질 농도 또는 상승 속도가 증가했습니다.', insight: '센서 값의 복합 위험 점수가 주의 단계입니다. 후드를 켜고 수치가 낮아지는지 확인하세요.', action: '후드를 켜고 환기를 시작하세요', actionDesc: '추가 환기를 시작하고 조리 중 오염물질 변화 추이를 확인하세요.', vent: '환기 시작 권장' };
  if (score < 75) return { name: '위험', color: '#e9b296', title: '조리흄 노출 위험이 높아요', desc: '복합 오염물질의 위험 점수가 높아졌습니다.', insight: '오염물질 농도와 상승 속도를 함께 계산한 결과 위험 단계입니다. 후드의 풍량을 높이세요.', action: '후드를 강풍으로 작동하세요', actionDesc: '창문을 열어 환기하고, 가능하면 조리 공간에서 잠시 벗어나세요.', vent: '강한 환기 권장' };
  return { name: '매우 위험', color: '#e68d8d', title: '즉시 환기가 필요합니다', desc: '높은 농도의 조리흄이 감지되었습니다.', insight: '센서 기반 위험 점수가 매우 높습니다. 조리를 중단하고 신선한 공기가 있는 곳으로 이동하세요.', action: '조리를 멈추고 즉시 환기하세요', actionDesc: '후드를 최대로 작동하고 창문을 여세요. 신체 이상이 있으면 즉시 도움을 요청하세요.', vent: '즉시 환기 필요' };
}

// ── 에어커튼 바람 제어 ─────────────────────────────────────────

export const MAX_FAN_LEVEL = 3;
export const AUTO_STEP_DOWN_MS = 10000;

export const fanModes = {
  off: { label: '끄기', desc: '에어커튼을 끕니다.' },
  manual: { label: '수동', desc: '선택한 단계로 계속 가동합니다. 위험도가 바뀌어도 단계는 그대로입니다.' },
  auto: { label: '자동', desc: '위험도에 따라 단계를 바꿉니다. 안전 꺼짐 · 주의 1단 · 위험 2단 · 매우 위험 3단.' },
  always: { label: '상시 가동', desc: '선택한 단계 아래로 내려가지 않고 계속 켜 두며, 위험도가 오르면 자동으로 더 세게 붑니다.' }
};

// 저장소나 기기에서 온 값을 믿을 수 있는 바람 설정으로 바꾼다.
export function normalizeFanSetting(stored) {
  const mode = stored && Object.hasOwn(fanModes, stored.mode) ? stored.mode : 'off';
  const level = stored && Number.isInteger(stored.level) && stored.level >= 1 && stored.level <= MAX_FAN_LEVEL ? stored.level : 1;
  return { mode, level };
}

export function fanLevelForScore(score) {
  if (score < 30) return 0;
  if (score < 55) return 1;
  if (score < 75) return 2;
  return 3;
}

// 자동 단계는 올릴 때는 즉시, 내릴 때는 10초 동안 계속 낮아야 내린다(단계가 오락가락하지 않게).
export function stepAutoLevel(auto, score, now) {
  const target = fanLevelForScore(score);
  if (target >= auto.level) {
    auto.level = target;
    auto.lowerSince = null;
  } else if (auto.lowerSince === null) {
    auto.lowerSince = now;
  } else if (now - auto.lowerSince >= AUTO_STEP_DOWN_MS) {
    auto.level = target;
    auto.lowerSince = null;
  }
  return auto.level;
}

// 모드, 사용자가 고른 단계, 자동 단계로부터 실제로 기기에 보낼 바람 단계(0~3)를 정한다.
export function targetFanLevel(mode, userLevel, autoLevel) {
  if (mode === 'manual') return userLevel;
  if (mode === 'auto') return autoLevel;
  if (mode === 'always') return Math.max(userLevel, autoLevel);
  return 0;
}

// 제어 특성에 쓰는 UTF-8 JSON. ESP32는 fan(0~3)만 적용하면 되고 mode는 참고용이다.
export function fanCommand(mode, fan) {
  return JSON.stringify({ fan, mode });
}

// 센서 알림 JSON에 fan(0~3)이 함께 오면 기기가 실제로 적용한 단계로 본다.
export function reportedFan(data) {
  return data && Number.isInteger(data.fan) && data.fan >= 0 && data.fan <= MAX_FAN_LEVEL ? data.fan : null;
}

// ── BLE 재연결 ────────────────────────────────────────────────

export const MAX_RECONNECTS = 5;

export function reconnectDelay(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}
