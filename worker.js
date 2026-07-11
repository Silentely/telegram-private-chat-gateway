import { createApp } from './src/app.js';
import { createAdminService } from './src/admin-service.js';
import {
  createConversationService,
  hashContent,
  snapshotMessage,
} from './src/conversation-service.js';
import { createLogger } from './src/logger.js';
import { evaluateMessagePolicy } from './src/message-policy.js';
import { createTelegramClient, TelegramApiError } from './src/telegram-client.js';
import { createD1Storage } from './src/storage/d1-storage.js';
import { ensureMigrations } from './src/storage/migrations.js';
import { createEphemeralStore } from './src/storage/kv-ephemeral-store.js';
import { createKVStorage } from './src/storage/kv-storage.js';
import { createUpdateHandler } from './src/update-router.js';
import {
  OPS_TZ_OFFSET_HOURS,
  opsDayKey,
  opsYesterdayKey,
  opsDayStartMs,
  summarizeInboundActivity,
  formatSparkline,
  activitySourceLabel,
} from './src/activity-summary.js';
import {
  escapeHtml,
  formatSysTime,
  formatRelativeTime,
  formatTimeBoth,
  statusChip,
  buildUserActionKeyboard,
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
} from './src/admin-ui-format.js';
import { createAdminCommandHandlers } from './src/admin-commands.js';
import { VERIFY_COPY } from './src/verify-copy.js';

// Telegram Private Chat Gateway — Cloudflare Workers 私聊安全接入与双向会话网关

// --- 纯函数工具（内联自 src/utils.js，便于单文件部署到 Cloudflare Workers） ---

/**
 * 检测消息文本中是否包含 URL/链接
 */
function containsLink(text) {
  if (!text) return false;
  const patterns = [
    /https?:\/\/\S+/i,
    /[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(\/\S*)?/,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i,
  ];
  return patterns.some(p => p.test(text));
}

/**
 * 构建反垃圾检测文本：消息正文 + 发送者资料
 */
function buildSpamCheckText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const from = msg.from || {};
  return [
    msg.text,
    msg.caption,
    from.first_name,
    from.last_name,
    from.username,
  ]
    .filter(v => typeof v === 'string' && v.trim().length > 0)
    .join(' ');
}

/**
 * 检测消息是否包含垃圾关键词
 */
function detectSpamKeywords(text, keywords) {
  if (!text || keywords.length === 0) return { isSpam: false, matchedWord: null };
  const lower = text.toLowerCase();
  for (const word of keywords) {
    if (lower.includes(word)) return { isSpam: true, matchedWord: word };
  }
  return { isSpam: false, matchedWord: null };
}

/**
 * 计算消息内容的简单哈希（用于重复检测）
 */
function computeMessageHash(msg) {
  const text = (msg.text || msg.caption || '').trim().toLowerCase();
  if (!text) return null;
  const fingerprint = `${text.length}|${text.substring(0, 100)}|${text.substring(Math.max(0, text.length - 20))}`;
  return fingerprint;
}

/**
 * 标准化 Telegram API 描述字符串
 */
function normalizeTgDescription(description) {
  return (description || "").toString().toLowerCase();
}

/**
 * 判断话题是否不存在或已被删除
 */
function isTopicMissingOrDeleted(description) {
  const desc = normalizeTgDescription(description);
  return desc.includes("thread not found") ||
    desc.includes("topic not found") ||
    desc.includes("message thread not found") ||
    desc.includes("topic deleted") ||
    desc.includes("thread deleted") ||
    desc.includes("forum topic not found") ||
    desc.includes("topic closed permanently");
}

/**
 * 判断探测消息是否因内容为空而失败
 */
function isTestMessageInvalid(description) {
  const desc = normalizeTgDescription(description);
  return desc.includes("message text is empty") ||
    desc.includes("bad request: message text is empty");
}

/**
 * 为请求 body 添加 message_thread_id 字段
 */
function withMessageThreadId(body, threadId) {
  if (threadId === undefined || threadId === null) return body;
  return { ...body, message_thread_id: threadId };
}

/**
 * 将 SPAM_KEYWORDS 环境变量解析为关键词数组
 */
function parseSpamKeywords(raw) {
  if (!raw) return [];
  return raw.toString().trim()
    .split(/[,;，；\n]+/g)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
}

/**
 * 生成安全的验证 code（16 字节十六进制）
 */
function generateVerifyCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- 配置常量 ---
const CONFIG = {
  VERIFY_ID_LENGTH: 12,
  VERIFY_EXPIRE_SECONDS: 300, // 5分钟
  VERIFIED_EXPIRE_SECONDS: 2592000, // 30天
  MEDIA_GROUP_EXPIRE_SECONDS: 60,
  MEDIA_GROUP_DELAY_MS: 3000, // 3秒（从2秒增加）
  PENDING_MAX_MESSAGES: 10, // 验证期间最多暂存的消息数
  ADMIN_CACHE_TTL_SECONDS: 300, // 管理员权限缓存 5 分钟
  NEEDS_REVERIFY_TTL_SECONDS: 600, // 标记需重新验证的 TTL（用于并发兜底）
  RATE_LIMIT_MESSAGE: 45,
  RATE_LIMIT_VERIFY: 3,
  RATE_LIMIT_WINDOW: 60,
  BUTTON_COLUMNS: 2,
  MAX_TITLE_LENGTH: 128,
  MAX_NAME_LENGTH: 30,
  API_TIMEOUT_MS: 10000,
  CLEANUP_BATCH_SIZE: 10,
  MAX_CLEANUP_DISPLAY: 20,
  CLEANUP_LOCK_TTL_SECONDS: 1800, // /cleanup 防并发锁 30 分钟
  MAX_RETRY_ATTEMPTS: 3,
  THREAD_HEALTH_TTL_MS: 60000,
  // PR #12: Turnstile 和垃圾检测配置
  TURNSTILE_VERIFY_TTL: 600,            // Turnstile 验证 code 有效期 10 分钟
  NEW_USER_LINK_BLOCK_SECONDS: 86400,   // 新用户 24 小时内禁止发链接
  SPAM_MESSAGE_HASH_TTL: 3600,          // 消息去重 hash 缓存 1 小时
  SPAM_REPEAT_MESSAGE_LIMIT: 3,         // 相同内容重复次数阈值
  SPAM_NOTIFY_ADMIN: true,              // 是否通知管理员有骚扰消息
  SPAM_SILENCE_MODE: false              // 静默丢弃模式（不通知管理员）
};

/** 网关版本（展示于 /sysinfo） */
const GATEWAY_VERSION = '1.0.0';

// 线程健康检查缓存，减少频繁探测请求
const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();
// PR #12: 垃圾关键词集合（延迟初始化）
let spamKeywordsCache = null;
// PR #12: 消息哈希去重缓存（用于检测重复骚扰消息）
const messageHashCache = new Map();
// thread 映射缺失时的负缓存（避免重复全量扫描已知不存在的话题）
const threadNotFoundCache = new Map();
const ruleCache = new WeakMap();
const THREAD_NOT_FOUND_TTL_MS = 5 * 60 * 1000;
const THREAD_NOT_FOUND_MAX_ENTRIES = 1000;
const ADMIN_STATUS_MAX_ENTRIES = 1000;
const THREAD_HEALTH_MAX_ENTRIES = 1000;
const MESSAGE_HASH_MAX_ENTRIES = 5000;

function setBoundedCache(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

// --- 本地题库 (15条) ---
const LOCAL_QUESTIONS = [
  {"question": "冰融化后会变成什么？", "correct_answer": "水", "incorrect_answers": ["石头", "木头", "火"]},
  {"question": "正常人有几只眼睛？", "correct_answer": "2", "incorrect_answers": ["1", "3", "4"]},
  {"question": "以下哪个属于水果？", "correct_answer": "香蕉", "incorrect_answers": ["白菜", "猪肉", "大米"]},
  {"question": "1 加 2 等于几？", "correct_answer": "3", "incorrect_answers": ["2", "4", "5"]},
  {"question": "5 减 2 等于几？", "correct_answer": "3", "incorrect_answers": ["1", "2", "4"]},
  {"question": "2 乘以 3 等于几？", "correct_answer": "6", "incorrect_answers": ["4", "5", "7"]},
  {"question": "10 加 5 等于几？", "correct_answer": "15", "incorrect_answers": ["10", "12", "20"]},
  {"question": "8 减 4 等于几？", "correct_answer": "4", "incorrect_answers": ["2", "3", "5"]},
  {"question": "在天上飞的交通工具是什么？", "correct_answer": "飞机", "incorrect_answers": ["汽车", "轮船", "自行车"]},
  {"question": "星期一的后面是星期几？", "correct_answer": "星期二", "incorrect_answers": ["星期日", "星期五", "星期三"]},
  {"question": "鱼通常生活在哪里？", "correct_answer": "水里", "incorrect_answers": ["树上", "土里", "火里"]},
  {"question": "我们用什么器官来听声音？", "correct_answer": "耳朵", "incorrect_answers": ["眼睛", "鼻子", "嘴巴"]},
  {"question": "晴朗的天空通常是什么颜色的？", "correct_answer": "蓝色", "incorrect_answers": ["绿色", "红色", "紫色"]},
  {"question": "太阳从哪个方向升起？", "correct_answer": "东方", "incorrect_answers": ["西方", "南方", "北方"]},
  {"question": "小狗发出的叫声通常是？", "correct_answer": "汪汪", "incorrect_answers": ["喵喵", "咩咩", "呱呱"]}
];

// --- PR #11: 屏蔽词列表（硬编码，用户可自行修改此数组） ---
const BLOCKED_WORDS = [
  "赌博",
  "色情",
  "代开发",
  "加微信",
  // ↑ 在此添加更多屏蔽词，每行一个，用引号包裹、逗号结尾
];

// 屏蔽词内存缓存（减少 KV 读取频率）
const blockedWordsCache = { data: null, ts: 0, ttl: 60000 }; // 缓存 60 秒

/**
 * 获取完整屏蔽词列表 = 硬编码 + KV 动态词库（合并去重）
 * @param {object} env - Worker 环境
 * @param {boolean} forceRefresh - 是否强制刷新缓存
 * @returns {Promise<string[]>}
 */
async function getBlockedWords(env, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && blockedWordsCache.data && (now - blockedWordsCache.ts < blockedWordsCache.ttl)) {
    return blockedWordsCache.data;
  }

  // 从 KV 读取动态屏蔽词
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        kvWords = parsed.filter(w => typeof w === "string" && w.trim().length > 0);
      }
    }
  } catch (e) {
    Logger.warn('blocked_words_kv_parse_error', { error: e.message });
  }

  // 合并去重（硬编码优先，KV 补充）
  const merged = [...new Set([...BLOCKED_WORDS, ...kvWords])];
  blockedWordsCache.data = merged;
  blockedWordsCache.ts = now;
  return merged;
}


// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = createLogger();

// 进程内最近错误环形缓冲（isolate 生命周期内有效；并尽力写入 KV）
const RECENT_SYSTEM_ERRORS_MAX = 12;
const recentSystemErrors = [];

function recordSystemError(action, error, data = {}, env = null) {
  const entry = {
    ts: Date.now(),
    action: String(action || 'unknown'),
    error: error instanceof Error ? error.message : String(error ?? ''),
    userId: data?.userId != null ? String(data.userId) : undefined,
  };
  recentSystemErrors.unshift(entry);
  if (recentSystemErrors.length > RECENT_SYSTEM_ERRORS_MAX) {
    recentSystemErrors.length = RECENT_SYSTEM_ERRORS_MAX;
  }
  if (env?.TOPIC_MAP) {
    Promise.resolve()
      .then(async () => {
        let list = [];
        try {
          const raw = await env.TOPIC_MAP.get('sys:recent_errors');
          if (raw) list = JSON.parse(raw);
        } catch { list = []; }
        if (!Array.isArray(list)) list = [];
        list.unshift(entry);
        await env.TOPIC_MAP.put(
          'sys:recent_errors',
          JSON.stringify(list.slice(0, RECENT_SYSTEM_ERRORS_MAX)),
          { expirationTtl: 7 * 24 * 3600 },
        );
      })
      .catch(() => {});
  }
}

const _loggerError = Logger.error.bind(Logger);
Logger.error = (action, error, data = {}) => {
  try {
    recordSystemError(action, error, data, data?.env || null);
  } catch { /* 忽略环形缓冲失败 */ }
  return _loggerError(action, error, data);
};

function ephemeralStore(env) {
  return createEphemeralStore(env.TOPIC_MAP);
}

async function getVerificationState(env, userId) {
  const temporary = await ephemeralStore(env).getVerification(userId);
  if (temporary?.type === 'temporary') return temporary;

  const persistent = env.TG_BOT_DB
    ? await createD1Storage(env.TG_BOT_DB).getUser(userId)
    : null;
  if (persistent?.trustLevel === 'trusted') return { type: 'trusted' };

  if (temporary?.type === 'legacy_trusted' && env.TG_BOT_DB) {
    await setPersistentTrust(env, userId, 'trusted');
    return { type: 'trusted' };
  }
  return temporary;
}

async function getStoredRules(env) {
  if (!env.TG_BOT_DB) return [];
  const cached = ruleCache.get(env.TG_BOT_DB);
  const now = Date.now();
  if (cached && now - cached.ts < 30000) return cached.rules;
  const rules = await createD1Storage(env.TG_BOT_DB).listEnabledRules();
  ruleCache.set(env.TG_BOT_DB, { ts: now, rules });
  return rules;
}

