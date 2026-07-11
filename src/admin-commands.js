/**
 * 管理命令编排：日统计、看板、查找/备注、adm 回调
 * 通过 createAdminCommandHandlers(deps) 注入副作用依赖
 */

import {
  OPS_TZ_OFFSET_HOURS,
  opsDayKey,
  opsYesterdayKey,
  opsDayStartMs,
  summarizeInboundActivity,
  formatSparkline,
  pickPeakDays,
  formatPeakDays,
  activitySourceLabel,
} from './activity-summary.js';
import {
  escapeHtml,
  formatRelativeTime,
  formatTimeBoth,
  statusChip,
  buildSysinfoKeyboard,
  buildUserJumpKeyboard,
  formatRankingBlock,
  formatHeatBlock,
  formatCompareLine,
  buildAdminHomeKeyboard,
  buildBanConfirmKeyboard,
  buildCloseConfirmKeyboard,
  buildResetConfirmKeyboard,
  buildCleanupConfirmKeyboard,
  formatEmptyActivityHints,
} from './admin-ui-format.js';
import { createD1Storage } from './storage/d1-storage.js';
import { ensureMigrations } from './storage/migrations.js';

/**
 * @param {object} deps
 */
export function createAdminCommandHandlers(deps) {
  const {
    tgCall,
    gatewayVersion: GATEWAY_VERSION,
    recordSystemError,
    isOwnerUser,
    isAdminUser,
    parseIdAllowlist,
    safeGetJSON,
    resolveThreadIdForUser,
    getRecentSystemErrors,
    handleCleanupCommand,
    handleListWordsCommand,
    userActions = {},
  } = deps;

  const sysinfoKvCache = { ts: 0, data: null, ttlMs: 45000 };

function emptyDailyStats(day) {
  return {
    day,
    messages_in: 0,
    bans: 0,
    verifies: 0,
    spam: 0,
    hours: Array.from({ length: 24 }, () => 0),
  };
}

async function bumpDailyStat(env, field, n = 1) {
  if (!env?.TOPIC_MAP) return;
  try {
    // 按运维时区（CST）日历日切分，避免北京时间午夜仍算「昨天」
    const day = opsDayKey();
    const key = `stats:${day}`;
    let obj = {};
    try {
      const raw = await env.TOPIC_MAP.get(key);
      if (raw) obj = JSON.parse(raw);
    } catch { obj = {}; }
    if (!obj || typeof obj !== 'object') obj = {};
    obj[field] = Number(obj[field] || 0) + Number(n || 0);
    obj.tz = `UTC+${OPS_TZ_OFFSET_HOURS}`;
    // 入站消息同步累计小时热力（存 UTC 小时，展示时平移到 CST）
    if (field === 'messages_in') {
      if (!Array.isArray(obj.hours) || obj.hours.length !== 24) {
        obj.hours = Array.from({ length: 24 }, () => 0);
      }
      const h = new Date().getUTCHours();
      obj.hours[h] = Number(obj.hours[h] || 0) + Number(n || 0);
    }
    obj.updated_at = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(obj), { expirationTtl: 21 * 86400 });
  } catch { /* 统计失败不影响主流程 */ }
}

async function getDailyStats(env, day = opsDayKey()) {
  try {
    const raw = await env.TOPIC_MAP.get(`stats:${day}`);
    if (!raw) return emptyDailyStats(day);
    const obj = JSON.parse(raw);
    const hours = Array.isArray(obj.hours) && obj.hours.length === 24
      ? obj.hours.map(n => Number(n || 0))
      : Array.from({ length: 24 }, () => 0);
    return {
      day,
      messages_in: Number(obj.messages_in || 0),
      bans: Number(obj.bans || 0),
      verifies: Number(obj.verifies || 0),
      spam: Number(obj.spam || 0),
      hours,
      updated_at: obj.updated_at,
    };
  } catch {
    return emptyDailyStats(day);
  }
}

/** 近 N 个运维日入站序列（含今日） */
async function getRecentDailySeries(env, days = 7) {
  const n = Math.min(Math.max(Number(days) || 7, 1), 14);
  const series = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = opsDayKey(now - i * 86400_000);
    const s = await getDailyStats(env, day);
    series.push({
      day,
      messages_in: s.messages_in,
      verifies: s.verifies,
      bans: s.bans,
      spam: s.spam,
    });
  }
  return series;
}

/**
 * 今日活跃：优先 message_links 入站汇总，不足时用 last_message_at / KV 小时桶兜底
 * 「今日」= 运维时区（CST）日历日
 */
