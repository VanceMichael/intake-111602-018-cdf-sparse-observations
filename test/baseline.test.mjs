import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/catalog.mjs';
import { decode } from '../src/decode.mjs';
import { SourceClient } from '../src/transport.mjs';
import { profile } from '../src/profile.mjs';
import { startSource } from '../source/service.mjs';
import { startApplication, previewOne } from '../src/app.mjs';

test('真实来源资料可以解码，原始内容可以回读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const source = await startSource();
  const app = await startApplication({ source: source.base, root: directory });
  try {
    const result = await previewOne(source.base);
    assert.ok(result.bytes.length > 0);
    assert.deepEqual(Object.keys(result.preview).sort(), [...profile.previewKeys].sort());
    const response = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.match(receipt.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(await app.catalog.object(receipt.digest), result.bytes);
    assert.equal((await app.catalog.list()).length, 1);
    const reopened = new Catalog(directory);
    assert.deepEqual(await reopened.object(receipt.digest), result.bytes);
  } finally {
    await app.close(); await source.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('来源变动由显式操作推进，控制记录可回查', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    const before = await client.request(profile.previewPath);
    const state = await client.control({ action: 'advance' });
    assert.equal(state.phase, 1);
    const after = await client.request(profile.previewPath);
    assert.notDeepEqual(before.bytes, after.bytes);
    const audit = await client.control({ action: 'inspect' });
    assert.equal(audit.requests.length, 2);
    assert.deepEqual(audit.requests.map(item => item.phase), [0, 1]);
  } finally { await source.close(); }
});

test('不可识别资料不生成预览，不自动转为空结果', () => {
  assert.throws(() => decode(Buffer.from('not-a-supported-record')));
});

test('来源客户端拒绝跨配置边界领取', async () => {
  const client = new SourceClient('http://127.0.0.1:1');
  await assert.rejects(client.request('https://example.invalid/data'), /来源/);
});

test('同一原件可以有独立接收凭据，重开目录后仍可复核', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-test-'));
  try {
    const catalog = new Catalog(directory);
    const first = await catalog.accept({ source: 'local:a', bytes: Buffer.from('内容'), mediaType: 'text/plain', preview: { name: '甲' } });
    const second = await catalog.accept({ source: 'local:b', bytes: Buffer.from('内容'), mediaType: 'text/plain', preview: { name: '乙' } });
    assert.equal(first.digest, second.digest);
    assert.notEqual(first.id, second.id);
    assert.equal((await new Catalog(directory).list()).length, 2);
    await assert.rejects(catalog.object('../escape'), /摘要/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
