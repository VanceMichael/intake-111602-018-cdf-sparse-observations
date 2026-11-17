// CDF3 单文件解释。
// 本项目的资料记录头为 12 字节：[保留字 u32=0][记录长度 size u32][记录类型 type u32]，
// 长度包含头部。描述符与指针按大端读取；变量数据值的字节序由 CDR 的 encoding 决定，
// 当前资料为 IBMPC（小端）。所有偏移均以整份文件为基准。

const RECORD = {
  HEADER_SIZE: 12,
  TYPE_ZVDR: 8, // z 变量描述符
  TYPE_ZXDR: 6, // z 变量索引记录
  TYPE_ZVVR: 7, // z 变量值记录
};

const ZVDR = {
  NEXT: 12,
  DATA_TYPE: 20,
  MAX_RECORD: 24,
  FIRST_INDEX: 28,
  PAD: 36,
  SPARSE: 48,
  NUM_ELEMS: 64,
  NUM_DIMS: 72,
  DIM_SIZES: 76,
  NAME: 84,
  NAME_END: 340,
};

const ZXDR = {
  FIRST_RECORD: 16,
  LAST_RECORD: 20,
  ENTRY_START: 24,
  ENTRY_SIZE: 16,
  SLOT_SIZE: 8,
  EMPTY: 0xffffffff,
};

// 当前资料涉及的数据类型。读取长度与读取函数与 encoding 字节序绑定。
const DATA_TYPES = {
  4: { name: 'CDF_INT4', bytes: 4, read: (buffer, offset, littleEndian) => (littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset)) },
  33: { name: 'CDF_TIME_TT2000', bytes: 8, read: (buffer, offset, littleEndian) => (littleEndian ? buffer.readBigInt64LE(offset) : buffer.readBigInt64BE(offset)) },
  45: { name: 'CDF_DOUBLE', bytes: 8, read: (buffer, offset, littleEndian) => (littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset)) },
};

// CDF 编码：奇数为大端网络/主机变体，偶数为对应小端变体；当前资料为 6（IBMPC 小端）。
const LITTLE_ENDIAN_ENCODINGS = new Set([2, 4, 6]);

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

function assertRecord(bytes, offset, expectedType, label) {
  if (offset + RECORD.HEADER_SIZE > bytes.length) throw new Error(`${label} 记录截断`);
  if (bytes.readUInt32BE(offset + 8) !== expectedType) throw new Error(`${label} 记录类型不符`);
  const size = bytes.readUInt32BE(offset + 4);
  if (size < RECORD.HEADER_SIZE || offset + size > bytes.length) throw new Error(`${label} 记录长度越界`);
  return size;
}

function valueType(dataType) {
  const spec = DATA_TYPES[dataType];
  if (!spec) throw new Error(`暂不支持的变量数据类型：${dataType}`);
  return spec;
}

