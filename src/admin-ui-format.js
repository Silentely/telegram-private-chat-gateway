/**
 * 管理 UI 展示纯函数：键盘、时间格式、排行/热力文案
 * 无 env / Telegram 副作用，便于单测
 */

import {
  OPS_TZ_OFFSET_HOURS,
  shiftHourBuckets,
  peakHoursFromBuckets,
  formatHeatBars,
  formatHeatAxis,
  formatPeakHours,
  rankMedal,
  displayUserLabel,
  shouldAppendUsername,
  formatDelta,
} from './activity-summary.js';

/** HTML 转义（验证页与管理消息共用） */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatSysTime(ts) {
  if (ts == null || ts === '' || Number(ts) <= 0) return '无';
  try {
    return new Date(Number(ts)).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return String(ts);
  }
}

/** 相对时间（中文），便于扫读 */
export function formatRelativeTime(ts, now = Date.now()) {
  const n = Number(ts);
  if (!n || n <= 0) return '无';
  const diff = Number(now) - n;
  if (diff < 0) return formatSysTime(ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return formatSysTime(ts);
}

export function formatTimeBoth(ts, now = Date.now()) {
  if (ts == null || Number(ts) <= 0) return '无';
  return `${formatRelativeTime(ts, now)} · <code>${formatSysTime(ts)}</code>`;
}

export function statusChip(ok, okText = '正常', badText = '异常') {
  return ok ? `🟢 ${okText}` : `🔴 ${badText}`;
}

export function buildUserActionKeyboard(userId) {
  const id = String(userId);
  return {
    inline_keyboard: [
      [
        { text: '🚫 封禁', callback_data: `adm:u:banask:${id}` },
        { text: '✅ 解封', callback_data: `adm:u:unban:${id}` },
      ],
      [
        { text: '🔒 关闭', callback_data: `adm:u:close:${id}` },
        { text: '🔓 打开', callback_data: `adm:u:open:${id}` },
      ],
      [
        { text: '🌟 信任', callback_data: `adm:u:trust:${id}` },
        { text: '🔄 重置', callback_data: `adm:u:reset:${id}` },
      ],
      [
        { text: '🔇 静音', callback_data: `adm:u:mute:${id}` },
        { text: '🔊 取消静音', callback_data: `adm:u:unmute:${id}` },
      ],
      [
        { text: '👤 资料', callback_data: `adm:u:info:${id}` },
        { text: '📝 看备注', callback_data: `adm:u:shownote:${id}` },
      ],
    ],
  };
}

export function buildSysinfoKeyboard(page = 'overview') {
  const mark = (p, label) => (p === page ? `·${label}·` : label);
  const refreshPage = ['overview', 'storage', 'errors', 'stats', 'activity'].includes(page)
    ? page
    : 'overview';
  return {
    inline_keyboard: [
      [
        { text: mark('overview', '概览'), callback_data: 'adm:sys:overview' },
        { text: mark('storage', '存储'), callback_data: 'adm:sys:storage' },
        { text: mark('errors', '错误'), callback_data: 'adm:sys:errors' },
      ],
      [
        { text: mark('stats', '今日'), callback_data: 'adm:sys:stats' },
        { text: mark('activity', '活跃'), callback_data: 'adm:sys:activity' },
        { text: '🔄 刷新', callback_data: `adm:sys:${refreshPage}` },
      ],
      [
        { text: '🏠 菜单', callback_data: 'adm:nav:menu' },
      ],
    ],
  };
}

export function buildUserJumpKeyboard(users, { includeMenu = true, columns = 2 } = {}) {
  const cols = Math.min(Math.max(Number(columns) || 2, 1), 3);
  const list = (users || []).slice(0, 8);
  const rows = [];
  for (let i = 0; i < list.length; i += cols) {
    const chunk = list.slice(i, i + cols).map((u) => {
      const label = displayUserLabel(u).slice(0, cols === 1 ? 24 : 14);
      return {
        text: `👤 ${label}`,
        callback_data: `adm:u:panel:${u.userId}`,
      };
    });
    rows.push(chunk);
  }
  if (includeMenu) {
    rows.push([
      { text: '🔥 活跃', callback_data: 'adm:nav:rank' },
      { text: '🏠 菜单', callback_data: 'adm:nav:menu' },
    ]);
  }
  return { inline_keyboard: rows };
}

export function formatRankingBlock(rankingUsers, { withCount = true, now = Date.now() } = {}) {
  if (!rankingUsers?.length) {
    return ['暂无今日活跃用户', '<i>有入站消息或用户发过言后会显示排行</i>'];
  }
  const lines = [];
  rankingUsers.slice(0, 10).forEach((u, i) => {
    const label = displayUserLabel(u);
    const name = escapeHtml(label);
    const un = shouldAppendUsername(u, label) ? ` @${escapeHtml(u.username)}` : '';
    const cnt = withCount && u.count != null ? ` · <b>${u.count}</b> 条` : '';
    const when = u.lastMessageAt && u.count == null
      ? ` · ${formatRelativeTime(u.lastMessageAt, now)}`
      : '';
    const badge = u.status === 'banned' ? ' 🚫'
      : u.status === 'closed' ? ' 🔒'
        : '';
    lines.push(`${rankMedal(i)} ${name}${un}${cnt}${when}${badge}`);
    lines.push(`   <code>${escapeHtml(u.userId)}</code>${u.topicId ? ` · T${escapeHtml(u.topicId)}` : ''}`);
  });
  return lines;
}

/** 热力展示统一用运维时区（默认 CST UTC+8） */
export function formatHeatBlock(utcHours) {
  const localHours = shiftHourBuckets(utcHours, OPS_TZ_OFFSET_HOURS);
  const peaks = peakHoursFromBuckets(localHours, 3);
  return [
    `🌡 <b>小时热力</b> <i>CST UTC+${OPS_TZ_OFFSET_HOURS} · 0–23</i>`,
    `<code>${formatHeatBars(localHours)}</code>`,
    `<code>${formatHeatAxis()}</code>`,
    `高峰 ${escapeHtml(formatPeakHours(peaks))}`,
  ];
}

export function formatCompareLine(label, todayVal, ydayVal) {
  const t = Number(todayVal) || 0;
  const y = Number(ydayVal) || 0;
  return `  ${label}  <b>${t}</b>  <i>较昨 ${escapeHtml(formatDelta(t, y))}</i>`;
}

export function buildAdminHomeKeyboard(isOwner = false) {
  const rows = [
    [
      { text: '🖥 系统', callback_data: 'adm:nav:sysinfo' },
      { text: '📊 今日', callback_data: 'adm:nav:stats' },
      { text: '🔥 活跃', callback_data: 'adm:nav:rank' },
    ],
    [
      { text: '🔍 查找', callback_data: 'adm:nav:find' },
      { text: '🔎 备注', callback_data: 'adm:nav:notes' },
      { text: '📝 屏蔽词', callback_data: 'adm:nav:listwords' },
    ],
    [
      { text: '🧹 清理', callback_data: 'adm:nav:cleanup_ask' },
      { text: '🪪 我', callback_data: 'adm:nav:whoami' },
      { text: '❓ 帮助', callback_data: 'adm:nav:help' },
    ],
  ];
  if (isOwner) {
    rows.push([{ text: '📡 同步命令菜单', callback_data: 'adm:nav:synccommands' }]);
  }
  return { inline_keyboard: rows };
}

export function buildBanConfirmKeyboard(userId) {
  const id = String(userId);
  return {
    inline_keyboard: [[
      { text: '确认封禁', callback_data: `adm:u:banok:${id}` },
      { text: '取消', callback_data: `adm:u:bancancel:${id}` },
    ]],
  };
}

export function buildCleanupConfirmKeyboard() {
  return {
    inline_keyboard: [[
      { text: '确认清理', callback_data: 'adm:nav:cleanup_ok' },
      { text: '取消', callback_data: 'adm:nav:cleanup_cancel' },
    ]],
  };
}
