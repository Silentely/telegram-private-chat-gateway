import { createApp } from './src/app.js';
import { createAdminService } from './src/admin-service.js';
import {
  createConversationService,
  hashContent,
  snapshotMessage,
} from './src/conversation-service.js';
import { createLogger } from './src/logger.js';
import { evaluateMessagePolicy, buildLegacyBlockedRules } from './src/message-policy.js';
import { createTelegramClient, TelegramApiError, classifyTelegramError } from './src/telegram-client.js';
import { createD1Storage } from './src/storage/d1-storage.js';
import { ensureMigrations } from './src/storage/migrations.js';
import { createEphemeralStore } from './src/storage/kv-ephemeral-store.js';
import { createUpdateHandler } from './src/update-router.js';
import { getBlockedWords } from './src/blocked-words.js';
import { createAdminActions } from './src/admin-actions.js';
import { createVerificationModule } from './src/verification.js';
import { createMediaGroupModule } from './src/media-group.js';
import { createSpamModule } from './src/spam.js';
import { bumpDailyStat } from './src/daily-stats.js';
import {
  escapeHtml,
  SEP_LINE,
  formatUserStatusChips,
  buildUserActionKeyboard,
  buildBanConfirmKeyboard,
  buildCloseConfirmKeyboard,
  buildResetConfirmKeyboard,
  buildCleanupConfirmKeyboard,
  confirmBanText,
  confirmCloseText,
  confirmResetText,
  CLEANUP_CONFIRM_TEXT,
} from './src/admin-ui-format.js';
import { createAdminCommandHandlers } from './src/admin-commands.js';
import { VERIFY_COPY } from './src/verify-copy.js';
import { renderVerifyPage, renderVerifyErrorPage } from './src/verify-page.js';
import { USER_COPY, ADMIN_COPY } from './src/user-copy.js';
import {
  normalizeTgDescription,
  isTopicMissingOrDeleted,
  isTestMessageInvalid,
  cleanProfileText,
  createThrottle,
  isPlaceholderTopicTitle,
  normalizeRecentErrorItem,
  secureRandomId,
  isAdminCommandText,
  GATEWAY_REPO,
  noticeKey,
} from './src/utils.js';

// Telegram Private Chat Gateway — Cloudflare Workers 私聊安全接入与双向会话网关
// 纯函数工具统一来自 src/utils.js（单文件部署由 esbuild bundle 完成，勿在本文件内重复定义）

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
  RATE_LIMIT_VERIFY_CALLBACK: 15,       // verify-callback IP 限流：15 次/分钟
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
  SPAM_SILENCE_MODE: false,             // 静默丢弃模式（不通知管理员）
  ALERT_THROTTLE_MS: 60000,             // 管理告警节流：同类型 60 秒内最多一条
  WORD_MAX_LENGTH: 50,                  // /addword 单词长度上限，防 KV 词库被超长输入污染
  MEDIA_GROUP_CLEANUP_PROBABILITY: 0.05, // 过期媒体组扫描概率：键自带 60s TTL，孤儿键极少，无需每条消息全量扫 KV
  RETRY_COUNT_TTL_SECONDS: 3600,        // 话题健康重试计数有效期：超过即视为从未失败，避免历史失败永久生效
};

/** 网关版本（展示于 /sysinfo） */
const GATEWAY_VERSION = '1.4.0';

/** 话题占位标题：资料缺失时建话题的兜底名称，出现即视为需要修复 */
const TOPIC_TITLE_PLACEHOLDER = 'User';
/** 低频状态（封禁/静音）每小时最多提醒一次的 KV TTL */
const HOURLY_NOTICE_TTL_SECONDS = 3600;

// 线程健康检查缓存，减少频繁探测请求
const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();
// thread 映射缺失时的负缓存（避免重复全量扫描已知不存在的话题）
const threadNotFoundCache = new Map();
// thread->user 映射进程内缓存：映射建立后不再变化，命中即跳过每条消息一次的补建 KV 读
const threadMappingCache = new Map();
const THREAD_MAPPING_CACHE_TTL_MS = 10 * 60 * 1000;
const THREAD_MAPPING_CACHE_MAX_ENTRIES = 2000;
const ruleCache = new WeakMap();
const THREAD_NOT_FOUND_TTL_MS = 5 * 60 * 1000;
const THREAD_NOT_FOUND_MAX_ENTRIES = 1000;
const ADMIN_STATUS_MAX_ENTRIES = 1000;
const THREAD_HEALTH_MAX_ENTRIES = 1000;
/** 话题状态降级全量反查的最大分页数（每页 1000 键），防止超大命名空间拖垮请求 */
const TOPIC_SCAN_MAX_PAGES = 20;
/** Topic 创建锁等待轮询延时（毫秒）：获取锁失败后按序等待再重读 */
const TOPIC_LOCK_RETRY_DELAYS_MS = [150, 225, 300];