async function evaluateLegacyPolicy(env, message, user = {}) {
  const [blockedWords, verification, storedRules] = await Promise.all([
    getBlockedWords(env),
    getVerificationState(env, user.userId ?? message.chat?.id),
    getStoredRules(env),
  ]);
  const rules = blockedWords.filter(Boolean).map((pattern, index) => ({
    ruleId: `legacy_blocked:${index}`,
    ruleType: 'blocked_keyword',
    matchType: 'contains',
    pattern,
    action: 'reject',
    priority: index,
  }));
  return evaluateMessagePolicy({
    message,
    user: {
      ...user,
      status: user.status || 'active',
      trustLevel: user.trustLevel || (verification?.type === 'trusted' ? 'trusted' : 'normal'),
    },
    verification,
    rules: [...rules, ...storedRules],
  });
}

function createLegacyConversationService(env) {
  return createConversationService({
    storage: createD1Storage(env.TG_BOT_DB),
    telegram: { call: (method, body) => tgCall(env, method, body) },
    policy: ({ message, user }) => evaluateLegacyPolicy(env, message, user),
    logger: Logger,
    supergroupId: env.SUPERGROUP_ID,
  });
}

/** 解析逗号/空白分隔的 Telegram 用户 ID 列表为字符串数组 */
function parseIdAllowlist(raw) {
  return String(raw || '')
    .split(/[,;\s]+/g)
    .map(value => value.trim())
    .filter(value => /^\d{1,20}$/.test(value));
}

function idAllowlistHas(raw, userId) {
  return parseIdAllowlist(raw).includes(String(userId));
}

function createLegacyAdminService(env) {
  return createAdminService({
    storage: createD1Storage(env.TG_BOT_DB),
    ephemeralStore: ephemeralStore(env),
    telegram: { call: (method, body) => tgCall(env, method, body) },
    ownerIds: parseIdAllowlist(env.OWNER_IDS),
    onRulesChanged: () => ruleCache.delete(env.TG_BOT_DB),
  });
}

async function setPersistentTrust(env, userId, trustLevel) {
  if (!env.TG_BOT_DB) throw new Error("D1 'TG_BOT_DB' not bound");
  const d1Storage = createD1Storage(env.TG_BOT_DB);
  const existing = await d1Storage.getUser(userId)
    || await createKVStorage(env.TOPIC_MAP).getUser(userId)
    || { userId: String(userId) };
  await d1Storage.upsertUser({ ...existing, userId: String(userId), trustLevel });
  await ephemeralStore(env).clearVerification(userId);
}

async function saveLegacyMessageLink(env, link) {
  if (!env.TG_BOT_DB || link.targetMessageId == null) return;
  const contentSnapshot = snapshotMessage(link.message);
  await createD1Storage(env.TG_BOT_DB).saveMessageLink({
    direction: link.direction,
    sourceChatId: link.message.chat.id,
    sourceMessageId: link.message.message_id,
    targetChatId: link.targetChatId,
    targetMessageId: link.targetMessageId,
    topicId: link.topicId,
    userId: link.userId,
    contentSnapshot,
    contentHash: hashContent(contentSnapshot),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

// 加密安全的随机数生成
function secureRandomInt(min, max) {
  const range = max - min;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return min + (bytes[0] % range);
}

function secureRandomId(length = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 安全的 JSON 获取
async function safeGetJSON(env, key, defaultValue = null) {
  try {
    const data = await env.TOPIC_MAP.get(key, { type: "json" });
    if (data === null || data === undefined) {
      return defaultValue;
    }
    if (typeof data !== 'object') {
      Logger.warn('kv_invalid_type', { key, type: typeof data });
      return defaultValue;
    }
    return data;
  } catch (e) {
    Logger.error('kv_parse_failed', e, { key });
    return defaultValue;
  }
}

/**
 * 判断 Telegram from 是否缺少可用于话题标题的资料字段。
 */
function isSparseTelegramFrom(from) {
  if (!from || typeof from !== 'object') return true;
  const hasName = Boolean(String(from.first_name || '').trim() || String(from.last_name || '').trim());
  const hasUsername = Boolean(String(from.username || '').trim());
  return !hasName && !hasUsername;
}

/**
 * 缓存用户资料，供 Turnstile 验证回放等缺少 from 的路径建话题时使用。
 */
async function saveUserProfileSnapshot(env, userId, from) {
  if (!env?.TOPIC_MAP || !userId || isSparseTelegramFrom(from)) return;
  try {
    await env.TOPIC_MAP.put(`profile:${userId}`, JSON.stringify({
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      username: from.username || null,
      saved_at: Date.now(),
    }), { expirationTtl: 30 * 24 * 3600 });
  } catch (e) {
    Logger.warn('profile_snapshot_save_failed', { userId, error: e?.message });
  }
}

/**
 * 解析建话题用的 from：优先消息 from，其次 KV 快照、D1、Telegram getChat。
 * 修复 Turnstile 验证通过后 fakeMsg 仅含 id 导致标题变成「User」的问题。
 */
async function resolveUserFromForTopic(env, userId, from) {
  if (!isSparseTelegramFrom(from)) {
    return {
      id: Number(from.id ?? userId),
      first_name: from.first_name || '',
      last_name: from.last_name || '',
      username: from.username || '',
    };
  }

  try {
    const raw = await env.TOPIC_MAP?.get(`profile:${userId}`);
    if (raw) {
      const snap = JSON.parse(raw);
      if (!isSparseTelegramFrom(snap)) {
        return {
          id: Number(userId),
          first_name: snap.first_name || '',
          last_name: snap.last_name || '',
          username: snap.username || '',
        };
      }
    }
  } catch { /* 忽略坏快照 */ }

  if (env.TG_BOT_DB) {
    try {
      const user = await createD1Storage(env.TG_BOT_DB).getUser(userId);
      if (user && (user.firstName || user.lastName || user.username)) {
        return {
          id: Number(userId),
          first_name: user.firstName || '',
          last_name: user.lastName || '',
          username: user.username || '',
        };
      }
    } catch { /* 忽略 D1 读取失败 */ }
  }

  try {
    const res = await tgCall(env, 'getChat', { chat_id: userId });
    if (res?.ok && res.result) {
      const chat = res.result;
      const resolved = {
        id: Number(userId),
        first_name: chat.first_name || '',
        last_name: chat.last_name || '',
        username: chat.username || '',
      };
      if (!isSparseTelegramFrom(resolved)) {
        await saveUserProfileSnapshot(env, userId, resolved);
        return resolved;
      }
    }
  } catch { /* 忽略 getChat 失败 */ }

  return {
    id: Number(from?.id ?? userId),
    first_name: from?.first_name || '',
    last_name: from?.last_name || '',
    username: from?.username || '',
  };
}

async function getOrCreateUserTopicRec(from, key, env, userId) {
  const existing = await safeGetJSON(env, key, null);
  if (existing && existing.thread_id) return existing;

  const inflight = topicCreateInFlight.get(String(userId));
  if (inflight) return await inflight;

  const p = (async () => {
    // 并发下二次确认，避免已被其他请求创建却读到旧值
    const again = await safeGetJSON(env, key, null);
    if (again && again.thread_id) return again;

    // 补全资料，避免标题退化为 "User"
    const resolvedFrom = await resolveUserFromForTopic(env, userId, from);
    await saveUserProfileSnapshot(env, userId, resolvedFrom);

    const storage = createD1Storage(env.TG_BOT_DB);
    let user = await storage.getUser(userId);
    if (!user) {
      user = await storage.ensureUser({
        userId: String(userId),
        username: resolvedFrom?.username || null,
        firstName: resolvedFrom?.first_name || null,
        lastName: resolvedFrom?.last_name || null,
      });
    } else if (
      isSparseTelegramFrom({
        first_name: user.firstName,
        last_name: user.lastName,
        username: user.username,
      }) && !isSparseTelegramFrom(resolvedFrom)
    ) {
      try {
        await storage.updateUserState(userId, {
          username: resolvedFrom.username || null,
          firstName: resolvedFrom.first_name || null,
          lastName: resolvedFrom.last_name || null,
        });
      } catch { /* 资料回填失败不阻塞建话题 */ }
    }
    if (user?.topicId) {
      const rec = { thread_id: user.topicId, title: buildTopicTitle(resolvedFrom), closed: false };
      await env.TOPIC_MAP.put(key, JSON.stringify(rec));
      await env.TOPIC_MAP.put(`thread:${user.topicId}`, String(userId));
      return rec;
    }

    const token = secureRandomId(20);
    const acquired = await storage.acquireTopicLock(userId, token, Date.now(), 30000);
    if (acquired) {
      try {
        const rec = await createTopic(resolvedFrom, key, env, userId);
        const saved = await storage.setTopic(userId, rec.thread_id, token, Date.now());
        if (!saved) throw new Error("Topic 锁所有权已丢失");
        return rec;
      } finally {
        await storage.releaseTopicLock(userId, token, Date.now());
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 150 + attempt * 75));
      const refreshed = await storage.getUser(userId);
      if (refreshed?.topicId) {
        const rec = { thread_id: refreshed.topicId, title: buildTopicTitle(resolvedFrom), closed: false };
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await env.TOPIC_MAP.put(`thread:${refreshed.topicId}`, String(userId));
        return rec;
      }
    }
    throw Object.assign(new Error("Topic 创建锁繁忙"), {
      category: 'topic_lock_busy',
      retryable: true,
    });
  })();

  topicCreateInFlight.set(String(userId), p);
  try {
    return await p;
  } finally {
    if (topicCreateInFlight.get(String(userId)) === p) {
      topicCreateInFlight.delete(String(userId));
    }
  }
}


async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
  const attemptOnce = async () => {
    const res = await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: expectedThreadId,
      text: "🔎"
    });

    const actualThreadId = res.result?.message_thread_id;
    const probeMessageId = res.result?.message_id;

    // 尽可能清理探测消息（无论落到哪个话题/General）
    if (res.ok && probeMessageId) {
      try {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: probeMessageId
        });
      } catch (e) {
        // 删除失败不影响主流程
      }
    }

    if (!res.ok) {
      if (isTopicMissingOrDeleted(res.description)) {
        return { status: "missing", description: res.description };
      }
      if (isTestMessageInvalid(res.description)) {
        return { status: "probe_invalid", description: res.description };
      }
      return { status: "unknown_error", description: res.description };
    }

    // 关键：有些情况下 Telegram 会返回 ok 但不带 message_thread_id（常见于 General）
    if (actualThreadId === undefined || actualThreadId === null) {
      return { status: "missing_thread_id" };
    }

    if (Number(actualThreadId) !== Number(expectedThreadId)) {
      return { status: "redirected", actualThreadId };
    }

    return { status: "ok" };
  };

  const first = await attemptOnce();
  if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

  // 二次探测：避免偶发字段缺失导致误判并触发重建
  const second = await attemptOnce();
  if (second.status === "missing_thread_id") {
    Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
  }
  return second;
}

async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason }) {
  // 清理旧映射与验证状态：用户需要重新做人机验证
  await setPersistentTrust(env, userId, 'normal');
  await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
  await env.TOPIC_MAP.delete(`retry:${userId}`);

  if (userKey) {
    await env.TOPIC_MAP.delete(userKey);
  }

  if (oldThreadId !== undefined && oldThreadId !== null) {
    await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
    await ephemeralStore(env).clearTopicHealth(oldThreadId);
    threadHealthCache.delete(oldThreadId);
  }

  Logger.info('verification_reset_due_to_topic_loss', {
    userId,
    oldThreadId,
    pendingMsgId,
    reason
  });

  await sendVerificationChallenge(userId, env, pendingMsgId || null);
}

function parseAdminIdAllowlist(env) {
  const set = new Set(parseIdAllowlist(env.ADMIN_IDS));
  return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId) {
  // OWNER_IDS 为网关所有者，应始终可执行管理指令（即使未点群管理）
  if (idAllowlistHas(env.OWNER_IDS, userId)) return true;

  const allowlist = parseAdminIdAllowlist(env);
  if (allowlist && allowlist.has(String(userId))) return true;

  const cacheKey = String(userId);
  const now = Date.now();
  const cached = adminStatusCache.get(cacheKey);
  if (cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) {
    return cached.isAdmin;
  }

  const kvVal = await ephemeralStore(env).getAdminCache(userId);
  if (kvVal !== null) {
    const isAdmin = kvVal;
    setBoundedCache(adminStatusCache, cacheKey, { ts: now, isAdmin }, ADMIN_STATUS_MAX_ENTRIES);
    return isAdmin;
  }

  try {
    const res = await tgCall(env, "getChatMember", {
      chat_id: env.SUPERGROUP_ID,
      user_id: userId
    });

    const status = res.result?.status;
    const isAdmin = res.ok && (status === "creator" || status === "administrator");
    await ephemeralStore(env).setAdminCache(userId, isAdmin, CONFIG.ADMIN_CACHE_TTL_SECONDS);
    setBoundedCache(adminStatusCache, cacheKey, { ts: now, isAdmin }, ADMIN_STATUS_MAX_ENTRIES);
    return isAdmin;
  } catch (e) {
    Logger.warn('admin_check_failed', { userId });
    return false;
  }
}