async function loadTodayActivity(env) {
  const dayStart = opsDayStartMs();
  const day = opsDayKey();
  const today = await getDailyStats(env, day);
  let summary = summarizeInboundActivity([], { topN: 10 });
  let source = 'none';
  const storage = env.TG_BOT_DB ? createD1Storage(env.TG_BOT_DB) : null;

  if (storage) {
    try {
      await ensureMigrations(env.TG_BOT_DB);
      const rows = await storage.getInboundMessageRows(dayStart, 2000);
      if (rows.length) {
        summary = summarizeInboundActivity(rows, { topN: 10 });
        source = 'message_links';
      }
    } catch (e) {
      recordSystemError('activity_links_failed', e, {}, env);
    }
  }

  // 热力：D1 无数据时用 KV 小时桶
  if (summary.total === 0 && today.hours?.some(n => n > 0)) {
    summary = {
      ...summary,
      total: today.messages_in || today.hours.reduce((a, b) => a + b, 0),
      hours: today.hours,
      peakHours: today.hours
        .map((count, hour) => ({ hour, count }))
        .filter(item => item.count > 0)
        .sort((a, b) => b.count - a.count || a.hour - b.hour)
        .slice(0, 3),
    };
    source = source === 'none' ? 'kv_hours' : source;
  }

  // 排行兜底：今日有 last_message_at 的用户
  let rankingUsers = [];
  if (storage) {
    try {
      if (summary.ranking.length) {
        const map = await storage.getUsersByIds(summary.ranking.map(r => r.userId));
        rankingUsers = summary.ranking.map((r) => {
          const u = map.get(r.userId);
          return {
            userId: r.userId,
            count: r.count,
            username: u?.username || null,
            firstName: u?.firstName || null,
            lastName: u?.lastName || null,
            topicId: u?.topicId || null,
            lastMessageAt: u?.lastMessageAt || null,
            status: u?.status || null,
          };
        });
      } else {
        const active = await storage.getUsersActiveSince(dayStart, 10);
        rankingUsers = active.map(u => ({
          userId: u.userId,
          count: null,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          topicId: u.topicId,
          lastMessageAt: u.lastMessageAt,
          status: u.status,
        }));
        if (rankingUsers.length && source === 'none') source = 'last_message';
        else if (rankingUsers.length && source === 'kv_hours') source = 'kv_hours+last_message';
      }
    } catch (e) {
      recordSystemError('activity_rank_failed', e, {}, env);
    }
  }

  return {
    day,
    dayStart,
    today,
    summary,
    rankingUsers,
    source,
  };
}

async function handleHelpCommand(env, threadId, senderId = null) {
  const helpText = `📋 <b>管理帮助</b> · v${GATEWAY_VERSION}

<b>权限</b>
群主/管理员、<code>ADMIN_IDS</code> 或 <code>OWNER_IDS</code>
私聊用户仅 <code>/start</code> <code>/help</code> · 命令菜单：BotFather 或 Owner <code>/synccommands</code>

<b>推荐用法</b>
• <code>/menu</code> — 按钮首页（最省事）
• 用户话题内 <code>/panel</code> 或 <code>/info</code> — 一键操作
• <code>/sysinfo</code> / <code>/rank</code> — 系统与今日活跃看板
• 统计「今日」按 <b>中国时间 CST</b> 日切

<b>全局命令</b>
/menu /sysinfo /stats /rank /whoami
/find 词 · /notes 关键词
/cleanup /listwords /addword /delword
/synccommands <i>(Owner)</i>

<b>话题内</b>
/panel /info /note 备注
/ban(需确认) /unban /close /open /mute /unmute /trust /reset`;
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: helpText,
    parse_mode: "HTML",
    reply_markup: buildAdminHomeKeyboard(isOwnerUser(env, senderId)),
  });
}

async function handleMenuCommand(env, threadId, senderId) {
  const text = [
    `🏠 <b>管理菜单</b> · v${GATEWAY_VERSION}`,
    '────────────',
    '点下方按钮快速打开功能，无需记忆命令。',
    '',
    '🔥 <b>活跃</b> 今日排行 + 中国时间热力',
    '🔍 <b>查找</b> /find · 🔎 <b>备注</b> /notes',
    '💡 用户会话请进入对应 Forum Topic 使用 <b>面板/资料</b>。',
  ].join('\n');
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text,
    parse_mode: 'HTML',
    reply_markup: buildAdminHomeKeyboard(isOwnerUser(env, senderId)),
  });
}

async function countKvPrefix(env, prefix) {
  if (!env?.TOPIC_MAP?.list) return null;
  let total = 0;
  let cursor;
  let pages = 0;
  const maxPages = 20; // 防止超大命名空间拖垮命令
  do {
    const result = await env.TOPIC_MAP.list({ prefix, cursor, limit: 1000 });
    total += (result.keys || []).length;
    cursor = result.list_complete ? undefined : result.cursor;
    pages += 1;
  } while (cursor && pages < maxPages);
  return { total, truncated: Boolean(cursor) };
}

