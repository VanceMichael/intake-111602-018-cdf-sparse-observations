import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, basisFingerprint } from '../src/sessions.mjs';

test('会话按来源版本核对，版本变化不能悄悄覆盖旧依据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-'));
  try {
    const store = await new SessionStore(directory).initialize();
    const saved = await store.save({
      id: 'session-one', sourcePath: '/files/space.cdf', sourceVersion: 'etag-a',
      digest: 'a'.repeat(64), status: { complete: true }, variables: [],
    });
    assert.equal(saved.id, 'session-one');

    // 同版本可以接续。
    const resumed = await store.save({ ...saved, resumeCount: 1 });
    assert.equal(resumed.resumeCount, 1);

    // 文件名/路径不变但来源版本变化：必须拒绝静默替换。
    await assert.rejects(
      store.save({ ...saved, sourceVersion: 'etag-b' }),
      /来源版本已变化/,
    );
    const stillOld = await store.get('session-one');
    assert.equal(stillOld.sourceVersion, 'etag-a');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('依据指纹随解释依据与物理记录位置变化', () => {
  const materialized = {
    variables: [{ name: 'Flux', sparse: 2, padValue: 'NaN',
      physical: [{ record: 0, valueOffset: 2075 }, { record: 3, valueOffset: 2235 }] }],
  };
  const base = { sourcePath: '/files/space.cdf', etag: '"v1"', digest: 'd'.repeat(64), materialized };
  const first = basisFingerprint(base);
  // 物理记录位置变化（资料修订）改变指纹。
  const moved = basisFingerprint({ ...base, materialized: {
    variables: [{ name: 'Flux', sparse: 2, padValue: 'NaN',
      physical: [{ record: 0, valueOffset: 2075 }, { record: 3, valueOffset: 2240 }] }],
  } });
  assert.notEqual(first, moved);
  // 相同输入指纹稳定。
  assert.equal(first, basisFingerprint(base));
});

test('会话标识非法时拒绝读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-'));
  try {
    const store = await new SessionStore(directory).initialize();
    await assert.rejects(store.get('../escape'), /会话标识/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