// 获取所有 KV keys（处理分页）
async function getAllKeys(env, prefix) {
  const allKeys = [];
  let cursor = undefined;

  do {
    const result = await env.TOPIC_MAP.list({ prefix, cursor });
    allKeys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return allKeys;
}

// Fisher-Yates 洗牌算法
function shuffleArray(arr) {
  const array = [...arr];
  for (let i = array.length - 1; i > 0; i--) {
    const j = secureRandomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// 速率限制检查
async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
  return ephemeralStore(env).checkRateLimit(userId, action, limit, window);
}

// --- PR #12: Turnstile 人机验证模块 ---

/**
 * 调用 Cloudflare Turnstile API 验证 token
 * @param {string} token - Turnstile 前端生成的 token
 * @param {string} secretKey - Turnstile secret key
 * @param {string} remoteIp - 用户 IP（可选）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function verifyTurnstileToken(token, secretKey, remoteIp) {
  const formData = new URLSearchParams();
  formData.append('secret', secretKey);
  formData.append('response', token);
  if (remoteIp) {
    formData.append('remoteip', remoteIp);
  }

  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });
    const result = await resp.json();
    return { success: result.success === true, error: result['error-codes']?.join(', ') };
  } catch (e) {
    Logger.error('turnstile_verify_error', e);
    return { success: false, error: e.message };
  }
}

// --- PR #12: 垃圾内容检测模块 ---

/**
 * 加载/解析垃圾关键词列表
 * @param {object} env - 环境变量
 * @returns {string[]} 关键词数组
 */
function getSpamKeywords(env) {
  if (spamKeywordsCache) return spamKeywordsCache;

  const raw = (env.SPAM_KEYWORDS || '').toString().trim();
  spamKeywordsCache = parseSpamKeywords(raw);

  if (spamKeywordsCache.length > 0) {
    Logger.info('spam_keywords_loaded', { count: spamKeywordsCache.length });
  }
  return spamKeywordsCache;
}

/**
 * 检测用户是否在短时间内重复发送相同内容
 * @param {number} userId - 用户 ID
 * @param {object} msg - Telegram message object
 * @returns {Promise<{isRepeat: boolean, count: number}>}
 */
async function detectRepeatMessage(userId, msg) {
  const hash = computeMessageHash(msg);
  if (!hash) return { isRepeat: false, count: 0 };

  const cacheKey = `msghash:${userId}:${hash}`;
  const now = Date.now();
  const cached = messageHashCache.get(cacheKey);

  // TTL 驱逐：过期条目视为首次出现
  if (cached && (now - cached.ts > CONFIG.SPAM_MESSAGE_HASH_TTL * 1000)) {
    messageHashCache.delete(cacheKey);
    const count = 1;
    setBoundedCache(messageHashCache, cacheKey, { count, ts: now }, MESSAGE_HASH_MAX_ENTRIES);
    return { isRepeat: false, count };
  }

  const count = (cached?.count || 0) + 1;
  setBoundedCache(messageHashCache, cacheKey, { count, ts: now }, MESSAGE_HASH_MAX_ENTRIES);

  if (count >= CONFIG.SPAM_REPEAT_MESSAGE_LIMIT) {
    return { isRepeat: true, count };
  }
  return { isRepeat: false, count };
}

// 定期清理过期的 messageHashCache 条目（防止内存无限增长）
function pruneMessageHashCache(now) {
  const ttl = CONFIG.SPAM_MESSAGE_HASH_TTL * 1000;
  for (const [key, value] of messageHashCache) {
    if (now - value.ts > ttl) {
      messageHashCache.delete(key);
    }
  }
}

/**
 * 综合垃圾检测（关键词 + 链接 + 重复）
 * @param {object} msg - Telegram message object
 * @param {number} userId - 用户 ID
 * @param {object} env - 环境变量
 * @returns {Promise<{isSpam: boolean, reasons: string[], details: object}>}
 */
async function spamCheck(msg, userId, env) {
  const reasons = [];
  const details = {};
  const text = buildSpamCheckText(msg).trim();

  // 1. 关键词检测
  const keywords = getSpamKeywords(env);
  const keywordResult = detectSpamKeywords(text, keywords);
  if (keywordResult.isSpam) {
    reasons.push('keyword');
    details.keyword = keywordResult.matchedWord;
  }

  // 2. 链接检测（新用户限制）
  if (containsLink(text)) {
    // 检查用户验证时间：如果在 24 小时内验证的，拦截链接
    const verifyTs = await ephemeralStore(env).getVerificationTimestamp(userId);
    if (!verifyTs) {
      reasons.push('new_user_link');
      details.linkBlockRemainingHours = Math.ceil(CONFIG.NEW_USER_LINK_BLOCK_SECONDS / 3600);
    } else {
      const elapsed = (Date.now() - parseInt(verifyTs)) / 1000;
      if (elapsed < CONFIG.NEW_USER_LINK_BLOCK_SECONDS) {
        const remainingHours = Math.ceil((CONFIG.NEW_USER_LINK_BLOCK_SECONDS - elapsed) / 3600);
        reasons.push('new_user_link');
        details.linkBlockRemainingHours = remainingHours;
      }
    }
  }

  // 3. 重复消息检测
  const repeatResult = await detectRepeatMessage(userId, msg);
  if (repeatResult.isRepeat) {
    reasons.push('repeat_message');
    details.repeatCount = repeatResult.count;
  }

  return {
    isSpam: reasons.length > 0,
    reasons,
    details
  };
}

/**
 * 统一管理员告警通知
 * 用于关键异常（转发失败、KV 异常等）向管理员发送即时通知
 * @param {object} env - 环境变量
 * @param {string} alertType - 告警类型标识
 * @param {string} message - 告警内容（Markdown 格式）
 * @param {number} [threadId] - 可选，发送到指定话题
 */
async function notifyAdmin(env, alertType, message, threadId) {
  Logger.warn('admin_alert', { alertType, messageLength: message.length });

  const body = threadId ? { message_thread_id: threadId } : {};

  try {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      text: message,
      parse_mode: 'Markdown',
      ...body
    });
  } catch (e) {
    Logger.error('admin_alert_failed', e, { alertType });
  }
}

/**
 * 异步更新 spam 统计计数（在 waitUntil 中调用，不阻塞主响应）
 * @param {object} env - 环境变量
 * @param {string[]} reasons - spam 命中原因列表
 */
async function updateSpamStats(env, reasons) {
  try {
    for (const reason of reasons) {
      const countKey = `stats:spam:${reason}`;
      const current = parseInt(await env.TOPIC_MAP.get(countKey) || "0");
      await env.TOPIC_MAP.put(countKey, String(current + 1), { expirationTtl: 2592000 }); // 30天
    }
    const totalKey = 'stats:spam:total';
    const total = parseInt(await env.TOPIC_MAP.get(totalKey) || "0");
    await env.TOPIC_MAP.put(totalKey, String(total + 1), { expirationTtl: 2592000 });
  } catch (e) {
    Logger.warn('spam_stats_update_failed', { error: e.message });
  }
}

/**
 * 处理垃圾消息（通知管理员或静默丢弃）
 * @param {object} env - 环境变量
 * @param {number} userId - 用户 ID
 * @param {object} msg - 消息对象
 * @param {object} spamResult - spamCheck 返回的结果
 * @param {number} threadId - 可选，话题 ID
 */
async function handleSpamMessage(env, userId, msg, spamResult, threadId, ctx) {
  Logger.warn('spam_detected', {
    userId,
    reasons: spamResult.reasons,
    details: spamResult.details
  });

  // 统计 spam 拦截计数（按原因分类，便于分析趋势）
  // 使用 waitUntil 异步写入 KV，不阻塞主响应
  // 注意：KV 无原子递增，多实例并发下计数可能略低于实际值，仅供参考
  if (ctx?.waitUntil) {
    ctx.waitUntil(updateSpamStats(env, spamResult.reasons));
  }

  if (CONFIG.SPAM_NOTIFY_ADMIN && !CONFIG.SPAM_SILENCE_MODE) {
    const reasonText = spamResult.reasons.map(r => {
      switch (r) {
        case 'keyword': return `🔑 关键词: \`${spamResult.details.keyword}\``;
        case 'new_user_link': return `🔗 新用户链接 (剩余 ${spamResult.details.linkBlockRemainingHours}h)`;
        case 'repeat_message': return `🔄 重复消息 (${spamResult.details.repeatCount}次)`;
        default: return r;
      }
    }).join('\n');

    const body = threadId ? { message_thread_id: threadId } : {};

    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      text: `⚠️ **检测到疑似骚扰消息**\n\n👤 用户: \`${userId}\`\n${reasonText}\n\n📝 消息已拦截。使用 /ban 封禁该用户。`,
      parse_mode: 'Markdown',
      ...body
    });
  }
}

// escapeHtml 由 src/admin-ui-format.js 提供