async function collectRecentErrors(env) {
  let kvErrors = [];
  try {
    if (env?.TOPIC_MAP) {
      const raw = await env.TOPIC_MAP.get('sys:recent_errors');
      if (raw) kvErrors = JSON.parse(raw);
    }
  } catch { kvErrors = []; }
  if (!Array.isArray(kvErrors)) kvErrors = [];
  const merged = [];
  const seen = new Set();
  for (const item of [...getRecentSystemErrors(), ...kvErrors]) {
    if (!item || typeof item !== 'object') continue;
    const key = `${item.ts}|${item.action}|${item.error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  return merged.slice(0, 8);
}

async function getCachedKvPrefixCounts(env) {
  const now = Date.now();
  if (sysinfoKvCache.data && now - sysinfoKvCache.ts < sysinfoKvCache.ttlMs) {
    return sysinfoKvCache.data;
  }
  const prefixes = [
    ['user:', '用户会话'],
    ['thread:', '话题反查'],
    ['banned:', '封禁'],
    ['muted:', '静音'],
    ['profile:', '资料快照'],
    ['note:', '备注'],
    ['chal:', '验证挑战'],
    ['turnstile_code:', 'Turnstile'],
    ['pending_turnstile:', '待转发'],
    ['stats:', '日统计'],
    ['sys:', '系统键'],
  ];
  const rows = [];
  for (const [prefix, label] of prefixes) {
    const c = await countKvPrefix(env, prefix);
    rows.push({ prefix, label, ...(c || { total: 0, truncated: false }) });
  }
  sysinfoKvCache.ts = now;
  sysinfoKvCache.data = rows;
  return rows;
}

/**
 * 构建 sysinfo 某一页正文
 * @param {'overview'|'storage'|'errors'|'stats'|'activity'} page
 * @returns {Promise<{text:string, activity:object|null}>}
 */
async function buildSysinfoPageText(env, page = 'overview') {
  const started = Date.now();
  const hasKv = Boolean(env.TOPIC_MAP && typeof env.TOPIC_MAP.get === 'function');
  const hasD1 = Boolean(env.TG_BOT_DB && typeof env.TG_BOT_DB.prepare === 'function');
  const baseUrl = String(env.VERIFICATION_PAGE_URL || '').replace(/\/$/, '') || '(未配置 VERIFICATION_PAGE_URL)';
  const turnstileOn = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.VERIFICATION_PAGE_URL);
  const lines = [];
  let activity = null;

  if (page === 'overview' || page === 'stats') {
    lines.push(`🖥 <b>系统 · ${page === 'stats' ? '今日统计' : '概览'}</b>`);
    lines.push(`<code>v${GATEWAY_VERSION}</code>`);
    lines.push('────────────────');
    lines.push(`${statusChip(true, 'Worker 运行中')}`);
    lines.push(`${statusChip(hasKv, 'KV 已绑定', 'KV 缺失')} · ${statusChip(hasD1, 'D1 已绑定', 'D1 缺失')}`);
    lines.push(`验证: ${turnstileOn ? '🛡 Turnstile' : '📝 本地题库'} · Owner: ${
      parseIdAllowlist(env.OWNER_IDS).length > 0 ? '已配置' : '未配置'
    }`);
    lines.push(`超级群 ID: ${
      String(env.SUPERGROUP_ID || '').startsWith('-100') ? '✅ 格式正确' : '❌ 需 -100 开头'
    }`);
    lines.push('');

    if (hasD1) {
      try {
        await ensureMigrations(env.TG_BOT_DB);
        const stats = await createD1Storage(env.TG_BOT_DB).getSystemStats();
        lines.push('📊 <b>会话</b>');
        lines.push(`  用户 <b>${stats.usersTotal}</b>  ·  Topic ${stats.usersWithTopic}`);
        lines.push(`  封禁 ${stats.usersBanned}  ·  关闭 ${stats.usersClosed || 0}`);
        lines.push('🗂 <b>数据</b>');
        lines.push(`  映射 ${stats.messageLinks}  ·  规则 ${stats.rulesTotal}`);
        lines.push(`  Update 处理中/可重试  ${stats.updatesProcessing}/${stats.updatesRetryable}`);
        const recent = stats.recentActiveUsers?.length
          ? stats.recentActiveUsers
          : (stats.lastActiveUser ? [stats.lastActiveUser] : []);
        if (recent.length) {
          lines.push('');
          lines.push('<b>最近活跃</b>');
          for (const u of recent.slice(0, 5)) {
            const name = escapeHtml([u.firstName, u.lastName].filter(Boolean).join(' ').trim() || '未知');
            const un = u.username ? `@${escapeHtml(u.username)}` : '无用户名';
            lines.push(`• ${name} · ${un}`);
            lines.push(`  <code>${escapeHtml(u.userId)}</code> · ${formatTimeBoth(u.lastMessageAt)}`);
          }
        } else {
          lines.push('最近活跃: 暂无');
        }
        if (stats.updatesProcessing > 20) {
          lines.push('');
          lines.push('⚠️ Update 处理中数量偏高，请检查 Webhook 是否持续 5xx');
        }
      } catch (e) {
        recordSystemError('sysinfo_d1_failed', e, {}, env);
        lines.push(`D1 读取失败: ${escapeHtml(e?.message || String(e))}`);
      }
    } else {
      lines.push('D1 未绑定，无法显示会话统计');
    }

    // 概览页：轻量告警入口
    if (page === 'overview') {
      try {
        const recentErrs = await collectRecentErrors(env);
        if (recentErrs.length) {
          lines.push('');
          lines.push(`⚠️ 最近错误 <b>${recentErrs.length}</b> 条 · 点下方「错误」分页查看`);
        }
      } catch { /* ignore */ }
    }

    if (page === 'stats') {
      activity = await loadTodayActivity(env);
      const today = activity.today;
      const yday = await getDailyStats(env, opsYesterdayKey());
      const week = await getRecentDailySeries(env, 7);
      const peaks = pickPeakDays(week, 2);
      lines.push('');
      lines.push(`📅 <b>今日</b> <code>${escapeHtml(today.day)}</code> <i>CST UTC+${OPS_TZ_OFFSET_HOURS}</i>`);
      lines.push(formatCompareLine('💬 入站', today.messages_in, yday.messages_in));
      lines.push(formatCompareLine('✅ 验证', today.verifies, yday.verifies));
      lines.push(formatCompareLine('🚫 封禁', today.bans, yday.bans));
      lines.push(formatCompareLine('🛡 垃圾', today.spam, yday.spam));
      lines.push(`  <i>昨 ${escapeHtml(yday.day)}：入站 ${yday.messages_in} · 验证 ${yday.verifies} · 垃圾 ${yday.spam}</i>`);
      if (today.messages_in === 0 && yday.messages_in === 0) {
        lines.push('');
        lines.push(...formatEmptyActivityHints());
      }
      lines.push('');
      lines.push('📈 <b>近 7 日入站</b> <i>CST</i>');
      lines.push(`<code>${formatSparkline(week.map(d => d.messages_in))}</code>`);
      lines.push(week.map(d => {
        const mmdd = d.day.slice(5);
        return `${mmdd}:${d.messages_in}`;
      }).join(' · '));
      lines.push(`峰值日 ${escapeHtml(formatPeakDays(peaks))}`);
      lines.push('');
      lines.push(...formatHeatBlock(activity.summary.hours));
      if (activity.rankingUsers.length) {
        lines.push('');
        lines.push('🏆 <b>今日 Top</b> <i>（完整见 /rank）</i>');
        lines.push(...formatRankingBlock(activity.rankingUsers.slice(0, 3)));
      }
    }

    lines.push('');
    lines.push('🔗 <b>端点</b>');
    lines.push(`<code>${escapeHtml(baseUrl)}/health</code>`);
    lines.push(`<code>…/health/env</code> · <code>…/health/d1</code> · <code>…/verify</code>`);
    lines.push(`Webhook <code>POST ${escapeHtml(baseUrl)}/</code>`);
  }

  if (page === 'activity') {
    activity = await loadTodayActivity(env);
    const unique = activity.summary.uniqueUsers || activity.rankingUsers.length;
    lines.push('🔥 <b>系统 · 今日活跃</b>');
    lines.push(`<code>v${GATEWAY_VERSION}</code> · <code>${escapeHtml(activity.day)}</code> CST`);
    lines.push('────────────────');
    lines.push(`入站样本 <b>${activity.summary.total}</b> · 独立用户 <b>${unique}</b>`);
    lines.push(`数据源: ${escapeHtml(activitySourceLabel(activity.source))}`);
    lines.push('');
    if (activity.summary.total === 0 && !activity.rankingUsers.length) {
      lines.push(...formatEmptyActivityHints());
      lines.push('');
    }
    lines.push(...formatHeatBlock(activity.summary.hours));
    lines.push('');
    lines.push('🏆 <b>活跃排行</b>');
    lines.push(...formatRankingBlock(activity.rankingUsers, {
      withCount: activity.rankingUsers.some(u => u.count != null),
    }));
    lines.push('');
    lines.push('<i>点下方用户按钮打开面板 · 日切与热力均为中国时间 CST</i>');
  }

  if (page === 'storage') {
    lines.push('🗄 <b>系统 · 存储</b>');
    lines.push(`<code>v${GATEWAY_VERSION}</code>`);
    lines.push('────────────────');
    if (hasD1) {
      try {
        const stats = await createD1Storage(env.TG_BOT_DB).getSystemStats();
        lines.push('<b>D1</b>');
        lines.push(`• users: ${stats.usersTotal} (topic ${stats.usersWithTopic})`);
        lines.push(`• banned ${stats.usersBanned} · closed ${stats.usersClosed || 0}`);
        lines.push(`• message_links ${stats.messageLinks} · rules ${stats.rulesTotal}`);
        lines.push(`• processed processing/retryable: ${stats.updatesProcessing}/${stats.updatesRetryable}`);
      } catch (e) {
        lines.push(`D1: ${escapeHtml(e?.message || String(e))}`);
      }
    } else lines.push('D1: 未绑定');
    lines.push('');
    lines.push('<b>KV 前缀</b>');
    if (hasKv) {
      try {
        const rows = await getCachedKvPrefixCounts(env);
        for (const r of rows) {
          lines.push(`• ${r.label} <code>${r.prefix}</code> ${r.total}${r.truncated ? '+' : ''}`);
        }
        lines.push('<i>计数缓存约 45s</i>');
      } catch (e) {
        lines.push(`KV: ${escapeHtml(e?.message || String(e))}`);
      }
    } else lines.push('KV: 未绑定');
  }

  if (page === 'errors') {
    lines.push('⚠️ <b>系统 · 最近错误</b>');
    lines.push(`<code>v${GATEWAY_VERSION}</code>`);
    lines.push('────────────────');
    const top = await collectRecentErrors(env);
    if (!top.length) {
      lines.push('✨ 暂无错误记录');
      lines.push('<i>冷启动后内存缓冲会清空；持续 5xx 时请查 /health 与 CF 日志</i>');
    } else {
      for (const err of top) {
        const act = escapeHtml(err.action || '?');
        const msg = escapeHtml(String(err.error || '').slice(0, 140));
        const uid = err.userId ? ` · uid ${escapeHtml(err.userId)}` : '';
        lines.push(`🔴 <b>${act}</b>${uid}`);
        lines.push(`   ${formatRelativeTime(err.ts)} · ${msg}`);
      }
      lines.push('');
      lines.push('<i>建议：对照 Webhook 是否 5xx、D1/KV 绑定是否正常</i>');
    }
  }

  lines.push('');
  lines.push(`⏱ ${Date.now() - started} ms · 点下方切换分页`);
  let text = lines.join('\n');
  if (text.length > 3500) text = `${text.slice(0, 3500)}\n…`;
  return { text, activity };
}

/**
 * @param {object} env
 * @param {number|undefined} threadId
 * @param {object} [opts]
 * @param {'overview'|'storage'|'errors'|'stats'|'activity'} [opts.page]
 * @param {{chatId:number,messageId:number}|null} [opts.edit]
 */
async function handleSysinfoCommand(env, threadId, opts = {}) {
  const page = opts.page || 'overview';
  const { text, activity } = await buildSysinfoPageText(env, page);
  let markup = buildSysinfoKeyboard(page);
  // 活跃页附加用户跳转按钮（复用同一次 activity，避免二次查库）
  if (page === 'activity' && activity?.rankingUsers?.length) {
    const jump = buildUserJumpKeyboard(activity.rankingUsers, { includeMenu: false });
    markup = {
      inline_keyboard: [
        ...buildSysinfoKeyboard('activity').inline_keyboard,
        ...jump.inline_keyboard,
      ],
    };
  } else if (page === 'stats') {
    // 今日页快捷跳到活跃排行
    const base = buildSysinfoKeyboard('stats').inline_keyboard;
    markup = {
      inline_keyboard: [
        base[0],
        base[1],
        [{ text: '🔥 完整活跃排行', callback_data: 'adm:sys:activity' }],
        base[2],
      ].filter(Boolean),
    };
  }
  if (opts.edit?.chatId && opts.edit?.messageId) {
    const res = await tgCall(env, 'editMessageText', {
      chat_id: opts.edit.chatId,
      message_id: opts.edit.messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: markup,
    });
    if (!res?.ok) {
      await tgCall(env, 'sendMessage', {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: markup,
      });
    }
    return;
  }
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: markup,
  });
}

async function handleStatsCommand(env, threadId) {
  await handleSysinfoCommand(env, threadId, { page: 'stats' });
}

async function handleRankCommand(env, threadId, opts = {}) {
  await handleSysinfoCommand(env, threadId, { page: 'activity', edit: opts.edit || null });
}

/**
 * 备注搜索 /notes [关键词]；无关键词时列出最近备注
 */
async function handleNotesCommand(env, threadId, queryText = '') {
  const q = String(queryText || '')
    .replace(/^\/notes(@\w+)?\s*/i, '')
    .trim();
  if (!env.TOPIC_MAP?.list) {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: '❌ KV 未绑定，无法搜索备注',
    });
    return;
  }

  const needle = q.toLowerCase();
  const matches = [];
  let cursor;
  let pages = 0;
  const maxPages = 12;
  try {
    do {
      const result = await env.TOPIC_MAP.list({ prefix: 'note:', cursor, limit: 100 });
      for (const key of result.keys || []) {
        const userId = String(key.name || '').slice(5);
        if (!userId) continue;
        const note = await env.TOPIC_MAP.get(key.name);
        if (!note) continue;
        const noteStr = String(note);
        if (needle) {
          const hitNote = noteStr.toLowerCase().includes(needle);
          const hitId = userId.includes(needle);
          if (!hitNote && !hitId) continue;
        }
        matches.push({ userId, note: noteStr });
        if (matches.length >= 12) break;
      }
      cursor = result.list_complete ? undefined : result.cursor;
      pages += 1;
    } while (cursor && pages < maxPages && matches.length < 12);
  } catch (e) {
    recordSystemError('notes_search_failed', e, {}, env);
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `❌ 备注搜索失败: ${escapeHtml(e?.message || String(e))}`,
      parse_mode: 'HTML',
    });
    return;
  }

  if (!matches.length) {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: q
        ? `🔎 未找到含「${escapeHtml(q)}」的备注\n\n用法: <code>/notes 关键词</code>\n也可: <code>/find ${escapeHtml(q)}</code> 找用户`
        : '📝 暂无备注。\n在用户话题内用 <code>/note 内容</code> 添加，再用 <code>/notes 关键词</code> 检索。',
      parse_mode: 'HTML',
      reply_markup: buildAdminHomeKeyboard(false),
    });
    return;
  }

  // 补全显示名
  let userMap = new Map();
  if (env.TG_BOT_DB) {
    try {
      await ensureMigrations(env.TG_BOT_DB);
      userMap = await createD1Storage(env.TG_BOT_DB).getUsersByIds(matches.map(m => m.userId));
    } catch { /* ignore */ }
  }

  const truncated = matches.length >= 12 || Boolean(cursor);
  const lines = [
    `🔎 <b>备注搜索</b>${q ? ` · 「${escapeHtml(q)}」` : ' · 最近'}`,
    `共 ${matches.length} 条${truncated ? '（已截断，可加关键词缩小）' : ''}`,
    '────────────────',
  ];
  const jumpUsers = [];
  for (const m of matches) {
    const u = userMap.get(m.userId) || { userId: m.userId };
    jumpUsers.push(u);
    const label = escapeHtml(displayUserLabel(u));
    lines.push(`• ${label} · <code>${escapeHtml(m.userId)}</code>`);
    lines.push(`  📝 ${escapeHtml(m.note.slice(0, 120))}${m.note.length > 120 ? '…' : ''}`);
  }
  lines.push('', '<i>点下方按钮打开用户面板</i>');

  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: buildUserJumpKeyboard(jumpUsers),
  });
}

async function handleWhoamiCommand(env, threadId, senderId) {
  const admin = await isAdminUser(env, senderId);
  const owner = isOwnerUser(env, senderId);
  let member = 'unknown';
  try {
    const res = await tgCall(env, 'getChatMember', {
      chat_id: env.SUPERGROUP_ID,
      user_id: senderId,
    });
    member = res.result?.status || res.description || 'unknown';
  } catch { /* ignore */ }
  const text = [
    '🪪 <b>Whoami</b>',
    `UID: <code>${senderId}</code>`,
    `群身份: <code>${escapeHtml(member)}</code>`,
    `管理指令权限: ${admin ? '✅ 是' : '❌ 否'}`,
    `OWNER_IDS: ${owner ? '✅ 是' : '❌ 否'}`,
  ].join('\n');
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text,
    parse_mode: 'HTML',
    reply_markup: buildAdminHomeKeyboard(owner),
  });
}

async function handleFindCommand(env, threadId, queryText) {
  const q = queryText.replace(/^\/find(@\w+)?\s*/i, '').trim();
  if (!q) {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: '用法: <code>/find UID或用户名或姓名</code>',
      parse_mode: 'HTML',
    });
    return;
  }
  if (!env.TG_BOT_DB) {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: '❌ D1 未绑定，无法搜索',
    });
    return;
  }
  try {
    await ensureMigrations(env.TG_BOT_DB);
    const hits = await createD1Storage(env.TG_BOT_DB).searchUsers(q, 10);
    if (!hits.length) {
      await tgCall(env, 'sendMessage', {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `未找到匹配「${escapeHtml(q)}」的用户\n也可试 <code>/notes ${escapeHtml(q)}</code> 搜备注`,
        parse_mode: 'HTML',
      });
      return;
    }
    const lines = [`🔎 <b>查找结果</b> · ${hits.length} 条`, ''];
    for (const u of hits) {
      const name = escapeHtml([u.firstName, u.lastName].filter(Boolean).join(' ').trim() || '未知');
      const un = u.username ? `@${escapeHtml(u.username)}` : '无用户名';
      lines.push(`• ${name} · ${un}`);
      lines.push(`  UID <code>${escapeHtml(u.userId)}</code> · Topic <code>${escapeHtml(u.topicId || '-')}</code> · ${escapeHtml(u.status || '?')}`);
      lines.push(`  最近: ${formatTimeBoth(u.lastMessageAt)}`);
    }
    lines.push('', '<i>点下方按钮直接打开用户面板</i>');
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: buildUserJumpKeyboard(hits),
    });
  } catch (e) {
    recordSystemError('find_failed', e, {}, env);
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `❌ 搜索失败: ${escapeHtml(e?.message || String(e))}`,
      parse_mode: 'HTML',
    });
  }
}

async function handleSyncCommandsCommand(env, threadId, senderId) {
  if (!isOwnerUser(env, senderId)) {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: '❌ 仅 <code>OWNER_IDS</code> 可同步 Bot 命令菜单',
      parse_mode: 'HTML',
    });
    return;
  }
  // Telegram setMyCommands 建议控制数量；描述需简短
  const commands = [
    { command: 'start', description: '开始对话' },
    { command: 'help', description: '帮助' },
    { command: 'menu', description: '管理菜单' },
    { command: 'sysinfo', description: '系统信息' },
    { command: 'stats', description: '今日统计' },
    { command: 'rank', description: '今日活跃排行' },
    { command: 'panel', description: '用户快捷面板' },
    { command: 'info', description: '用户资料' },
    { command: 'find', description: '查找用户' },
    { command: 'notes', description: '搜索备注' },
    { command: 'note', description: '写/看备注' },
    { command: 'whoami', description: '查看我的权限' },
    { command: 'ban', description: '封禁（需确认）' },
    { command: 'unban', description: '解封用户' },
    { command: 'mute', description: '静音用户' },
    { command: 'unmute', description: '取消静音' },
    { command: 'close', description: '关闭对话' },
    { command: 'open', description: '打开对话' },
    { command: 'listwords', description: '屏蔽词列表' },
    { command: 'cleanup', description: '清理无效话题' },
    { command: 'synccommands', description: '同步命令菜单' },
  ];
  const res = await tgCall(env, 'setMyCommands', { commands });
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: res?.ok
      ? `✅ 已同步 ${commands.length} 条命令到 Bot 菜单`
      : `❌ 同步失败: ${escapeHtml(res?.description || 'unknown')}`,
    parse_mode: 'HTML',
  });
}


async function handleAdminUiCallback(query, env, ctx) {
  const data = String(query.data || '');
  const senderId = query.from?.id;
  try {
    if (!senderId || !(await isAdminUser(env, senderId))) {
      await tgCall(env, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: '无权限',
        show_alert: true,
      });
      return;
    }

    const threadId = query.message?.message_thread_id;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const parts = data.split(':');

    // adm:sys:overview | storage | errors | stats | activity
    if (parts[0] === 'adm' && parts[1] === 'sys') {
      const page = parts[2] || 'overview';
      await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id, text: '已更新' });
      await handleSysinfoCommand(env, threadId, {
        page: ['overview', 'storage', 'errors', 'stats', 'activity'].includes(page) ? page : 'overview',
        edit: chatId && messageId ? { chatId, messageId } : null,
      });
      return;
    }

    // adm:nav:* 全局导航
    if (parts[0] === 'adm' && parts[1] === 'nav') {
      const nav = parts[2];
      if (nav === 'cleanup_ask') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id });
        await tgCall(env, 'sendMessage', {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: threadId,
          text: '🧹 <b>确认清理无效话题？</b>\n将扫描并处理失效 Topic 映射，可能耗时。',
          parse_mode: 'HTML',
          reply_markup: buildCleanupConfirmKeyboard(),
        });
        return;
      }
      if (nav === 'cleanup_ok') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id, text: '开始清理' });
        if (handleCleanupCommand) {
          if (ctx?.waitUntil) ctx.waitUntil(handleCleanupCommand(threadId, env));
          else await handleCleanupCommand(threadId, env);
        }
        return;
      }
      if (nav === 'cleanup_cancel') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id, text: '已取消' });
        if (chatId && messageId) {
          await tgCall(env, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: '已取消清理。',
          });
        }
        return;
      }

      const navHandlers = {
        sysinfo: () => handleSysinfoCommand(env, threadId, { page: 'overview' }),
        stats: () => handleStatsCommand(env, threadId),
        rank: () => handleRankCommand(env, threadId),
        activity: () => handleRankCommand(env, threadId),
        notes: () => handleNotesCommand(env, threadId, '/notes'),
        find: async () => {
          await tgCall(env, 'sendMessage', {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: [
              '🔍 <b>查找用户</b>',
              '用法: <code>/find UID或用户名或姓名</code>',
              '备注: <code>/notes 关键词</code>',
              '活跃: <code>/rank</code>',
            ].join('\n'),
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔎 备注列表', callback_data: 'adm:nav:notes' },
                { text: '🔥 活跃', callback_data: 'adm:nav:rank' },
                { text: '🏠 菜单', callback_data: 'adm:nav:menu' },
              ]],
            },
          });
        },
        whoami: () => handleWhoamiCommand(env, threadId, senderId),
        listwords: () => {
          if (typeof handleListWordsCommand === 'function') {
            return handleListWordsCommand(env, threadId);
          }
          return tgCall(env, 'sendMessage', {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: '请使用命令 <code>/listwords</code>',
            parse_mode: 'HTML',
          });
        },
        help: () => handleHelpCommand(env, threadId, senderId),
        menu: () => handleMenuCommand(env, threadId, senderId),
        synccommands: () => handleSyncCommandsCommand(env, threadId, senderId),
      };
      const navFn = navHandlers[nav];
      if (!navFn) {
        await tgCall(env, 'answerCallbackQuery', {
          callback_query_id: query.id,
          text: '未知导航',
          show_alert: true,
        });
        return;
      }
      await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id });
      await navFn();
      return;
    }

    // adm:u:action:userId
    if (parts[0] === 'adm' && parts[1] === 'u' && parts.length >= 4) {
      const action = parts[2];
      const userId = parts[3];
      if (!/^\d{1,20}$/.test(String(userId))) {
        await tgCall(env, 'answerCallbackQuery', {
          callback_query_id: query.id,
          text: '无效用户 ID',
          show_alert: true,
        });
        return;
      }
      const tid = (await resolveThreadIdForUser(env, userId)) || threadId;
      if (!tid) {
        await tgCall(env, 'answerCallbackQuery', {
          callback_query_id: query.id,
          text: '找不到用户话题',
          show_alert: true,
        });
        return;
      }

      // 危险操作二次确认
      if (action === 'banask') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id });
        await tgCall(env, 'sendMessage', {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: tid,
          text: `⚠️ <b>确认封禁用户</b> <code>${escapeHtml(userId)}</code>？\n对方将收到通知且无法继续发消息。`,
          parse_mode: 'HTML',
          reply_markup: buildBanConfirmKeyboard(userId),
        });
        return;
      }
      if (action === 'bancancel') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id, text: '已取消' });
        if (chatId && messageId) {
          await tgCall(env, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: '已取消封禁。',
          });
        }
        return;
      }
      if (action === 'closeask') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id });
        await tgCall(env, 'sendMessage', {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: tid,
          text: `⚠️ <b>确认关闭对话</b> <code>${escapeHtml(userId)}</code>？\n将关闭 Forum Topic，用户消息不再接入（可用打开恢复）。`,
          parse_mode: 'HTML',
          reply_markup: buildCloseConfirmKeyboard(userId),
        });
        return;
      }
      if (action === 'closecancel') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id, text: '已取消' });
        if (chatId && messageId) {
          await tgCall(env, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: '已取消关闭对话。',
          });
        }
        return;
      }
      if (action === 'resetask') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id });
        await tgCall(env, 'sendMessage', {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: tid,
          text: `⚠️ <b>确认重置验证</b> <code>${escapeHtml(userId)}</code>？\n将取消永久信任，用户下次需重新验证。`,
          parse_mode: 'HTML',
          reply_markup: buildResetConfirmKeyboard(userId),
        });
        return;
      }
      if (action === 'resetcancel') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id, text: '已取消' });
        if (chatId && messageId) {
          await tgCall(env, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: '已取消重置验证。',
          });
        }
        return;
      }
      if (action === 'shownote') {
        await tgCall(env, 'answerCallbackQuery', { callback_query_id: query.id });
        await userActions.note?.(env, tid, userId, '/note');
        return;
      }

      const map = {
        ban: () => userActions.ban?.(env, tid, userId),
        banok: () => userActions.ban?.(env, tid, userId),
        unban: () => userActions.unban?.(env, tid, userId),
        close: () => userActions.close?.(env, tid, userId),
        closeok: () => userActions.close?.(env, tid, userId),
        open: () => userActions.open?.(env, tid, userId),
        trust: () => userActions.trust?.(env, tid, userId),
        reset: () => userActions.reset?.(env, tid, userId),
        resetok: () => userActions.reset?.(env, tid, userId),
        mute: () => userActions.mute?.(env, tid, userId),
        unmute: () => userActions.unmute?.(env, tid, userId),
        info: () => userActions.info?.(env, tid, userId),
        panel: () => userActions.panel?.(env, tid, userId),
      };
      const fn = map[action];
      if (!fn) {
        await tgCall(env, 'answerCallbackQuery', {
          callback_query_id: query.id,
          text: '未知操作',
          show_alert: true,
        });
        return;
      }
      // 先应答再执行，避免 Telegram 转圈；文案不预告成功结果
      const busyText = action === 'banok' || action === 'ban' ? '正在封禁…'
        : action === 'closeok' || action === 'close' ? '正在关闭…'
          : action === 'resetok' || action === 'reset' ? '正在重置…'
            : '处理中…';
      await tgCall(env, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: busyText,
      });
      await fn();
      // 状态变更后刷一次面板，方便管理员立刻看到最新状态
      const refreshPanel = [
        'banok', 'ban', 'unban',
        'closeok', 'close', 'open',
        'mute', 'unmute',
        'trust', 'resetok', 'reset',
      ].includes(action);
      if (refreshPanel && typeof userActions.panel === 'function') {
        try {
          await userActions.panel(env, tid, userId);
        } catch { /* 面板刷新失败不影响主操作 */ }
      }
      return;
    }

    await tgCall(env, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: '未知回调',
      show_alert: true,
    });
  } catch (e) {
    recordSystemError('admin_ui_callback_failed', e, { data }, env);
    try {
      await tgCall(env, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: '操作失败，请重试',
        show_alert: true,
      });
    } catch { /* 可能已 answer */ }
  }
}

  return {
    bumpDailyStat,
    getDailyStats,
    getRecentDailySeries,
    loadTodayActivity,
    handleHelpCommand,
    handleMenuCommand,
    handleSysinfoCommand,
    handleStatsCommand,
    handleRankCommand,
    handleNotesCommand,
    handleWhoamiCommand,
    handleFindCommand,
    handleSyncCommandsCommand,
    handleAdminUiCallback,
  };
}
