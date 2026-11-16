export function decode(bytes) {
  if (bytes.length < 320 || bytes.subarray(0, 4).toString('hex') !== 'cdf30001' || bytes.subarray(4, 8).toString('hex') !== '0000ffff') throw new Error('不是当前支持的 CDF3 单文件');
  const pointer = offset => { const value = bytes.readBigUInt64BE(offset); if (value > BigInt(bytes.length)) throw new Error('CDF 指针越界'); return Number(value); };
  const cdr = 8;
  const gdr = pointer(cdr + 12);
  if (gdr + 64 > bytes.length) throw new Error('全局描述截断');
  let current = pointer(gdr + 20);
  const count = bytes.readInt32BE(gdr + 60);
  const variables = [];
  const visited = new Set();
  while (current) {
    if (visited.has(current) || current + 344 > bytes.length) throw new Error('变量描述链损坏');
    visited.add(current);
    const name = bytes.subarray(current + 84, current + 340).toString().split('\0')[0];
    const dimensions = bytes.readInt32BE(current + 340);
    const sizes = [];
    for (let index = 0; index < dimensions; index++) sizes.push(bytes.readInt32BE(current + 344 + index * 4));
    variables.push({ name, type: bytes.readInt32BE(current + 20), maxRecord: bytes.readInt32BE(current + 24),
      recordVary: Boolean(bytes.readInt32BE(current + 44) & 1), sparse: bytes.readInt32BE(current + 48), sizes,
      firstIndex: pointer(current + 28) });
    current = pointer(current + 12);
    if (variables.length > count) throw new Error('变量描述数量冲突');
  }
  if (variables.length !== count) throw new Error('变量目录不完整');
  return { version: [bytes.readInt32BE(cdr + 20), bytes.readInt32BE(cdr + 24)], encoding: bytes.readInt32BE(cdr + 28), variables, bytes: bytes.length };
}
