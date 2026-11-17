// 接收会话：记录一次时间范围请求的接收状态，使来源截断或时间变量缺失时可以补齐，
// 并且重取时严格按来源版本（ETag/摘要）核对，绝不凭新文件名悄悄替换旧依据。

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const stringify = value => JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);

export class SessionStore {
  constructor(root) {
    this.root = root;
    this.serial = Promise.resolve();
  }

  async initialize() {
    await mkdir(join(this.root, 'sessions'), { recursive: true });
    return this;
  }

  async atomic(path, text) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(Buffer.from(text));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  // 保存或推进一个会话。已存在会话按会话 id 与来源版本核对，版本变化必须显式声明才允许接续。
  async save(session) {
    const operation = this.serial.then(async () => {
      await this.initialize();
      const path = join(this.root, 'sessions', `${session.id}.json`);
      const saved = await this.#readIfExists(path);
      if (saved) {
        if (saved.id !== session.id) throw new Error('会话标识不一致');
        if (saved.sourceVersion && session.sourceVersion && saved.sourceVersion !== session.sourceVersion) {
          throw new Error('来源版本已变化，不能凭新文件名替换旧依据；请新建接收会话');
        }
      }
      const stamped = { ...session, updatedAt: new Date().toISOString() };
      await this.atomic(path, stringify(stamped));
      return stamped;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async get(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('无效的会话标识');
    return this.#readIfExists(join(this.root, 'sessions', `${id}.json`));
  }

  async list() {
    await this.initialize();
    const names = (await readdir(join(this.root, 'sessions'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(name => readFile(join(this.root, 'sessions', name), 'utf8').then(JSON.parse)));
  }

  async #readIfExists(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }
}

// 依据指纹：把解释依据（稀疏规则、PAD、时间变量、物理记录偏移）与实际字节一起固化，
// 资料修订后用它核对“解释依据”和“实际记录”是否仍一致。
export function basisFingerprint({ sourcePath, etag, digest, materialized }) {
  const basis = {
    sourcePath,
    etag,
    digest,
    variables: materialized.variables.map(variable => variable.error
      ? { name: variable.name, error: variable.error }
      : { name: variable.name, sparse: variable.sparse, padValue: String(variable.padValue),
        physical: (variable.physical || []).map(entry => ({ record: entry.record, offset: entry.valueOffset })) }),
  };
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}
