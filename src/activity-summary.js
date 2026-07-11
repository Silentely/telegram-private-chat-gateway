/**
 * 管理看板：消息活跃汇总与热力展示（纯函数，便于单测）
 */

/** 默认运维时区：中国（UTC+8） */
export const OPS_TZ_OFFSET_HOURS = 8;

/** 当日 UTC 0 点毫秒时间戳（兼容/测试） */
export function utcDayStartMs(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** UTC 日历日 YYYY-MM-DD */
export function utcDayKey(now = Date.now()) {
  return new Date(Number(now) || Date.now()).toISOString().slice(0, 10);
}

/** 前一 UTC 日 YYYY-MM-DD */
export function utcYesterdayKey(now = Date.now()) {
  return utcDayKey(Number(now) - 86400_000);
}

/**
 * 运维时区日历日 YYYY-MM-DD（默认 CST）
 * 将 now 平移 offset 小时后取 ISO 日期，即目标时区的“今天”
 */
export function opsDayKey(now = Date.now(), offsetHours = OPS_TZ_OFFSET_HOURS) {
  const off = Number(offsetHours);
  const shifted = new Date(Number(now) + off * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

/** 运维时区「昨天」日历日 */
export function opsYesterdayKey(now = Date.now(), offsetHours = OPS_TZ_OFFSET_HOURS) {
  return opsDayKey(Number(now) - 86400_000, offsetHours);
}

/**
 * 运维时区当日 0 点对应的 UTC 毫秒时间戳
 * 例：CST 2026-07-12 00:00 = 2026-07-11 16:00 UTC
 */
export function opsDayStartMs(now = Date.now(), offsetHours = OPS_TZ_OFFSET_HOURS) {
  const key = opsDayKey(now, offsetHours);
  const [y, m, d] = key.split('-').map(Number);
  const off = Number(offsetHours);
  return Date.UTC(y, m - 1, d) - off * 3600_000;
}

/**
 * 可变长度迷你 sparkline（用于近 N 日）
 * @param {number[]} values
 */
export function formatSparkline(values) {
  const list = (values || []).map(n => Math.max(0, Number(n) || 0));
  if (!list.length) return '';
  const max = Math.max(0, ...list);
  if (max <= 0) return '·'.repeat(list.length);
  const blocks = '▁▂▃▄▅▆▇█';
  return list.map((n) => {
    if (n <= 0) return '·';
    const level = Math.min(8, Math.max(1, Math.ceil((n / max) * 8)));
    return blocks[level - 1];
  }).join('');
}

/**
 * 汇总入站消息行 → 总量 / 小时桶 / 用户排行
 * @param {Array<{userId:string, createdAt:number}>} rows
 * @param {{topN?:number}} [opts]
 */
export function summarizeInboundActivity(rows, opts = {}) {
  const topN = Math.min(Math.max(Number(opts.topN) || 10, 1), 30);
  const hours = Array.from({ length: 24 }, () => 0);
  const byUser = new Map();
  let total = 0;

  for (const row of rows || []) {
    const createdAt = Number(row?.createdAt || 0);
    if (!createdAt) continue;
    total += 1;
    const hour = new Date(createdAt).getUTCHours();
    hours[hour] += 1;
    const uid = String(row.userId || '');
    if (!uid) continue;
    byUser.set(uid, (byUser.get(uid) || 0) + 1);
  }

  const ranking = [...byUser.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([userId, count]) => ({ userId, count }));

  return {
    total,
    hours,
    ranking,
    peakHours: peakHoursFromBuckets(hours, 3),
    uniqueUsers: byUser.size,
  };
}

/**
 * 将 UTC 小时桶平移到目标时区（offset 为正表示东时区）
 * @param {number[]} hours
 * @param {number} offsetHours
 */
export function shiftHourBuckets(hours, offsetHours = OPS_TZ_OFFSET_HOURS) {
  const list = Array.isArray(hours) && hours.length === 24
    ? hours.map(n => Math.max(0, Number(n) || 0))
    : Array.from({ length: 24 }, () => 0);
  const off = ((Number(offsetHours) % 24) + 24) % 24;
  if (off === 0) return list;
  const out = Array.from({ length: 24 }, () => 0);
  for (let utc = 0; utc < 24; utc += 1) {
    out[(utc + off) % 24] = list[utc];
  }
  return out;
}

/** 从小时桶提取高峰 */
export function peakHoursFromBuckets(hours, topN = 3) {
  const list = Array.isArray(hours) && hours.length === 24
    ? hours
    : Array.from({ length: 24 }, () => 0);
  return list
    .map((count, hour) => ({ hour, count: Number(count) || 0 }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .slice(0, Math.min(Math.max(Number(topN) || 3, 1), 24));
}

/**
 * 将 24 小时计数渲染为 Unicode 热力条
 * @param {number[]} hours
 */
export function formatHeatBars(hours) {
  const list = Array.isArray(hours) && hours.length === 24
    ? hours.map(n => Math.max(0, Number(n) || 0))
    : Array.from({ length: 24 }, () => 0);
  const max = Math.max(0, ...list);
  if (max <= 0) return '·'.repeat(24);
  const blocks = '▁▂▃▄▅▆▇█';
  return list.map((n) => {
    if (n <= 0) return '·';
    // 将 (0, max] 映射到 8 档，最大值固定为 █
    const level = Math.min(8, Math.max(1, Math.ceil((n / max) * 8)));
    return blocks[level - 1];
  }).join('');
}

/** 热力轴刻度（与 24 格对齐的近似标记） */
export function formatHeatAxis() {
  return '0·····6····12····18···23';
}

/**
 * 高峰时段文案，如 14:00×12 · 15:00×9
 * @param {Array<{hour:number,count:number}>} peakHours
 */
export function formatPeakHours(peakHours) {
  if (!peakHours?.length) return '暂无';
  return peakHours
    .map(p => `${String(p.hour).padStart(2, '0')}:00×${p.count}`)
    .join(' · ');
}

/**
 * 名次徽章
 * @param {number} index0
 */
export function rankMedal(index0) {
  if (index0 === 0) return '🥇';
  if (index0 === 1) return '🥈';
  if (index0 === 2) return '🥉';
  return `${index0 + 1}.`;
}

/** 用户展示名（优先姓名） */
export function displayUserLabel(u) {
  if (!u || typeof u !== 'object') return '未知';
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (u.username) return `@${u.username}`;
  return String(u.userId || '未知');
}

/** 姓名行是否还需追加 @username（避免 @bob @bob） */
export function shouldAppendUsername(u, label) {
  if (!u?.username) return false;
  const un = String(u.username);
  const lb = String(label || '');
  return lb !== `@${un}` && lb !== un;
}

/**
 * 今日 vs 昨日增量文案
 * @param {number} current
 * @param {number} previous
 */
export function formatDelta(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  const d = c - p;
  if (d === 0) return '持平';
  return d > 0 ? `↑${d}` : `↓${Math.abs(d)}`;
}

/** 活跃数据源中文标签 */
export function activitySourceLabel(source) {
  switch (String(source || '')) {
    case 'message_links': return '消息映射';
    case 'kv_hours': return 'KV 小时桶';
    case 'last_message': return '最近活跃';
    case 'kv_hours+last_message': return 'KV热力+最近活跃';
    case 'none': return '暂无';
    default: return source || '未知';
  }
}