function setBoundedCache(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

// --- 辅助工具函数 ---

// 结构化日志系统：错误统一经由 onError 写入系统错误环形缓冲与 KV
const Logger = createLogger({}, console, {
  onError: (action, error, data = {}) => {
    try {
      recordSystemError(action, error, data, data?.env || null);
    } catch { /* 忽略环形缓冲失败 */ }
  },
});

// 进程内最近错误环形缓冲（isolate 生命周期内有效；并尽力写入 KV）
const RECENT_SYSTEM_ERRORS_MAX = 12;
const recentSystemErrors = [];
// 系统错误写入 KV 节流：错误风暴期间内存环形缓冲全量保留，KV 尽力写入降频，避免放大 KV 写入成本
const systemErrorKvThrottle = createThrottle({ windowMs: 30000 });

function recordSystemError(action, error, data = {}, env = null) {
  const entry = normalizeRecentErrorItem({
    ts: Date.now(),
    action,
    error: error instanceof Error ? error.message : String(error ?? ''),
    userId: data?.userId,
    updateId: data?.updateId,
    correlationId: data?.correlationId,
  });
  recentSystemErrors.unshift(entry);
  if (recentSystemErrors.length > RECENT_SYSTEM_ERRORS_MAX) {
    recentSystemErrors.length = RECENT_SYSTEM_ERRORS_MAX;
  }
  if (env?.TOPIC_MAP && systemErrorKvThrottle('sys:recent_errors')) {
    Promise.resolve()
      .then(async () => {
        let list = [];
        try {
          const raw = await env.TOPIC_MAP.get('sys:recent_errors');
          if (raw) list = JSON.parse(raw);
        } catch { list = []; }
        if (!Array.isArray(list)) list = [];
        list = list.map(normalizeRecentErrorItem).filter(Boolean);
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

// --- 子模块装配（依赖均为本文件内声明/导入的函数，全部惰性引用） ---
const adminActions = createAdminActions({
  tgCall,
  safeGetJSON,
  escapeHtml,
  SEP_LINE,
  formatUserStatusChips,
  buildUserActionKeyboard,
  createD1Storage,
  setPersistentTrust,
  getVerificationState,
  resolveUserFromForTopic,
  buildTopicTitle,
  bumpDailyStat,
  probeForumThread,
  config: CONFIG,
  logger: Logger,
});

const verificationModule = createVerificationModule({
  config: CONFIG,
  tgCall,
  safeGetJSON,
  ephemeralStore,
  checkRateLimit,
  bumpDailyStat,
  resolveUserFromForTopic,
  forwardToTopic,
  saveUserProfileSnapshot,
  shuffleArray,
  secureRandomInt,
  secureRandomId,
  logger: Logger,
});

const mediaGroup = createMediaGroupModule({
  config: CONFIG,
  tgCall,
  safeGetJSON,
  logger: Logger,
});

// 垃圾内容检测与处理（关键词/链接/重复 + 管理员告警 + 统计）
const spamModule = createSpamModule({
  config: CONFIG,
  logger: Logger,
  escapeHtml,
  adminCopy: ADMIN_COPY,
  safeGetJSON,
  tgCall,
  getVerificationTimestamp: (env, userId) => ephemeralStore(env).getVerificationTimestamp(userId),
  setBoundedCache,
});
const {
  spamCheck,
  handleSpamMessage,
  pruneMessageHashCache,
} = spamModule;

const adminHandlers = createAdminCommandHandlers({
  tgCall,
  gatewayVersion: GATEWAY_VERSION,
  gatewayRepo: GATEWAY_REPO,
  recordSystemError,
  isOwnerUser,
  isAdminUser,
  parseIdAllowlist,
  safeGetJSON,
  resolveThreadIdForUser,
  getRecentSystemErrors: () => recentSystemErrors,
  handleCleanupCommand: adminActions.cleanup,
  handleListWordsCommand: adminActions.listWords,
  createD1Storage,
  ensureMigrations,
  userActions: adminActions,
});

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
    getBlockedWords(env, false, Logger),
    getVerificationState(env, user.userId ?? message.chat?.id),
    getStoredRules(env),
  ]);
  const rules = buildLegacyBlockedRules(blockedWords);
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
  });
}

// ID 白名单解析缓存：环境变量在实例生命周期内不变，避免每次权限判断重复 split
const idAllowlistParseCache = new Map();
const ID_ALLOWLIST_CACHE_MAX = 64;

/** 解析逗号/空白分隔的 Telegram 用户 ID 列表为 Set（带缓存） */
function parseIdAllowlistSet(raw) {
  const key = String(raw || '');
  let set = idAllowlistParseCache.get(key);
  if (!set) {
    set = new Set(
      key
        .split(/[,;\s]+/g)
        .map(value => value.trim())
        .filter(value => /^\d{1,20}$/.test(value)),
    );
    if (idAllowlistParseCache.size >= ID_ALLOWLIST_CACHE_MAX) {
      idAllowlistParseCache.delete(idAllowlistParseCache.keys().next().value);
    }
    idAllowlistParseCache.set(key, set);
  }
  return set;
}