// --- PR #12: Turnstile 验证页面 HTML 模板 ---
// 由 Worker 的 GET /verify 端点渲染，用户点击 bot 按钮后跳转到此页面
// 模板变量：{{SITE_KEY}} {{CODE}} {{USER_ID}} {{WORKER_URL}}
const VERIFY_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>人机验证</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,0.08)}
.icon{font-size:48px;margin-bottom:12px}
h2{color:#1a1a1a;margin-bottom:8px;font-size:20px}
p.desc{color:#666;font-size:14px;margin-bottom:24px;line-height:1.6}
.turnstile-container{display:flex;justify-content:center;margin-bottom:20px;min-height:65px}
#status{font-size:13px;color:#999;margin-top:12px;min-height:20px}
.success{color:#22c55e}
.error{color:#ef4444}
.footer{margin-top:20px;font-size:11px;color:#bbb}
.footer span{font-family:monospace;color:#999}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🛡️</div>
  <h2>人机验证</h2>
  <p class="desc">请完成下方验证以确认您不是机器人。<br>验证通过后您的消息将自动送达。</p>
  <div class="turnstile-container">
    <div class="cf-turnstile" data-sitekey="{{SITE_KEY}}" data-callback="onTurnstileSuccess" data-error-callback="onTurnstileError" data-theme="light"></div>
  </div>
  <div id="status">正在加载验证组件...</div>
  <a id="back-btn" href="tg://resolve" style="display:none;margin-top:16px;background:#0088cc;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:16px;text-decoration:none;">📱 返回 Telegram</a>
  <div class="footer">
    User: <span>{{USER_ID}}</span> · Code: <span>{{CODE}}</span>
  </div>
</div>
<script>
var submitted = false;
function showStatus(msg, cls) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}
function onTurnstileSuccess(token) {
  if (submitted) return;
  submitted = true;
  showStatus('✅ 验证通过！正在通知机器人...', 'success');
  fetch('{{WORKER_URL}}/verify-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, code: '{{CODE}}', userId: '{{USER_ID}}' })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      var msg = '✅ 验证成功！机器人已收到您的消息。';
      if (data.pendingCount > 0) {
        msg += '（' + data.pendingCount + ' 条消息将于数秒内送达）';
      }
      showStatus(msg, 'success');
      document.querySelector('.desc').textContent = '请返回 Telegram，机器人已向您发送了验证通过通知。';
      // 显示返回 Telegram 按钮
      var btn = document.getElementById('back-btn');
      if (btn) {
        btn.style.display = 'inline-block';
      }
    } else {
      var errMap = {
        'turnstile_failed': '人机验证未通过，请刷新页面重试',
        'code_invalid_or_expired': '验证链接已过期（有效期10分钟），请返回 Telegram 重新发送消息获取新的验证链接',
        'server_not_configured': '服务器未完成配置，请联系管理员'
      };
      var errMsg = errMap[data.error] || ('验证失败: ' + (data.detail || data.error || '未知错误'));
      showStatus(errMsg, 'error');
      submitted = false;
      if (window.turnstile) {
        window.turnstile.reset();
      }
    }
  })
  .catch(function(e) {
    showStatus('❌ 网络连接失败，请检查网络后刷新页面重试', 'error');
    submitted = false;
    if (window.turnstile) {
      window.turnstile.reset();
    }
  });
}
function onTurnstileError(errorCode) {
  // Turnstile 客户端错误码：https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/
  var code = (errorCode == null || errorCode === '') ? '' : String(errorCode);
  var hint = '';
  if (code === '110200') {
    hint = '（域名未授权：请在 Cloudflare Turnstile → Hostname 中添加当前 Worker 域名，如 xxx.workers.dev）';
  } else if (code === '110110') {
    hint = '（Site Key 无效：请检查 Dashboard 中的 TURNSTILE_SITE_KEY）';
  } else if (code === '110600') {
    hint = '（挑战超时：请刷新页面重试；若在 Telegram 内置浏览器失败，可改用系统浏览器打开链接）';
  } else if (code === '300030' || code === '300031') {
    hint = '（组件初始化失败：多为 CSP/网络拦截 challenges.cloudflare.com）';
  } else if (!code) {
    hint = '（无法加载 challenges.cloudflare.com：请检查网络/代理/地区访问）';
  }
  showStatus('⚠️ 验证组件失败' + (code ? ' [' + code + ']' : '') + '，请刷新重试' + hint, 'error');
}
// 脚本长时间未就绪时给出提示（区分脚本被墙与 widget 配置错误）
setTimeout(function() {
  if (!window.turnstile && !submitted) {
    showStatus('⚠️ 未能加载 Turnstile 脚本（challenges.cloudflare.com）。请检查网络，或让管理员暂时关闭 TURNSTILE_* 变量以使用本地题库验证。', 'error');
  }
}, 8000);
</script>
</body>
</html>`;

const legacyApp = {
  async fetch(request, env, ctx) {
    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    // 规范化环境变量，统一为字符串类型
    const normalizedEnv = {
      ...env,
      SUPERGROUP_ID: String(env.SUPERGROUP_ID),
      BOT_TOKEN: String(env.BOT_TOKEN)
    };

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
      return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    const url = new URL(request.url);

    // --- PR #12: GET 请求处理 ---

    if (request.method === "GET") {
      // 健康检查
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response("OK");
      }

      // Turnstile 验证页面（用户点击 bot 按钮后跳转到的页面）
      if (url.pathname === "/verify" || url.pathname.endsWith("/verify")) {
        const code = url.searchParams.get('code');
        const userId = url.searchParams.get('uid');
        const siteKey = (env.TURNSTILE_SITE_KEY || '').toString().trim();

        if (!code || !userId || !siteKey) {
          return new Response(
            '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h2>❌ 参数无效</h2><p>缺少验证信息或系统未配置 Turnstile。</p></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }

        const workerUrl = url.origin;

        // Turnstile 专用 CSP：官方要求 script-src/frame-src 放行 challenges.cloudflare.com。
        // 勿使用仅 nonce 的严格 script-src——Turnstile 会执行 javascript: URL，nonce 策略会触发
        // onTurnstileError，页面显示「验证组件加载失败」。
        // 本页为独立验证页，无第三方内容，unsafe-inline/eval 风险可控。
        // 参考：https://developers.cloudflare.com/turnstile/reference/content-security-policy/
        const csp = [
          "default-src 'none'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com",
          "style-src 'unsafe-inline'",
          "img-src https://challenges.cloudflare.com data:",
          "connect-src 'self' https://challenges.cloudflare.com",
          "frame-src https://challenges.cloudflare.com",
          "child-src https://challenges.cloudflare.com",
          "worker-src blob:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; ');

        return new Response(VERIFY_PAGE_HTML
          .replace(/{{SITE_KEY}}/g, escapeHtml(siteKey))
          .replace(/{{CODE}}/g, escapeHtml(code))
          .replace(/{{USER_ID}}/g, escapeHtml(userId))
          .replace(/{{WORKER_URL}}/g, escapeHtml(workerUrl)),
          { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } }
        );
      }

      return new Response("Not Found", { status: 404 });
    }

    // --- POST 请求处理（Telegram webhook + Turnstile token 验证） ---

    // PR #12: Turnstile token 验证端点（由前端页面 JS fetch 调用）
    if ((url.pathname === "/verify-callback" || url.pathname.endsWith("/verify-callback")) && request.method === "POST") {
      try {
        const body = await request.json();
        const { token, code, userId } = body || {};

        if (!token || !code || !userId) {
          return new Response(JSON.stringify({ success: false, error: 'missing_params' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 验证 Turnstile token
        const turnstileSecret = (env.TURNSTILE_SECRET_KEY || '').toString().trim();
        if (!turnstileSecret) {
          return new Response(JSON.stringify({ success: false, error: 'server_not_configured' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const verifyResult = await verifyTurnstileToken(token, turnstileSecret);
        if (!verifyResult.success) {
          Logger.warn('turnstile_token_invalid', { userId, error: verifyResult.error });
          return new Response(JSON.stringify({ success: false, error: 'turnstile_failed', detail: verifyResult.error }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 从 KV 验证 code 是否匹配
        const storedUserId = await env.TOPIC_MAP.get(`turnstile_code:${code}`);
        if (!storedUserId || storedUserId !== String(userId)) {
          return new Response(JSON.stringify({ success: false, error: 'code_invalid_or_expired' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Turnstile token 有效 + code 匹配 → 标记验证通过
        await ephemeralStore(env).setVerification(userId, {
          ttl: CONFIG.VERIFIED_EXPIRE_SECONDS,
          verifiedAt: Date.now(),
        });
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await env.TOPIC_MAP.delete(`turnstile_code:${code}`);
        await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

        Logger.info('turnstile_verification_success', { userId });
        await bumpDailyStat(normalizedEnv, 'verifies', 1);

        // 删除验证消息（去掉带按钮的验证卡片）
        const verifyMsgId = await env.TOPIC_MAP.get(`turnstile_msg:${code}`);
        ctx.waitUntil((async () => {
          if (verifyMsgId) {
            try {
              await tgCall(normalizedEnv, "deleteMessage", {
                chat_id: Number(userId),
                message_id: parseInt(verifyMsgId)
              });
            } catch (e) {
              // 消息可能已被删除，忽略
            }
            await env.TOPIC_MAP.delete(`turnstile_msg:${code}`);
          }
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: Number(userId),
            text: VERIFY_COPY.successBody,
            parse_mode: "HTML",
          });
        })());

        // 返回 pending 消息列表供前端页面显示，由 worker 在后台转发
        const pendingKey = `pending_turnstile:${userId}`;
        const pendingIdsStr = await env.TOPIC_MAP.get(pendingKey);
        let pendingCount = 0;
        if (pendingIdsStr) {
          try {
            const pendingIds = JSON.parse(pendingIdsStr);
            if (Array.isArray(pendingIds) && pendingIds.length > 0) {
              pendingCount = Math.min(pendingIds.length, CONFIG.PENDING_MAX_MESSAGES);
              ctx.waitUntil((async () => {
                let forwardedCount = 0;
                const limited = pendingIds.slice(0, CONFIG.PENDING_MAX_MESSAGES);
                // 补全 from：验证页回调没有 Telegram 用户资料，勿用仅含 id 的 from 建话题（会变成 "User"）
                const topicFrom = await resolveUserFromForTopic(normalizedEnv, userId, null);
                for (const pendingId of limited) {
                  if (!pendingId) continue;
                  const fakeMsg = {
                    message_id: pendingId,
                    chat: { id: Number(userId), type: "private" },
                    from: topicFrom,
                  };
                  try {
                    await forwardToTopic(fakeMsg, userId, `user:${userId}`, normalizedEnv, ctx);
                    forwardedCount++;
                  } catch (e) {
                    Logger.error('pending_turnstile_forward_failed', e, { userId, messageId: pendingId });
                  }
                }
                if (forwardedCount > 0) {
                  await tgCall(normalizedEnv, "sendMessage", {
                    chat_id: Number(userId),
                    text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
                  });
                }
                await env.TOPIC_MAP.delete(pendingKey);
              })());
            }
          } catch (e) {
            Logger.error('pending_turnstile_parse_failed', e, { userId });
          }
        }

        return new Response(JSON.stringify({ success: true, pendingCount }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        Logger.error('verify_callback_error', e);
        return new Response(JSON.stringify({ success: false, error: 'server_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      Logger.warn('invalid_content_type', { contentType });
      return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
        Logger.warn('invalid_json_structure', { update: typeof update });
        return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.edited_message) {
      const handleUpdate = createUpdateHandler({
        conversation: createLegacyConversationService(normalizedEnv),
        supergroupId: normalizedEnv.SUPERGROUP_ID,
      });
      await handleUpdate(update);
      return new Response("OK");
    }

    if (update.callback_query) {
      const cbData = String(update.callback_query.data || '');
      if (cbData.startsWith('adm:')) {
        await handleAdminUiCallback(update.callback_query, normalizedEnv, ctx);
      } else if (cbData.startsWith('v1:')) {
        await createLegacyAdminService(normalizedEnv)
          .handleCallbackQuery(update.callback_query);
      } else {
        await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      }
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    const now = Date.now();
    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, now));
    // 概率性清理过期缓存（1% 请求触发一次，分摊成本）
    if (Math.random() < 0.01) {
      pruneMessageHashCache(now);
    }

    if (msg.chat && msg.chat.type === "private") {
      try {
        const ptext = removeCommandBotSuffix((msg.text || '').trim());
        // 用户向简短帮助（非管理员也能看）
        if (ptext === '/help') {
          await tgCall(normalizedEnv, 'sendMessage', {
            chat_id: msg.chat.id,
            text: [
              '👋 <b>私聊网关</b>',
              '',
              '直接发送文字 / 图片 / 文件即可联系管理员。',
              '首次使用可能需要完成人机验证（按钮或网页）。',
              '若被静音或封禁，会收到单独通知。',
              '',
              '常用：',
              '• /start — 开始或重新触发验证',
              '• /help — 显示本说明',
              '',
              '<i>管理指令仅在超级群话题内由管理员使用。</i>',
            ].join('\n'),
            parse_mode: 'HTML',
          });
          return new Response('OK');
        }
        if (ptext === '/start' || ptext === '/cancel') {
          const adminResult = await createLegacyAdminService(normalizedEnv)
            .handlePrivateAdminMessage(msg);
          if (adminResult.status === 'menu' || adminResult.status === 'cancelled') {
            return new Response("OK");
          }
        }
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        // 不向用户泄露技术细节
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 使用字符串比较
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
        return new Response("OK");
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
        return new Response("OK");
      }
      // 支持 General 话题和普通话题
      // General 话题的 message_thread_id 可能不存在，或者等于 1
      const text = (msg.text || "").trim();
      const isCommand = !!text && text.startsWith("/");
      if (msg.message_thread_id || isCommand) {
        await handleAdminReply(msg, normalizedEnv, ctx);
        return new Response("OK");
      }
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 尽早缓存资料，供验证通过后的消息回放建话题使用
  await saveUserProfileSnapshot(env, userId, msg.from);

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ 发送过于频繁，请稍后再试。"
    });
    return;
  }

  // 拦截普通用户发送的指令（/help 已在入口处理）
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
    return;
  }

  const [isBanned, isMuted, blockedWords, verification] = await Promise.all([
    env.TOPIC_MAP.get(`banned:${userId}`),
    env.TOPIC_MAP.get(`muted:${userId}`),
    getBlockedWords(env),
    getVerificationState(env, userId),
  ]);
  const blockedRules = blockedWords.map((pattern, index) => ({
    ruleId: `legacy_blocked:${index}`,
    ruleType: 'blocked_keyword',
    matchType: 'contains',
    pattern,
    action: 'reject',
    priority: index,
  }));
  const policyResult = evaluateMessagePolicy({
    message: msg,
    user: {
      status: isBanned ? 'banned' : 'active',
      trustLevel: verification?.type === 'trusted' ? 'trusted' : 'normal',
    },
    verification,
    rules: blockedRules,
  });

  if (policyResult.reason === 'banned') {
    // 避免用户不知道已被封禁仍反复发送；每小时最多提醒一次
    try {
      const noticeKey = `ban_notice:${userId}`;
      const noticed = await env.TOPIC_MAP.get(noticeKey);
      if (!noticed) {
        await tgCall(env, 'sendMessage', {
          chat_id: userId,
          text: '🚫 您已被管理员封禁，暂时无法继续发送消息。如有疑问请等待管理员处理。',
        });
        await env.TOPIC_MAP.put(noticeKey, '1', { expirationTtl: 3600 });
      }
    } catch (e) {
      Logger.warn('ban_notice_failed', { userId, error: e?.message });
    }
    return;
  }
  // 静音：仍接收但不转发到管理群（每小时提示一次）
  if (isMuted) {
    try {
      const noticeKey = `mute_notice:${userId}`;
      if (!(await env.TOPIC_MAP.get(noticeKey))) {
        await tgCall(env, 'sendMessage', {
          chat_id: userId,
          text: '🔇 您当前处于静音状态，消息不会送达管理员。请等待管理员取消静音。',
        });
        await env.TOPIC_MAP.put(noticeKey, '1', { expirationTtl: 3600 });
      }
    } catch { /* ignore */ }
    return;
  }
  if (policyResult.reason === 'blocked_keyword') {
    const matchedIndex = Number(policyResult.matchedRuleId?.split(':')[1]);
    Logger.info('message_blocked_by_word', { userId, word: blockedWords[matchedIndex] });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "🚫 您的消息包含违规内容，已被拦截，请修改后重新发送。"
    });
    return;
  }

  // PR #12: 垃圾内容检测（在验证之前检查）
  const spamResult = await spamCheck(msg, userId, env);
  if (spamResult.isSpam) {
    await bumpDailyStat(env, 'spam', 1);
    await handleSpamMessage(env, userId, msg, spamResult, undefined, ctx);
    return;
  }

  if (policyResult.action === 'require_verification') {
    const isStart = msg.text && msg.text.trim() === "/start";
    const pendingMsgId = isStart ? null : msg.message_id;
    await sendVerificationChallenge(userId, env, pendingMsgId, msg.from);
    return;
  }

  if (policyResult.autoReply) {
    try {
      await tgCall(env, "sendMessage", { chat_id: userId, text: policyResult.autoReply });
    } catch (error) {
      Logger.warn('auto_reply_failed', { userId, ruleId: policyResult.matchedRuleId });
      if (policyResult.action === 'auto_reply_only') throw error;
    }
  }
  if (policyResult.action === 'auto_reply_only') return;

  await bumpDailyStat(env, 'messages_in', 1);
  await forwardToTopic(msg, userId, key, env, ctx);
}

/**
 * 消息转发到话题 — 主入口（编排层）
 * 职责：前置检查 → 获取/创建话题 → 健康检查 → 执行转发
 */
async function forwardToTopic(msg, userId, key, env, ctx) {
  // 并发兜底：如果已被标记为需要重新验证，直接发起验证并暂停转发/建话题
  const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
  if (needsVerify) {
    await sendVerificationChallenge(userId, env, msg.message_id || null, msg.from);
    return;
  }

  // 获取用户话题记录
  let rec = await safeGetJSON(env, key, null);

  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
    return;
  }

  // 重试计数器检查
  const retryKey = `retry:${userId}`;
  let retryCount = parseInt((await env.TOPIC_MAP.get(retryKey)) ?? "0", 10);
  if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: "❌ 系统繁忙，请稍后再试。" });
    await env.TOPIC_MAP.delete(retryKey);
    return;
  }

  // 获取或创建话题
  if (!rec || !rec.thread_id) {
    rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
    if (!rec || !rec.thread_id) {
      throw new Error("创建话题失败");
    }
  } else if (!rec.title || rec.title === 'User' || /^User @/i.test(rec.title)) {
    // 修复 Turnstile 回放建话题时资料缺失导致的占位标题
    try {
      const resolvedFrom = await resolveUserFromForTopic(env, userId, msg.from);
      const title = buildTopicTitle(resolvedFrom);
      if (title && title !== 'User' && title !== rec.title) {
        const edit = await tgCall(env, 'editForumTopic', {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: rec.thread_id,
          name: title,
        });
        if (edit?.ok) {
          rec.title = title;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        }
      }
    } catch (e) {
      Logger.warn('topic_title_repair_failed', { userId, error: e?.message });
    }
  }

  // 补建 thread->user 映射（兼容旧数据）
  if (rec.thread_id) {
    const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
    if (!mappedUser) {
      await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
    }
  }

  // 话题健康检查（话题被删除后自动重建）
  if (rec.thread_id) {
    const healthResult = await checkThreadHealth(rec.thread_id, env, { userId, retryKey });
    if (healthResult.action === "reverify") {
      await resetUserVerificationAndRequireReverify(env, {
        userId,
        userKey: key,
        oldThreadId: rec.thread_id,
        pendingMsgId: msg.message_id,
        reason: `health_check:${healthResult.status}`
      });
      return;
    }
  }

  // 注意：屏蔽词和垃圾检查已在 handlePrivateMessage 入口处统一执行，此处无需重复。
  // forwardToTopic 也会被验证通过后的待处理消息回放调用（此时消息已在入口处检查过），
  // 因此此处不再重复检查，避免每条消息多消耗一次 KV 读取（getBlockedWords）和 spamCheck 计算。

  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, {
      direction: "p2t",
      targetChat: env.SUPERGROUP_ID,
      threadId: rec.thread_id
    });
    return;
  }

  // 执行转发（forwardMessage → copyMessage 降级）
  await executeMessageForward(msg, userId, rec.thread_id, env);
}

/**
 * 话题健康检查 — 双层缓存（内存 + KV）+ 探测
 * @returns {{ action: "ok" | "reverify", status: string }}
 */
async function checkThreadHealth(threadId, env, { userId, retryKey }) {
  const cacheKey = threadId;
  const now = Date.now();
  const cached = threadHealthCache.get(cacheKey);
  const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

  if (withinTTL) {
    return { action: "ok", status: cached.ok ? "ok" : "missing" };
  }

  // 跨节点缓存：避免由于 Workers 多 PoP 导致每次都做健康探测
  const kvHealthOk = await ephemeralStore(env).getTopicHealth(threadId);

  if (kvHealthOk === true) {
    setBoundedCache(threadHealthCache, cacheKey, { ts: now, ok: true }, THREAD_HEALTH_MAX_ENTRIES);
    return { action: "ok", status: "ok" };
  }

  const probe = await probeForumThread(env, threadId, { userId, reason: "health_check" });

  if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
    return { action: "reverify", status: probe.status };
  }

  if (probe.status === "probe_invalid") {
    Logger.warn('topic_health_probe_invalid_message', {
      userId, threadId, errorDescription: probe.description
    });
    // 仍然设置短 TTL，避免每条消息都探测（并误触发重建）
    setBoundedCache(threadHealthCache, cacheKey, { ts: now, ok: true }, THREAD_HEALTH_MAX_ENTRIES);
    await ephemeralStore(env).setTopicHealth(
      threadId,
      true,
      Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000),
    );
    return { action: "ok", status: "ok" };
  }

  if (probe.status === "unknown_error") {
    Logger.warn('topic_test_failed_unknown', {
      userId, threadId, errorDescription: probe.description
    });
    return { action: "ok", status: "unknown" };
  }

  // 健康状态：清除重试计数，更新缓存
  await env.TOPIC_MAP.delete(retryKey);
  setBoundedCache(threadHealthCache, cacheKey, { ts: now, ok: true }, THREAD_HEALTH_MAX_ENTRIES);
  await ephemeralStore(env).setTopicHealth(
    threadId,
    true,
    Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000),
  );
  return { action: "ok", status: "ok" };
}

/**
 * 执行消息转发 — forwardMessage → copyMessage 降级 + 重定向检测
 */
async function executeMessageForward(msg, userId, threadId, env) {
  const res = await tgCall(env, "forwardMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: threadId,
  });

  const resThreadId = res.result?.message_thread_id;

  // 检测 Telegram 静默重定向到 General 的情况
  if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(threadId)) {
    await handleForwardRedirect(res, msg, userId, threadId, env, "forward_redirected_to_general");
    return;
  }

  // 兜底：部分情况下 Telegram 返回 ok 但不带 message_thread_id（可能已落入 General）
  if (res.ok && (resThreadId === undefined || resThreadId === null)) {
    const probe = await probeForumThread(env, threadId, { userId, reason: "forward_result_missing_thread_id" });
    if (probe.status !== "ok") {
      await handleForwardRedirect(res, msg, userId, threadId, env, `forward_missing_thread_id:${probe.status}`);
      return;
    }
  }

  // 转发失败：尝试降级和错误分类
  if (!res.ok) {
    await handleForwardFailure(res, msg, userId, threadId, env);
    return;
  }

  await saveLegacyMessageLink(env, {
    direction: 'user_to_admin',
    message: msg,
    targetChatId: env.SUPERGROUP_ID,
    targetMessageId: res.result?.message_id,
    topicId: threadId,
    userId,
  });
}

/**
 * 处理转发重定向 — 删除误投消息 + 触发重建
 */
async function handleForwardRedirect(res, msg, userId, threadId, env, reason) {
  Logger.warn('forward_redirected', { userId, expectedThreadId: threadId, reason });

  // 删除误投到 General 的消息（使用 Telegram 返回的消息 ID）
  if (res.result?.message_id) {
    try {
      await tgCall(env, "deleteMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_id: res.result.message_id
      });
    } catch {
      // 删除失败不影响后续处理
    }
  }

  // 使用用户原消息 ID（msg.message_id）作为 pendingMsgId，而非误投消息的 ID
  await resetUserVerificationAndRequireReverify(env, {
    userId,
    userKey: `user:${userId}`,
    oldThreadId: threadId,
    pendingMsgId: msg?.message_id || res.result?.message_id,
    reason,
  });
}

/**
 * 处理转发失败 — 话题丢失检测 + copyMessage 降级 + 通知管理员
 */
async function handleForwardFailure(res, msg, userId, threadId, env) {
  const desc = normalizeTgDescription(res.description);

  if (isTopicMissingOrDeleted(desc)) {
    Logger.warn('forward_failed_topic_missing', {
      userId, threadId, errorDescription: res.description
    });
    await resetUserVerificationAndRequireReverify(env, {
      userId,
      userKey: `user:${userId}`,
      oldThreadId: threadId,
      pendingMsgId: msg.message_id,
      reason: "forward_failed_topic_missing",
    });
    return;
  }

  if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
  if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

  // forwardMessage 失败，使用 copyMessage 作为降级方案
  Logger.warn('forward_fallback_to_copy', {
    userId, threadId, originalError: res.description
  });

  const copyRes = await tgCall(env, "copyMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: threadId,
  });

  if (!copyRes.ok) {
    Logger.error('forward_and_copy_both_failed', copyRes.description, { userId, threadId });
    await notifyAdmin(env, 'forward_failed',
      `⚠️ **消息转发完全失败**\n\n👤 用户: \`${userId}\`\n📝 话题: \`${threadId}\`\n❌ forwardMessage: \`${res.description}\`\n❌ copyMessage: \`${copyRes.description}\``
    );
  }
}

