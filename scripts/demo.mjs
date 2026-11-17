import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource();
const app = await startApplication({ source: source.base, root: directory });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);
  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`原件已接收：${saved.digest}，${saved.bytes} 字节\n`);

  // 结构化接收：物理记录、PREV 虚拟记录、PAD 填充分别标注，不混为同一种观测。
  const intake = await fetch(`${app.base}/intakes`, { method: 'POST', body: '{}' }).then(response => response.json());
  process.stdout.write('\n结构化接收时间线（physical=实测 previous=前值延续 pad=填充）\n');
  for (const variable of intake.variables) {
    process.stdout.write(`  ${variable.name}（${variable.sparseKind}）：`);
    process.stdout.write(variable.timeline.map(entry => `${entry.record} ${entry.time} ${entry.origin}=${entry.value}`).join(' | '));
    process.stdout.write('\n');
  }

  // 时间范围请求：范围外的前值依据单列为 supporting，不计入本次新观测。
  const ranged = await fetch(`${app.base}/range-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: intake.id, from: '2000-01-01T12:00:02.000Z', to: '2000-01-01T12:00:03.000Z' }),
  }).then(response => response.json());
  const flux = ranged.variables.find(variable => variable.name === 'Flux');
  process.stdout.write(`\n范围 12:00:02~03 的 Flux 观测：${flux.observations.map(entry => `${entry.origin}=${entry.value}`).join(', ')}\n`);
  process.stdout.write(`仅为理解该范围取得的范围外依据：${flux.supporting.map(entry => `记录${entry.record}=${entry.value}`).join(', ') || '无'}\n`);
  process.stdout.write('（supporting 不计入本次新观测）\n');
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
