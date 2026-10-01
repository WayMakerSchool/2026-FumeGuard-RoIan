import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validSensor, contributions, calculateScore, level,
  normalizeFanSetting, fanLevelForScore, stepAutoLevel, targetFanLevel, fanCommand, reportedFan,
  reconnectDelay, AUTO_STEP_DOWN_MS
} from '../logic.js';

const clean = { pm: 12, voc: 180, co: 1.2, temp: 24, humidity: 48 };

test('validSensor: 다섯 값이 모두 범위 안의 숫자일 때만 통과한다', () => {
  assert.equal(validSensor(clean), true);
  assert.equal(validSensor({ ...clean, pm: '12' }), false);
  assert.equal(validSensor({ ...clean, co: NaN }), false);
  assert.equal(validSensor({ ...clean, humidity: 101 }), false);
  assert.equal(validSensor({ pm: 12, voc: 180, co: 1.2, temp: 24 }), false);
  assert.equal(validSensor(null), false);
});

test('calculateScore: 깨끗한 공기는 기본 점수 근처, 고농도는 100으로 제한된다', () => {
  assert.equal(calculateScore({ ...clean, time: 10000 }, []), 10);
  assert.equal(calculateScore({ pm: 300, voc: 2000, co: 20, temp: 25, humidity: 50, time: 10000 }, []), 100);
});

test('contributions: 7초 이전 측정값이 있어야 상승 속도를 더한다', () => {
  const now = 100000;
  const data = { ...clean, pm: 60, time: now };
  assert.equal(contributions(data, [{ pm: 20, time: now - 3000 }]).rise, 0);
  assert.equal(contributions(data, [{ pm: 20, time: now - 8000 }]).rise, 14);
});

test('level: 30·55·75점에서 단계가 바뀐다', () => {
  assert.deepEqual([0, 29, 30, 54, 55, 74, 75, 100].map(score => level(score).name),
    ['안전', '안전', '주의', '주의', '위험', '위험', '매우 위험', '매우 위험']);
});

test('fanLevelForScore: 위험 단계와 같은 경계로 0~3단을 고른다', () => {
  assert.deepEqual([0, 29, 30, 54, 55, 74, 75, 100].map(fanLevelForScore), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('targetFanLevel: 모드별 실제 바람 단계', () => {
  assert.equal(targetFanLevel('off', 3, 3), 0);
  assert.equal(targetFanLevel('manual', 2, 3), 2);
  assert.equal(targetFanLevel('auto', 2, 0), 0);
  assert.equal(targetFanLevel('auto', 1, 3), 3);
  assert.equal(targetFanLevel('always', 2, 0), 2);
  assert.equal(targetFanLevel('always', 1, 3), 3);
});

test('stepAutoLevel: 올릴 때는 즉시, 내릴 때는 10초 동안 낮아야 내린다', () => {
  const auto = { level: 0, lowerSince: null };
  assert.equal(stepAutoLevel(auto, 80, 0), 3);
  assert.equal(stepAutoLevel(auto, 10, 1000), 3);
  assert.equal(stepAutoLevel(auto, 10, 1000 + AUTO_STEP_DOWN_MS - 1), 3);
  assert.equal(stepAutoLevel(auto, 10, 1000 + AUTO_STEP_DOWN_MS), 0);
});

test('stepAutoLevel: 내려가기 전에 다시 위험해지면 대기 시간을 초기화한다', () => {
  const auto = { level: 3, lowerSince: null };
  stepAutoLevel(auto, 10, 0);
  stepAutoLevel(auto, 80, 9000);
  assert.equal(stepAutoLevel(auto, 10, 12000), 3);
  assert.equal(stepAutoLevel(auto, 10, 21999), 3);
  assert.equal(stepAutoLevel(auto, 10, 22000), 0);
});

test('fanCommand: 기기로 보내는 JSON 형식', () => {
  assert.equal(fanCommand('manual', 2), '{"fan":2,"mode":"manual"}');
  assert.equal(fanCommand('off', 0), '{"fan":0,"mode":"off"}');
});

test('normalizeFanSetting: 저장값이 깨져 있으면 끄기·1단으로 되돌린다', () => {
  assert.deepEqual(normalizeFanSetting({ mode: 'always', level: 3 }), { mode: 'always', level: 3 });
  assert.deepEqual(normalizeFanSetting({ mode: 'turbo', level: 9 }), { mode: 'off', level: 1 });
  assert.deepEqual(normalizeFanSetting({ mode: 'toString', level: 0 }), { mode: 'off', level: 1 });
  assert.deepEqual(normalizeFanSetting(null), { mode: 'off', level: 1 });
});

test('reportedFan: 0~3의 정수만 기기 보고값으로 인정한다', () => {
  assert.equal(reportedFan({ fan: 0 }), 0);
  assert.equal(reportedFan({ fan: 3 }), 3);
  assert.equal(reportedFan({ fan: 4 }), null);
  assert.equal(reportedFan({ fan: '2' }), null);
  assert.equal(reportedFan({}), null);
});

test('reconnectDelay: 1초에서 시작해 두 배씩 늘고 8초에서 멈춘다', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(reconnectDelay), [1000, 2000, 4000, 8000, 8000]);
});