/**
 * 移除命令中的 @botname 后缀
 * 例如：/listwords@callcosr_bot -> /listwords
 * @param {string} text - 原始命令文本
 * @returns {string} 清理后的命令文本
 */
function removeCommandBotSuffix(text) {
  if (!text || !text.startsWith("/")) return text;
  // 匹配 /command@botname 格式，移除 @botname 部分
  return text.replace(/^\/([a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, '/$1');
}

async function handleAdminReply(msg, env, ctx) {
  try {
    await _handleAdminReplyInner(msg, env, ctx);
  } catch (e) {
    Logger.error('admin_reply_failed', e, {
      threadId: msg?.message_thread_id,
      senderId: msg?.from?.id
    });
  }
}

// --- 管理员命令处理函数 ---

function isOwnerUser(env, userId) {
  return idAllowlistHas(env.OWNER_IDS, userId);
}


/** 管理命令 handlers（惰性创建，闭包绑定 userActions） */
let _adminHandlersCache = null;
function getAdminHandlers() {
  if (_adminHandlersCache) return _adminHandlersCache;
  _adminHandlersCache = createAdminCommandHandlers({
    tgCall,
    gatewayVersion: GATEWAY_VERSION,
    recordSystemError,
    isOwnerUser,
    isAdminUser,
    parseIdAllowlist,
    safeGetJSON,
    resolveThreadIdForUser,
    getRecentSystemErrors: () => recentSystemErrors,
    handleCleanupCommand,
    handleListWordsCommand,
    userActions: {
      ban: handleBanCommand,
      unban: handleUnbanCommand,
      close: handleCloseCommand,
      open: handleOpenCommand,
      trust: handleTrustCommand,
      reset: handleResetCommand,
      mute: handleMuteCommand,
      unmute: handleUnmuteCommand,
      info: handleInfoCommand,
      panel: handlePanelCommand,
      note: handleNoteCommand,
    },
  });
  return _adminHandlersCache;
}

function bumpDailyStat(env, field, n = 1) {
  return getAdminHandlers().bumpDailyStat(env, field, n);
}
function handleHelpCommand(env, threadId, senderId = null) {
  return getAdminHandlers().handleHelpCommand(env, threadId, senderId);
}
function handleMenuCommand(env, threadId, senderId) {
  return getAdminHandlers().handleMenuCommand(env, threadId, senderId);
}
function handleSysinfoCommand(env, threadId, opts = {}) {
  return getAdminHandlers().handleSysinfoCommand(env, threadId, opts);
}
function handleStatsCommand(env, threadId) {
  return getAdminHandlers().handleStatsCommand(env, threadId);
}
function handleRankCommand(env, threadId, opts = {}) {
  return getAdminHandlers().handleRankCommand(env, threadId, opts);
}
function handleNotesCommand(env, threadId, queryText = '') {
  return getAdminHandlers().handleNotesCommand(env, threadId, queryText);
}
function handleWhoamiCommand(env, threadId, senderId) {
  return getAdminHandlers().handleWhoamiCommand(env, threadId, senderId);
}
function handleFindCommand(env, threadId, queryText) {
  return getAdminHandlers().handleFindCommand(env, threadId, queryText);
}
function handleSyncCommandsCommand(env, threadId, senderId) {
  return getAdminHandlers().handleSyncCommandsCommand(env, threadId, senderId);
}
function handleAdminUiCallback(query, env, ctx) {
  return getAdminHandlers().handleAdminUiCallback(query, env, ctx);
}


async function resolveThreadIdForUser(env, userId) {
  const rec = await safeGetJSON(env, `user:${userId}`, null);
  if (rec?.thread_id) return rec.thread_id;
  if (env.TG_BOT_DB) {
    try {
      const u = await createD1Storage(env.TG_BOT_DB).getUser(userId);
      if (u?.topicId) return u.topicId;
    } catch { /* ignore */ }
  }
  return null;
}

async function handlePanelCommand(env, threadId, userId) {
  const from = await resolveUserFromForTopic(env, userId, null);
  const name = escapeHtml([from.first_name, from.last_name].filter(Boolean).join(' ').trim() || '未知');
  const un = from.username ? `@${escapeHtml(from.username)}` : '无用户名';
  const ban = await env.TOPIC_MAP.get(`banned:${userId}`);
  const muted = await env.TOPIC_MAP.get(`muted:${userId}`);
  const rec = await safeGetJSON(env, `user:${userId}`, null);
  const note = await env.TOPIC_MAP.get(`note:${userId}`);
  const text = [
    '🎛 <b>用户面板</b>',
    '────────────────',
    `👤 ${name} · ${un}`,
    `UID <code>${userId}</code>`,
    `状态  封禁:${ban ? '🚫 是' : '否'} · 静音:${muted ? '🔇 是' : '否'} · 关闭:${rec?.closed ? '🔒 是' : '否'}`,
    note
      ? `📝 ${escapeHtml(String(note).slice(0, 80))}${String(note).length > 80 ? '…' : ''}`
      : '📝 无备注 · <code>/note 内容</code> 添加',
    '',
    '👇 点按钮操作',
    '<i>封禁 / 关闭 / 重置需二次确认</i>',
  ].join('\n');
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text,
    parse_mode: 'HTML',
    reply_markup: buildUserActionKeyboard(userId),
  });
}

async function handleMuteCommand(env, threadId, userId) {
  await env.TOPIC_MAP.put(`muted:${userId}`, '1');
  if (env.TG_BOT_DB) {
    try { await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { isMuted: true }); } catch { /* ignore */ }
  }
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '🔇 <b>已静音</b>：用户消息不再转发到本群',
    parse_mode: 'HTML',
  });
  await tgCall(env, 'sendMessage', {
    chat_id: userId,
    text: '🔇 您已被管理员静音，消息暂时不会送达管理员。',
  });
}

async function handleUnmuteCommand(env, threadId, userId) {
  await env.TOPIC_MAP.delete(`muted:${userId}`);
  await env.TOPIC_MAP.delete(`mute_notice:${userId}`);
  if (env.TG_BOT_DB) {
    try { await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { isMuted: false }); } catch { /* ignore */ }
  }
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '🔊 <b>已取消静音</b>',
    parse_mode: 'HTML',
  });
  await tgCall(env, 'sendMessage', {
    chat_id: userId,
    text: '🔊 您的静音已取消，可以继续联系管理员。',
  });
}

async function handleNoteCommand(env, threadId, userId, text) {
  const note = text.replace(/^\/note(@\w+)?\s*/i, '').trim();
  if (!note) {
    const existing = await env.TOPIC_MAP.get(`note:${userId}`);
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: existing
        ? `📝 <b>当前备注</b>\n${escapeHtml(existing)}\n\n用法: <code>/note 新备注</code>（发 <code>/note clear</code> 清空）`
        : '📝 暂无备注。用法: <code>/note 内容</code>',
      parse_mode: 'HTML',
    });
    return;
  }
  if (note.toLowerCase() === 'clear' || note === '-' || note === '清除') {
    await env.TOPIC_MAP.delete(`note:${userId}`);
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: '✅ 备注已清除',
    });
    return;
  }
  await env.TOPIC_MAP.put(`note:${userId}`, note.slice(0, 500), { expirationTtl: 365 * 86400 });
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: `✅ 备注已保存：\n${escapeHtml(note.slice(0, 500))}`,
    parse_mode: 'HTML',
  });
}