// 读取 z 变量的索引项与值记录，返回带物理记录号的实际记录。
function readVariable(bytes, descriptorOffset, littleEndian) {
  const dataType = bytes.readInt32BE(descriptorOffset + ZVDR.DATA_TYPE);
  const spec = valueType(dataType);
  const maxRecord = bytes.readInt32BE(descriptorOffset + ZVDR.MAX_RECORD);
  const sparse = bytes.readInt32BE(descriptorOffset + ZVDR.SPARSE);
  const numElems = Math.max(1, bytes.readInt32BE(descriptorOffset + ZVDR.NUM_ELEMS));
  const numDims = Math.max(0, bytes.readInt32BE(descriptorOffset + ZVDR.NUM_DIMS));
  const dimensions = [];
  for (let index = 0; index < Math.max(0, numDims); index++) dimensions.push(bytes.readInt32BE(descriptorOffset + ZVDR.DIM_SIZES + index * 4));
  const recordElements = numElems * dimensions.reduce((product, size) => product * Math.max(1, size), 1);
  const recordBytes = spec.bytes * recordElements;
  const padValue = spec.read(bytes, descriptorOffset + ZVDR.PAD, littleEndian);

  const indexOffset = Number(bytes.readBigUInt64BE(descriptorOffset + ZVDR.FIRST_INDEX));
  const indexSize = assertRecord(bytes, indexOffset, RECORD.TYPE_ZXDR, '变量索引');
  const firstRecord = bytes.readUInt32BE(indexOffset + ZXDR.FIRST_RECORD);
  const lastRecord = bytes.readUInt32BE(indexOffset + ZXDR.LAST_RECORD);
  // 项区从记录内偏移 ENTRY_START 开始，每个 16 字节项为四个 u32 字。
  const entryCapacity = Math.max(0, Math.floor((indexSize - ZXDR.ENTRY_START) / ZXDR.ENTRY_SIZE));
  const physical = [];
  const isValueRecord = offset => offset < bytes.length
    && offset + RECORD.HEADER_SIZE <= bytes.length
    && bytes.readUInt32BE(offset + 8) === RECORD.TYPE_ZVVR;
  if (sparse === 0) {
    // 无稀疏：索引中唯一指向 zVVR 的项给出值块起点，块内连续存放 firstRecord..maxRecord。
    let blockOffset = 0;
    for (let item = 0; item < entryCapacity; item++) {
      const candidate = bytes.readUInt32BE(indexOffset + ZXDR.ENTRY_START + item * ZXDR.ENTRY_SIZE);
      if (isValueRecord(candidate)) { blockOffset = candidate; break; }
    }
    if (!blockOffset) throw new Error('非稀疏变量缺少值块指针');
    for (let recordNumber = firstRecord; recordNumber <= maxRecord; recordNumber++) {
      const at = blockOffset + RECORD.HEADER_SIZE + (recordNumber - firstRecord) * recordBytes;
      if (at + recordBytes > bytes.length) throw new Error('变量值记录数据截断');
      physical.push({ record: recordNumber, value: spec.read(bytes, at, littleEndian), valueOffset: at });
    }
  } else {
    // 稀疏索引项区是一条连续的 8 字节槽流，未使用槽为全 FF，两类槽交错出现：
    //   记录号槽 [0][物理记录号]；记录号为 0 时不单独占槽，由索引首记录号补齐。
    //   指针槽   [值记录指针][标记]，首字指向真正的 zVVR 记录。
    // 分别按出现顺序收集两类槽，再按物理记录顺序配对。
    const recordNumbers = [];
    const valueOffsets = [];
    const slotCount = Math.floor((indexSize - ZXDR.ENTRY_START) / ZXDR.SLOT_SIZE);
    for (let slot = 0; slot < slotCount; slot++) {
      const slotOffset = indexOffset + ZXDR.ENTRY_START + slot * ZXDR.SLOT_SIZE;
      const word0 = bytes.readUInt32BE(slotOffset);
      const word1 = bytes.readUInt32BE(slotOffset + 4);
      if (word0 === 0 && word1 !== ZXDR.EMPTY) recordNumbers.push(word1);
      else if (word0 !== ZXDR.EMPTY && isValueRecord(word0)) valueOffsets.push(word0);
    }
    while (recordNumbers.length < valueOffsets.length) recordNumbers.unshift(firstRecord);
    if (recordNumbers.length !== valueOffsets.length) throw new Error('稀疏变量记录号与值记录数量不一致');
    if (recordNumbers.some((number, index) => index > 0 && number <= recordNumbers[index - 1])) {
      throw new Error('稀疏变量记录号不是严格升序，无法与值记录可靠配对');
    }
    for (let index = 0; index < valueOffsets.length; index++) {
      const at = valueOffsets[index] + RECORD.HEADER_SIZE;
      if (at + recordBytes > bytes.length) throw new Error('变量值记录数据截断');
      physical.push({ record: recordNumbers[index], value: spec.read(bytes, at, littleEndian), valueOffset: at });
    }
  }
  if (!physical.length) throw new Error('变量索引没有可读取的物理记录');
  return { dataType: spec.name, sparse, maxRecord, firstRecord, lastRecord, padValue,
    recordElements, dimensions, physical: physical.sort((a, b) => a.record - b.record) };
}

// 完整结构化接收：在目录之外，把每个变量的物理记录、PAD 值与稀疏规则一起解释出来。
// 结构性截断（描述符或索引落在文件尾之外）不整体抛出，而在变量上带 error，
// 使上层能保留“可补齐”的接收状态，等待重取后接续。
export function materialize(bytes) {
  if (bytes.length < 320 || bytes.subarray(0, 4).toString('hex') !== 'cdf30001' || bytes.subarray(4, 8).toString('hex') !== '0000ffff') {
    throw new Error('不是当前支持的 CDF3 单文件');
  }
  const cdr = 8;
  const littleEndian = LITTLE_ENDIAN_ENCODINGS.has(bytes.readInt32BE(cdr + 28));
  const gdr = Number(bytes.readBigUInt64BE(cdr + 12));
  let descriptorOffset = Number(bytes.readBigUInt64BE(gdr + 20));
  const variables = [];
  const visited = new Set();
  while (descriptorOffset) {
    if (visited.has(descriptorOffset)) break;
    visited.add(descriptorOffset);
    let name = `offset-${descriptorOffset}`;
    try {
      assertRecord(bytes, descriptorOffset, RECORD.TYPE_ZVDR, '变量描述');
      name = bytes.subarray(descriptorOffset + ZVDR.NAME, descriptorOffset + ZVDR.NAME_END).toString().split('\0')[0] || name;
      variables.push({ name, ...readVariable(bytes, descriptorOffset, littleEndian) });
    } catch (error) {
      variables.push({ name, error: error.message });
    }
    try {
      const next = Number(bytes.readBigUInt64BE(descriptorOffset + ZVDR.NEXT));
      descriptorOffset = next < bytes.length ? next : 0;
    } catch {
      descriptorOffset = 0;
    }
  }
  return {
    version: [bytes.readInt32BE(cdr + 20), bytes.readInt32BE(cdr + 24)],
    encoding: bytes.readInt32BE(cdr + 28), littleEndian, variables, bytes: bytes.length,
  };
}
