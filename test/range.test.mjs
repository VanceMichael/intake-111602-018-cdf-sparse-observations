import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { profile } from '../src/profile.mjs';

test('原件范围读取可以核对版本，越界范围不生成假空片段', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    const original = await client.request(profile.previewPath);
    const part = await client.request(profile.previewPath, { headers: { range: 'bytes=0-7', 'if-match': original.headers.etag } });
    assert.equal(part.status, 206);
    assert.deepEqual(part.bytes, original.bytes.subarray(0, 8));
    assert.match(part.headers['content-range'], /^bytes 0-7\//);
    assert.equal((await client.request(profile.previewPath, { headers: { range: 'bytes=9999999-' } })).status, 416);
    await client.control({ action: 'advance' });
    const stale = await client.request(profile.previewPath, { headers: { 'if-match': original.headers.etag } });
    assert.equal(stale.status, 412);
  } finally { await source.close(); }
});