async function handleAddWordCommand(env, threadId, text, senderId) {
  const word = text.slice(9).trim();
  if (!word) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "⚠️ 用法: `/addword 屏蔽词`", parse_mode: "Markdown" });
    return;
  }
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) kvWords = JSON.parse(raw);
  } catch { /* 忽略解析错误，从空数组开始 */ }
  if (!Array.isArray(kvWords)) kvWords = [];

  // 检查是否已存在（合并硬编码一起判断）
  const allWords = [...new Set([...BLOCKED_WORDS, ...kvWords])];
  if (allWords.map(w => w.toLowerCase()).includes(word.toLowerCase())) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `⚠️ 屏蔽词「${word}」已存在。`, parse_mode: "Markdown" });
    return;
  }

  kvWords.push(word);
  await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
  blockedWordsCache.data = null; // 强制刷新缓存
  Logger.info('blocked_word_added', { word, by: senderId });
  await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `✅ 已添加屏蔽词「${word}」\n当前动态词库共 ${kvWords.length} 个词`, parse_mode: "Markdown" });
}

async function handleDelWordCommand(env, threadId, text, senderId) {
  const word = text.slice(9).trim();
  if (!word) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "⚠️ 用法: `/delword 屏蔽词`", parse_mode: "Markdown" });
    return;
  }

  // 检查是否为硬编码词
  if (BLOCKED_WORDS.map(w => w.toLowerCase()).includes(word.toLowerCase())) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `⚠️「${word}」是硬编码屏蔽词，无法通过命令删除，请直接修改代码中的 BLOCKED_WORDS 数组。`, parse_mode: "Markdown" });
    return;
  }

  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) kvWords = JSON.parse(raw);
  } catch { /* 忽略 */ }
  if (!Array.isArray(kvWords)) kvWords = [];

  const before = kvWords.length;
  kvWords = kvWords.filter(w => w.toLowerCase() !== word.toLowerCase());

  if (kvWords.length === before) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `⚠️ 屏蔽词「${word}」不存在于动态词库中。`, parse_mode: "Markdown" });
    return;
  }

  await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
  blockedWordsCache.data = null; // 强制刷新缓存
  Logger.info('blocked_word_removed', { word, by: senderId });
  await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `✅ 已删除屏蔽词「${word}」\n当前动态词库共 ${kvWords.length} 个词`, parse_mode: "Markdown" });
}

async function handleListWordsCommand(env, threadId) {
  const allWords = await getBlockedWords(env, true); // 强制刷新
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) kvWords = JSON.parse(raw);
  } catch { /* 忽略 */ }
  if (!Array.isArray(kvWords)) kvWords = [];

  const hardcoded = BLOCKED_WORDS;
  const dynamic = kvWords.filter(w => !BLOCKED_WORDS.map(h => h.toLowerCase()).includes(w.toLowerCase()));
  // SPAM_KEYWORDS 是独立的垃圾检测词库（环境变量），不进入 blocked_words_kv
  const spamKeywords = parseSpamKeywords((env.SPAM_KEYWORDS || '').toString());

  const blockedTotal = allWords.length;
  let reply = `📝 **内容过滤词库**\n\n`;
  reply += `**一、屏蔽词**（命中后拦截并提示用户，共 ${blockedTotal} 个）\n\n`;
  reply += `🔧 **硬编码词** (${hardcoded.length} 个，修改需改代码):\n`;
  reply += hardcoded.length > 0 ? hardcoded.map(w => `  • ${w}`).join("\n") : "  (无)";
  reply += `\n\n💾 **动态词** (${dynamic.length} 个，可通过 /addword /delword 管理):\n`;
  reply += dynamic.length > 0 ? dynamic.map(w => `  • ${w}`).join("\n") : "  (无)";
  reply += `\n\n**二、垃圾关键词 SPAM_KEYWORDS**（环境变量，走 spam 检测；共 ${spamKeywords.length} 个）\n`;
  reply += spamKeywords.length > 0
    ? spamKeywords.map(w => `  • ${w}`).join("\n")
    : "  (未配置或为空；在 Cloudflare Variables 中设置 SPAM_KEYWORDS，逗号分隔)";
  reply += `\n\n说明：/addword 只写入「动态屏蔽词」，不会改 SPAM_KEYWORDS 环境变量。`;

  await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: reply, parse_mode: "Markdown" });
}

async function handleCloseCommand(env, threadId, userId) {
  const key = `user:${userId}`;
  let rec = await safeGetJSON(env, key, null);
  if (!rec) {
    rec = { thread_id: threadId, closed: true };
  } else {
    rec.closed = true;
    if (!rec.thread_id) rec.thread_id = threadId;
  }
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: 'closed' });
    } catch (e) {
      Logger.warn('close_d1_update_failed', { userId, error: e?.message });
    }
  }
  await tgCall(env, 'closeForumTopic', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
  });
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '🚫 <b>对话已强制关闭</b>',
    parse_mode: 'HTML',
  });
}

async function handleOpenCommand(env, threadId, userId) {
  const key = `user:${userId}`;
  let rec = await safeGetJSON(env, key, null);
  if (!rec) {
    rec = { thread_id: threadId, closed: false };
  } else {
    rec.closed = false;
    if (!rec.thread_id) rec.thread_id = threadId;
  }
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: 'active' });
    } catch (e) {
      Logger.warn('open_d1_update_failed', { userId, error: e?.message });
    }
  }
  await tgCall(env, 'reopenForumTopic', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
  });
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '✅ <b>对话已恢复</b>',
    parse_mode: 'HTML',
  });
}

async function handleResetCommand(env, threadId, userId) {
  await setPersistentTrust(env, userId, 'normal');
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '🔄 <b>验证重置</b>（已取消永久信任，下次需重新验证）',
    parse_mode: 'HTML',
  });
}

async function handleTrustCommand(env, threadId, userId) {
  await setPersistentTrust(env, userId, 'trusted');
  await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '🌟 <b>已设置永久信任</b>',
    parse_mode: 'HTML',
  });
}

async function handleBanCommand(env, threadId, userId) {
  await env.TOPIC_MAP.put(`banned:${userId}`, "1");
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: 'banned' });
    } catch (e) {
      Logger.warn('ban_d1_update_failed', { userId, error: e?.message });
    }
  }
  await bumpDailyStat(env, 'bans', 1);
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '🚫 <b>用户已封禁</b>（已尝试通知对方）',
    parse_mode: 'HTML',
  });
  // 主动告知用户已被封禁，避免对方不知情仍持续发消息
  const notify = await tgCall(env, 'sendMessage', {
    chat_id: userId,
    text: '🚫 您已被管理员封禁，暂时无法继续发送消息。如有疑问请等待管理员处理。',
  });
  if (!notify?.ok) {
    Logger.warn('ban_user_notify_failed', {
      userId,
      description: notify?.description,
    });
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `⚠️ 已封禁，但通知用户失败（可能对方未私聊过机器人或已拉黑）：${escapeHtml(notify?.description || 'unknown')}`,
      parse_mode: 'HTML',
    });
  } else {
    await env.TOPIC_MAP.put(`ban_notice:${userId}`, '1', { expirationTtl: 3600 });
  }
}

async function handleUnbanCommand(env, threadId, userId) {
  await env.TOPIC_MAP.delete(`banned:${userId}`);
  await env.TOPIC_MAP.delete(`ban_notice:${userId}`);
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: 'active' });
    } catch (e) {
      Logger.warn('unban_d1_update_failed', { userId, error: e?.message });
    }
  }
  await tgCall(env, 'sendMessage', {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: '✅ <b>用户已解封</b>（已尝试通知对方）',
    parse_mode: 'HTML',
  });
  const notify = await tgCall(env, 'sendMessage', {
    chat_id: userId,
    text: '✅ 您已被管理员解封，可以继续发送消息了。',
  });
  if (!notify?.ok) {
    Logger.warn('unban_user_notify_failed', {
      userId,
      description: notify?.description,
    });
  }
}

async function handleInfoCommand(env, threadId, userId) {
  const userKey = `user:${userId}`;
  let userRec = await safeGetJSON(env, userKey, null);
  const verifyStatus = await getVerificationState(env, userId);
  const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);

  // 补全资料并尽量修复历史「User」占位话题名
  const from = await resolveUserFromForTopic(env, userId, null);
  const resolvedTitle = buildTopicTitle(from);
  if (
    userRec?.thread_id
    && resolvedTitle
    && resolvedTitle !== 'User'
    && (!userRec.title || userRec.title === 'User' || /^User(\s@|$)/i.test(userRec.title))
  ) {
    try {
      const edit = await tgCall(env, 'editForumTopic', {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: userRec.thread_id,
        name: resolvedTitle,
      });
      if (edit?.ok) {
        userRec = { ...userRec, title: resolvedTitle };
        await env.TOPIC_MAP.put(userKey, JSON.stringify(userRec));
      }
    } catch (e) {
      Logger.warn('info_topic_title_repair_failed', { userId, error: e?.message });
    }
  }

  const displayName = escapeHtml(
    [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || '未知',
  );
  const usernameText = from.username
    ? `@${escapeHtml(from.username)}`
    : '无';
  // t.me/username 在群内可点；tg://user?id= 在部分客户端对“群外用户”不可点
  const openLink = from.username
    ? `<a href="https://t.me/${escapeHtml(from.username)}">打开主页 @${escapeHtml(from.username)}</a>`
    : `<a href="tg://user?id=${userId}">打开用户资料</a>`;
  const topicTitle = escapeHtml(userRec?.title || resolvedTitle || '未知');
  const verifyText = verifyStatus
    ? (verifyStatus.type === 'trusted' ? '🌟 永久信任' : '✅ 已验证')
    : '❌ 未验证';
  const banText = banStatus ? '🚫 已封禁' : '✅ 正常';
  const muted = await env.TOPIC_MAP.get(`muted:${userId}`);
  const note = await env.TOPIC_MAP.get(`note:${userId}`);
  let lastMsgAt = null;
  let d1Status = null;
  if (env.TG_BOT_DB) {
    try {
      const u = await createD1Storage(env.TG_BOT_DB).getUser(userId);
      lastMsgAt = u?.lastMessageAt ?? null;
      d1Status = u?.status ?? null;
    } catch { /* ignore */ }
  }

  const info = [
    '👤 <b>用户信息</b>',
    `姓名: ${displayName}`,
    `用户名: ${usernameText}`,
    `UID: <code>${userId}</code>`,
    `Topic ID: <code>${threadId}</code>`,
    `话题标题: ${topicTitle}`,
    `验证: ${verifyText}`,
    `封禁: ${banText} · 静音: ${muted ? '🔇 是' : '否'} · 会话关闭: ${userRec?.closed ? '是' : '否'}`,
    d1Status ? `D1 状态: <code>${escapeHtml(d1Status)}</code>` : '',
    `最近消息: ${formatTimeBoth(lastMsgAt)}`,
    note ? `备注: ${escapeHtml(note)}` : '备注: 无（/note 内容）',
    `链接: ${openLink}`,
    from.username
      ? ''
      : '<i>无公开用户名时部分客户端无法点击 tg 链接</i>',
  ].filter(Boolean).join('\n');

  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: info,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildUserActionKeyboard(userId),
  });
}

/**
 * 管理员回复处理 — 编排层
 * 职责：权限检查 → 全局命令路由 → 用户反查 → 话题内指令路由 → 消息转发
 */
