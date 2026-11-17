// 结构化收件：把 materialize 给出的物理记录，结合变量自身的稀疏规则与独立时间变量，
// 展开成逐条时间线。每条时间线记录都带来源分类，绝不把三类来源混为同一种“观测”：
//   physical —— 文件里真实存在的值记录（zVVR）；
//   previous —— 按 PREV(sparse=2) 规则由前一条物理记录延续得到的虚拟记录；
//   pad      —— 按 PAD(sparse=1) 规则用变量填充值补上的虚拟记录。
// 时间解释依赖独立的 Epoch 变量；时间变量缺失时不编造时间，返回可补齐的接收状态。

import { materialize } from './decode.mjs';

export const ORIGIN = {
  PHYSICAL: 'physical',
  PREVIOUS: 'previous',
  PAD: 'pad',
};

const SPARSE_KIND = { 0: 'none', 1: 'pad', 2: 'previous' };
// TT2000 以 2000-01-01T12:00:00Z 为零纳秒。
const TT2000_EPOCH_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

function tt2000ToIso(bigNanos) {
  const nanos = typeof bigNanos === 'bigint' ? bigNanos : BigInt(bigNanos);
  const ms = TT2000_EPOCH_MS + Number(nanos / 1000000n);
  return new Date(ms).toISOString();
}

function findTimeVariable(materialized, timeName = 'Epoch') {
  return materialized.variables.find(variable => variable.name === timeName && !variable.error) || null;
}

// 为单个变量构造记录号 -> 物理记录的映射。
function physicalIndex(variable) {
  const map = new Map();
  for (const record of variable.physical || []) map.set(record.record, record);
  return map;
}

// 按变量稀疏规则把记录区间 firstRecord..maxRecord 逐记录展开。
function expandVariable(variable, timeVariable) {
  const sparseKind = SPARSE_KIND[variable.sparse] ?? 'unknown';
  const byRecord = physicalIndex(variable);
  const timeline = [];
  let carried = null; // PREV 规则下最近一条物理记录的值。
  for (let record = variable.firstRecord; record <= variable.maxRecord; record++) {
    const timeEntry = timeVariable ? (timeVariable.physical || []).find(item => item.record === record) : null;
    const base = { record, time: timeEntry ? tt2000ToIso(timeEntry.value) : null,
      timeRecord: timeEntry ? record : null };
    const physical = byRecord.get(record);
    if (physical) {
      carried = physical.value;
      timeline.push({ ...base, origin: ORIGIN.PHYSICAL, value: physical.value, valueOffset: physical.valueOffset });
    } else if (sparseKind === 'previous') {
      timeline.push({ ...base, origin: ORIGIN.PREVIOUS, value: carried,
        derivedFrom: carried === null ? null : nearestPhysicalRecord(byRecord, record) });
    } else if (sparseKind === 'pad') {
      timeline.push({ ...base, origin: ORIGIN.PAD, value: variable.padValue, pad: variable.padValue });
    } else {
      timeline.push({ ...base, origin: ORIGIN.PAD, value: variable.padValue, pad: variable.padValue, note: '无稀疏规则但缺少物理记录，按填充值占位' });
    }
  }
  return timeline;
}

function nearestPhysicalRecord(byRecord, record) {
  for (let candidate = record - 1; candidate >= 0; candidate--) {
    if (byRecord.has(candidate)) return candidate;
  }
  return null;
}

export const __expandVariableForTest = expandVariable;

// 完整接收一份 CDF 字节：解释依据（目录、稀疏规则、PAD、时间变量）与实际记录一并核对。
// 任何结构性截断都收敛为可补齐状态，而不是让接收过程整体失败。
export function intake(bytes, { timeVariable = 'Epoch' } = {}) {
  let materialized;
  let structuralError = null;
  try {
    materialized = materialize(bytes);
  } catch (error) {
    structuralError = error.message;
    materialized = { encoding: null, littleEndian: null, variables: [] };
  }
  const time = findTimeVariable(materialized, timeVariable);
  const failures = materialized.variables.filter(variable => variable.error).map(variable => ({ variable: variable.name, error: variable.error }));
  const status = {
    complete: structuralError === null && failures.length === 0 && Boolean(time),
    // 可补齐状态：来源截断会表现为结构错误或变量解释失败；依赖时间变量缺失则单独标注，等待重取。
    missingTimeVariable: !time,
    truncated: structuralError !== null || failures.length > 0,
    reasons: [],
  };
  if (structuralError) status.reasons.push(`资料结构不完整：${structuralError}`);
  if (!time) status.reasons.push(`依赖的时间变量 ${timeVariable} 缺失，时间线无法赋时`);
  for (const failure of failures) status.reasons.push(`变量 ${failure.variable} 解释不完整：${failure.error}`);

  const variables = materialized.variables
    .filter(variable => !variable.error)
    .map(variable => ({
      name: variable.name,
      dataType: variable.dataType,
      sparse: variable.sparse,
      sparseKind: SPARSE_KIND[variable.sparse] ?? 'unknown',
      maxRecord: variable.maxRecord,
      padValue: variable.padValue,
      physicalRecords: (variable.physical || []).map(entry => entry.record),
      timeline: expandVariable(variable, time),
    }));

  return {
    encoding: materialized.encoding,
    littleEndian: materialized.littleEndian,
    timeVariable: time ? { name: time.name, dataType: time.dataType,
      records: (time.physical || []).map(entry => ({ record: entry.record, time: tt2000ToIso(entry.value) })) } : null,
    status,
    variables,
  };
}

// 在完整时间线之上做时间范围请求。允许读取为理解当前范围所必需的范围外依据
// （PREV 的延续值来自范围起点之前的物理记录），这些记录标 supporting，不计为本次新观测。
export function selectRange(result, { from, to } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const inWindow = entry => {
    if (entry.time === null) return false;
    const ms = Date.parse(entry.time);
    return ms >= fromMs && ms <= toMs;
  };

  const variables = result.variables.map(variable => {
    const observations = [];
    const supporting = [];
    for (const entry of variable.timeline) {
      if (inWindow(entry)) observations.push(entry);
    }
    // PREV 范围内若出现虚拟记录，回溯到范围外最近一条物理记录，作为解释依据登记。
    if (variable.sparseKind === 'previous') {
      const hasVirtualInWindow = observations.some(entry => entry.origin === ORIGIN.PREVIOUS);
      if (hasVirtualInWindow) {
        const anchor = variable.timeline
          .filter(entry => entry.origin === ORIGIN.PHYSICAL && !inWindow(entry) && Date.parse(entry.time) < fromMs)
          .at(-1);
        if (anchor) supporting.push({ ...anchor, role: 'previous-anchor' });
      }
    }
    return { name: variable.name, observations, supporting };
  });

  return {
    range: { from: from ?? null, to: to ?? null },
    timeVariable: result.timeVariable,
    status: result.status,
    variables,
    note: 'supporting 仅为解释当前范围取得的范围外依据，不计入本次新观测',
  };
}