/** 解析逗号/空白分隔的 Telegram 用户 ID 列表为字符串数组 */
function parseIdAllowlist(raw) {
  return [...parseIdAllowlistSet(raw)];
}

function idAllowlistHas(raw, userId) {
  return parseIdAllowlistSet(raw).has(String(userId));
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
    || await readLegacyKvUser(env, userId)
    || { userId: String(userId) };
  await d1Storage.upsertUser({ ...existing, userId: String(userId), trustLevel });
  await ephemeralStore(env).clearVerification(userId);
}

/**
 * 读取 KV 旧版 user: 记录作为 D1 兜底（迁移期用户资料尚未写入 D1 时使用）。
 * 替代已删除的 createKVStorage 模块，仅保留 setPersistentTrust 需要的字段。
 */
async function readLegacyKvUser(env, userId) {
  const rec = await safeGetJSON(env, `user:${userId}`, null);
  if (!rec || typeof rec !== 'object') return null;
  return {
    userId: String(userId),
    username: rec.username ?? null,
    firstName: rec.first_name ?? null,
    lastName: rec.last_name ?? null,
    topicId: rec.thread_id == null ? null : String(rec.thread_id),
  };
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

// 加密安全的随机数生成（拒绝采样消除取模偏差）
function secureRandomInt(min, max) {
  const range = max - min;
  if (range <= 0) return min;
  const limit = Math.floor(0x100000000 / range) * range;
  const bytes = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0];
  } while (value >= limit);
  return min + (value % range);
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

// 验证相关 JSON 响应统一禁用缓存：验证 code 单次有效，任何缓存都会导致过期误判
function verifyJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
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
 * 写去重：同 isolate 内资料指纹未变化且在 TTL 窗口内时不重复写 KV——
 * 用户资料极少变动，高频消息流可把「每消息一次 KV put」降为「资料变化时才写」。
 */
const profileSnapshotCache = new Map(); // userId -> { fingerprint, ts }
const PROFILE_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const PROFILE_SNAPSHOT_MAX_ENTRIES = 2000;

function profileFingerprint(from) {
  return [from.first_name || '', from.last_name || '', from.username || ''].join('\u0001');
}

