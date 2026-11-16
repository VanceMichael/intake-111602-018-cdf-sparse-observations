import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('CDF 变量目录保留稀疏模式与独立记录范围', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    const beforeBytes = (await client.request('/files/space.cdf')).bytes;
    const first = decode(beforeBytes);
    assert.equal(first.variables.find(variable => variable.name === 'Flux').sparse, 2);
    assert.equal(first.variables.find(variable => variable.name === 'Quality').sparse, 1);
    assert.equal(first.variables.find(variable => variable.name === 'Epoch').sparse, 0);
    assert.ok(first.variables.every(variable => variable.maxRecord === 3));
    await client.control({ action: 'advance' });
    assert.notDeepEqual((await client.request('/files/space.cdf')).bytes, beforeBytes);
    assert.equal(JSON.parse((await client.request('/releases')).bytes).release, 'space-2');
  } finally { await source.close(); }
});