async function _handleAdminReplyInner(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const rawText = (msg.text || "").trim();
  const text = removeCommandBotSuffix(rawText); // 移除 @botname 后缀
  const senderId = msg.from?.id;
  const isCommand = !!text && text.startsWith('/');

  // 仅允许管理员在群内操作与回信，防止任意群成员向用户私聊注入消息
  if (!senderId || !(await isAdminUser(env, senderId))) {
    // 仅对已知管理命令提示，避免普通聊天被误伤
    const known = /^\/(help|menu|dashboard|sysinfo|system|status|stats|rank|activity|heat|whoami|find|notes|cleanup|listwords|addword|delword|panel|info|ban|unban|close|open|mute|unmute|trust|reset|note|synccommands)(@|\s|$)/i;
    if (isCommand && senderId && known.test(text)) {
      await tgCall(env, 'sendMessage', {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: '⛔ 无管理权限：仅群主/管理员或 ADMIN_IDS 可使用该指令。',
      });
    }
    return;
  }

  // /cleanup 二次确认
  if (text === "/cleanup") {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: '🧹 <b>确认清理无效话题？</b>\n将扫描失效 Topic 映射，可能耗时。',
      parse_mode: 'HTML',
      reply_markup: buildCleanupConfirmKeyboard(),
    });
    return;
  }

  // --- 全局命令路由表（不依赖 userId，可在 General 话题执行） ---
  if (text === "/help") {
    await handleHelpCommand(env, threadId, senderId);
    return;
  }
  if (text === "/menu" || text === "/dashboard") {
    await handleMenuCommand(env, threadId, senderId);
    return;
  }
  if (text === "/sysinfo" || text === "/system" || text === "/status") {
    await handleSysinfoCommand(env, threadId, { page: 'overview' });
    return;
  }
  if (text === "/stats") {
    await handleStatsCommand(env, threadId);
    return;
  }
  if (text === "/rank" || text === "/activity" || text === "/heat") {
    await handleRankCommand(env, threadId);
    return;
  }
  if (text === "/whoami") {
    await handleWhoamiCommand(env, threadId, senderId);
    return;
  }
  if (text === "/synccommands") {
    await handleSyncCommandsCommand(env, threadId, senderId);
    return;
  }
  if (text.startsWith("/find")) {
    await handleFindCommand(env, threadId, text);
    return;
  }
  if (text === "/notes" || text.startsWith("/notes ")) {
    await handleNotesCommand(env, threadId, text);
    return;
  }
  if (text.startsWith("/addword ")) {
    await handleAddWordCommand(env, threadId, text, senderId);
    return;
  }
  if (text.startsWith("/delword ")) {
    await handleDelWordCommand(env, threadId, text, senderId);
    return;
  }
  if (text === "/listwords") {
    await handleListWordsCommand(env, threadId);
    return;
  }

  // --- 以下命令需要 userId（必须在具体用户话题内执行） ---

  // 优先通过 thread 映射快速反查用户，缺失时再降级全量扫描
  let userId = null;
  const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mappedUser) {
    userId = Number(mappedUser);
  } else if (
    threadNotFoundCache.has(threadId)
    && Date.now() - threadNotFoundCache.get(threadId) < THREAD_NOT_FOUND_TTL_MS
  ) {
    // 负缓存：已知该 threadId 无映射，直接跳过
    if (isCommand) {
      await tgCall(env, 'sendMessage', {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: '⚠️ 当前话题未关联用户（请在对应用户 Forum Topic 内执行，或使用 /find）。',
      });
    }
    return;
  } else {
    // 降级全量扫描（带数量限制，防止 DoS）
    const allKeys = await getAllKeys(env, "user:");
    let scanned = 0;
    for (const { name } of allKeys) {
      if (++scanned > 200) break; // 限制最大扫描数，超过视为不存在
      const rec = await safeGetJSON(env, name, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        userId = Number(name.slice(5));
        break;
      }
    }
    // 扫描完仍未找到，加入负缓存
    if (!userId) {
      if (threadNotFoundCache.size >= THREAD_NOT_FOUND_MAX_ENTRIES) {
        threadNotFoundCache.delete(threadNotFoundCache.keys().next().value);
      }
      threadNotFoundCache.set(threadId, Date.now());
    }
  }

  // 如果找不到用户，说明可能是在普通话题，或者数据丢失，直接返回
  if (!userId) {
    if (isCommand) {
      await tgCall(env, 'sendMessage', {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: '⚠️ 当前话题未关联用户。全局命令：/sysinfo /stats /rank /find /notes /help',
      });
    }
    return;
  }

  // --- 话题内指令路由表 ---
  // /close /reset /ban 与面板按钮一致：二次确认
  if (text === "/close") {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `⚠️ <b>确认关闭对话</b> <code>${escapeHtml(String(userId))}</code>？\n将关闭 Forum Topic，用户消息不再接入（可用打开恢复）。`,
      parse_mode: 'HTML',
      reply_markup: buildCloseConfirmKeyboard(userId),
    });
    return;
  }
  if (text === "/open") { await handleOpenCommand(env, threadId, userId); return; }
  if (text === "/reset") {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `⚠️ <b>确认重置验证</b> <code>${escapeHtml(String(userId))}</code>？\n将取消永久信任，用户下次需重新验证。`,
      parse_mode: 'HTML',
      reply_markup: buildResetConfirmKeyboard(userId),
    });
    return;
  }
  if (text === "/trust") { await handleTrustCommand(env, threadId, userId); return; }
  if (text === "/ban") {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `⚠️ <b>确认封禁用户</b> <code>${escapeHtml(String(userId))}</code>？\n对方将收到通知且无法继续发消息。`,
      parse_mode: 'HTML',
      reply_markup: buildBanConfirmKeyboard(userId),
    });
    return;
  }
  if (text === "/unban") { await handleUnbanCommand(env, threadId, userId); return; }
  if (text === "/info") { await handleInfoCommand(env, threadId, userId); return; }
  if (text === "/panel") { await handlePanelCommand(env, threadId, userId); return; }
  if (text === "/mute") { await handleMuteCommand(env, threadId, userId); return; }
  if (text === "/unmute") { await handleUnmuteCommand(env, threadId, userId); return; }
  if (text.startsWith("/note")) { await handleNoteCommand(env, threadId, userId, text); return; }

  // 非命令消息：转发管理员回复给用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
    return;
  }
  const response = await tgCall(env, "copyMessage", {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id,
  });
  if (response.ok) {
    await saveLegacyMessageLink(env, {
      direction: 'admin_to_user',
      message: msg,
      targetChatId: userId,
      targetMessageId: response.result?.message_id,
      topicId: threadId,
      userId,
    });
  }
}

// ---------------- 验证模块 (纯本地) ----------------

async function sendVerificationChallenge(userId, env, pendingMsgId, from = null) {
  if (from) await saveUserProfileSnapshot(env, userId, from);
  // 追踪已写入的 KV 键，用于异常时回滚
  const writtenKeys = [];
  try {
    await _sendVerificationChallengeInner(userId, env, pendingMsgId, writtenKeys);
  } catch (e) {
    Logger.error('verification_challenge_failed', e, { userId });
    // 回滚已写入的部分状态，避免用户卡在无效验证状态
    for (const key of writtenKeys) {
      try { await env.TOPIC_MAP.delete(key); } catch { /* 忽略回滚错误 */ }
    }
    throw e; // 重新抛出，让调用方通知用户
  }
}

async function _sendVerificationChallengeInner(userId, env, pendingMsgId, writtenKeys) {
  // 检查是否已有进行中的验证
  const existingChallenge = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
  if (existingChallenge) {
    // 有正在进行的验证：仅将新消息加入待发送队列，避免重复下发题目/触发验证限速
    const chalKey = `chal:${existingChallenge}`;
    const state = await safeGetJSON(env, chalKey, null);

    // KV 可能存在不一致/过期：自愈清理后重新下发
    if (!state || state.userId !== userId) {
      await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
    } else {
      if (pendingMsgId) {
        let pendingIds = [];
        if (Array.isArray(state.pending_ids)) {
          pendingIds = state.pending_ids.slice();
        } else if (state.pending) {
          pendingIds = [state.pending];
        }

        if (!pendingIds.includes(pendingMsgId)) {
          pendingIds.push(pendingMsgId);
          if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
            pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
          }
          state.pending_ids = pendingIds;
          delete state.pending;
          await env.TOPIC_MAP.put(chalKey, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
        }
      }
      Logger.debug('verification_duplicate_skipped', { userId, verifyId: existingChallenge, hasPending: !!pendingMsgId });
      return;
    }
  }

  // 验证请求速率限制：仅在需要创建新挑战时检查
  const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
  if (!verifyLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ 验证请求过于频繁，请5分钟后再试。"
    });
    return;
  }

  // PR #12: 检查是否配置了 Turnstile
  const hasTurnstile = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.VERIFICATION_PAGE_URL);

  if (hasTurnstile) {
    await sendTurnstileChallenge(userId, env, pendingMsgId, writtenKeys);
  } else {
    await sendLocalQuizChallenge(userId, env, pendingMsgId, writtenKeys);
  }
}

/**
 * Turnstile 验证路径 — 发送验证按钮链接
 */
async function sendTurnstileChallenge(userId, env, pendingMsgId, writtenKeys) {
  const verifyCode = generateVerifyCode();
  const verifyUrl = `${env.VERIFICATION_PAGE_URL}/verify?code=${verifyCode}&uid=${userId}`;

  // 存储验证 code
  await env.TOPIC_MAP.put(`turnstile_code:${verifyCode}`, String(userId), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
  writtenKeys.push(`turnstile_code:${verifyCode}`);

  // 存储待转发消息
  if (pendingMsgId) {
    const pendingKey = `pending_turnstile:${userId}`;
    let pendingIds = [];
    try {
      const raw = await env.TOPIC_MAP.get(pendingKey);
      if (raw) pendingIds = JSON.parse(raw);
    } catch { /* 忽略 */ }
    if (!Array.isArray(pendingIds)) pendingIds = [];
    if (!pendingIds.includes(pendingMsgId)) {
      pendingIds.push(pendingMsgId);
      if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
        pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
      }
      await env.TOPIC_MAP.put(pendingKey, JSON.stringify(pendingIds), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
      writtenKeys.push(pendingKey);
    }
  }

  // 标记用户正在验证中
  await env.TOPIC_MAP.put(`user_challenge:${userId}`, `turnstile:${verifyCode}`, { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
  writtenKeys.push(`user_challenge:${userId}`);

  Logger.info('turnstile_verification_sent', { userId, verifyCode });

  // 发送验证按钮
  const verifyMsg = await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: VERIFY_COPY.turnstileChallenge,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: VERIFY_COPY.buttonTurnstile, url: verifyUrl }
      ]]
    }
  });

  // 发送失败时抛出异常，触发外层回滚（清理已写入的 turnstile_code、pending_turnstile、user_challenge）
  if (!verifyMsg.ok) {
    throw new Error(`Turnstile 验证消息发送失败: ${verifyMsg.description || '未知错误'}`);
  }

  // 存储验证消息 ID（验证成功后删除）
  if (verifyMsg.result?.message_id) {
    await env.TOPIC_MAP.put(`turnstile_msg:${verifyCode}`, String(verifyMsg.result.message_id), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
    writtenKeys.push(`turnstile_msg:${verifyCode}`);
  }
}

/**
 * 本地题库验证路径 — 发送选择题
 */
async function sendLocalQuizChallenge(userId, env, pendingMsgId, writtenKeys) {
  const q = LOCAL_QUESTIONS[secureRandomInt(0, LOCAL_QUESTIONS.length)];
  const challenge = {
    question: q.question,
    correct: q.correct_answer,
    options: shuffleArray([...q.incorrect_answers, q.correct_answer])
  };

  const verifyId = secureRandomId(CONFIG.VERIFY_ID_LENGTH);
  const answerIndex = challenge.options.indexOf(challenge.correct);

  const state = {
    answerIndex: answerIndex,
    options: challenge.options,
    pending_ids: pendingMsgId ? [pendingMsgId] : [],
    userId: userId
  };

  await env.TOPIC_MAP.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
  writtenKeys.push(`chal:${verifyId}`);
  await env.TOPIC_MAP.put(`user_challenge:${userId}`, verifyId, { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
  writtenKeys.push(`user_challenge:${userId}`);

  Logger.info('verification_sent', {
    userId,
    verifyId,
    question: q.question,
    pendingCount: state.pending_ids.length
  });

  const buttons = challenge.options.map((opt, idx) => ({
    text: opt,
    callback_data: `verify:${verifyId}:${idx}`
  }));

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += CONFIG.BUTTON_COLUMNS) {
    keyboard.push(buttons.slice(i, i + CONFIG.BUTTON_COLUMNS));
  }

  // 发送验证题目
  const quizMsg = await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: VERIFY_COPY.quizChallenge(escapeHtml(challenge.question)),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard }
  });

  // 发送失败时抛出异常，触发外层回滚（清理已写入的 chal、user_challenge）
  if (!quizMsg.ok) {
    throw new Error(`本地题库验证消息发送失败: ${quizMsg.description || '未知错误'}`);
  }
}

async function handleCallbackQuery(query, env, ctx) {
  try {
    const data = query.data;
    if (!data.startsWith("verify:")) return;

    const parts = data.split(":");
    if (parts.length !== 3) return;

    const verifyId = parts[1];
    const selectedIndex = parseInt(parts[2]);
    const userId = query.from.id;

    const stateStr = await env.TOPIC_MAP.get(`chal:${verifyId}`);
    if (!stateStr) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: VERIFY_COPY.expired,
        show_alert: true
      });
      return;
    }

    let state;
    try {
      state = JSON.parse(stateStr);
    } catch(e) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: VERIFY_COPY.dataError,
        show_alert: true
      });
      return;
    }

    // 验证用户ID匹配
    if (state.userId && state.userId !== userId) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: VERIFY_COPY.invalidUser,
        show_alert: true
      });
      return;
    }

    // 验证索引有效性
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: VERIFY_COPY.invalidOption,
        show_alert: true
      });
      return;
    }

    if (selectedIndex === state.answerIndex) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: VERIFY_COPY.successToast
      });

      Logger.info('verification_passed', {
        userId,
        verifyId,
        selectedOption: state.options[selectedIndex]
      });
      await bumpDailyStat(env, 'verifies', 1);

      // 30天有效期
      await ephemeralStore(env).setVerification(userId, {
        ttl: CONFIG.VERIFIED_EXPIRE_SECONDS,
        verifiedAt: Date.now(),
      });
      await env.TOPIC_MAP.delete(`needs_verify:${userId}`);

      // 清理所有相关挑战
      await env.TOPIC_MAP.delete(`chal:${verifyId}`);
      await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

      const hasPending = (Array.isArray(state.pending_ids) && state.pending_ids.length > 0) || !!state.pending;
      await tgCall(env, "editMessageText", {
        chat_id: userId,
        message_id: query.message.message_id,
        text: hasPending ? VERIFY_COPY.successBodyWithPending : VERIFY_COPY.successBody,
        parse_mode: "HTML"
      });

      if (hasPending) {
        await forwardPendingMessages(state, userId, query, env, ctx);
      }
    } else {
      Logger.info('verification_failed', {
        userId,
        verifyId,
        selectedIndex,
        correctIndex: state.answerIndex
      });

      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: VERIFY_COPY.wrongAnswer,
        show_alert: true
      });
      // 在题目消息上追加提示，避免用户不知道还能继续选
      try {
        const prev = String(query.message?.text || '');
        if (prev && !prev.includes('回答不正确') && query.message?.message_id) {
          const buttons = (state.options || []).map((opt, idx) => ({
            text: opt,
            callback_data: `verify:${verifyId}:${idx}`
          }));
          const keyboard = [];
          for (let i = 0; i < buttons.length; i += CONFIG.BUTTON_COLUMNS) {
            keyboard.push(buttons.slice(i, i + CONFIG.BUTTON_COLUMNS));
          }
          await tgCall(env, 'editMessageText', {
            chat_id: userId,
            message_id: query.message.message_id,
            text: `${prev}${VERIFY_COPY.wrongAnswerHint}`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
          });
        }
      } catch { /* 编辑失败不影响 toast */ }
    }
  } catch (e) {
    Logger.error('callback_query_error', e, {
      userId: query.from?.id,
      callbackData: query.data
    });
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: VERIFY_COPY.systemError,
      show_alert: true
    });
  }
}

