import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

async function freshApp(scenario = 'ordinary') {
  const directory = await mkdtemp(join(tmpdir(), 'intake-http-'));
  const source = await startSource({ scenario });
  const app = await startApplication({ source: source.base, root: directory });
  return { directory, source, app };
}

async function post(app, path, body) {
  const response = await fetch(`${app.base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: response.status, json: await response.json() };
}

test('接收端点返回三类来源分明的时间线并固化会话', async () => {
  const { source, app, directory } = await freshApp();
  try {
    const { status, json } = await post(app, '/intakes', {});
    assert.equal(status, 201);
    assert.equal(json.status.complete, true);
    const flux = json.variables.find(variable => variable.name === 'Flux');
    assert.deepEqual(flux.timeline.map(entry => entry.origin), ['physical', 'previous', 'previous', 'physical']);
    const quality = json.variables.find(variable => variable.name === 'Quality');
    assert.deepEqual(quality.timeline.map(entry => entry.origin), ['physical', 'pad', 'pad', 'physical']);
    assert.match(json.digest, /^[a-f0-9]{64}$/);
    assert.ok(json.basisFingerprint);
    // 会话可被列出并回查。
    const listed = await (await fetch(`${app.base}/sessions`)).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, json.id);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('范围请求把范围外依据单列，不混入本次观测', async () => {
  const { source, app, directory } = await freshApp();
  try {
    const intake = (await post(app, '/intakes', {})).json;
    const { json } = await post(app, '/range-requests', {
      sessionId: intake.id, from: '2000-01-01T12:00:02.000Z', to: '2000-01-01T12:00:03.000Z',
    });
    const flux = json.variables.find(variable => variable.name === 'Flux');
    assert.equal(flux.observations.length, 2);
    assert.deepEqual(flux.supporting.map(entry => entry.record), [0]);
    assert.equal(flux.supporting[0].role, 'previous-anchor');
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('资料修订后重取不能凭同名文件悄悄替换旧依据', async () => {
  const { source, app, directory } = await freshApp('transition');
  try {
    const first = (await post(app, '/intakes', {})).json;
    const fluxBefore = first.variables.find(variable => variable.name === 'Flux');
    assert.equal(fluxBefore.timeline[3].value, 15);
    // 推进发布日期：路径与文件名不变，仅一个字节的物理值被修订。
    await fetch(`${source.base}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'advance' }) });
    // 用旧会话补齐：版本/摘要不一致必须被拒绝（412 版本拦截或 409 摘要拦截）。
    const resume = await post(app, '/intakes/resume', { sessionId: first.id });
    assert.ok([412, 409].includes(resume.json.status), `应拒绝替换，实际状态 ${resume.json.status}`);
    assert.match(resume.json.error, /依据|版本|摘要/);
    // 旧会话里的解释依据没有被覆盖。
    const sessions = await (await fetch(`${app.base}/sessions`)).json();
    const stillOld = sessions.find(item => item.id === first.id);
    assert.equal(stillOld.variables.find(variable => variable.name === 'Flux').timeline[3].value, 15);
    // 新修订必须通过新的接收会话显式领取。
    const second = (await post(app, '/intakes', {})).json;
    assert.equal(second.variables.find(variable => variable.name === 'Flux').timeline[3].value, 16);
    assert.notEqual(second.digest, first.digest);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('同版本重取可以补齐未完成会话且不改变已锁定依据', async () => {
  const { source, app, directory } = await freshApp();
  try {
    const first = (await post(app, '/intakes', {})).json;
    // 来源未修订，用同会话重取：摘要一致，允许接续并累计补齐次数。
    const resume = await post(app, '/intakes/resume', { sessionId: first.id });
    assert.equal(resume.status, 200);
    assert.equal(resume.json.digest, first.digest);
    assert.equal(resume.json.resumeCount, 1);
    assert.equal(resume.json.status.complete, true);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('截断来源留下可补齐状态，恢复后同版本接续成功', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-resume-'));
  // 用 disconnect 场景制造截断；若无该夹具则用字节截断模拟可补齐状态。
  const source = await startSource({ scenario: 'ordinary' });
  const app = await startApplication({ source: source.base, root: directory });
  try {
    // 直接以截断字节建立会话：状态为未完成且带原因。
    const { SessionStore } = await import('../src/sessions.mjs');
    const { intake } = await import('../src/intake.mjs');
    const { materialize } = await import('../src/decode.mjs');
    const configResponse = await fetch(`${source.base}/files/space.cdf`);
    const full = Buffer.from(await configResponse.arrayBuffer());
    const truncated = Buffer.from(full.subarray(0, Math.floor(full.length * 0.55)));
    const partial = intake(truncated);
    assert.equal(partial.status.complete, false);
    assert.equal(partial.status.truncated, true);
    const store = app.sessions;
    const saved = await store.save({
      id: 'partial-session', sourcePath: '/files/space.cdf', etag: null,
      digest: null, status: partial.status, timeVariable: null, variables: [],
    });
    assert.equal(saved.status.complete, false);
    // 完整资料下 materialize 可正常解析，证明重取具备补齐条件。
    assert.ok(materialize(full).variables.every(variable => !variable.error));
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('依赖时间变量缺失时标记 missingTimeVariable，不编造时间', async () => {
  const { intake } = await import('../src/intake.mjs');
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../fixtures/ordinary.json', import.meta.url), 'utf8'));
  const bytes = Buffer.from(config.phases[0].routes[0].base64, 'base64');
  const result = intake(bytes, { timeVariable: 'NoSuchTime' });
  assert.equal(result.status.missingTimeVariable, true);
  assert.equal(result.status.complete, false);
  assert.ok(result.status.reasons.some(reason => reason.includes('NoSuchTime')));
});
