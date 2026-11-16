import { setTimeout as sleep } from 'node:timers/promises';

export class SourceClient {
  constructor(base, { timeoutMs = 3000, limit = 4 * 1024 * 1024 } = {}) {
    this.base = new URL(base);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(this.base.hostname)) {
      throw new Error('此配置仅连接本地资料服务');
    }
    this.timeoutMs = timeoutMs;
    this.limit = limit;
  }

  async request(path, { method = 'GET', headers = {}, body, signal } = {}) {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin) throw new Error('资料请求不能越过配置的来源');
    const timer = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(url, { method, headers, body,
      redirect: 'manual', signal: signal ? AbortSignal.any([signal, timer]) : timer });
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > this.limit) throw new Error('资料超过本地收件上限');
      chunks.push(chunk);
    }
    return { status: response.status, headers: Object.fromEntries(response.headers),
      bytes: Buffer.concat(chunks), url: url.href };
  }

  async control(action) {
    const result = await this.request('/control', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) });
    if (result.status !== 200) throw new Error(`来源控制失败：${result.status}`);
    return JSON.parse(result.bytes);
  }
}
