import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { materialize } from '../src/decode.mjs';
import { intake, selectRange, ORIGIN, __expandVariableForTest as expandVariable } from '../src/intake.mjs';

async function fixtureBytes(scenario = 'ordinary', phase = 0) {
  const config = JSON.parse(await readFile(new URL(`../fixtures/${scenario}.json`, import.meta.url), 'utf8'));
  return Buffer.from(config.phases[phase].routes[0].base64, 'base64');
}

function fixtureBytesSync(scenario = 'ordinary', phase = 0) {
  const config = JSON.parse(readFileSync(new URL(`../fixtures/${scenario}.json`, import.meta.url), 'utf8'));
  return Buffer.from(config.phases[phase].routes[0].base64, 'base64');
}

test('结构化接收区分物理记录、PREV 虚拟记录与 PAD 填充', async () => {
  const bytes = await fixtureBytes();
  const result = intake(bytes);
  assert.equal(result.status.complete, true);
  assert.equal(result.timeVariable.name, 'Epoch');

  const flux = result.variables.find(variable => variable.name === 'Flux');
  assert.deepEqual(flux.timeline.map(entry => entry.origin),
    [ORIGIN.PHYSICAL, ORIGIN.PREVIOUS, ORIGIN.PREVIOUS, ORIGIN.PHYSICAL]);
  assert.deepEqual(flux.timeline.map(entry => entry.value), [12, 12, 12, 15]);
  assert.deepEqual(flux.physicalRecords, [0, 3]);
  // PREV 虚拟值必须标注来源记录，不能伪装成新观测。
  assert.equal(flux.timeline[1].derivedFrom, 0);
  assert.equal(flux.timeline[2].derivedFrom, 0);

  const quality = result.variables.find(variable => variable.name === 'Quality');
  assert.deepEqual(quality.timeline.map(entry => entry.origin),
    [ORIGIN.PHYSICAL, ORIGIN.PAD, ORIGIN.PAD, ORIGIN.PHYSICAL]);
  assert.deepEqual(quality.timeline.map(entry => entry.value), [0, 0, 0, 1]);
  assert.equal(quality.padValue, 0);

  const epoch = result.variables.find(variable => variable.name === 'Epoch');
  assert.ok(epoch.timeline.every(entry => entry.origin === ORIGIN.PHYSICAL));
  assert.equal(epoch.timeline[0].time, '2000-01-01T12:00:01.000Z');
});

test('物理记录直接来自值记录，虚拟记录不产生 valueOffset', async () => {
  const bytes = await fixtureBytes();
  const result = intake(bytes);
  const flux = result.variables.find(variable => variable.name === 'Flux');
  assert.equal(typeof flux.timeline[0].valueOffset, 'number');
  assert.equal(flux.timeline[1].valueOffset, undefined);
  assert.equal(typeof flux.timeline[3].valueOffset, 'number');
});

test('时间范围请求把范围外 PREV 依据标为 supporting，不计入新观测', async () => {
  const bytes = await fixtureBytes();
  const result = intake(bytes);
  const selection = selectRange(result, { from: '2000-01-01T12:00:02.000Z', to: '2000-01-01T12:00:03.000Z' });

  const flux = selection.variables.find(variable => variable.name === 'Flux');
  assert.equal(flux.observations.length, 2);
  assert.ok(flux.observations.every(entry => entry.origin === ORIGIN.PREVIOUS));
  assert.deepEqual(flux.supporting.map(entry => entry.record), [0]);
  assert.equal(flux.supporting[0].role, 'previous-anchor');
  // 范围外物理记录只在 supporting 中，不混入观测。
  assert.ok(!flux.observations.some(entry => entry.record === 0));

  const quality = selection.variables.find(variable => variable.name === 'Quality');
  assert.equal(quality.observations.length, 2);
  assert.equal(quality.supporting.length, 0);
});

test('PREV 在首条物理记录之前缺测时不编造前值', async () => {
  // 构造一个 firstRecord=0 但物理记录从记录 1 才开始的 PREV 变量。
  const variable = {
    name: 'Late', sparse: 2, maxRecord: 2, firstRecord: 0, padValue: null,
    physical: [{ record: 1, value: 7, valueOffset: 100 }, { record: 2, value: 9, valueOffset: 110 }],
  };
  const timeVariable = { physical: [
    { record: 0, value: 1000000000n }, { record: 1, value: 2000000000n }, { record: 2, value: 3000000000n },
  ] };
  const timeline = expandVariable(variable, timeVariable);
  assert.equal(timeline[0].origin, ORIGIN.PREVIOUS);
  assert.equal(timeline[0].value, null);
  assert.equal(timeline[0].derivedFrom, null);
  assert.equal(timeline[1].origin, ORIGIN.PHYSICAL);
  assert.equal(timeline[2].origin, ORIGIN.PHYSICAL);
});

test('完整范围请求只返回落在窗口内的物理观测', async () => {
  const bytes = await fixtureBytes();
  const result = intake(bytes);
  const selection = selectRange(result, { from: '2000-01-01T12:00:04.000Z', to: '2000-01-01T12:00:04.000Z' });
  const flux = selection.variables.find(variable => variable.name === 'Flux');
  assert.deepEqual(flux.observations.map(entry => entry.record), [3]);
  assert.equal(flux.observations[0].origin, ORIGIN.PHYSICAL);
  assert.equal(flux.supporting.length, 0);
});

test('资料修订只改变物理记录值，解释依据与记录可逐项核对', async () => {
  const before = intake(await fixtureBytes('transition', 0));
  const after = intake(await fixtureBytes('transition', 1));
  const fluxBefore = before.variables.find(variable => variable.name === 'Flux');
  const fluxAfter = after.variables.find(variable => variable.name === 'Flux');
  // 物理记录位置与稀疏规则不变，只有记录 3 的实测值从 15 修订为 16。
  assert.deepEqual(fluxBefore.physicalRecords, fluxAfter.physicalRecords);
  assert.equal(fluxBefore.timeline[3].value, 15);
  assert.equal(fluxAfter.timeline[3].value, 16);
  // PREV 虚拟记录仍来自记录 0，未受修订影响。
  assert.equal(fluxAfter.timeline[1].value, 12);
  assert.equal(fluxAfter.timeline[1].derivedFrom, 0);
});

test('浅截断保留可解析变量并对受损变量标记错误', () => {
  const full = fixtureBytesSync();
  // 截在靠后位置：前置变量仍可解析，靠后的变量索引/值记录落在文件外。
  const truncated = Buffer.from(full.subarray(0, Math.floor(full.length * 0.82)));
  const result = materialize(truncated);
  assert.ok(result.variables.length > 0);
  assert.ok(result.variables.some(variable => variable.error));
  assert.ok(result.variables.some(variable => !variable.error));
});

test('截断资料的接收状态标记为未完成且说明原因', () => {
  const full = fixtureBytesSync();
  const truncated = Buffer.from(full.subarray(0, Math.floor(full.length * 0.55)));
  const result = intake(truncated);
  assert.equal(result.status.complete, false);
  assert.equal(result.status.truncated, true);
  assert.ok(result.status.reasons.length > 0);
});