/**
 * 验证通过后转发待处理消息 — 并行转发 + 去重 + 通知用户
 * @param {object} state - 验证挑战状态（含 pending_ids）
 * @param {number} userId - 用户 ID
 * @param {object} query - Telegram callback query 对象
 * @param {object} env - 环境变量
 * @param {object} ctx - Worker context
 */
async function forwardPendingMessages(state, userId, query, env, ctx) {
  try {
    let pendingIds = [];
    if (Array.isArray(state.pending_ids)) {
      pendingIds = state.pending_ids.slice();
    } else if (state.pending) {
      pendingIds = [state.pending];
    }

    // 限制一次性转发量，避免用户恶意堆积导致执行超时
    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
      pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
    }

    // 并行转发待处理消息（并发限制为 3，平衡速度与 API 限流）
    const CONCURRENT_FORWARDS = 3;
    let forwardedCount = 0;
    let skippedCount = 0;
    for (let i = 0; i < pendingIds.length; i += CONCURRENT_FORWARDS) {
      const batch = pendingIds.slice(i, i + CONCURRENT_FORWARDS);
      const results = await Promise.allSettled(batch.map(async (pendingId) => {
        if (!pendingId) return { forwarded: false, reason: 'empty_id' };
        const forwardedKey = `forwarded:${userId}:${pendingId}`;
        const alreadyForwarded = await env.TOPIC_MAP.get(forwardedKey);
        if (alreadyForwarded) {
          Logger.info('message_forward_duplicate_skipped', { userId, messageId: pendingId });
          return { forwarded: false, reason: 'already_forwarded' };
        }
        const topicFrom = await resolveUserFromForTopic(env, userId, query?.from);
        const fakeMsg = {
          message_id: pendingId,
          chat: { id: userId, type: "private" },
          from: topicFrom,
        };
        await forwardToTopic(fakeMsg, userId, `user:${userId}`, env, ctx);
        await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
        return { forwarded: true };
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.forwarded) {
          forwardedCount++;
        } else if (r.status === 'fulfilled' && !r.value?.forwarded) {
          skippedCount++;
        } else if (r.status === 'rejected') {
          Logger.warn('pending_forward_item_failed', { userId, error: r.reason?.message });
        }
      }
    }

    if (forwardedCount > 0) {
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
      });
    }
  } catch (e) {
    Logger.error('pending_message_forward_failed', e, { userId });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "⚠️ 自动发送失败，请重新发送您的消息。"
    });
  }
}

// ---------------- 辅助函数 ----------------

/**
 * 批量清理命令处理函数（优化并发性能）
 *
 * 功能说明：
 * 1. 检查所有用户的话题记录
 * 2. 找出话题ID已不存在（被删除）的用户
 * 3. 删除这些用户的KV存储记录和验证状态
 * 4. 让他们下次发消息时重新验证并创建新话题
 *
 * 使用场景：
 * - 管理员手动删除了多个用户话题后
 * - 需要批量重置这些用户的状态
 *
 * @param {number} threadId - 当前话题ID（通常在General话题中调用）
 * @param {object} env - 环境变量对象
 */
async function handleCleanupCommand(threadId, env) {
  const lockKey = "cleanup:lock";
  const locked = await env.TOPIC_MAP.get(lockKey);
  if (locked) {
    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: "⏳ **已有清理任务正在运行，请稍后再试。**",
      parse_mode: "Markdown"
    }, threadId));
    return;
  }

  await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

  // 发送处理中的消息
  await tgCall(env, "sendMessage", withMessageThreadId({
    chat_id: env.SUPERGROUP_ID,
    text: "🔄 **正在扫描需要清理的用户...**",
    parse_mode: "Markdown"
  }, threadId));

  let cleanedCount = 0;
  let errorCount = 0;
  const cleanedUsers = [];
  let scannedCount = 0;

  try {
    // 逐页扫描，避免一次性拉取全部 keys 导致超时/内存膨胀
    let cursor = undefined;
    do {
      const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
      const names = (result.keys || []).map(k => k.name);
      scannedCount += names.length;

      // 批量并发处理（限制并发数）
      for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
        const batch = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map(async (name) => {
            const rec = await safeGetJSON(env, name, null);
            if (!rec || !rec.thread_id) return null;

            const userId = name.slice(5);
            const topicThreadId = rec.thread_id;

            // 检测话题是否存在：尝试向话题发送测试消息
            const probe = await probeForumThread(env, topicThreadId, {
              userId,
              reason: "cleanup_check",
              doubleCheckOnMissingThreadId: false
            });

            // cleanup 要求更保守：仅在明确缺失/重定向时清理，避免误删有效记录
            if (probe.status === "redirected" || probe.status === "missing") {
              await env.TOPIC_MAP.delete(name);
              await setPersistentTrust(env, userId, 'normal');
              await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);

              return {
                userId,
                threadId: topicThreadId,
                title: rec.title || "未知"
              };
            } else if (probe.status === "probe_invalid") {
              Logger.warn('cleanup_probe_invalid_message', {
                userId,
                threadId: topicThreadId,
                errorDescription: probe.description
              });
            } else if (probe.status === "unknown_error") {
              Logger.warn('cleanup_probe_failed_unknown', {
                userId,
                threadId: topicThreadId,
                errorDescription: probe.description
              });
            } else if (probe.status === "missing_thread_id") {
              Logger.warn('cleanup_probe_missing_thread_id', { userId, threadId: topicThreadId });
            }

            return null;
          })
        );

        // 处理结果
        results.forEach(result => {
          if (result.status === 'fulfilled' && result.value) {
            cleanedCount++;
            cleanedUsers.push(result.value);
            Logger.info('cleanup_user', {
              userId: result.value.userId,
              threadId: result.value.threadId
            });
          } else if (result.status === 'rejected') {
            errorCount++;
            Logger.error('cleanup_batch_error', result.reason);
          }
        });

        // 防止速率限制
        if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) {
          await new Promise(r => setTimeout(r, 600));
        }
      }

      cursor = result.list_complete ? undefined : result.cursor;

      // 在分页之间让出时间片，降低单次执行压力
      if (cursor) {
        await new Promise(r => setTimeout(r, 200));
      }
    } while (cursor);

    // 生成并发送清理报告
    let reportText = `✅ **清理完成**\n\n`;
    reportText += `📊 **统计信息**\n`;
    reportText += `- 扫描用户数: ${scannedCount}\n`;
    reportText += `- 已清理用户数: ${cleanedCount}\n`;
    reportText += `- 错误数: ${errorCount}\n\n`;

    if (cleanedCount > 0) {
      reportText += `🗑️ **已清理的用户** (话题已删除):\n`;
      for (const user of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY)) {
        reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
      }
      if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY) {
        reportText += `\n...(还有 ${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} 个用户)\n`;
      }
      reportText += `\n💡 这些用户下次发消息时将重新进行人机验证并创建新话题。`;
    } else {
      reportText += `✨ 没有发现需要清理的用户记录。`;
    }

    Logger.info('cleanup_completed', {
      cleanedCount,
      errorCount,
      totalUsers: scannedCount
    });

    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: reportText,
      parse_mode: "Markdown"
    }, threadId));

  } catch (e) {
    Logger.error('cleanup_failed', e, { threadId });
    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\``,
      parse_mode: "Markdown"
    }, threadId));
  } finally {
    await env.TOPIC_MAP.delete(lockKey);
  }
}

// ---------------- 其他辅助函数 ----------------

// 为话题建立 thread->user 映射，避免管理员命令时全量 KV 反查
async function createTopic(from, key, env, userId) {
  const title = buildTopicTitle(from);
  if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  if (userId) {
    await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
  }
  return rec;
}

// 更新话题状态
async function updateThreadStatus(threadId, isClosed, env) {
  try {
    const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
    if (mappedUser) {
      const userKey = `user:${mappedUser}`;
      const rec = await safeGetJSON(env, userKey, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        rec.closed = isClosed;
        await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
        Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: 1 });
        return;
      }

      // 映射失效：清理后降级全量扫描
      await env.TOPIC_MAP.delete(`thread:${threadId}`);
    }

    const allKeys = await getAllKeys(env, "user:");
    const updates = [];

    for (const { name } of allKeys) {
      const rec = await safeGetJSON(env, name, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        rec.closed = isClosed;
        updates.push(env.TOPIC_MAP.put(name, JSON.stringify(rec)));
      }
    }

    await Promise.all(updates);
    Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: updates.length });
  } catch (e) {
    Logger.error('thread_status_update_failed', e, { threadId, isClosed });
    throw e;
  }
}

// 改进的话题标题构建（清理特殊字符）
// 期望输入 Telegram User 形态：{ first_name, last_name, username }
// 资料缺失时勿在调用方传入仅 { id } 的 from（会退化为 "User"）；应先 resolveUserFromForTopic。
function buildTopicTitle(from) {
  const src = from || {};
  const firstName = (src.first_name || src.firstName || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (src.last_name || src.lastName || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

  // 清理 username
  let username = "";
  const rawUsername = src.username || "";
  if (rawUsername) {
    username = String(rawUsername)
      .replace(/[^\w]/g, '') // 只保留字母数字下划线
      .substring(0, 20);
  }

  // 移除控制字符和换行符
  const cleanName = (firstName + " " + lastName)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  const client = createTelegramClient({
    botToken: env.BOT_TOKEN,
    apiBase: env.API_BASE,
    timeoutMs: timeout,
    logger: Logger,
  });
  try {
    return await client.call(method, body);
  } catch (error) {
    if (error instanceof TelegramApiError) {
      Logger.error('telegram_api_failed', error, {
        method,
        category: error.category,
        attempts: error.attempts,
      });
      return error.response || {
        ok: false,
        error_code: error.status || undefined,
        description: error.message,
        parameters: error.retryAfter ? { retry_after: error.retryAfter } : undefined,
      };
    }
    throw error;
  }
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
  const groupId = msg.media_group_id;
  const key = `mg:${direction}:${groupId}`;
  const item = extractMedia(msg);
  if (!item) {
    await tgCall(env, "copyMessage", withMessageThreadId({
      chat_id: targetChat,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    }, threadId));
    return;
  }
  let rec = await safeGetJSON(env, key, null);
  if (!rec) rec = { direction, targetChat, threadId: (threadId === null ? undefined : threadId), items: [], last_ts: Date.now() };
  rec.items.push({ ...item, msg_id: msg.message_id });
  rec.last_ts = Date.now();
  await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
  ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

// 改进的媒体提取（支持更多类型，不修改原数组）
function extractMedia(msg) {
  // 图片
  if (msg.photo && msg.photo.length > 0) {
    const highestResolution = msg.photo[msg.photo.length - 1]; // 不使用 pop()
    return {
      type: "photo",
      id: highestResolution.file_id,
      cap: msg.caption || ""
    };
  }

  // 视频
  if (msg.video) {
    return {
      type: "video",
      id: msg.video.file_id,
      cap: msg.caption || ""
    };
  }

  // 文档
  if (msg.document) {
    return {
      type: "document",
      id: msg.document.file_id,
      cap: msg.caption || ""
    };
  }

  // 音频
  if (msg.audio) {
    return {
      type: "audio",
      id: msg.audio.file_id,
      cap: msg.caption || ""
    };
  }

  // 动图
  if (msg.animation) {
    return {
      type: "animation",
      id: msg.animation.file_id,
      cap: msg.caption || ""
    };
  }

  // 语音和视频消息不支持 media group
  return null;
}

// 实现媒体组清理
async function flushExpiredMediaGroups(env, now) {
  try {
    const prefix = "mg:";
    const allKeys = await getAllKeys(env, prefix);
    let deletedCount = 0;

    for (const { name } of allKeys) {
      const rec = await safeGetJSON(env, name, null);
      if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { // 超过 5 分钟
        await env.TOPIC_MAP.delete(name);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      Logger.info('media_groups_cleaned', { deletedCount });
    }
  } catch (e) {
    Logger.error('media_group_cleanup_failed', e);
  }
}

// 改进媒体组延迟发送
async function delaySend(env, key, ts) {
  await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

  const rec = await safeGetJSON(env, key, null);

  if (rec && rec.last_ts === ts) {
    // 验证媒体数组
    if (!rec.items || rec.items.length === 0) {
      Logger.warn('media_group_empty', { key });
      await env.TOPIC_MAP.delete(key);
      return;
    }

    const media = rec.items.map((it, i) => {
      if (!it.type || !it.id) {
        Logger.warn('media_group_invalid_item', { key, item: it });
        return null;
      }
      // 限制 caption 长度
      const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
      return {
        type: it.type,
        media: it.id,
        caption
      };
    }).filter(Boolean); // 过滤掉无效项

    if (media.length > 0) {
      try {
        const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({
          chat_id: rec.targetChat,
          media
        }, rec.threadId));

        if (!result.ok) {
          Logger.error('media_group_send_failed', result.description, {
            key,
            mediaCount: media.length
          });
        } else {
          Logger.info('media_group_sent', {
            key,
            mediaCount: media.length,
            targetChat: rec.targetChat
          });
        }
      } catch (e) {
        Logger.error('media_group_send_exception', e, { key });
      }
    }

    await env.TOPIC_MAP.delete(key);
  }
}

const workerApp = createApp({
  handleFetch: legacyApp.fetch.bind(legacyApp),
});

export default {
  fetch: workerApp.fetch.bind(workerApp),
  scheduled(event, env, ctx) {
    ctx.waitUntil(workerApp.scheduled(event, env, ctx));
  },
};
