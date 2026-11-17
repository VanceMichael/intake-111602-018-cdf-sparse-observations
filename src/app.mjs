import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode, materialize } from './decode.mjs';
import { intake, selectRange } from './intake.mjs';
import { SessionStore, basisFingerprint } from './sessions.mjs';
import { SourceClient } from './transport.mjs';
import { profile } from './profile.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// TT2000 时间等 64 位整数以 BigInt 表示，JSON 不支持；统一转字符串，避免精度丢失。
function json(value) {
  return JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() : item));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export async function startApplication({ source, root, port = 0 }) {
  const catalog = await new Catalog(root).initialize();
  const sessions = await new SessionStore(root).initialize();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true, product: profile.name }));
      if (request.method === 'GET' && url.pathname === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: result.preview }));
      }
      if (request.method === 'POST' && url.pathname === '/receipts') {
        const input = await readJson(request);
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview });
        response.statusCode = 201;
        return response.end(json(receipt));
      }
      // 结构化接收：领取原件，连同解释依据展开成三类来源分明的时间线，并固化接收会话。
      if (request.method === 'POST' && url.pathname === '/intakes') {
        const input = await readJson(request);
        const path = input.path || profile.previewPath;
        const client = new SourceClient(source);
        const result = await client.fetch(path);
        if (result.status === 412) return response.end(JSON.stringify({ error: '来源版本与锁定版本不符，拒绝覆盖旧依据', status: 412 }));
        if (result.status !== 200 && result.status !== 206) throw new Error(`来源响应：${result.status}`);
        const materialized = materialize(result.bytes);
        const parsed = intake(result.bytes, { timeVariable: input.timeVariable });
        const digest = digestOf(result.bytes);
        // 原件照常内容寻址保存；即使解释不完整也保留已取得字节，供后续补齐。
        await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: decode(result.bytes) });
        const session = {
          id: randomUUID(),
          sourcePath: path,
          sourceUrl: result.url,
          etag: result.headers.etag || null,
          digest,
          range: input.range || null,
          basisFingerprint: basisFingerprint({ sourcePath: path, etag: result.headers.etag, digest, materialized }),
          status: parsed.status,
          timeVariable: parsed.timeVariable,
          variables: parsed.variables.map(variable => ({
            name: variable.name, sparseKind: variable.sparseKind, padValue: variable.padValue,
            physicalRecords: variable.physicalRecords,
            timeline: variable.timeline,
          })),
        };
        const saved = await sessions.save(session);
        response.statusCode = parsed.status.complete ? 201 : 202;
        return response.end(json(saved));
      }
      // 时间范围请求：在已接收会话上做范围选择，范围外依据标 supporting，不算新观测。
      if (request.method === 'POST' && url.pathname === '/range-requests') {
        const input = await readJson(request);
        const existing = await sessions.get(input.sessionId);
        if (!existing) throw new Error('接收会话不存在，请先建立接收');
        const reconstructed = {
          status: existing.status,
          timeVariable: existing.timeVariable,
          variables: existing.variables.map(variable => ({
            name: variable.name, sparse: variable.sparseKind === 'pad' ? 1 : variable.sparseKind === 'previous' ? 2 : 0,
            sparseKind: variable.sparseKind, timeline: variable.timeline,
          })),
        };
        const selection = selectRange(reconstructed, { from: input.from, to: input.to });
        return response.end(json(selection));
      }
      // 补齐：来源此前截断或时间变量缺失时，按原会话锁定的版本重新领取，核对指纹后接续。
      if (request.method === 'POST' && url.pathname === '/intakes/resume') {
        const input = await readJson(request);
        const existing = await sessions.get(input.sessionId);
        if (!existing) throw new Error('接收会话不存在，无法补齐');
        const client = new SourceClient(source);
        const result = await client.fetch(existing.sourcePath, { etag: existing.etag });
        if (result.status === 412) return response.end(JSON.stringify({ error: '来源已修订，旧会话锁定版本不再可用；保留旧依据并请新建会话', status: 412 }));
        if (result.status !== 200 && result.status !== 206) throw new Error(`来源响应：${result.status}`);
        const digest = digestOf(result.bytes);
        const materialized = materialize(result.bytes);
        const fingerprint = basisFingerprint({ sourcePath: existing.sourcePath, etag: result.headers.etag, digest, materialized });
        // 文件名/路径不变也不能替换依据：版本指纹变化时显式拒绝静默替换。
        if (existing.digest && digest !== existing.digest) {
          return response.end(JSON.stringify({ error: '重取内容摘要与旧依据不同，拒绝凭同名文件悄悄替换', expected: existing.digest, actual: digest, status: 409 }));
        }
        const parsed = intake(result.bytes);
        const resumed = await sessions.save({ ...existing,
          etag: result.headers.etag || existing.etag,
          basisFingerprint: fingerprint,
          status: parsed.status,
          timeVariable: parsed.timeVariable,
          variables: parsed.variables.map(variable => ({
            name: variable.name, sparseKind: variable.sparseKind, padValue: variable.padValue,
            physicalRecords: variable.physicalRecords, timeline: variable.timeline,
          })),
          resumeCount: (existing.resumeCount || 0) + 1,
        });
        response.statusCode = parsed.status.complete ? 200 : 202;
        return response.end(json(resumed));
      }
      if (request.method === 'GET' && url.pathname === '/sessions') return response.end(json(await sessions.list()));
      if (request.method === 'GET' && url.pathname === '/receipts') return response.end(JSON.stringify(await catalog.list()));
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog, sessions,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