async function saveUserProfileSnapshot(env, userId, from) {
  if (!env?.TOPIC_MAP || !userId || isSparseTelegramFrom(from)) return;
  const fingerprint = profileFingerprint(from);
  const now = Date.now();
  const cached = profileSnapshotCache.get(String(userId));
  if (cached && cached.fingerprint === fingerprint && now - cached.ts < PROFILE_SNAPSHOT_TTL_MS) {
    return; // 资料未变化，跳过 KV 写入
  }
  try {
    await env.TOPIC_MAP.put(`profile:${userId}`, JSON.stringify({
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      username: from.username || null,
      saved_at: Date.now(),
    }), { expirationTtl: 30 * 24 * 3600 });
    setBoundedCache(profileSnapshotCache, String(userId), { fingerprint, ts: now }, PROFILE_SNAPSHOT_MAX_ENTRIES);
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

    for (const delay of TOPIC_LOCK_RETRY_DELAYS_MS) {
      await new Promise(resolve => setTimeout(resolve, delay));
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

  await verificationModule.sendVerificationChallenge(userId, env, pendingMsgId || null);
}

function parseAdminIdAllowlist(env) {
  const set = parseIdAllowlistSet(env.ADMIN_IDS);
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
    Logger.warn('admin_check_failed', { userId, error: e?.message });
    return false;
  }
}

// 获取所有 KV keys（处理分页；maxPages=0 表示不限制页数）
async function getAllKeys(env, prefix, maxPages = 0) {
  const allKeys = [];
  let cursor = undefined;
  let pages = 0;

  do {
    const result = await env.TOPIC_MAP.list({ prefix, cursor });
    allKeys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
    pages += 1;
  } while (cursor && (maxPages <= 0 || pages < maxPages));

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


// Turnstile 验证页面模板与渲染函数见 src/verify-page.js（独立模块便于单测）

const legacyApp = {
  /**
   * 业务层 HTTP 入口。
   * @param {Request} request
   * @param {object} env - 已由 app.js normalize 的 env
   * @param {object} ctx
   * @param {object|null} [parsedUpdate] - POST / 的 webhook update 由 app.js 解析后透传，
   *   避免此处二次读取请求体（GET /verify 与 POST /verify-callback 仍自行处理）
   */
  async fetch(request, env, ctx, parsedUpdate = null) {
    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    // env 已由 app.js normalizeEnv 规范化（BOT_TOKEN/SUPERGROUP_ID 等已转字符串并 trim），
    // 此处直接引用同一对象，避免对同一请求重复包装
    const normalizedEnv = env;

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
      return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    const url = new URL(request.url);

    // --- PR #12: GET 请求处理 ---

    if (request.method === "GET") {
      // 健康检查（app.js 短路处理；此处保持一致以防直接调用 legacyApp.fetch）
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response("OK", {
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      // Turnstile 验证页面（用户点击 bot 按钮后跳转到的页面）
      if (url.pathname === "/verify" || url.pathname.endsWith("/verify")) {
        const code = url.searchParams.get('code');
        const userId = url.searchParams.get('uid');
        const siteKey = (env.TURNSTILE_SITE_KEY || '').toString().trim();

        if (!code || !userId || !siteKey || !/^\d{1,20}$/.test(userId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(code)) {
          const hint = siteKey
            ? VERIFY_COPY.pageErrorMissingParams.hintResend
            : VERIFY_COPY.pageErrorMissingParams.hintNoSiteKey;
          return new Response(renderVerifyErrorPage({
            message: VERIFY_COPY.pageErrorMissingParams.message,
            hint,
          }), {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer',
            },
          });
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

        return new Response(renderVerifyPage({
          siteKey,
          code,
          userId,
          workerUrl,
          // 过期提示分钟数对齐 TURNSTILE_VERIFY_TTL，避免页面文案与后端有效期漂移
          verifyExpireMinutes: CONFIG.TURNSTILE_VERIFY_TTL / 60,
        }),
          {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              // 验证链接单次有效：禁用一切缓存，防止浏览器/Telegram 内置浏览器复用旧页面
              'Cache-Control': 'no-store',
              'Content-Security-Policy': csp,
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer',
            },
          }
        );
      }

      return new Response("Not Found", { status: 404 });
    }

    // --- POST 请求处理（Telegram webhook + Turnstile token 验证） ---

    // PR #12: Turnstile token 验证端点（由前端页面 JS fetch 调用）
    if ((url.pathname === "/verify-callback" || url.pathname.endsWith("/verify-callback")) && request.method === "POST") {
      const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
      const ipRateLimit = await checkRateLimit(clientIp, env, 'verify_cb_ip', CONFIG.RATE_LIMIT_VERIFY_CALLBACK, 60);
      if (!ipRateLimit.allowed) {
        Logger.warn('turnstile_callback_rate_limited', { clientIp });
        return verifyJsonResponse({ success: false, error: 'rate_limited' }, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        // 非法 JSON 属客户端错误，返回 400 而非 500，避免错误日志噪声
        return verifyJsonResponse({ success: false, error: 'invalid_json' }, 400);
      }
      try {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return verifyJsonResponse({ success: false, error: 'missing_params' }, 400);
        }

        const { token, code, userId } = body;

        if (
          typeof token !== 'string' ||
          token.trim() === '' ||
          token.length > 2048 ||
          typeof code !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(code) ||
          (typeof userId !== 'string' && typeof userId !== 'number') ||
          !/^\d{1,20}$/.test(String(userId))
        ) {
          return verifyJsonResponse({ success: false, error: 'missing_params' }, 400);
        }

        // 验证 Turnstile token
        const turnstileSecret = (env.TURNSTILE_SECRET_KEY || '').toString().trim();
        if (!turnstileSecret) {
          return verifyJsonResponse({ success: false, error: 'server_not_configured' }, 500);
        }

        const verifyResult = await verificationModule.verifyTurnstileToken(token, turnstileSecret);
        if (!verifyResult.success) {
          Logger.warn('turnstile_token_invalid', { userId, error: verifyResult.error });
          return verifyJsonResponse({ success: false, error: 'turnstile_failed', detail: verifyResult.error }, 403);
        }

        // 从 KV 验证 code 是否匹配
        const storedUserId = await env.TOPIC_MAP.get(`turnstile_code:${code}`);
        if (!storedUserId || storedUserId !== String(userId)) {
          if (storedUserId) {
            // 安全防御：code 存在但 userId 不匹配，视为探测或攻击尝试，立即清除该 code 防止继续爆破
            await env.TOPIC_MAP.delete(`turnstile_code:${code}`);
            Logger.warn('turnstile_code_mismatch_cleared', { userId, storedUserId, clientIp });
          }
          return verifyJsonResponse({ success: false, error: 'code_invalid_or_expired' }, 403);
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
                message_id: parseInt(verifyMsgId, 10)
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
              const limited = pendingIds.slice(-CONFIG.PENDING_MAX_MESSAGES);
              ctx.waitUntil((async () => {
                try {
                  await verificationModule.forwardPendingMessageIds(userId, limited, normalizedEnv, ctx, { from: null });
                } catch (e) {
                  Logger.error('pending_turnstile_forward_failed', e, { userId });
                }
                await env.TOPIC_MAP.delete(pendingKey);
              })());
            }
          } catch (e) {
            Logger.error('pending_turnstile_parse_failed', e, { userId });
          }
        }

        return verifyJsonResponse({ success: true, pendingCount });
      } catch (e) {
        Logger.error('verify_callback_error', e);
        return verifyJsonResponse({ success: false, error: 'server_error' }, 500);
      }
    }

    // Webhook 消息体由 app.js 校验并解析后透传（parsedUpdate），此处不再重复读取
    let update = parsedUpdate;
    if (update === null || update === undefined || typeof update !== 'object') {
      Logger.warn('invalid_update_payload', {
        hasUpdate: update !== null && update !== undefined,
      });
      return new Response("Bad Request", { status: 400 });
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
        await adminHandlers.handleAdminUiCallback(update.callback_query, normalizedEnv, ctx);
      } else if (cbData.startsWith('v1:')) {
        await createLegacyAdminService(normalizedEnv)
          .handleCallbackQuery(update.callback_query);
      } else {
        await verificationModule.handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      }
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 概率性清理过期媒体组：媒体组键自带 60s TTL，孤儿键极少，
    // 按 MEDIA_GROUP_CLEANUP_PROBABILITY 抽样执行，避免每条消息都触发一次 KV list
    if (Math.random() < CONFIG.MEDIA_GROUP_CLEANUP_PROBABILITY) {
      ctx.waitUntil(mediaGroup.flushExpiredMediaGroups(normalizedEnv, Date.now()));
    }
    // 概率性清理过期缓存（1% 请求触发一次，分摊成本）
    if (Math.random() < 0.01) {
      pruneMessageHashCache(Date.now());
    }

    if (msg.chat && msg.chat.type === "private") {
      try {
        const ptext = removeCommandBotSuffix((msg.text || '').trim());
        // 用户向简短帮助（非管理员也能看）
        if (ptext === '/help') {
          // 限流时长按 RATE_LIMIT_WINDOW 注入，避免 FAQ 文案与配置漂移
          const rateLimitMinutes = Math.max(1, Math.round(CONFIG.RATE_LIMIT_WINDOW / 60));
          await tgCall(normalizedEnv, 'sendMessage', {
            chat_id: msg.chat.id,
            text: USER_COPY.helpText(rateLimitMinutes),
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
        // 私聊路径失败返回 200 且不抛错是刻意设计：Telegram 对 5xx 重试会导致
        // 同一条用户消息被重复转发（转发无幂等）。可重试标记机制仅用于
        // 回调等可安全重放的路径（edited_message / v1 回调）。
        // 不向用户泄露技术细节
        try {
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: msg.chat.id,
            text: USER_COPY.systemBusy,
          });
        } catch (notifyError) {
          // 兜底通知自身失败不得再抛出：上面的设计意图是私聊路径永不 5xx
          Logger.warn('system_busy_notify_failed', { userId: msg.chat.id, error: notifyError?.message });
        }
        Logger.error('private_message_failed', e, {
          userId: msg.chat.id,
          updateId: update?.update_id,
        });
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
        await handleAdminReply(msg, normalizedEnv, ctx, update?.update_id);
        return new Response("OK");
      }
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

/**
 * 低频状态（封禁/静音）每小时最多提醒一次：避免用户反复发送时被重复打扰。
 * @param {string} kvKey - 节流标记 KV 键（由 utils.noticeKey 生成；勿命名为 noticeKey 以免遮蔽导入）
 * @returns {Promise<boolean>} 本次是否实际发送了提醒
 */
async function sendHourlyNotice(env, userId, kvKey, text) {
  try {
    if (await env.TOPIC_MAP.get(kvKey)) return false;
    await tgCall(env, 'sendMessage', { chat_id: userId, text });
    await env.TOPIC_MAP.put(kvKey, '1', { expirationTtl: HOURLY_NOTICE_TTL_SECONDS });
    return true;
  } catch (e) {
    Logger.warn('hourly_notice_failed', { userId, noticeKey: kvKey, error: e?.message });
    return false;
  }
}

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.rateLimited(Math.max(1, Math.round(CONFIG.RATE_LIMIT_WINDOW / 60))),
    });
    return;
  }

  // 尽早缓存资料，供验证通过后的消息回放建话题使用。
  // 放在限流检查之后：被限流的消息不会进入验证/转发链路，无需触发 KV 写
  await saveUserProfileSnapshot(env, userId, msg.from);

  // 拦截普通用户发送的指令（/help 已在入口处理；/start 及深链参数走验证/无操作流程）。
  // 已知管理指令与未知指令都给一次性（每小时节流）友好提示，避免用户误发后毫无反馈
  const privateCommand = removeCommandBotSuffix((msg.text || '').trim());
  if (msg.text && msg.text.startsWith("/") && !/^\/start(\s|$)/i.test(privateCommand)) {
    if (isAdminCommandText(privateCommand)) {
      await sendHourlyNotice(env, userId, noticeKey.cmdHint(userId), USER_COPY.adminCommandHint);
    } else {
      await sendHourlyNotice(env, userId, noticeKey.cmdUnknown(userId), USER_COPY.unknownCommandHint);
    }
    return;
  }

  const [isBanned, isMuted] = await Promise.all([
    env.TOPIC_MAP.get(`banned:${userId}`),
    env.TOPIC_MAP.get(`muted:${userId}`),
  ]);
  // 统一走 evaluateLegacyPolicy：与编辑消息路径共用同一策略评估，
  // 使 D1 动态规则（blocked_keyword / auto_reply 等）对新消息同样生效
  const policyResult = await evaluateLegacyPolicy(env, msg, {
    userId,
    status: isBanned ? 'banned' : 'active',
  });

  if (policyResult.reason === 'banned') {
    // 避免用户不知道已被封禁仍反复发送；每小时最多提醒一次
    await sendHourlyNotice(env, userId, noticeKey.ban(userId), USER_COPY.bannedHourly);
    return;
  }
  // 静音：仍接收但不转发到管理群（每小时提示一次）
  if (isMuted) {
    await sendHourlyNotice(env, userId, noticeKey.mute(userId), USER_COPY.mutedHourly);
    return;
  }
  if (policyResult.reason === 'blocked_keyword') {
    const ruleId = policyResult.matchedRuleId || '';
    // legacy_blocked:N 映射到屏蔽词表；D1 规则命中时记录规则 ID，避免越界取词
    let word = ruleId;
    if (ruleId.startsWith('legacy_blocked:')) {
      const matchedIndex = Number(ruleId.split(':')[1]);
      const blockedWords = await getBlockedWords(env, false, Logger);
      word = blockedWords[matchedIndex] ?? ruleId;
    }
    Logger.info('message_blocked_by_word', { userId, word });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.blockedWord,
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
    // /start 及其深链参数（/start payload）不进入待转发队列：
    // 验证通过后不把指令文本转发给管理员
    const isStart = msg.text && /^\/start(\s|$)/i.test(removeCommandBotSuffix(msg.text.trim()));
    const pendingMsgId = isStart ? null : msg.message_id;
    await verificationModule.sendVerificationChallenge(userId, env, pendingMsgId, msg.from);
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

  // 已验证用户发送 /start（含深链参数）或 /cancel 视为无操作命令，不转发到管理话题（未验证用户不会走到这里）
  const commandText = removeCommandBotSuffix((msg.text || '').trim());
  if (/^\/start(\s|$)/i.test(commandText) || commandText === '/cancel') return;

  // 入站统计异步写入：不阻塞用户可见的转发链路（KV 读改写约几十毫秒）
  if (ctx?.waitUntil) {
    ctx.waitUntil(bumpDailyStat(env, 'messages_in', 1));
  } else {
    await bumpDailyStat(env, 'messages_in', 1);
  }
  await forwardToTopic(msg, userId, key, env, ctx);
}

/**
 * 消息转发到话题 — 主入口（编排层）
 * 职责：前置检查 → 获取/创建话题 → 健康检查 → 执行转发
 */
async function forwardToTopic(msg, userId, key, env, ctx) {
  // 前置三项 KV 读相互独立，并行拉取：每条消息少两次串行 KV 往返
  const retryKey = `retry:${userId}`;
  const [needsVerify, initialRec, retryRaw] = await Promise.all([
    env.TOPIC_MAP.get(`needs_verify:${userId}`),
    safeGetJSON(env, key, null),
    env.TOPIC_MAP.get(retryKey),
  ]);

  // 并发兜底：如果已被标记为需要重新验证，直接发起验证并暂停转发/建话题
  if (needsVerify) {
    await verificationModule.sendVerificationChallenge(userId, env, msg.message_id || null, msg.from);
    return;
  }

  // 获取用户话题记录
  let rec = initialRec;

  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: USER_COPY.conversationClosed });
    return;
  }

  // 重试计数器检查：连续未知错误达到上限后暂停转发并提示（见 checkThreadHealth 递增）
  const retryCount = parseInt(retryRaw ?? "0", 10);
  if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: USER_COPY.retryExceeded });
    await env.TOPIC_MAP.delete(retryKey);
    return;
  }

  // 获取或创建话题
  if (!rec || !rec.thread_id) {
    rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
    if (!rec || !rec.thread_id) {
      throw new Error("创建话题失败");
    }
  } else if (isPlaceholderTopicTitle(rec.title)) {
    // 修复 Turnstile 回放建话题时资料缺失导致的占位标题
    try {
      const resolvedFrom = await resolveUserFromForTopic(env, userId, msg.from);
      const title = buildTopicTitle(resolvedFrom);
      if (title && title !== TOPIC_TITLE_PLACEHOLDER && title !== rec.title) {
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

  // 补建 thread->user 映射（兼容旧数据）；进程内命中即跳过，避免每条消息一次 KV 读
  if (rec.thread_id) {
    const mappingKey = String(rec.thread_id);
    const cachedMapping = threadMappingCache.get(mappingKey);
    if (!cachedMapping || Date.now() - cachedMapping.ts >= THREAD_MAPPING_CACHE_TTL_MS) {
      const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
      if (!mappedUser) {
        await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
      }
      setBoundedCache(threadMappingCache, mappingKey, { ts: Date.now() }, THREAD_MAPPING_CACHE_MAX_ENTRIES);
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
    await mediaGroup.handleMediaGroup(msg, env, ctx, {
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
    // 累计瞬态失败：连续未知错误达到上限后由 forwardToTopic 暂停转发并提示用户。
    // 计数器带 TTL，健康探测成功时会被清除，避免历史失败永久生效。
    const currentRetry = parseInt((await env.TOPIC_MAP.get(retryKey)) ?? '0', 10);
    await env.TOPIC_MAP.put(retryKey, String(currentRetry + 1), { expirationTtl: CONFIG.RETRY_COUNT_TTL_SECONDS });
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

/** 管理告警节流器：同类型告警 ALERT_THROTTLE_MS 内最多一条，防故障期告警刷屏 */
const adminAlertThrottle = createThrottle({ windowMs: CONFIG.ALERT_THROTTLE_MS });

/**
 * 发送管理员告警到超级群（HTML 解析模式）。
 * 同类型告警按 ALERT_THROTTLE_MS 节流；发送失败仅记录日志，不得影响主流程。
 */
async function notifyAdmin(env, type, text) {
  if (!adminAlertThrottle(`admin_alert:${type}`)) {
    Logger.warn('admin_alert_throttled', { type });
    return;
  }
  try {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch (e) {
    Logger.warn('admin_alert_failed', { type, error: e?.message });
  }
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

  // 与 telegram-client 共用同一错误分类，避免手写描述匹配漂移
  const category = classifyTelegramError({
    status: res.error_code,
    description: res.description,
  }).category;
  if (category === 'chat_not_found') throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
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
    await notifyAdmin(
      env,
      'forward_failed',
      ADMIN_COPY.forwardTotalFail(
        String(userId),
        String(threadId),
        res.description || '',
        copyRes.description || '',
      ),
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

async function handleAdminReply(msg, env, ctx, updateId) {
  try {
    await _handleAdminReplyInner(msg, env, ctx);
  } catch (e) {
    Logger.error('admin_reply_failed', e, {
      threadId: msg?.message_thread_id,
      senderId: msg?.from?.id,
      updateId,
    });
  }
}

// --- 管理员命令处理函数 ---

function isOwnerUser(env, userId) {
  return idAllowlistHas(env.OWNER_IDS, userId);
}


/** 管理命令 handlers（惰性创建，闭包绑定 userActions） */


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
    if (isCommand && senderId && isAdminCommandText(text)) {
      await tgCall(env, 'sendMessage', {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.noPermissionHint,
      });
    }
    return;
  }

  // /cleanup 二次确认
  if (text === "/cleanup") {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: CLEANUP_CONFIRM_TEXT,
      parse_mode: 'HTML',
      reply_markup: buildCleanupConfirmKeyboard(),
    });
    return;
  }

  // --- 全局命令路由表（不依赖 userId，可在 General 话题执行） ---
  if (text === "/help") {
    await adminHandlers.handleHelpCommand(env, threadId, senderId);
    return;
  }
  if (text === "/menu" || text === "/dashboard") {
    await adminHandlers.handleMenuCommand(env, threadId, senderId);
    return;
  }
  if (text === "/sysinfo" || text === "/system" || text === "/status") {
    await adminHandlers.handleSysinfoCommand(env, threadId, { page: 'overview' });
    return;
  }
  if (text === "/stats") {
    await adminHandlers.handleStatsCommand(env, threadId);
    return;
  }
  if (text === "/rank" || text === "/activity" || text === "/heat") {
    await adminHandlers.handleRankCommand(env, threadId);
    return;
  }
  if (text === "/whoami") {
    await adminHandlers.handleWhoamiCommand(env, threadId, senderId);
    return;
  }
  if (text === "/synccommands") {
    await adminHandlers.handleSyncCommandsCommand(env, threadId, senderId);
    return;
  }
  if (text.startsWith("/find")) {
    await adminHandlers.handleFindCommand(env, threadId, text);
    return;
  }
  if (text === "/notes" || text.startsWith("/notes ")) {
    await adminHandlers.handleNotesCommand(env, threadId, text);
    return;
  }
  if (text.startsWith("/addword ")) {
    await adminActions.addWord(env, threadId, text, senderId);
    return;
  }
  if (text.startsWith("/delword ")) {
    await adminActions.delWord(env, threadId, text, senderId);
    return;
  }
  if (text === "/listwords") {
    await adminActions.listWords(env, threadId);
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
        text: ADMIN_COPY.threadNotLinked,
      });
    }
    return;
  } else {
    // 降级扫描（带数量限制，防止 DoS；分批并发读取缩短反查延迟）。
    // 直接单次 list 取前 scanLimit 个 user: 键，避免 getAllKeys 无上限分页后再截断的浪费
    const scanLimit = 200; // 最大扫描数，超过视为不存在
    const scanBatch = 20;  // 每批并发读数量，平衡延迟与 KV 压力
    const listed = await env.TOPIC_MAP.list({ prefix: 'user:', limit: scanLimit });
    const candidates = listed.keys || [];
    for (let i = 0; i < candidates.length && !userId; i += scanBatch) {
      const batch = candidates.slice(i, i + scanBatch);
      const results = await Promise.all(batch.map(async ({ name }) => {
        const rec = await safeGetJSON(env, name, null);
        return rec && Number(rec.thread_id) === Number(threadId) ? name : null;
      }));
      const hit = results.find(Boolean);
      if (hit) userId = Number(hit.slice(5));
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
        text: ADMIN_COPY.threadNotLinkedGlobal,
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
      text: confirmCloseText(userId),
      parse_mode: 'HTML',
      reply_markup: buildCloseConfirmKeyboard(userId),
    });
    return;
  }
  if (text === "/open") { await adminActions.open(env, threadId, userId); return; }
  if (text === "/reset") {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: confirmResetText(userId),
      parse_mode: 'HTML',
      reply_markup: buildResetConfirmKeyboard(userId),
    });
    return;
  }
  if (text === "/trust") { await adminActions.trust(env, threadId, userId); return; }
  if (text === "/ban") {
    await tgCall(env, 'sendMessage', {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: confirmBanText(userId),
      parse_mode: 'HTML',
      reply_markup: buildBanConfirmKeyboard(userId),
    });
    return;
  }
  if (text === "/unban") { await adminActions.unban(env, threadId, userId); return; }
  if (text === "/info") { await adminActions.info(env, threadId, userId); return; }
  if (text === "/panel") { await adminActions.panel(env, threadId, userId); return; }
  if (text === "/mute") { await adminActions.mute(env, threadId, userId); return; }
  if (text === "/unmute") { await adminActions.unmute(env, threadId, userId); return; }
  if (text.startsWith("/note")) { await adminActions.note(env, threadId, userId, text); return; }

  // 非命令消息：转发管理员回复给用户
  if (msg.media_group_id) {
    await mediaGroup.handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
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

    const allKeys = await getAllKeys(env, "user:", TOPIC_SCAN_MAX_PAGES);
    const updates = [];
    const scanBatch = 20;

    // 分批并发读取（每批 20），避免降级扫描时逐条串行等待 KV 拖垮请求
    for (let i = 0; i < allKeys.length; i += scanBatch) {
      const batch = allKeys.slice(i, i + scanBatch);
      const records = await Promise.all(batch.map(({ name }) => safeGetJSON(env, name, null)));
      for (let j = 0; j < batch.length; j += 1) {
        const rec = records[j];
        if (rec && Number(rec.thread_id) === Number(threadId)) {
          rec.closed = isClosed;
          updates.push(env.TOPIC_MAP.put(batch[j].name, JSON.stringify(rec)));
        }
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

  // 移除控制字符和换行符（与 src/utils.js cleanProfileText 同一规则）
  const cleanName = cleanProfileText(firstName + " " + lastName);

  const name = cleanName || TOPIC_TITLE_PLACEHOLDER;
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// Telegram 客户端实例缓存：同一 botToken/apiBase 下复用，避免每条消息重建对象
const telegramClientCache = new Map();

function getTelegramClient(env, timeout = CONFIG.API_TIMEOUT_MS) {
  const key = `${env.BOT_TOKEN}|${env.API_BASE || ''}|${timeout}`;
  let client = telegramClientCache.get(key);
  if (!client) {
    client = createTelegramClient({
      botToken: env.BOT_TOKEN,
      apiBase: env.API_BASE,
      timeoutMs: timeout,
      // 动态解析全局 fetch：测试通过 stubGlobal 替换时也能生效
      fetchImpl: (...args) => fetch(...args),
      logger: Logger,
    });
    telegramClientCache.set(key, client);
  }
  return client;
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  const client = getTelegramClient(env, timeout);
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

const workerApp = createApp({
  handleFetch: legacyApp.fetch.bind(legacyApp),
});

export default {
  fetch: workerApp.fetch.bind(workerApp),
  scheduled(event, env, ctx) {
    // 定时任务失败需记录并进入系统错误缓冲（/sysinfo 错误页可见），
    // 避免 waitUntil 未处理拒绝只留痕在 CF 日志里
    ctx.waitUntil(
      workerApp.scheduled(event, env, ctx).catch((error) => {
        Logger.error('scheduled_failed', error);
      }),
    );
  },
};
