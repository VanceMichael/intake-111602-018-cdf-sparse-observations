import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { dispatch } from './domain.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function startSource({ scenario = 'ordinary', port = 0 } = {}) {
  const scenarioPath = new URL(`../fixtures/${scenario}.json`, import.meta.url);
  const config = JSON.parse(await readFile(scenarioPath, 'utf8'));
  let phase = 0;
  const domainState = {};
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const path = request.url;
      if (path === '/health') {
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ ready: true, scenario, phase }));
      }
      if (path === '/control' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        if (input.action === 'advance') phase = Math.min(phase + 1, config.phases.length - 1);
        else if (input.action === 'reset') { phase = 0; requests.length = 0; }
        else if (input.action !== 'inspect') throw new Error('未知的来源操作');
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify({ phase, requests }));
      }
      const routes = config.phases[phase].routes;
      const url = new URL(path, 'http://localhost');
      const canonical = value => { const parsed = new URL(value, 'http://localhost'); parsed.searchParams.sort(); return parsed.pathname + parsed.search; };
      let route = await dispatch({ url, method: request.method, phase, state: domainState, headers: request.headers });
      if (!route) route = routes.find(item => canonical(item.path) === canonical(path) && (item.method || 'GET') === request.method);
      if (route?.json !== undefined) route = { ...route, body: JSON.stringify(route.json), headers: { 'content-type': 'application/json', ...route.headers } };
      requests.push({ path, phase, method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => ['if-match', 'range', 'accept', 'x-institution'].includes(name))) });
      if (!route) { response.writeHead(404); return response.end('资料不存在'); }
      if (route.requiredHeader && request.headers[route.requiredHeader.name] !== route.requiredHeader.value) {
        response.writeHead(403); return response.end('当前机构无权领取该资料');
      }
      if (route.delayMs) await new Promise(resolve => setTimeout(resolve, route.delayMs));
      if (route.earlyHints) response.writeEarlyHints({ link: route.earlyHints });
      let bytes = route.base64 ? Buffer.from(route.base64, 'base64') : Buffer.from(route.body || '');
      const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
      const headers = { etag, 'accept-ranges': 'bytes', ...(route.headers || {}) };
      if (request.headers['if-match'] && request.headers['if-match'] !== etag) {
        response.writeHead(412, headers); return response.end('来源内容已变化');
      }
      let status = route.status || 200;
      if (request.headers.range && status === 200) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        const start = match ? Number(match[1]) : -1;
        const end = match && match[2] ? Number(match[2]) : bytes.length - 1;
        if (start < 0 || start >= bytes.length || end < start) {
          response.writeHead(416, { ...headers, 'content-range': `bytes */${bytes.length}` }); return response.end();
        }
        const last = Math.min(end, bytes.length - 1);
        headers['content-range'] = `bytes ${start}-${last}/${bytes.length}`;
        bytes = bytes.subarray(start, last + 1); status = 206;
      }
      response.writeHead(status, headers);
      if (route.disconnect) {
        response.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        return response.destroy();
      }
      if (route.chunks) {
        let offset = 0;
        for (const size of route.chunks) {
          response.write(bytes.subarray(offset, offset + size));
          offset += size;
        }
        return response.end(bytes.subarray(offset));
      }
      response.end(bytes);
    } catch (error) {
      if (!response.headersSent) response.writeHead(400);
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { base: `http://127.0.0.1:${server.address().port}`, server,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = await startSource({ scenario: process.env.SCENARIO || 'ordinary', port: Number(process.env.PORT || 4310) });
  process.stdout.write(`资料服务已启动：${source.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await source.close(); process.exit(0); });
}
