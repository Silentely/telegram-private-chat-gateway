// src/config.js
var KNOWN_ENV_KEYS = Object.freeze([
  "BOT_TOKEN",
  "WEBHOOK_SECRET",
  "SUPERGROUP_ID",
  "OWNER_IDS",
  "ADMIN_IDS",
  "SPAM_KEYWORDS",
  "API_BASE",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "VERIFICATION_PAGE_URL",
  "TOPIC_MAP",
  "TG_BOT_DB"
]);
var STRING_ENV_KEYS = Object.freeze([
  "BOT_TOKEN",
  "WEBHOOK_SECRET",
  "SUPERGROUP_ID",
  "OWNER_IDS",
  "ADMIN_IDS",
  "SPAM_KEYWORDS",
  "API_BASE",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "VERIFICATION_PAGE_URL"
]);
function listEnvKeys(env = {}) {
  try {
    return Object.keys(env);
  } catch {
    return [];
  }
}
function readEnvValue(env, key) {
  if (env == null) return void 0;
  if (Object.prototype.hasOwnProperty.call(env, key) || env[key] !== void 0) {
    const direct = env[key];
    if (direct !== void 0 && direct !== null) {
      if (typeof direct !== "string" || direct.trim().length > 0) {
        return direct;
      }
    }
  }
  const target = String(key);
  for (const actual of listEnvKeys(env)) {
    if (actual !== key && actual.trim() === target) {
      return env[actual];
    }
  }
  return env[key];
}
function normalizeEnv(env = {}) {
  const normalized = { ...env };
  for (const key of STRING_ENV_KEYS) {
    const value = readEnvValue(env, key);
    normalized[key] = value === void 0 || value === null ? "" : String(value).trim();
  }
  for (const key of ["TOPIC_MAP", "TG_BOT_DB"]) {
    const value = readEnvValue(env, key);
    if (value !== void 0 && value !== null) {
      normalized[key] = value;
    }
  }
  return normalized;
}
function describeBindingShape(value) {
  if (value === void 0 || value === null) {
    return { present: false, jsType: "nullish" };
  }
  const jsType = typeof value;
  if (jsType === "string") {
    return {
      present: value.trim().length > 0,
      jsType: "string",
      // 字符串说明多半是 Text/Secret 变量，不是 D1/KV Binding
      looksLikeBinding: false,
      hasPrepare: false,
      hasGet: false,
      hasPut: false
    };
  }
  if (jsType !== "object" && jsType !== "function") {
    return { present: true, jsType, looksLikeBinding: false };
  }
  return {
    present: true,
    jsType: "object",
    looksLikeBinding: true,
    hasPrepare: typeof value.prepare === "function",
    hasBatch: typeof value.batch === "function",
    hasGet: typeof value.get === "function",
    hasPut: typeof value.put === "function"
  };
}
function inspectEnvPresence(env = {}) {
  const presence = {};
  for (const key of KNOWN_ENV_KEYS) {
    const value = readEnvValue(env, key);
    if (value === void 0 || value === null) {
      presence[key] = false;
    } else if (typeof value === "string") {
      presence[key] = value.trim().length > 0;
    } else {
      presence[key] = true;
    }
  }
  const keys = listEnvKeys(env).sort();
  const mistypedKeys = keys.filter((name) => {
    const trimmed = name.trim();
    return name !== trimmed && KNOWN_ENV_KEYS.includes(trimmed);
  });
  const bindings = {
    TOPIC_MAP: describeBindingShape(readEnvValue(env, "TOPIC_MAP")),
    TG_BOT_DB: describeBindingShape(readEnvValue(env, "TG_BOT_DB"))
  };
  return { presence, keys, mistypedKeys, bindings };
}
function formatEnvPresenceDetail(env = {}) {
  const { presence, keys, mistypedKeys, bindings } = inspectEnvPresence(env);
  const present = Object.entries(presence).filter(([, ok]) => ok).map(([name]) => name);
  const missing = Object.entries(presence).filter(([, ok]) => !ok).map(([name]) => name);
  const mistyped = mistypedKeys.length ? ` | mistypedKeys=${mistypedKeys.map((k) => JSON.stringify(k)).join(",")}` : "";
  const d1 = bindings?.TG_BOT_DB;
  const kv = bindings?.TOPIC_MAP;
  const bindingHint = ` | d1=${d1?.jsType || "none"}/prepare=${Boolean(d1?.hasPrepare)} | kv=${kv?.jsType || "none"}/get=${Boolean(kv?.hasGet)}`;
  return ` | present=${present.join(",") || "none"} | missing=${missing.join(",") || "none"} | keys=${keys.join(",") || "none"}${mistyped}${bindingHint}`;
}
function assertD1Binding(db, name = "TG_BOT_DB") {
  if (db == null) {
    throw new Error(`D1 '${name}' not bound`);
  }
  if (typeof db === "string") {
    throw new Error(
      `D1 '${name}' is a string variable, not a D1 Database binding. Delete the Text/Secret named TG_BOT_DB and add Bindings \u2192 D1 Database with variable name TG_BOT_DB.`
    );
  }
  if (typeof db.prepare !== "function") {
    throw new Error(
      `D1 '${name}' is bound but has no prepare() (got ${typeof db}). In Cloudflare Dashboard: Settings \u2192 Bindings \u2192 add D1 Database, variable name must be exactly TG_BOT_DB.`
    );
  }
  return db;
}
function validateBaseEnv(env) {
  if (!env.TOPIC_MAP) throw new Error("KV 'TOPIC_MAP' not bound");
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN not set");
  if (!env.SUPERGROUP_ID) throw new Error("SUPERGROUP_ID not set");
  if (!env.SUPERGROUP_ID.startsWith("-100")) {
    throw new Error("SUPERGROUP_ID must start with -100");
  }
}
function validateWebhookEnv(env) {
  if (!env.WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET not set");
  if (new TextEncoder().encode(env.WEBHOOK_SECRET).length < 32) {
    throw new Error("WEBHOOK_SECRET must be at least 32 bytes");
  }
}

// src/storage/migrations.js
var migrationPromises = /* @__PURE__ */ new WeakMap();
var SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )
`;
var VERSION_1_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    trust_level TEXT NOT NULL DEFAULT 'normal',
    is_muted INTEGER NOT NULL DEFAULT 0,
    violation_count INTEGER NOT NULL DEFAULT 0,
    topic_id TEXT,
    info_card_message_id TEXT,
    profile_snapshot TEXT,
    topic_lock_token TEXT,
    topic_lock_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_message_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS processed_updates (
    update_id TEXT PRIMARY KEY,
    update_type TEXT,
    claimed_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'processing',
    error_code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS message_links (
    direction TEXT NOT NULL,
    source_chat_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    target_chat_id TEXT NOT NULL,
    target_message_id TEXT NOT NULL,
    topic_id TEXT,
    user_id TEXT NOT NULL,
    content_snapshot TEXT,
    content_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (direction, source_chat_id, source_message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    rule_id TEXT PRIMARY KEY,
    rule_type TEXT NOT NULL,
    pattern TEXT,
    response_text TEXT,
    action TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    value_type TEXT NOT NULL DEFAULT 'string',
    updated_by TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_users (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    granted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    before_state TEXT,
    after_state TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_topic_id
    ON users(topic_id) WHERE topic_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`,
  `CREATE INDEX IF NOT EXISTS idx_users_last_message_at ON users(last_message_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rules_type_enabled_priority
    ON rules(rule_type, enabled, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_processed_updates_claimed_at
    ON processed_updates(claimed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_message_links_created_at
    ON message_links(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at
    ON admin_audit_log(created_at)`
];
async function runMigrations(db, now) {
  await db.prepare(SCHEMA_MIGRATIONS_SQL).run();
  const applied = await db.prepare(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
  ).first();
  if (Number(applied?.version ?? 0) >= 1) return;
  await db.batch(VERSION_1_STATEMENTS.map((sql) => db.prepare(sql)));
  await db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  ).bind(1, "initial_schema", now).run();
}
function ensureMigrations(db, now = Date.now()) {
  if (!db || typeof db !== "object" && typeof db !== "function") {
    return Promise.reject(new Error("D1 'TG_BOT_DB' must be a Database binding"));
  }
  if (!migrationPromises.has(db)) {
    const promise = runMigrations(db, now).catch((error) => {
      migrationPromises.delete(db);
      throw error;
    });
    migrationPromises.set(db, promise);
  }
  return migrationPromises.get(db);
}

// src/storage/d1-storage.js
var UPDATE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1e3;
var USER_UPDATE_COLUMNS = {
  username: "username",
  firstName: "first_name",
  lastName: "last_name",
  status: "status",
  trustLevel: "trust_level",
  isMuted: "is_muted",
  violationCount: "violation_count",
  topicId: "topic_id",
  infoCardMessageId: "info_card_message_id",
  profileSnapshot: "profile_snapshot",
  lastMessageAt: "last_message_at"
};
function storageValue(key, value) {
  if (key === "isMuted") return value ? 1 : 0;
  if (key === "violationCount") return Number(value || 0);
  if (key === "topicId" || key === "infoCardMessageId") {
    return value == null ? null : String(value);
  }
  return value ?? null;
}
var d1StorageCache = /* @__PURE__ */ new WeakMap();
function createD1Storage(db) {
  if (db && (typeof db === "object" || typeof db === "function")) {
    const cached = d1StorageCache.get(db);
    if (cached) return cached;
  }
  const storage = buildD1Storage(db);
  if (db && (typeof db === "object" || typeof db === "function")) {
    d1StorageCache.set(db, storage);
  }
  return storage;
}
function buildD1Storage(db) {
  function mapUser(row) {
    if (!row) return null;
    return {
      userId: String(row.user_id),
      username: row.username ?? null,
      firstName: row.first_name ?? null,
      lastName: row.last_name ?? null,
      status: row.status,
      trustLevel: row.trust_level,
      isMuted: Boolean(row.is_muted),
      violationCount: Number(row.violation_count || 0),
      topicId: row.topic_id == null ? null : String(row.topic_id),
      infoCardMessageId: row.info_card_message_id == null ? null : String(row.info_card_message_id),
      profileSnapshot: row.profile_snapshot ?? null,
      topicLockToken: row.topic_lock_token ?? null,
      topicLockUntil: row.topic_lock_until ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at ?? null
    };
  }
  function mapRule(row) {
    if (!row) return null;
    let metadata = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      metadata = {};
    }
    return {
      ruleId: row.rule_id,
      ruleType: row.rule_type,
      matchType: metadata.matchType || "contains",
      pattern: row.pattern,
      responseText: row.response_text,
      action: row.action,
      priority: Number(row.priority ?? 100),
      enabled: Boolean(row.enabled),
      createdBy: row.created_by
    };
  }
  const storage = {
    async getUser(userId) {
      const row = await db.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).bind(String(userId)).first();
      return mapUser(row);
    },
    async ensureUser(user) {
      const now = Date.now();
      await db.prepare(`
        INSERT OR IGNORE INTO users (
          user_id, username, first_name, last_name, status, trust_level,
          is_muted, violation_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 'normal', 0, 0, ?, ?)
      `).bind(
        String(user.userId),
        user.username ?? null,
        user.firstName ?? null,
        user.lastName ?? null,
        user.createdAt ?? now,
        user.updatedAt ?? now
      ).run();
      return storage.getUser(user.userId);
    },
    async upsertUser(user) {
      const now = Date.now();
      await db.prepare(`
        INSERT INTO users (
          user_id, username, first_name, last_name, status, trust_level,
          is_muted, violation_count, topic_id, info_card_message_id,
          profile_snapshot, created_at, updated_at, last_message_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          status = excluded.status,
          trust_level = excluded.trust_level,
          is_muted = excluded.is_muted,
          violation_count = excluded.violation_count,
          topic_id = excluded.topic_id,
          info_card_message_id = excluded.info_card_message_id,
          profile_snapshot = excluded.profile_snapshot,
          updated_at = excluded.updated_at,
          last_message_at = excluded.last_message_at
      `).bind(
        String(user.userId),
        user.username ?? null,
        user.firstName ?? null,
        user.lastName ?? null,
        user.status ?? "active",
        user.trustLevel ?? "normal",
        user.isMuted ? 1 : 0,
        Number(user.violationCount || 0),
        user.topicId == null ? null : String(user.topicId),
        user.infoCardMessageId == null ? null : String(user.infoCardMessageId),
        user.profileSnapshot ?? null,
        user.createdAt ?? now,
        user.updatedAt ?? now,
        user.lastMessageAt ?? null
      ).run();
    },
    async findUserByTopic(topicId) {
      const row = await db.prepare(`
        SELECT * FROM users WHERE topic_id = ?
      `).bind(String(topicId)).first();
      return mapUser(row);
    },
    async updateUserState(userId, changes) {
      const entries = Object.entries(changes).filter(([key]) => USER_UPDATE_COLUMNS[key]);
      if (entries.length === 0) return storage.getUser(userId);
      const assignments = entries.map(([key]) => `${USER_UPDATE_COLUMNS[key]} = ?`);
      const values = entries.map(([key, value]) => storageValue(key, value));
      await db.prepare(`
        UPDATE users
        SET ${assignments.join(", ")}, updated_at = ?
        WHERE user_id = ?
      `).bind(...values, Date.now(), String(userId)).run();
      return storage.getUser(userId);
    },
    async acquireTopicLock(userId, token, now, ttlMs = 3e4) {
      const result = await db.prepare(`
        UPDATE users
        SET topic_lock_token = ?, topic_lock_until = ?, updated_at = ?
        WHERE user_id = ?
          AND topic_id IS NULL
          AND (
            topic_lock_token IS NULL
            OR topic_lock_until < ?
            OR topic_lock_token = ?
          )
      `).bind(token, now + ttlMs, now, String(userId), now, token).run();
      return result.meta?.changes === 1;
    },
    async releaseTopicLock(userId, token, now = Date.now()) {
      await db.prepare(`
        UPDATE users
        SET topic_lock_token = NULL, topic_lock_until = NULL, updated_at = ?
        WHERE user_id = ? AND topic_lock_token = ?
      `).bind(now, String(userId), token).run();
    },
    async setTopic(userId, topicId, token, now = Date.now()) {
      const result = await db.prepare(`
        UPDATE users
        SET topic_id = ?, topic_lock_token = NULL, topic_lock_until = NULL,
            updated_at = ?
        WHERE user_id = ? AND topic_lock_token = ?
      `).bind(String(topicId), now, String(userId), token).run();
      return result.meta?.changes === 1;
    },
    async clearTopic(userId, topicId, now = Date.now()) {
      const result = await db.prepare(`
        UPDATE users
        SET topic_id = NULL, topic_lock_token = NULL, topic_lock_until = NULL,
            updated_at = ?
        WHERE user_id = ? AND topic_id = ?
      `).bind(now, String(userId), String(topicId)).run();
      return result.meta?.changes === 1;
    },
    async saveMessageLink(link) {
      const now = link.updatedAt ?? Date.now();
      await db.prepare(`
        INSERT INTO message_links (
          direction, source_chat_id, source_message_id, target_chat_id,
          target_message_id, topic_id, user_id, content_snapshot,
          content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(direction, source_chat_id, source_message_id) DO UPDATE SET
          target_chat_id = excluded.target_chat_id,
          target_message_id = excluded.target_message_id,
          topic_id = excluded.topic_id,
          user_id = excluded.user_id,
          content_snapshot = excluded.content_snapshot,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).bind(
        link.direction,
        String(link.sourceChatId),
        String(link.sourceMessageId),
        String(link.targetChatId),
        String(link.targetMessageId),
        link.topicId == null ? null : String(link.topicId),
        String(link.userId),
        link.contentSnapshot ?? null,
        link.contentHash ?? null,
        link.createdAt ?? now,
        now
      ).run();
    },
    async getMessageLink(direction, sourceChatId, sourceMessageId) {
      const row = await db.prepare(`
        SELECT * FROM message_links
        WHERE direction = ? AND source_chat_id = ? AND source_message_id = ?
      `).bind(direction, String(sourceChatId), String(sourceMessageId)).first();
      if (!row) return null;
      return {
        direction: row.direction,
        sourceChatId: row.source_chat_id,
        sourceMessageId: row.source_message_id,
        targetChatId: row.target_chat_id,
        targetMessageId: row.target_message_id,
        topicId: row.topic_id,
        userId: row.user_id,
        contentSnapshot: row.content_snapshot,
        contentHash: row.content_hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },
    async getAdminUser(userId) {
      const row = await db.prepare(`
        SELECT * FROM admin_users WHERE user_id = ?
      `).bind(String(userId)).first();
      return row ? {
        userId: row.user_id,
        role: row.role,
        enabled: Boolean(row.enabled),
        grantedBy: row.granted_by
      } : null;
    },
    async upsertAdminUser(admin) {
      const now = admin.updatedAt ?? Date.now();
      await db.prepare(`
        INSERT INTO admin_users (user_id, role, enabled, granted_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          role = excluded.role, enabled = excluded.enabled,
          granted_by = excluded.granted_by, updated_at = excluded.updated_at
      `).bind(
        String(admin.userId),
        admin.role,
        admin.enabled === false ? 0 : 1,
        String(admin.grantedBy),
        admin.createdAt ?? now,
        now
      ).run();
    },
    async appendAudit(entry) {
      await db.prepare(`
        INSERT INTO admin_audit_log (
          id, admin_id, action, resource_type, resource_id,
          before_state, after_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.id,
        String(entry.adminId),
        entry.action,
        entry.resourceType,
        entry.resourceId == null ? null : String(entry.resourceId),
        entry.beforeState == null ? null : JSON.stringify(entry.beforeState),
        entry.afterState == null ? null : JSON.stringify(entry.afterState),
        entry.createdAt ?? Date.now()
      ).run();
    },
    async getRule(ruleId2) {
      const row = await db.prepare("SELECT * FROM rules WHERE rule_id = ?").bind(String(ruleId2)).first();
      return mapRule(row);
    },
    async upsertRule(rule) {
      await db.prepare(`INSERT INTO rules (
        rule_id, rule_type, pattern, response_text, action, priority,
        enabled, metadata, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET rule_type=excluded.rule_type,
        pattern=excluded.pattern, response_text=excluded.response_text,
        action=excluded.action, priority=excluded.priority, enabled=excluded.enabled,
        metadata=excluded.metadata, updated_at=excluded.updated_at`).bind(
        rule.ruleId,
        rule.ruleType,
        rule.pattern ?? null,
        rule.responseText ?? null,
        rule.action,
        Number(rule.priority ?? 100),
        rule.enabled === false ? 0 : 1,
        JSON.stringify({ matchType: rule.matchType || "contains" }),
        rule.createdBy ?? null,
        rule.createdAt ?? Date.now(),
        rule.updatedAt ?? Date.now()
      ).run();
    },
    async listRules(offset = 0, limit = 20) {
      const [result, count] = await Promise.all([
        db.prepare("SELECT * FROM rules ORDER BY priority, rule_id LIMIT ? OFFSET ?").bind(limit, offset).all(),
        db.prepare("SELECT COUNT(*) AS total FROM rules").first()
      ]);
      const items = (result.results || []).map(mapRule);
      return { items, total: Number(count?.total || 0), offset, limit };
    },
    async listEnabledRules() {
      const result = await db.prepare(`
        SELECT * FROM rules
        WHERE enabled = 1
        ORDER BY priority, rule_id
      `).all();
      return (result.results || []).map(mapRule);
    },
    async deleteRule(ruleId2) {
      const result = await db.prepare("DELETE FROM rules WHERE rule_id = ?").bind(String(ruleId2)).run();
      return result.meta?.changes === 1;
    },
    async setRuleEnabled(ruleId2, enabled, updatedAt = Date.now()) {
      const result = await db.prepare("UPDATE rules SET enabled = ?, updated_at = ? WHERE rule_id = ?").bind(enabled ? 1 : 0, updatedAt, String(ruleId2)).run();
      return result.meta?.changes === 1;
    },
    async cleanupRetention({ updatesBefore, linksBefore, auditsBefore }) {
      const [updates, links, audits] = await db.batch([
        db.prepare("DELETE FROM processed_updates WHERE claimed_at < ?").bind(updatesBefore),
        db.prepare("DELETE FROM message_links WHERE created_at < ?").bind(linksBefore),
        db.prepare("DELETE FROM admin_audit_log WHERE created_at < ?").bind(auditsBefore)
      ]);
      return {
        updates: Number(updates.meta?.changes || 0),
        links: Number(links.meta?.changes || 0),
        audits: Number(audits.meta?.changes || 0)
      };
    },
    async getProcessedUpdate(updateId) {
      return db.prepare(`
        SELECT update_id, update_type, claimed_at, completed_at, status, error_code
        FROM processed_updates
        WHERE update_id = ?
      `).bind(String(updateId)).first();
    },
    async claimUpdate(updateId, updateType, now) {
      const id = String(updateId);
      const inserted = await db.prepare(`
        INSERT OR IGNORE INTO processed_updates (
          update_id, update_type, claimed_at, status
        ) VALUES (?, ?, ?, 'processing')
      `).bind(id, updateType, now).run();
      if (inserted.meta?.changes === 1) return "claimed";
      const existing = await this.getProcessedUpdate(id);
      if (!existing || existing.status === "completed") return "duplicate";
      const reclaimed = await db.prepare(`
        UPDATE processed_updates
        SET status = 'processing', claimed_at = ?, update_type = ?,
            completed_at = NULL, error_code = NULL
        WHERE update_id = ?
          AND (
            status = 'retryable'
            OR (status = 'processing' AND claimed_at < ?)
          )
      `).bind(
        now,
        updateType,
        id,
        now - UPDATE_PROCESSING_TIMEOUT_MS
      ).run();
      return reclaimed.meta?.changes === 1 ? "reclaimed" : "duplicate";
    },
    async completeUpdate(updateId, now) {
      await db.prepare(`
        UPDATE processed_updates
        SET status = 'completed', completed_at = ?, error_code = NULL
        WHERE update_id = ?
      `).bind(now, String(updateId)).run();
    },
    async markUpdateRetryable(updateId, errorCode) {
      await db.prepare(`
        UPDATE processed_updates
        SET status = 'retryable', error_code = ?
        WHERE update_id = ?
      `).bind(String(errorCode || "temporary"), String(updateId)).run();
    },
    /**
     * 系统信息统计（管理员 /sysinfo）
     */
    async getSystemStats() {
      const [
        users,
        withTopic,
        banned,
        closed,
        processing,
        retryable,
        links,
        rules,
        lastActive,
        recentActive
      ] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS total FROM users").first(),
        db.prepare("SELECT COUNT(*) AS total FROM users WHERE topic_id IS NOT NULL").first(),
        db.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'banned'").first(),
        db.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'closed'").first(),
        db.prepare("SELECT COUNT(*) AS total FROM processed_updates WHERE status = 'processing'").first(),
        db.prepare("SELECT COUNT(*) AS total FROM processed_updates WHERE status = 'retryable'").first(),
        db.prepare("SELECT COUNT(*) AS total FROM message_links").first(),
        db.prepare("SELECT COUNT(*) AS total FROM rules").first(),
        db.prepare(`
          SELECT user_id, username, first_name, last_name, last_message_at, topic_id, status
          FROM users
          ORDER BY COALESCE(last_message_at, 0) DESC
          LIMIT 1
        `).first(),
        db.prepare(`
          SELECT user_id, username, first_name, last_name, last_message_at, topic_id, status
          FROM users
          ORDER BY COALESCE(last_message_at, 0) DESC
          LIMIT 5
        `).all()
      ]);
      return {
        usersTotal: Number(users?.total || 0),
        usersWithTopic: Number(withTopic?.total || 0),
        usersBanned: Number(banned?.total || 0),
        usersClosed: Number(closed?.total || 0),
        updatesProcessing: Number(processing?.total || 0),
        updatesRetryable: Number(retryable?.total || 0),
        messageLinks: Number(links?.total || 0),
        rulesTotal: Number(rules?.total || 0),
        lastActiveUser: lastActive ? mapUser(lastActive) : null,
        recentActiveUsers: (recentActive?.results || []).map(mapUser)
      };
    },
    /**
     * 按 UID 精确或用户名/姓名模糊查找（管理员 /find）
     */
    async searchUsers(query, limit = 10) {
      const q = String(query || "").trim();
      if (!q) return [];
      const lim = Math.min(Math.max(Number(limit) || 10, 1), 20);
      if (/^\d{1,20}$/.test(q)) {
        const one = await this.getUser(q);
        return one ? [one] : [];
      }
      const escaped = q.replace(/[%_\\]/g, (match) => `\\${match}`);
      const like = `%${escaped}%`;
      const result = await db.prepare(`
        SELECT user_id, username, first_name, last_name, last_message_at, topic_id, status, trust_level
        FROM users
        WHERE username LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\'
        ORDER BY COALESCE(last_message_at, 0) DESC
        LIMIT ?
      `).bind(like, like, like, lim).all();
      return (result.results || []).map(mapUser);
    },
    /**
     * 指定时间之后有 last_message_at 的用户（今日活跃兜底）
     */
    async getUsersActiveSince(sinceMs, limit = 10) {
      const since = Number(sinceMs) || 0;
      const lim = Math.min(Math.max(Number(limit) || 10, 1), 30);
      const result = await db.prepare(`
        SELECT user_id, username, first_name, last_name, last_message_at, topic_id, status, trust_level
        FROM users
        WHERE COALESCE(last_message_at, 0) >= ?
        ORDER BY COALESCE(last_message_at, 0) DESC
        LIMIT ?
      `).bind(since, lim).all();
      return (result.results || []).map(mapUser);
    },
    /**
     * 拉取入站（user_to_admin）消息行，供 JS 侧汇总热力与排行
     */
    async getInboundMessageRows(sinceMs, maxRows = 2e3) {
      const since = Number(sinceMs) || 0;
      const lim = Math.min(Math.max(Number(maxRows) || 2e3, 1), 5e3);
      const result = await db.prepare(`
        SELECT user_id, created_at
        FROM message_links
        WHERE created_at >= ? AND direction = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(since, "user_to_admin", lim).all();
      return (result.results || []).map((row) => ({
        userId: String(row.user_id),
        createdAt: Number(row.created_at || 0)
      }));
    },
    /**
     * 批量取用户资料（排行展示姓名）
     * 单条 IN 查询替代 N+1 逐条 getUser
     */
    async getUsersByIds(userIds) {
      const ids = [...new Set((userIds || []).map(String).filter(Boolean))].slice(0, 30);
      if (!ids.length) return /* @__PURE__ */ new Map();
      const placeholders = ids.map(() => "?").join(", ");
      const result = await db.prepare(`
        SELECT user_id, username, first_name, last_name, last_message_at, topic_id, status, trust_level
        FROM users
        WHERE user_id IN (${placeholders})
      `).bind(...ids).all();
      const map = /* @__PURE__ */ new Map();
      for (const row of result.results || []) {
        const user = mapUser(row);
        if (user) map.set(user.userId, user);
      }
      return map;
    }
  };
  return storage;
}

// src/update-router.js
function getUpdateType(update) {
  if (update?.edited_message) return "edited_message";
  if (update?.callback_query) return "callback_query";
  if (update?.message) return "message";
  return "unsupported";
}
function createUpdateHandler({ conversation, supergroupId }) {
  return async function handleUpdate(update) {
    const editedMessage = update?.edited_message;
    if (editedMessage) {
      if (editedMessage.chat?.type === "private") {
        return conversation.handleEditedPrivateMessage(editedMessage);
      }
      if (String(editedMessage.chat?.id) === String(supergroupId)) {
        return conversation.handleEditedAdminMessage(editedMessage);
      }
      return { status: "unsupported" };
    }
    const message = update?.message;
    if (message?.chat?.type === "private") {
      return conversation.handlePrivateMessage(message);
    }
    if (message && String(message.chat?.id) === String(supergroupId)) {
      return conversation.handleAdminMessage(message);
    }
    return { status: "unsupported" };
  };
}
function webhookResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
async function routeUpdate(update, {
  storage,
  handleUpdate,
  now = Date.now
}) {
  const updateId = update?.update_id;
  if (updateId === void 0 || updateId === null) {
    return webhookResponse("Bad Request", 400);
  }
  let claim;
  try {
    claim = await storage.claimUpdate(updateId, getUpdateType(update), now());
  } catch (error) {
    return webhookResponse(
      `Error: claimUpdate failed: ${error?.message || String(error)}`,
      500
    );
  }
  if (claim === "duplicate") return webhookResponse("OK");
  try {
    const response = await handleUpdate(update);
    if (response instanceof Response && response.status >= 500) {
      try {
        await storage.markUpdateRetryable(updateId, `http_${response.status}`);
      } catch {
      }
      return response;
    }
    try {
      await storage.completeUpdate(updateId, now());
    } catch (error) {
      return webhookResponse(
        `Error: completeUpdate failed: ${error?.message || String(error)}`,
        500
      );
    }
    return response instanceof Response ? response : webhookResponse("OK");
  } catch (error) {
    try {
      await storage.markUpdateRetryable(updateId, error?.category || "temporary");
    } catch {
    }
    return webhookResponse(
      `Error: handleUpdate failed: ${error?.message || String(error)}`,
      500
    );
  }
}

// src/maintenance-service.js
var DAY_MS = 24 * 60 * 60 * 1e3;
function createMaintenanceService({ storage }) {
  async function runRetentionCleanup(now) {
    const result = await storage.cleanupRetention({
      updatesBefore: now - 7 * DAY_MS,
      linksBefore: now - 30 * DAY_MS,
      auditsBefore: now - 90 * DAY_MS
    });
    return {
      processedUpdates: result.updates,
      messageLinks: result.links,
      adminAudits: result.audits
    };
  }
  return { runRetentionCleanup };
}

// src/app.js
var MAX_REQUEST_BODY_BYTES = 1024 * 1024;
var HttpRequestError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function readRequestBodyWithLimit(request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new HttpRequestError(413, "Payload Too Large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  const maxLength = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}
async function validateTelegramWebhookRequest(request, env) {
  validateWebhookEnv(env);
  const contentType = request.headers.get("content-type") || "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError(415, "Unsupported Media Type");
  }
  const providedSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!constantTimeEqual(providedSecret, env.WEBHOOK_SECRET)) {
    throw new HttpRequestError(401, "Unauthorized");
  }
  let bodyText;
  try {
    bodyText = await readRequestBodyWithLimit(request.clone());
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "Bad Request");
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new HttpRequestError(400, "Bad Request");
  }
}
async function notFoundHandler() {
  return httpError(404, "Not Found");
}
function httpError(status, message, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders }
  });
}
function createApp({ handleFetch = notFoundHandler } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return new Response("OK", {
          headers: { "Cache-Control": "no-store" }
        });
      }
      if (request.method === "GET" && url.pathname === "/health/env") {
        const { presence, keys, mistypedKeys, bindings } = inspectEnvPresence(env);
        return Response.json({
          ok: true,
          presence,
          keys,
          mistypedKeys,
          bindings,
          note: mistypedKeys.length ? "Some variable names have leading/trailing spaces; rename them exactly (e.g. SUPERGROUP_ID)." : "values are never included; TG_BOT_DB must be a D1 Binding with prepare(), not a Text variable"
        }, { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/health/d1") {
        try {
          const shape = inspectEnvPresence(env).bindings.TG_BOT_DB;
          const db = assertD1Binding(env?.TG_BOT_DB, "TG_BOT_DB");
          await ensureMigrations(db);
          const row = await db.prepare("SELECT 1 AS ok").first();
          const version = await db.prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1"
          ).first();
          return Response.json({
            ok: true,
            select1: row?.ok ?? null,
            schemaVersion: version?.version ?? null,
            schemaName: version?.name ?? null,
            binding: shape
          }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return Response.json({
            ok: false,
            error: error?.message || String(error),
            name: error?.name || "Error",
            binding: inspectEnvPresence(env).bindings.TG_BOT_DB
          }, { status: 500, headers: { "Cache-Control": "no-store" } });
        }
      }
      try {
        const normalizedEnv = normalizeEnv(env);
        if (request.method === "POST" && url.pathname !== "/") {
          try {
            await readRequestBodyWithLimit(request.clone());
          } catch (error) {
            if (error instanceof HttpRequestError) {
              return httpError(error.status, error.message);
            }
            throw error;
          }
        }
        if (request.method === "POST" && url.pathname === "/") {
          let update;
          try {
            update = await validateTelegramWebhookRequest(request, normalizedEnv);
          } catch (error) {
            if (error instanceof HttpRequestError) {
              return httpError(error.status, error.message);
            }
            return httpError(500, `Error: ${error.message}`);
          }
          try {
            validateBaseEnv(normalizedEnv);
          } catch (error) {
            return httpError(500, `Error: ${error.message}${formatEnvPresenceDetail(normalizedEnv)}`);
          }
          try {
            assertD1Binding(normalizedEnv.TG_BOT_DB, "TG_BOT_DB");
          } catch (error) {
            return httpError(500, `Error: ${error.message}`);
          }
          try {
            await ensureMigrations(normalizedEnv.TG_BOT_DB);
          } catch (error) {
            return httpError(500, `Error: D1 migration failed: ${error?.message || String(error)}`);
          }
          try {
            return await routeUpdate(update, {
              storage: createD1Storage(normalizedEnv.TG_BOT_DB),
              // 已解析的 update 直传业务层，避免 handleFetch 二次读取/解析请求体
              handleUpdate: (parsedUpdate) => handleFetch(request, normalizedEnv, ctx, parsedUpdate)
            });
          } catch (error) {
            return httpError(500, `Error: update routing failed: ${error?.message || String(error)}`);
          }
        }
        try {
          validateBaseEnv(normalizedEnv);
        } catch (error) {
          return httpError(500, `Error: ${error.message}${formatEnvPresenceDetail(normalizedEnv)}`);
        }
        return await handleFetch(request, normalizedEnv, ctx);
      } catch (error) {
        return httpError(500, `Error: unhandled ${error?.name || "Error"}: ${error?.message || String(error)}`);
      }
    },
    async scheduled(_event, env) {
      const normalizedEnv = normalizeEnv(env);
      if (!normalizedEnv.TG_BOT_DB) throw new Error("D1 'TG_BOT_DB' not bound");
      await ensureMigrations(normalizedEnv.TG_BOT_DB);
      return createMaintenanceService({
        storage: createD1Storage(normalizedEnv.TG_BOT_DB)
      }).runRetentionCleanup(Date.now());
    }
  };
}
var defaultApp = createApp();

// src/utils.js
function cleanProfileText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  return [message.text, message.caption].filter((value) => typeof value === "string" && value.trim().length > 0).join(" ").trim();
}
function containsLink(text) {
  if (!text) return false;
  const patterns = [
    /https?:\/\/\S+/i,
    /[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(\/\S*)?/,
    /t\.me\/\S+/i,
    /telegram\.me\/\S+/i
  ];
  return patterns.some((p) => p.test(text));
}
function buildSpamCheckText(msg) {
  if (!msg || typeof msg !== "object") return "";
  const from = msg.from || {};
  return [
    msg.text,
    msg.caption,
    from.first_name,
    from.last_name,
    from.username
  ].filter((v) => typeof v === "string" && v.trim().length > 0).join(" ");
}
function detectSpamKeywords(text, keywords) {
  if (!text || keywords.length === 0) {
    return { isSpam: false, matchedWord: null };
  }
  const lower = text.toLowerCase();
  for (const word of keywords) {
    if (lower.includes(word)) {
      return { isSpam: true, matchedWord: word };
    }
  }
  return { isSpam: false, matchedWord: null };
}
function computeMessageHash(msg) {
  const text = (msg.text || msg.caption || "").trim().toLowerCase();
  if (!text) return null;
  const fingerprint = `${text.length}|${text.substring(0, 100)}|${text.substring(Math.max(0, text.length - 20))}`;
  return fingerprint;
}
function normalizeTgDescription(description) {
  return (description || "").toString().toLowerCase();
}
function isTopicMissingOrDeleted(description) {
  const desc = normalizeTgDescription(description);
  return desc.includes("thread not found") || desc.includes("topic not found") || desc.includes("message thread not found") || desc.includes("topic deleted") || desc.includes("thread deleted") || desc.includes("forum topic not found") || desc.includes("topic closed permanently");
}
function isTestMessageInvalid(description) {
  const desc = normalizeTgDescription(description);
  return desc.includes("message text is empty") || desc.includes("bad request: message text is empty");
}
var GATEWAY_REPO = "https://github.com/Silentely/telegram-private-chat-gateway";
function truncateText(text, limit = 1500) {
  const s = String(text ?? "");
  return s.length > limit ? `${s.slice(0, limit)}\u2026` : s;
}
function formatUserName(src, fallback = "\u672A\u77E5") {
  if (!src || typeof src !== "object") return fallback;
  const first = src.first_name ?? src.firstName;
  const last = src.last_name ?? src.lastName;
  const name = [first, last].filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()).join(" ");
  return name || fallback;
}
function commandArgument(text, command) {
  const pattern = new RegExp(`^\\/${command}(@[A-Za-z0-9_]+)?\\s*`, "i");
  return String(text ?? "").replace(pattern, "").trim();
}
var noticeKey = {
  ban: (userId) => `ban_notice:${userId}`,
  mute: (userId) => `mute_notice:${userId}`,
  cmdHint: (userId) => `cmd_hint:${userId}`,
  cmdUnknown: (userId) => `cmd_unknown:${userId}`
};
var ADMIN_COMMAND_PATTERN = /^\/(help|menu|dashboard|sysinfo|system|status|stats|rank|activity|heat|whoami|find|notes|cleanup|listwords|addword|delword|panel|info|ban|unban|close|open|mute|unmute|trust|reset|note|synccommands)(@|\s|$)/i;
function isAdminCommandText(text) {
  return ADMIN_COMMAND_PATTERN.test(String(text ?? ""));
}
function isPlaceholderTopicTitle(title) {
  const value = String(title ?? "").trim();
  if (!value) return true;
  return value === "User" || /^User\s@/i.test(value);
}
function withMessageThreadId(body, threadId) {
  if (threadId === void 0 || threadId === null) return body;
  return { ...body, message_thread_id: threadId };
}
function parseSpamKeywords(raw) {
  if (!raw) return [];
  return raw.toString().trim().split(/[,;，；\n]+/g).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}
function generateVerifyCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function secureRandomId(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const limit = Math.floor(256 / chars.length) * chars.length;
  const result = [];
  const byte = new Uint8Array(1);
  const target = Math.max(1, Number(length) || 12);
  while (result.length < target) {
    crypto.getRandomValues(byte);
    if (byte[0] < limit) result.push(chars[byte[0] % chars.length]);
  }
  return result.join("");
}
function createThrottle({ windowMs = 6e4 } = {}) {
  const lastSentAt = /* @__PURE__ */ new Map();
  return (key, now = Date.now()) => {
    const k = String(key);
    const prev = lastSentAt.get(k);
    if (prev !== void 0 && now - prev < windowMs) return false;
    lastSentAt.set(k, now);
    return true;
  };
}
var RECENT_ERROR_ACTION_MAX = 120;
var RECENT_ERROR_TEXT_MAX = 500;
var RECENT_ERROR_ID_MAX = 120;
function normalizeRecentErrorItem(item) {
  if (!item || typeof item !== "object") return null;
  const text = (value, maxLength, fallback = "") => {
    if (typeof value !== "string" && typeof value !== "number") return fallback;
    return String(value).slice(0, maxLength);
  };
  const id = (value) => {
    if (typeof value !== "string" && typeof value !== "number") return void 0;
    const valueText = String(value).slice(0, RECENT_ERROR_ID_MAX);
    return valueText || void 0;
  };
  const ts = Number(item.ts);
  const entry = {
    ts: Number.isFinite(ts) ? ts : 0,
    action: text(item.action, RECENT_ERROR_ACTION_MAX, "unknown"),
    error: text(item.error, RECENT_ERROR_TEXT_MAX)
  };
  for (const key of ["userId", "updateId", "correlationId"]) {
    const value = id(item[key]);
    if (value !== void 0) entry[key] = value;
  }
  return entry;
}

// src/message-policy.js
var MAX_PATTERN_LENGTH = 200;
var MAX_RESPONSE_LENGTH = 4e3;
var MAX_INPUT_LENGTH = 5e3;
var MATCH_TYPES = /* @__PURE__ */ new Set(["contains", "equals", "regex"]);
var RULE_ACTIONS = {
  blocked_keyword: /* @__PURE__ */ new Set(["reject", "silent_reject", "count_violation", "notify_only"]),
  auto_reply: /* @__PURE__ */ new Set(["reply_and_forward", "reply_only", "forward_only"]),
  content_type: /* @__PURE__ */ new Set(["reject", "silent_reject", "allow"])
};
var VALIDATION_CACHE_MAX = 500;
var ruleValidationCache = /* @__PURE__ */ new Map();
var regexCache = /* @__PURE__ */ new Map();
function cacheBoundedSet(cache, key, value) {
  if (cache.size >= VALIDATION_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}
function getCachedRegex(pattern) {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "i");
    cacheBoundedSet(regexCache, pattern, re);
  }
  return re;
}
function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}
function ruleValue(rule, camelName, snakeName) {
  return rule?.[camelName] ?? rule?.[snakeName];
}
function hasUnsafeNestedQuantifier(pattern) {
  return /\((?:[^()\\]|\\.)*(?:[+*?]|\{\d*,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*?]|\{\d*,?\d*\})/.test(pattern);
}
function hasOverlappingQuantifiedAlternatives(pattern) {
  const quantifiedGroup = /\(([^()]*)\)\s*(?:[+*]|\{\d*,?\d*\})/g;
  for (const match of pattern.matchAll(quantifiedGroup)) {
    const alternatives = match[1].split("|").filter(Boolean);
    for (let leftIndex = 0; leftIndex < alternatives.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < alternatives.length; rightIndex += 1) {
        const left = alternatives[leftIndex];
        const right = alternatives[rightIndex];
        if (left.startsWith(right) || right.startsWith(left)) return true;
      }
    }
  }
  return false;
}
function validateRuleInput(rule) {
  const matchType = ruleValue(rule, "matchType", "match_type") || "contains";
  const pattern = String(rule?.pattern ?? "");
  const responseText = String(ruleValue(rule, "responseText", "response_text") ?? "");
  const ruleType = ruleValue(rule, "ruleType", "rule_type");
  const action = rule?.action;
  const cacheKey = [matchType, pattern, ruleType || "", action || "", String(responseText.length)].join("\0");
  if (ruleValidationCache.has(cacheKey)) return;
  if (!MATCH_TYPES.has(matchType)) throw new Error(`unsupported matchType: ${matchType}`);
  if (!pattern) throw new Error("pattern is required");
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error("pattern must not exceed 200 characters");
  }
  if (responseText.length > MAX_RESPONSE_LENGTH) {
    throw new Error("responseText must not exceed 4000 characters");
  }
  if (ruleType && !RULE_ACTIONS[ruleType]) throw new Error(`unsupported ruleType: ${ruleType}`);
  if (ruleType && action && !RULE_ACTIONS[ruleType].has(action)) {
    throw new Error(`unsupported action: ${action}`);
  }
  if (ruleType === "auto_reply" && action !== "forward_only" && responseText.length === 0) {
    throw new Error("responseText is required for auto reply");
  }
  if (matchType !== "regex") {
    cacheBoundedSet(ruleValidationCache, cacheKey, true);
    return;
  }
  if (hasUnsafeNestedQuantifier(pattern)) {
    throw new Error("regex contains unsafe nested quantifiers");
  }
  if (hasOverlappingQuantifiedAlternatives(pattern)) {
    throw new Error("regex contains unsafe overlapping alternatives");
  }
  let expression;
  try {
    expression = getCachedRegex(pattern);
  } catch {
    throw new Error("regex is invalid");
  }
  if (expression.test("")) throw new Error("regex must not match empty text");
  cacheBoundedSet(ruleValidationCache, cacheKey, true);
}
function matchRule(text, rule) {
  validateRuleInput(rule);
  const input = String(text ?? "").slice(0, MAX_INPUT_LENGTH);
  const pattern = String(rule.pattern);
  const matchType = ruleValue(rule, "matchType", "match_type") || "contains";
  if (matchType === "regex") return getCachedRegex(pattern).test(input);
  const normalizedInput = normalizeText(input);
  const normalizedPattern = normalizeText(pattern);
  if (matchType === "equals") return normalizedInput === normalizedPattern;
  return normalizedInput.includes(normalizedPattern);
}
function createResult(overrides = {}) {
  return {
    action: "allow",
    reason: null,
    matchedRuleId: null,
    autoReply: null,
    shouldForward: true,
    shouldIncrementViolation: false,
    ...overrides
  };
}
function ruleId(rule) {
  const value = ruleValue(rule, "ruleId", "rule_id");
  return value == null ? null : String(value);
}
function buildLegacyBlockedRules(blockedWords) {
  return (Array.isArray(blockedWords) ? blockedWords : []).filter(Boolean).map((pattern, index) => ({
    ruleId: `legacy_blocked:${index}`,
    ruleType: "blocked_keyword",
    matchType: "contains",
    pattern,
    action: "reject",
    priority: index
  }));
}
function enabledRules(rules) {
  return [...Array.isArray(rules) ? rules : []].filter((rule) => rule && rule.enabled !== false && rule.enabled !== 0).sort((left, right) => Number(left.priority ?? 100) - Number(right.priority ?? 100));
}
function blockedRuleResult(rule) {
  const action = rule.action || "count_violation";
  if (action === "silent_reject") {
    return createResult({
      action: "silent_reject",
      reason: "blocked_keyword",
      matchedRuleId: ruleId(rule),
      shouldForward: false
    });
  }
  if (action === "notify_only") {
    return createResult({
      reason: "blocked_keyword_notify_only",
      matchedRuleId: ruleId(rule),
      autoReply: ruleValue(rule, "responseText", "response_text") || null
    });
  }
  return createResult({
    action: "reject",
    reason: "blocked_keyword",
    matchedRuleId: ruleId(rule),
    shouldForward: false,
    shouldIncrementViolation: action === "count_violation"
  });
}
function autoReplyResult(rule) {
  const action = rule.action || "reply_and_forward";
  const autoReply = ruleValue(rule, "responseText", "response_text") || null;
  if (action === "reply_only") {
    return createResult({
      action: "auto_reply_only",
      reason: "auto_reply",
      matchedRuleId: ruleId(rule),
      autoReply,
      shouldForward: false
    });
  }
  return createResult({
    reason: action === "forward_only" ? null : "auto_reply",
    matchedRuleId: ruleId(rule),
    autoReply: action === "forward_only" ? null : autoReply
  });
}
function evaluateMessagePolicy({
  message,
  user = {},
  verification = null,
  rules = []
}) {
  if (user.status === "banned") {
    return createResult({
      action: "silent_reject",
      reason: "banned",
      shouldForward: false
    });
  }
  if (user.status === "closed") {
    return createResult({
      action: "reject",
      reason: "closed",
      shouldForward: false
    });
  }
  const text = extractMessageText(message).slice(0, MAX_INPUT_LENGTH);
  const sortedRules = enabledRules(rules);
  for (const rule of sortedRules) {
    const type = ruleValue(rule, "ruleType", "rule_type");
    if (type === "blocked_keyword" && matchRule(text, rule)) {
      return blockedRuleResult(rule);
    }
  }
  if (user.trustLevel !== "trusted" && !verification) {
    return createResult({
      action: "require_verification",
      reason: "verification_required",
      shouldForward: false
    });
  }
  for (const rule of sortedRules) {
    const type = ruleValue(rule, "ruleType", "rule_type");
    if (type === "auto_reply" && matchRule(text, rule)) {
      return autoReplyResult(rule);
    }
  }
  return createResult();
}

// src/user-copy.js
var POLICY_REASON_LABELS = {
  blocked_keyword: "\u547D\u4E2D\u5C4F\u853D\u8BCD\u6216\u89C4\u5219",
  blocked_keyword_notify_only: "\u547D\u4E2D\u89C4\u5219\uFF08\u4EC5\u901A\u77E5\uFF09",
  auto_reply: "\u89C4\u5219\u81EA\u52A8\u56DE\u590D",
  banned: "\u7528\u6237\u5DF2\u5C01\u7981",
  closed: "\u4F1A\u8BDD\u5DF2\u5173\u95ED",
  verification_required: "\u9700\u8981\u91CD\u65B0\u9A8C\u8BC1"
};
function policyReasonLabel(reason) {
  return POLICY_REASON_LABELS[reason] || String(reason || "unknown");
}
var CALLBACK_BUSY_COPY = {
  ban: "\u6B63\u5728\u5C01\u7981\u2026",
  banok: "\u6B63\u5728\u5C01\u7981\u2026",
  close: "\u6B63\u5728\u5173\u95ED\u2026",
  closeok: "\u6B63\u5728\u5173\u95ED\u2026",
  reset: "\u6B63\u5728\u91CD\u7F6E\u2026",
  resetok: "\u6B63\u5728\u91CD\u7F6E\u2026"
};
var FIND_USAGE_TEXT = "\u7528\u6CD5: <code>/find UID\u6216\u7528\u6237\u540D\u6216\u59D3\u540D</code>";
var USER_COPY = {
  /** 消息发送限流（minutes 由调用方按 RATE_LIMIT_WINDOW 换算，与验证限流口径一致，防文案漂移） */
  rateLimited(minutes) {
    return `\u26A0\uFE0F \u53D1\u9001\u8FC7\u4E8E\u9891\u7E41\uFF0C\u672C\u6B21\u6D88\u606F\u672A\u9001\u8FBE\uFF0C\u8BF7\u7EA6 ${minutes} \u5206\u949F\u540E\u518D\u8BD5\u3002`;
  },
  /** 通用系统繁忙提示（与验证侧 VERIFY_COPY.systemError 口径一致，防两处措辞漂移） */
  systemBusy: "\u26A0\uFE0F \u7CFB\u7EDF\u7E41\u5FD9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
  /** 话题健康连续失败达到上限：暂停转发并给出可行动提示（区别于一次性 systemBusy） */
  retryExceeded: "\u26A0\uFE0F \u7CFB\u7EDF\u6682\u65F6\u65E0\u6CD5\u63A5\u6536\u60A8\u7684\u6D88\u606F\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002\u82E5\u6301\u7EED\u5982\u6B64\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u3002",
  bannedHourly: "\u{1F6AB} \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u5C01\u7981\uFF0C\u6682\u65F6\u65E0\u6CD5\u7EE7\u7EED\u53D1\u9001\u6D88\u606F\u3002\u5982\u6709\u7591\u95EE\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u5904\u7406\u3002",
  mutedHourly: "\u{1F507} \u60A8\u5F53\u524D\u5904\u4E8E\u9759\u97F3\u72B6\u6001\uFF0C\u6D88\u606F\u4E0D\u4F1A\u9001\u8FBE\u7BA1\u7406\u5458\u3002\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u53D6\u6D88\u9759\u97F3\u3002",
  blockedWord: "\u{1F6AB} \u60A8\u7684\u6D88\u606F\u5305\u542B\u8FDD\u89C4\u5185\u5BB9\uFF0C\u5DF2\u88AB\u62E6\u622A\u3002\u8BF7\u4FEE\u6539\u540E\u91CD\u65B0\u53D1\u9001\u3002",
  conversationClosed: "\u{1F6AB} \u5F53\u524D\u5BF9\u8BDD\u5DF2\u88AB\u7BA1\u7406\u5458\u5173\u95ED\u3002\u5982\u9700\u7EE7\u7EED\uFF0C\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u91CD\u65B0\u6253\u5F00\u3002",
  /** 普通用户私聊发送管理指令时的一次性提示（每小时节流，避免反复打扰） */
  adminCommandHint: "\u2139\uFE0F \u8BE5\u6307\u4EE4\u4EC5\u4F9B\u7BA1\u7406\u5458\u5728\u8D85\u7EA7\u7FA4\u8BDD\u9898\u5185\u4F7F\u7528\u3002\u5982\u9700\u8054\u7CFB\u7BA1\u7406\u5458\uFF0C\u76F4\u63A5\u53D1\u9001\u6D88\u606F\u5373\u53EF\u3002",
  /** 普通用户私聊发送未知指令时的一次性提示（每小时节流） */
  unknownCommandHint: "\u2139\uFE0F \u672A\u8BC6\u522B\u7684\u6307\u4EE4\u3002\u53D1\u9001 /help \u67E5\u770B\u53EF\u7528\u529F\u80FD\u3002",
  pendingDelivered(count) {
    return `\u{1F4E9} \u521A\u624D\u7684 <b>${count}</b> \u6761\u6D88\u606F\u5DF2\u5E2E\u60A8\u9001\u8FBE\u7BA1\u7406\u5458\u3002`;
  },
  muteUserNotify: "\u{1F507} \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u9759\u97F3\uFF0C\u6D88\u606F\u6682\u65F6\u4E0D\u4F1A\u9001\u8FBE\u7BA1\u7406\u5458\u3002",
  unmuteUserNotify: "\u{1F50A} \u60A8\u7684\u9759\u97F3\u5DF2\u53D6\u6D88\uFF0C\u53EF\u4EE5\u7EE7\u7EED\u8054\u7CFB\u7BA1\u7406\u5458\u3002",
  banUserNotify: "\u{1F6AB} \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u5C01\u7981\uFF0C\u6682\u65F6\u65E0\u6CD5\u7EE7\u7EED\u53D1\u9001\u6D88\u606F\u3002\u5982\u6709\u7591\u95EE\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u5904\u7406\u3002",
  unbanUserNotify: "\u2705 \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u89E3\u5C01\uFF0C\u53EF\u4EE5\u7EE7\u7EED\u53D1\u9001\u6D88\u606F\u4E86\u3002",
  /** 管理员修改回复后发给用户的编辑通知（纯文本，内容来自消息快照，单侧截断防超长） */
  adminEditedReply(original, updated) {
    return `\u270F\uFE0F \u7BA1\u7406\u5458\u4FEE\u6539\u4E86\u56DE\u590D
\u539F\u5185\u5BB9\uFF1A${truncateText(original)}
\u65B0\u5185\u5BB9\uFF1A${truncateText(updated)}`;
  },
  /** 私聊 /help 帮助正文（rateLimitMinutes 由调用方按 RATE_LIMIT_WINDOW 注入，防文案与配置漂移） */
  helpText(rateLimitMinutes) {
    return [
      "\u{1F44B} <b>\u79C1\u804A\u7F51\u5173</b>",
      "",
      "\u76F4\u63A5\u53D1\u9001\u6587\u5B57 / \u56FE\u7247 / \u6587\u4EF6\u5373\u53EF\u8054\u7CFB\u7BA1\u7406\u5458\uFF1B\u4E00\u6B21\u53D1\u9001\u591A\u5F20\u56FE\u7247\u4F1A\u6309\u76F8\u518C\u5408\u5E76\u9001\u8FBE\u3002",
      "",
      "<b>\u5E38\u89C1\u95EE\u9898</b>",
      "\u2022 \u63D0\u793A\u300C\u4EBA\u673A\u9A8C\u8BC1\u300D\u2014 \u70B9\u6309\u94AE\u7B54\u9898\u6216\u6253\u5F00\u7F51\u9875\u5B8C\u6210\uFF0C\u7B54\u5BF9\u540E\u6D88\u606F\u81EA\u52A8\u9001\u8FBE",
      "\u2022 \u9A8C\u8BC1\u94FE\u63A5\u8FC7\u671F \u2014 \u91CD\u65B0\u53D1\u4E00\u6761\u6D88\u606F\u5373\u53EF\u83B7\u53D6\u65B0\u94FE\u63A5",
      "\u2022 \u63D0\u793A\u300C\u5305\u542B\u8FDD\u89C4\u5185\u5BB9\u300D\u2014 \u4FEE\u6539\u63AA\u8F9E\u540E\u91CD\u65B0\u53D1\u9001",
      `\u2022 \u63D0\u793A\u300C\u53D1\u9001\u8FC7\u4E8E\u9891\u7E41\u300D\u2014 \u672C\u6B21\u6D88\u606F\u672A\u9001\u8FBE\uFF0C\u8BF7\u7A0D\u7B49\u7EA6 ${rateLimitMinutes} \u5206\u949F\u518D\u53D1`,
      "\u2022 \u88AB\u9759\u97F3\u6216\u5C01\u7981 \u2014 \u4F1A\u6536\u5230\u5355\u72EC\u901A\u77E5\uFF0C\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u5904\u7406",
      "",
      "<b>\u547D\u4EE4</b>",
      "\u2022 /start \u2014 \u5F00\u59CB\u6216\u91CD\u65B0\u9A8C\u8BC1",
      "\u2022 /help \u2014 \u672C\u8BF4\u660E",
      "\u2022 /cancel \u2014 \u53D6\u6D88\u8FDB\u884C\u4E2D\u7684\u64CD\u4F5C\uFF08\u5185\u5BB9\u4E0D\u4F1A\u8F6C\u53D1\u7ED9\u7BA1\u7406\u5458\uFF09",
      "",
      "<i>\u8BF7\u52FF\u5728\u6B64\u4F7F\u7528\u7BA1\u7406\u6307\u4EE4\uFF1B\u7BA1\u7406\u64CD\u4F5C\u4EC5\u5728\u8D85\u7EA7\u7FA4\u8BDD\u9898\u5185\u6709\u6548\u3002</i>"
    ].join("\n");
  }
};
var ADMIN_COPY = {
  spamIntercepted(userId, reasonText, { threadId, snippet } = {}) {
    const locateHint = threadId ? "\u5DF2\u53D1\u9001\u5230\u8BE5\u7528\u6237\u8BDD\u9898\uFF0C\u53EF\u5728\u672C\u8BDD\u9898\u5185\u4F7F\u7528 <b>/panel</b> \u64CD\u4F5C\u3002" : "\u8BE5\u7528\u6237\u5C1A\u65E0\u8BDD\u9898\uFF0C\u53EF\u7528 <code>/find UID</code> \u5B9A\u4F4D\u3002";
    return [
      "\u26A0\uFE0F <b>\u68C0\u6D4B\u5230\u7591\u4F3C\u9A9A\u6270\u6D88\u606F</b>",
      "",
      `\u{1F464} \u7528\u6237: <code>${userId}</code>`,
      reasonText,
      ...snippet ? ["", `\u{1F4C4} \u5185\u5BB9: <code>${snippet}</code>`] : [],
      "",
      `\u{1F4DD} \u6D88\u606F\u5DF2\u62E6\u622A\u3002${locateHint}`
    ].join("\n");
  },
  /** 转发完全失败报告（HTML；四段值均为原始文本，内部统一转义） */
  forwardTotalFail(userId, threadId, fwdDesc, copyDesc) {
    return [
      "\u26A0\uFE0F <b>\u6D88\u606F\u8F6C\u53D1\u5B8C\u5168\u5931\u8D25</b>",
      "",
      `\u{1F464} \u7528\u6237: <code>${escapeHtml(String(userId))}</code>`,
      `\u{1F4DD} \u8BDD\u9898: <code>${escapeHtml(String(threadId))}</code>`,
      `\u274C forwardMessage: <code>${escapeHtml(String(fwdDesc || "unknown"))}</code>`,
      `\u274C copyMessage: <code>${escapeHtml(String(copyDesc || "unknown"))}</code>`
    ].join("\n");
  },
  wordUsageAdd: "\u26A0\uFE0F \u7528\u6CD5: <code>/addword \u5C4F\u853D\u8BCD</code>",
  wordUsageDel: "\u26A0\uFE0F \u7528\u6CD5: <code>/delword \u5C4F\u853D\u8BCD</code>",
  /** 词库回执（HTML；word 为管理员输入的原始文本，内部统一转义） */
  wordExists(word) {
    return `\u26A0\uFE0F \u5C4F\u853D\u8BCD\u300C${escapeHtml(word)}\u300D\u5DF2\u5B58\u5728\u3002`;
  },
  wordAdded(word, count) {
    return `\u2705 \u5DF2\u6DFB\u52A0\u5C4F\u853D\u8BCD\u300C${escapeHtml(word)}\u300D
\u5F53\u524D\u52A8\u6001\u8BCD\u5E93\u5171 <b>${count}</b> \u4E2A\u8BCD`;
  },
  wordHardcoded(word) {
    return `\u26A0\uFE0F\u300C${escapeHtml(word)}\u300D\u662F\u786C\u7F16\u7801\u5C4F\u853D\u8BCD\uFF0C\u65E0\u6CD5\u901A\u8FC7\u547D\u4EE4\u5220\u9664\uFF0C\u8BF7\u76F4\u63A5\u4FEE\u6539\u4EE3\u7801\u4E2D\u7684 BLOCKED_WORDS\u3002`;
  },
  wordMissing(word) {
    return `\u26A0\uFE0F \u5C4F\u853D\u8BCD\u300C${escapeHtml(word)}\u300D\u4E0D\u5B58\u5728\u4E8E\u52A8\u6001\u8BCD\u5E93\u4E2D\u3002`;
  },
  wordDeleted(word, count) {
    return `\u2705 \u5DF2\u5220\u9664\u5C4F\u853D\u8BCD\u300C${escapeHtml(word)}\u300D
\u5F53\u524D\u52A8\u6001\u8BCD\u5E93\u5171 <b>${count}</b> \u4E2A\u8BCD`;
  },
  /** 用户编辑消息被策略拦截后发给管理员的提示（纯文本，reason 为策略原因标识） */
  userEditBlocked(reason) {
    return `\u{1F6AB} \u7528\u6237\u7F16\u8F91\u5DF2\u62E6\u622A\uFF1A${policyReasonLabel(reason)}`;
  },
  /** 用户编辑消息后发给管理员的变更通知（纯文本，内容来自消息快照，单侧截断防超长） */
  userEditedMessage(original, updated) {
    return `\u270F\uFE0F \u7528\u6237\u4FEE\u6539\u4E86\u6D88\u606F
\u539F\u5185\u5BB9\uFF1A${truncateText(original)}
\u65B0\u5185\u5BB9\uFF1A${truncateText(updated)}`;
  },
  /** 群内状态操作反馈（HTML） */
  mutedInGroup: "\u{1F507} <b>\u5DF2\u9759\u97F3</b>\uFF1A\u7528\u6237\u6D88\u606F\u4E0D\u518D\u8F6C\u53D1\u5230\u672C\u7FA4",
  unmutedInGroup: "\u{1F50A} <b>\u5DF2\u53D6\u6D88\u9759\u97F3</b>",
  noteEmpty: "\u{1F4DD} \u6682\u65E0\u5907\u6CE8\u3002\u7528\u6CD5: <code>/note \u5185\u5BB9</code>",
  noteCleared: "\u2705 \u5907\u6CE8\u5DF2\u6E05\u9664",
  /** 备注回执（HTML；备注内容为管理员输入的原始文本，内部统一转义） */
  noteSaved(content) {
    return `\u2705 \u5907\u6CE8\u5DF2\u4FDD\u5B58\uFF1A
${escapeHtml(content)}`;
  },
  noteView(existing) {
    return `\u{1F4DD} <b>\u5F53\u524D\u5907\u6CE8</b>
${escapeHtml(existing)}

\u7528\u6CD5: <code>/note \u65B0\u5907\u6CE8</code>\uFF08\u53D1 <code>/note clear</code> \u6E05\u7A7A\uFF09`;
  },
  conversationClosedInGroup: "\u{1F6AB} <b>\u5BF9\u8BDD\u5DF2\u5F3A\u5236\u5173\u95ED</b>",
  conversationOpenedInGroup: "\u2705 <b>\u5BF9\u8BDD\u5DF2\u6062\u590D</b>",
  verificationReset: "\u{1F504} <b>\u9A8C\u8BC1\u91CD\u7F6E</b>\uFF08\u5DF2\u53D6\u6D88\u6C38\u4E45\u4FE1\u4EFB\uFF0C\u4E0B\u6B21\u9700\u91CD\u65B0\u9A8C\u8BC1\uFF09",
  trusted: "\u{1F31F} <b>\u5DF2\u8BBE\u7F6E\u6C38\u4E45\u4FE1\u4EFB</b>",
  bannedInGroup: "\u{1F6AB} <b>\u7528\u6237\u5DF2\u5C01\u7981</b>\uFF08\u5DF2\u5C1D\u8BD5\u901A\u77E5\u5BF9\u65B9\uFF09",
  unbannedInGroup: "\u2705 <b>\u7528\u6237\u5DF2\u89E3\u5C01</b>\uFF08\u5DF2\u5C1D\u8BD5\u901A\u77E5\u5BF9\u65B9\uFF09",
  /** 封禁通知失败提示（HTML；desc 为 Telegram 错误描述的原始文本，内部统一转义） */
  banNotifyFailed(desc) {
    return `\u26A0\uFE0F \u5DF2\u5C01\u7981\uFF0C\u4F46\u901A\u77E5\u7528\u6237\u5931\u8D25\uFF08\u53EF\u80FD\u5BF9\u65B9\u672A\u79C1\u804A\u8FC7\u673A\u5668\u4EBA\u6216\u5DF2\u62C9\u9ED1\uFF09\uFF1A${escapeHtml(desc)}`;
  },
  /** 批量清理流程提示（HTML） */
  cleanupBusy: "\u23F3 <b>\u5DF2\u6709\u6E05\u7406\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002</b>",
  cleanupScanning: "\u{1F504} <b>\u6B63\u5728\u626B\u63CF\u9700\u8981\u6E05\u7406\u7684\u7528\u6237...</b>",
  /** 清理失败提示（HTML；msg 为错误描述的原始文本，内部统一转义） */
  cleanupFailed(msg) {
    return `\u274C <b>\u6E05\u7406\u8FC7\u7A0B\u51FA\u9519</b>

\u9519\u8BEF\u4FE1\u606F: <code>${escapeHtml(msg)}</code>`;
  },
  /** 批量清理完成报告（HTML；cleanedUsers 为 {userId, title} 原始记录，内部统一转义） */
  cleanupReport({ scannedCount = 0, cleanedCount = 0, errorCount = 0, cleanedUsers = [], maxDisplay = 20 } = {}) {
    const limit = Math.max(1, Number(maxDisplay) || 20);
    const lines = [
      "\u2705 <b>\u6E05\u7406\u5B8C\u6210</b>",
      "",
      "\u{1F4CA} <b>\u7EDF\u8BA1</b>",
      `\u2022 \u626B\u63CF\u7528\u6237: <b>${scannedCount}</b>`,
      `\u2022 \u5DF2\u6E05\u7406: <b>${cleanedCount}</b>`,
      `\u2022 \u9519\u8BEF: ${errorCount}`,
      ""
    ];
    if (cleanedCount > 0) {
      lines.push("\u{1F5D1} <b>\u5DF2\u6E05\u7406\u7528\u6237</b>\uFF08\u8BDD\u9898\u5DF2\u5220\u9664\uFF09:");
      for (const user of cleanedUsers.slice(0, limit)) {
        lines.push(`\u2022 UID <code>${escapeHtml(String(user.userId ?? ""))}</code> \xB7 ${escapeHtml(user.title || "")}`);
      }
      if (cleanedUsers.length > limit) {
        lines.push("", `\u2026\u8FD8\u6709 ${cleanedUsers.length - limit} \u4E2A`);
      }
      lines.push("", "\u{1F4A1} \u8FD9\u4E9B\u7528\u6237\u4E0B\u6B21\u53D1\u6D88\u606F\u5C06\u91CD\u65B0\u9A8C\u8BC1\u5E76\u521B\u5EFA\u65B0\u8BDD\u9898\u3002");
    } else {
      lines.push("\u2728 \u6CA1\u6709\u53D1\u73B0\u9700\u8981\u6E05\u7406\u7684\u7528\u6237\u8BB0\u5F55\u3002");
    }
    return lines.join("\n");
  },
  /** 管理 UI 回调 toast 与通用错误提示 */
  cbNoPermission: "\u65E0\u6743\u9650",
  cbUpdated: "\u5DF2\u66F4\u65B0",
  cbCleanupStarted: "\u5F00\u59CB\u6E05\u7406",
  cbCancelled: "\u5DF2\u53D6\u6D88",
  cleanupCancelled: "\u5DF2\u53D6\u6D88\u6E05\u7406\u3002",
  cbUnknownNav: "\u672A\u77E5\u5BFC\u822A",
  cbInvalidUserId: "\u65E0\u6548\u7528\u6237 ID",
  cbNoUserTopic: "\u627E\u4E0D\u5230\u7528\u6237\u8BDD\u9898",
  cbUnknownAction: "\u672A\u77E5\u64CD\u4F5C",
  cbUnknownCallback: "\u672A\u77E5\u56DE\u8C03",
  callbackBusy(action) {
    return CALLBACK_BUSY_COPY[action] || "\u5904\u7406\u4E2D\u2026";
  },
  cbOperationFailed: "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
  kvNotBoundNotes: "\u274C KV \u672A\u7ED1\u5B9A\uFF0C\u65E0\u6CD5\u641C\u7D22\u5907\u6CE8",
  d1NotBoundFind: "\u274C D1 \u672A\u7ED1\u5B9A\uFF0C\u65E0\u6CD5\u641C\u7D22",
  /** 搜索失败提示（HTML；msg 为错误描述的原始文本，内部统一转义） */
  notesSearchFailed(msg) {
    return `\u274C \u5907\u6CE8\u641C\u7D22\u5931\u8D25: ${escapeHtml(msg)}`;
  },
  searchFailed(msg) {
    return `\u274C \u641C\u7D22\u5931\u8D25: ${escapeHtml(msg)}`;
  },
  /** v1:* 资料卡回调与后台菜单文案 */
  adminMenuTitle: "\u7BA1\u7406\u540E\u53F0",
  cbInvalidOperation: "\u65E0\u6548\u64CD\u4F5C",
  userNotFound: "\u7528\u6237\u4E0D\u5B58\u5728",
  processed: "\u5DF2\u5904\u7406",
  backendConnected: "\u540E\u53F0\u8FDE\u63A5\u6B63\u5E38",
  permissionExpired: "\u6743\u9650\u5DF2\u5931\u6548",
  /** v1 资料卡回调回执：按动作与操作前状态显示新状态（取代笼统「已处理」） */
  v1ActionResult(action, before) {
    switch (action) {
      case "trust":
        return before?.trustLevel === "trusted" ? "\u5DF2\u53D6\u6D88\u4FE1\u4EFB" : "\u5DF2\u4FE1\u4EFB";
      case "ban":
        return before?.status === "banned" ? "\u5DF2\u89E3\u5C01" : "\u5DF2\u5C01\u7981";
      case "close":
        return before?.status === "closed" ? "\u5DF2\u6253\u5F00\u5BF9\u8BDD" : "\u5DF2\u5173\u95ED\u5BF9\u8BDD";
      case "mute":
        return before?.isMuted ? "\u5DF2\u53D6\u6D88\u9759\u97F3" : "\u5DF2\u9759\u97F3";
      default:
        return "\u5DF2\u5904\u7406";
    }
  },
  /** 群内非管理员执行管理命令时的提示 */
  noPermissionHint: "\u26D4 \u65E0\u7BA1\u7406\u6743\u9650\uFF1A\u4EC5\u7FA4\u4E3B/\u7BA1\u7406\u5458\u6216 ADMIN_IDS \u53EF\u4F7F\u7528\u8BE5\u6307\u4EE4\u3002",
  /** 话题内未反查到用户（可定位） */
  threadNotLinked: "\u26A0\uFE0F \u5F53\u524D\u8BDD\u9898\u672A\u5173\u8054\u7528\u6237\uFF08\u8BF7\u5728\u5BF9\u5E94\u7528\u6237 Forum Topic \u5185\u6267\u884C\uFF0C\u6216\u4F7F\u7528 /find\uFF09\u3002",
  /** 话题内未反查到用户（不可定位时的全局命令提示） */
  threadNotLinkedGlobal: "\u26A0\uFE0F \u5F53\u524D\u8BDD\u9898\u672A\u5173\u8054\u7528\u6237\u3002\u5168\u5C40\u547D\u4EE4\uFF1A/sysinfo /stats /rank /find /notes /help",
  /** /find 无参用法提示 */
  findUsage: FIND_USAGE_TEXT,
  /** /find 导航说明卡片（adm:nav:find 与文本命令共用） */
  findNavHelp: [
    "\u{1F50D} <b>\u67E5\u627E\u7528\u6237</b>",
    FIND_USAGE_TEXT,
    "\u5907\u6CE8: <code>/notes \u5173\u952E\u8BCD</code>",
    "\u6D3B\u8DC3: <code>/rank</code>"
  ].join("\n"),
  /** listwords 回调不可用时的兜底提示 */
  listWordsUnavailable: "\u8BF7\u4F7F\u7528\u547D\u4EE4 <code>/listwords</code>",
  /** 非 Owner 尝试同步 Bot 命令菜单 */
  syncCommandsDenied: "\u274C \u4EC5 <code>OWNER_IDS</code> \u53EF\u540C\u6B65 Bot \u547D\u4EE4\u83DC\u5355",
  /** 命令菜单同步成功回执（count 为同步条数） */
  commandsSynced(count) {
    return `\u2705 \u5DF2\u540C\u6B65 <b>${count}</b> \u6761\u547D\u4EE4\u5230 Bot \u83DC\u5355

<i>\u5BA2\u6237\u7AEF\u53EF\u80FD\u9700\u91CD\u542F\u6216\u7B49\u51E0\u5206\u949F\u540E\u5237\u65B0\u83DC\u5355</i>`;
  }
};

// src/admin-service.js
var ROLE_PERMISSIONS = {
  owner: /* @__PURE__ */ new Set(["*"]),
  operator: /* @__PURE__ */ new Set([
    "admin.menu",
    "user.view",
    "user.reply",
    "user.ban",
    "user.mute",
    "user.close",
    "user.trust"
  ]),
  rules_manager: /* @__PURE__ */ new Set(["admin.menu", "rule.view", "rule.create", "rule.update", "rule.delete"])
};
var USER_CALLBACK_ACTIONS = {
  trust: "user.trust",
  ban: "user.ban",
  close: "user.close",
  mute: "user.mute"
};
function buildAdminMenu() {
  return {
    inline_keyboard: [
      [{ text: "\u68C0\u67E5\u540E\u53F0\u8FDE\u63A5", callback_data: "v1:admin:status" }]
    ]
  };
}
function createAdminService({
  storage,
  ephemeralStore: ephemeralStore2,
  telegram,
  ownerIds = [],
  randomId = () => crypto.randomUUID(),
  now = Date.now,
  onRulesChanged = () => {
  }
}) {
  const owners = new Set(ownerIds.map(String));
  async function authorize(adminId, action) {
    if (owners.has(String(adminId))) return true;
    const admin = await storage.getAdminUser?.(adminId);
    if (!admin?.enabled) return false;
    const permissions = ROLE_PERMISSIONS[admin.role];
    return Boolean(permissions?.has("*") || permissions?.has(action));
  }
  async function handlePrivateAdminMessage(message) {
    const adminId = message.from?.id;
    if (!adminId || !await authorize(adminId, "admin.menu")) {
      return { status: "unauthorized" };
    }
    const text = (message.text || "").trim();
    if (text === "/cancel") {
      await ephemeralStore2?.clearAdminState?.(adminId);
      return { status: "cancelled" };
    }
    if (text !== "/start") return { status: "ignored" };
    await telegram.call("sendMessage", {
      chat_id: message.chat.id,
      text: ADMIN_COPY.adminMenuTitle,
      reply_markup: buildAdminMenu()
    });
    return { status: "menu" };
  }
  async function handleCallbackQuery(query) {
    const adminId = query.from?.id;
    const parts = String(query.data || "").split(":");
    let permission = null;
    let resourceId = null;
    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "admin" && parts[2] === "status") {
      permission = "admin.menu";
    } else if (parts.length === 4 && parts[0] === "v1" && parts[1] === "user" && /^\d{1,20}$/.test(parts[3])) {
      permission = USER_CALLBACK_ACTIONS[parts[2]] || null;
      resourceId = parts[3];
    }
    if (!permission) {
      await telegram.call("answerCallbackQuery", {
        callback_query_id: query.id,
        text: ADMIN_COPY.cbInvalidOperation,
        show_alert: true
      });
      return { status: "invalid" };
    }
    const allowed = adminId && await authorize(adminId, permission);
    let before = null;
    if (allowed && resourceId) {
      before = await storage.getUser(resourceId);
      if (!before) {
        await telegram.call("answerCallbackQuery", {
          callback_query_id: query.id,
          text: ADMIN_COPY.userNotFound,
          show_alert: true
        });
        return { status: "missing_user" };
      }
      const action = parts[2];
      const changes = action === "trust" ? { trustLevel: before.trustLevel === "trusted" ? "normal" : "trusted" } : action === "ban" ? { status: before.status === "banned" ? "active" : "banned" } : action === "close" ? { status: before.status === "closed" ? "active" : "closed" } : { isMuted: !before.isMuted };
      const after = await storage.updateUserState(resourceId, changes);
      await storage.appendAudit?.({
        id: randomId(),
        adminId: String(adminId),
        action: permission,
        resourceType: "user",
        resourceId,
        beforeState: before,
        afterState: after,
        createdAt: now()
      });
    }
    const responseText = resourceId ? ADMIN_COPY.v1ActionResult(parts[2], before) : ADMIN_COPY.backendConnected;
    await telegram.call("answerCallbackQuery", {
      callback_query_id: query.id,
      text: allowed ? responseText : ADMIN_COPY.permissionExpired,
      show_alert: !allowed
    });
    return { status: allowed ? "handled" : "unauthorized" };
  }
  async function createRule(adminId, rule) {
    if (!await authorize(adminId, "rule.create")) throw new Error("Forbidden");
    validateRuleInput(rule);
    const created = {
      ...rule,
      ruleId: rule.ruleId || randomId(),
      enabled: rule.enabled !== false,
      createdBy: String(adminId),
      createdAt: now(),
      updatedAt: now()
    };
    await storage.upsertRule(created);
    onRulesChanged();
    return created;
  }
  async function listRules(adminId, offset = 0, limit = 20) {
    if (!await authorize(adminId, "rule.view")) throw new Error("Forbidden");
    return storage.listRules(offset, limit);
  }
  async function deleteRule(adminId, ruleId2) {
    if (!await authorize(adminId, "rule.delete")) throw new Error("Forbidden");
    const deleted = await storage.deleteRule(ruleId2);
    if (deleted) onRulesChanged();
    return deleted;
  }
  async function setRuleEnabled(adminId, ruleId2, enabled) {
    if (!await authorize(adminId, "rule.update")) throw new Error("Forbidden");
    const updated = await storage.setRuleEnabled(ruleId2, enabled, now());
    if (updated) onRulesChanged();
    return updated;
  }
  return {
    authorize,
    handlePrivateAdminMessage,
    handleCallbackQuery,
    createRule,
    listRules,
    deleteRule,
    setRuleEnabled
  };
}

// src/conversation-service.js
var SNAPSHOT_LIMIT = 5e3;
function snapshotMessage(message) {
  return extractMessageText(message).slice(0, SNAPSHOT_LIMIT);
}
function hashContent(content) {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
function createConversationService({
  storage,
  telegram,
  policy,
  now = Date.now
}) {
  async function evaluate(message, user) {
    return policy ? policy({ message, user }) : {
      action: "allow",
      reason: null,
      shouldForward: true,
      shouldIncrementViolation: false
    };
  }
  async function updateLinkSnapshot(link, message, contentSnapshot) {
    await storage.saveMessageLink({
      ...link,
      contentSnapshot,
      contentHash: hashContent(contentSnapshot),
      updatedAt: now()
    });
  }
  async function handleEditedPrivateMessage(message) {
    const link = await storage.getMessageLink(
      "user_to_admin",
      message.chat.id,
      message.message_id
    );
    if (!link) return { status: "missing_link" };
    const user = await storage.getUser(link.userId);
    const policyResult = await evaluate(message, user || { userId: link.userId });
    if (!policyResult.shouldForward) {
      await telegram.call("sendMessage", {
        chat_id: message.chat.id,
        text: USER_COPY.blockedWord
      });
      await telegram.call("sendMessage", {
        chat_id: link.targetChatId,
        message_thread_id: link.topicId,
        text: ADMIN_COPY.userEditBlocked(policyResult.reason || policyResult.action)
      });
      return { status: "blocked", reason: policyResult.reason };
    }
    const contentSnapshot = snapshotMessage(message);
    if (hashContent(contentSnapshot) === link.contentHash) return { status: "unchanged" };
    await telegram.call("sendMessage", {
      chat_id: link.targetChatId,
      message_thread_id: link.topicId,
      text: ADMIN_COPY.userEditedMessage(link.contentSnapshot || "(\u7A7A)", contentSnapshot || "(\u7A7A)")
    });
    await updateLinkSnapshot(link, message, contentSnapshot);
    return { status: "notified" };
  }
  async function handleEditedAdminMessage(message) {
    const link = await storage.getMessageLink(
      "admin_to_user",
      message.chat.id,
      message.message_id
    );
    if (!link) return { status: "missing_link" };
    const contentSnapshot = snapshotMessage(message);
    if (hashContent(contentSnapshot) === link.contentHash) return { status: "unchanged" };
    await telegram.call("sendMessage", {
      chat_id: link.userId,
      text: USER_COPY.adminEditedReply(link.contentSnapshot || "(\u7A7A)", contentSnapshot || "(\u7A7A)")
    });
    await updateLinkSnapshot(link, message, contentSnapshot);
    return { status: "notified" };
  }
  return {
    handleEditedPrivateMessage,
    handleEditedAdminMessage
  };
}

// src/logger.js
var REDACTED_KEYS = /* @__PURE__ */ new Set([
  "bot_token",
  "turnstile_secret_key",
  "webhook_secret",
  "bottoken",
  "turnstiletoken",
  "webhooksecret",
  "verifycode",
  "verifyid",
  "text",
  "caption",
  // 通用凭据/敏感字段（精确键名匹配，防新增日志误带）
  "token",
  "secret",
  "phone",
  "password",
  "passcode",
  "auth_key",
  "api_hash",
  "access_hash",
  "session_key",
  "private_key"
]);
function redactValue(key, value, seen) {
  if (REDACTED_KEYS.has(String(key).toLowerCase())) return "[REDACTED]";
  if (Array.isArray(value)) {
    return value.map((item) => redactValue("", item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childKey, childValue, seen)
      ])
    );
    seen.delete(value);
    return redacted;
  }
  return value;
}
function redactLogData(data = {}) {
  return redactValue("", data, /* @__PURE__ */ new WeakSet());
}
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[Unserializable]";
    }
  }
}
function errorMessage(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value !== null && typeof value === "object") {
    const message = value.message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(value);
    } catch {
      return "[Unserializable Error]";
    }
  }
  if (value === void 0 || value === null) return "unknown";
  return String(value);
}
var LOG_MAX_BYTES = 32 * 1024;
var LOG_TRUNCATED_SUFFIX = "\u2026[truncated]";
function capLogLine(output) {
  if (output.length * 3 <= LOG_MAX_BYTES) return output;
  const encoder = new TextEncoder();
  if (encoder.encode(output).byteLength <= LOG_MAX_BYTES) return output;
  const budget = LOG_MAX_BYTES - encoder.encode(LOG_TRUNCATED_SUFFIX).byteLength;
  let bytes = 0;
  let end = 0;
  for (const char of output) {
    const charBytes = encoder.encode(char).byteLength;
    if (bytes + charBytes > budget) break;
    bytes += charBytes;
    end += char.length;
  }
  return `${output.slice(0, end)}${LOG_TRUNCATED_SUFFIX}`;
}
function createLogger(baseContext = {}, sink = console, options = {}) {
  const { onError } = options;
  function emit(level, action, data = {}) {
    const method = level.toLowerCase();
    const log = redactLogData({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      action,
      ...baseContext,
      ...data
    });
    const output = capLogLine(safeStringify(log));
    try {
      const target = typeof sink?.[method] === "function" ? sink[method] : sink?.log;
      if (typeof target === "function") target.call(sink, output);
    } catch {
    }
  }
  return {
    info(action, data = {}) {
      emit("INFO", action, data);
    },
    warn(action, data = {}) {
      emit("WARN", action, data);
    },
    error(action, error, data = {}) {
      emit("ERROR", action, {
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : void 0,
        ...data
      });
      try {
        onError?.(action, error, data);
      } catch {
      }
    },
    debug(action, data = {}) {
      emit("DEBUG", action, data);
    }
  };
}

// src/telegram-client.js
var DEFAULT_API_BASE = "https://api.telegram.org";
var API_BASE_WHITELIST = /* @__PURE__ */ new Set([
  DEFAULT_API_BASE,
  "https://api.telegram.dev"
]);
var DEFAULT_SLEEP = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
var TelegramApiError = class extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TelegramApiError";
    Object.assign(this, details);
  }
};
function classifyTelegramError({ status, description = "", retryAfter }) {
  const normalized = String(description).toLowerCase();
  if (status === 429) {
    return { category: "rate_limited", retryable: true, retryAfter };
  }
  if (status >= 500) return { category: "server_error", retryable: true };
  if (status === 401) return { category: "unauthorized", retryable: false };
  if (status === 403) {
    const category = normalized.includes("bot was blocked by the user") ? "user_unreachable" : "forbidden";
    return { category, retryable: false };
  }
  if (normalized.includes("thread not found") || normalized.includes("topic not found") || normalized.includes("message thread not found") || normalized.includes("topic deleted")) {
    return { category: "topic_missing", retryable: false };
  }
  if (normalized.includes("chat not found")) {
    return { category: "chat_not_found", retryable: false };
  }
  if (normalized.includes("user not found")) {
    return { category: "user_not_found", retryable: false };
  }
  if (normalized.includes("message id is not specified") || normalized.includes("message to forward not found") || normalized.includes("message to copy not found") || normalized.includes("message is too old")) {
    return { category: "message_missing", retryable: false };
  }
  if (normalized.includes("message is too long")) {
    return { category: "message_too_long", retryable: false };
  }
  return { category: "invalid_request", retryable: false };
}
function resolveApiBase(apiBase, logger) {
  if (!apiBase || API_BASE_WHITELIST.has(apiBase)) {
    return apiBase || DEFAULT_API_BASE;
  }
  logger?.warn?.("api_base_rejected", { attemptedBase: apiBase });
  return DEFAULT_API_BASE;
}
function retryDelay(attempt, random) {
  const base = attempt === 1 ? 250 : 750;
  const jitter = attempt === 1 ? 250 : 750;
  return base + Math.floor(random() * jitter);
}
function createTelegramClient({
  botToken,
  apiBase,
  fetchImpl = fetch,
  sleep = DEFAULT_SLEEP,
  random = Math.random,
  timeoutMs = 8e3,
  maxTotalMs = 2e4,
  logger
} = {}) {
  const base = resolveApiBase(apiBase, logger);
  return {
    async call(method, body) {
      const startedAt = Date.now();
      let attempt = 0;
      while (attempt < 3) {
        attempt += 1;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(`${base}/bot${botToken}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
          });
          let result;
          try {
            result = await response.json();
          } catch (cause) {
            const error2 = new TelegramApiError("Invalid Telegram API response", {
              category: "parse_error",
              retryable: true,
              status: response.status,
              method,
              attempts: attempt,
              cause
            });
            if (attempt >= 2) throw error2;
            const delay2 = retryDelay(attempt, random);
            if (Date.now() - startedAt + delay2 > maxTotalMs) throw error2;
            logger?.warn?.("telegram_api_retry", {
              method,
              category: "parse_error",
              attempt,
              delay: delay2
            });
            await sleep(delay2);
            continue;
          }
          if (result.ok) return result;
          const status = Number(result.error_code || response.status || 0);
          const retryAfter = status === 429 ? Number(result.parameters?.retry_after || 0) || 5 : void 0;
          const classification = classifyTelegramError({
            status,
            description: result.description,
            retryAfter
          });
          const error = new TelegramApiError(
            result.description || `Telegram API ${status}`,
            {
              ...classification,
              status,
              method,
              attempts: attempt,
              response: result
            }
          );
          const maxAttempts = classification.category === "rate_limited" ? 2 : 3;
          if (!classification.retryable || attempt >= maxAttempts) throw error;
          const delay = classification.category === "rate_limited" ? retryAfter * 1e3 : retryDelay(attempt, random);
          if (Date.now() - startedAt + delay > maxTotalMs) throw error;
          logger?.warn?.("telegram_api_retry", {
            method,
            category: classification.category,
            attempt,
            delay
          });
          await sleep(delay);
        } catch (caught) {
          if (caught instanceof TelegramApiError) throw caught;
          const category = caught?.name === "AbortError" ? "timeout" : "network";
          const error = new TelegramApiError(
            category === "timeout" ? "Request timeout" : String(caught?.message || caught),
            {
              category,
              retryable: true,
              status: 0,
              method,
              attempts: attempt
            }
          );
          if (attempt >= 3) throw error;
          const delay = retryDelay(attempt, random);
          if (Date.now() - startedAt + delay > maxTotalMs) throw error;
          logger?.warn?.("telegram_api_retry", { method, category, attempt, delay });
          await sleep(delay);
        } finally {
          clearTimeout(timeoutId);
        }
      }
      throw new TelegramApiError("Telegram API retry limit reached", {
        category: "network",
        retryable: true,
        status: 0,
        method,
        attempts: attempt
      });
    }
  };
}

// src/storage/kv-ephemeral-store.js
function createEphemeralStore(kv) {
  return {
    async getVerification(userId) {
      const value = await kv.get(`verified:${userId}`);
      if (!value) return null;
      if (value === "trusted") return { type: "legacy_trusted" };
      return { type: "temporary" };
    },
    async getVerificationTimestamp(userId) {
      const value = await kv.get(`verified_ts:${userId}`);
      return value == null ? null : Number(value);
    },
    async setVerification(userId, {
      type = "temporary",
      ttl,
      verifiedAt = Date.now()
    }) {
      if (type !== "temporary") {
        throw new Error("Permanent trust must use persistent storage");
      }
      await Promise.all([
        kv.put(`verified:${userId}`, "1", { expirationTtl: ttl }),
        kv.put(`verified_ts:${userId}`, String(verifiedAt), { expirationTtl: ttl })
      ]);
    },
    async clearVerification(userId) {
      await Promise.all([
        kv.delete(`verified:${userId}`),
        kv.delete(`verified_ts:${userId}`)
      ]);
    },
    async checkRateLimit(userId, action, limit, windowSeconds) {
      const key = `ratelimit:${action}:${userId}`;
      const count = Number(await kv.get(key) || 0);
      if (count >= limit) return { allowed: false, remaining: 0 };
      const next = count + 1;
      await kv.put(key, String(next), { expirationTtl: windowSeconds });
      return { allowed: true, remaining: Math.max(0, limit - next) };
    },
    async getAdminCache(userId) {
      const value = await kv.get(`admin:${userId}`);
      if (value == null) return null;
      return value === "1";
    },
    async setAdminCache(userId, isAdmin, ttl) {
      await kv.put(`admin:${userId}`, isAdmin ? "1" : "0", { expirationTtl: ttl });
    },
    async getAdminState(userId) {
      return kv.get(`admin_state:${userId}`, { type: "json" });
    },
    async setAdminState(userId, state, ttl = 600) {
      await kv.put(`admin_state:${userId}`, JSON.stringify(state), { expirationTtl: ttl });
    },
    async clearAdminState(userId) {
      await kv.delete(`admin_state:${userId}`);
    },
    async getTopicHealth(topicId) {
      const value = await kv.get(`thread_ok:${topicId}`);
      if (value == null) return null;
      return value === "1";
    },
    async setTopicHealth(topicId, healthy, ttl) {
      await kv.put(`thread_ok:${topicId}`, healthy ? "1" : "0", { expirationTtl: ttl });
    },
    async clearTopicHealth(topicId) {
      await kv.delete(`thread_ok:${topicId}`);
    }
  };
}

// src/blocked-words.js
var BLOCKED_WORDS = [
  "\u8D4C\u535A",
  "\u8272\u60C5",
  "\u4EE3\u5F00\u53D1",
  "\u52A0\u5FAE\u4FE1"
  // ↑ 在此添加更多屏蔽词，每行一个，用引号包裹、逗号结尾
];
var blockedWordsCache = { data: null, ts: 0, ttl: 6e4 };
async function getBlockedWords(env, forceRefresh = false, logger = null) {
  const now = Date.now();
  if (!forceRefresh && blockedWordsCache.data && now - blockedWordsCache.ts < blockedWordsCache.ttl) {
    return blockedWordsCache.data;
  }
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        kvWords = parsed.filter((w) => typeof w === "string" && w.trim().length > 0);
      }
    }
  } catch (e) {
    logger?.warn?.("blocked_words_kv_parse_error", { error: e.message });
  }
  const merged = [.../* @__PURE__ */ new Set([...BLOCKED_WORDS, ...kvWords])];
  blockedWordsCache.data = merged;
  blockedWordsCache.ts = now;
  return merged;
}
async function readKvBlockedWords(env) {
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) kvWords = JSON.parse(raw);
  } catch {
  }
  if (!Array.isArray(kvWords)) kvWords = [];
  return kvWords;
}
function invalidateBlockedWordsCache() {
  blockedWordsCache.data = null;
}

// src/admin-actions.js
function createAdminActions(deps) {
  const {
    tgCall: tgCall2,
    safeGetJSON: safeGetJSON2,
    escapeHtml: escapeHtml2,
    SEP_LINE: SEP_LINE2,
    formatUserStatusChips: formatUserStatusChips2,
    formatTimeBoth: formatTimeBoth2,
    buildUserActionKeyboard: buildUserActionKeyboard2,
    createD1Storage: createD1Storage2,
    setPersistentTrust: setPersistentTrust2,
    getVerificationState: getVerificationState2,
    resolveUserFromForTopic: resolveUserFromForTopic2,
    buildTopicTitle: buildTopicTitle2,
    bumpDailyStat: bumpDailyStat2,
    probeForumThread: probeForumThread2,
    config,
    logger
  } = deps;
  const readSafely = (work, fallback) => Promise.resolve().then(work).catch(() => fallback);
  const HOURLY_NOTICE_TTL_SECONDS2 = 3600;
  async function panel(env, threadId, userId) {
    const [resolvedFrom, ban2, muted, rec, note2, d1User, verification] = await Promise.all([
      readSafely(
        async () => await resolveUserFromForTopic2(env, userId, null) || {},
        {}
      ),
      readSafely(() => env.TOPIC_MAP.get(`banned:${userId}`), null),
      readSafely(() => env.TOPIC_MAP.get(`muted:${userId}`), null),
      readSafely(() => safeGetJSON2(env, `user:${userId}`, null), null),
      readSafely(() => env.TOPIC_MAP.get(`note:${userId}`), null),
      readSafely(
        () => env.TG_BOT_DB ? createD1Storage2(env.TG_BOT_DB).getUser(userId) : null,
        null
      ),
      readSafely(
        () => env.TG_BOT_DB ? null : getVerificationState2(env, userId),
        null
      )
    ]);
    const from = resolvedFrom;
    const name = escapeHtml2(formatUserName(from));
    const un = from.username ? `@${escapeHtml2(from.username)}` : "\u65E0\u7528\u6237\u540D";
    let lastMsgLine = "\u6700\u8FD1\u6D88\u606F: \u65E0";
    if (d1User?.lastMessageAt) lastMsgLine = `\u6700\u8FD1\u6D88\u606F: ${formatTimeBoth2(d1User.lastMessageAt)}`;
    const d1Status = d1User?.status || null;
    const trusted = d1User?.trustLevel === "trusted" || verification?.type === "trusted" || verification?.type === "legacy_trusted";
    const text = [
      "\u{1F39B} <b>\u7528\u6237\u9762\u677F</b>",
      SEP_LINE2,
      `\u{1F464} ${name} \xB7 ${un}`,
      `UID <code>${userId}</code>`,
      rec?.title ? `\u8BDD\u9898: ${escapeHtml2(String(rec.title))}` : "",
      `\u72B6\u6001  ${formatUserStatusChips2({ banned: Boolean(ban2), muted: Boolean(muted), closed: Boolean(rec?.closed) })}`,
      d1Status ? `D1: <code>${escapeHtml2(d1Status)}</code>` : "",
      lastMsgLine,
      note2 ? `\u{1F4DD} ${escapeHtml2(String(note2).slice(0, 80))}${String(note2).length > 80 ? "\u2026" : ""}` : "\u{1F4DD} \u65E0\u5907\u6CE8 \xB7 <code>/note \u5185\u5BB9</code> \u6DFB\u52A0",
      "",
      "\u{1F447} \u70B9\u6309\u94AE\u64CD\u4F5C",
      "<i>\u5C01\u7981 / \u5173\u95ED / \u91CD\u7F6E\u9700\u4E8C\u6B21\u786E\u8BA4</i>"
    ].filter(Boolean).join("\n");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text,
      parse_mode: "HTML",
      reply_markup: buildUserActionKeyboard2(userId, {
        banned: Boolean(ban2),
        muted: Boolean(muted),
        closed: Boolean(rec?.closed),
        trusted
      })
    });
  }
  async function mute(env, threadId, userId) {
    await env.TOPIC_MAP.put(`muted:${userId}`, "1");
    if (env.TG_BOT_DB) {
      try {
        await createD1Storage2(env.TG_BOT_DB).updateUserState(userId, { isMuted: true });
      } catch {
      }
    }
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.mutedInGroup,
      parse_mode: "HTML"
    });
    await tgCall2(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.muteUserNotify
    });
  }
  async function unmute(env, threadId, userId) {
    await env.TOPIC_MAP.delete(`muted:${userId}`);
    await env.TOPIC_MAP.delete(noticeKey.mute(userId));
    if (env.TG_BOT_DB) {
      try {
        await createD1Storage2(env.TG_BOT_DB).updateUserState(userId, { isMuted: false });
      } catch {
      }
    }
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.unmutedInGroup,
      parse_mode: "HTML"
    });
    await tgCall2(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.unmuteUserNotify
    });
  }
  async function note(env, threadId, userId, text) {
    const content = commandArgument(text, "note");
    if (!content) {
      const existing = await env.TOPIC_MAP.get(`note:${userId}`);
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: existing ? ADMIN_COPY.noteView(existing) : ADMIN_COPY.noteEmpty,
        parse_mode: "HTML"
      });
      return;
    }
    if (content.toLowerCase() === "clear" || content === "-" || content === "\u6E05\u9664") {
      await env.TOPIC_MAP.delete(`note:${userId}`);
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.noteCleared
      });
      return;
    }
    await env.TOPIC_MAP.put(`note:${userId}`, content.slice(0, 500), { expirationTtl: 365 * 86400 });
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.noteSaved(content.slice(0, 500)),
      parse_mode: "HTML"
    });
  }
  async function addWord(env, threadId, text, senderId) {
    const word = commandArgument(text, "addword");
    if (!word) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.wordUsageAdd,
        parse_mode: "HTML"
      });
      return;
    }
    if (word.length > config.WORD_MAX_LENGTH) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `\u26A0\uFE0F \u8BCD\u8FC7\u957F\uFF08\u6700\u591A ${config.WORD_MAX_LENGTH} \u5B57\uFF09\uFF0C\u8BF7\u7F29\u77ED\u540E\u91CD\u8BD5\u3002`,
        parse_mode: "HTML"
      });
      return;
    }
    let kvWords = await readKvBlockedWords(env);
    const allWords = [.../* @__PURE__ */ new Set([...BLOCKED_WORDS, ...kvWords])];
    if (allWords.map((w) => w.toLowerCase()).includes(word.toLowerCase())) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.wordExists(word),
        parse_mode: "HTML"
      });
      return;
    }
    kvWords.push(word);
    await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
    invalidateBlockedWordsCache();
    logger.info("blocked_word_added", { word, by: senderId });
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.wordAdded(word, kvWords.length),
      parse_mode: "HTML"
    });
  }
  async function delWord(env, threadId, text, senderId) {
    const word = commandArgument(text, "delword");
    if (!word) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.wordUsageDel,
        parse_mode: "HTML"
      });
      return;
    }
    if (BLOCKED_WORDS.map((w) => w.toLowerCase()).includes(word.toLowerCase())) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.wordHardcoded(word),
        parse_mode: "HTML"
      });
      return;
    }
    let kvWords = await readKvBlockedWords(env);
    const before = kvWords.length;
    kvWords = kvWords.filter((w) => w.toLowerCase() !== word.toLowerCase());
    if (kvWords.length === before) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.wordMissing(word),
        parse_mode: "HTML"
      });
      return;
    }
    await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
    invalidateBlockedWordsCache();
    logger.info("blocked_word_removed", { word, by: senderId });
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.wordDeleted(word, kvWords.length),
      parse_mode: "HTML"
    });
  }
  async function listWords(env, threadId) {
    const allWords = await getBlockedWords(env, true, logger);
    const kvWords = await readKvBlockedWords(env);
    const hardcoded = BLOCKED_WORDS;
    const dynamic = kvWords.filter((w) => !BLOCKED_WORDS.map((h) => h.toLowerCase()).includes(w.toLowerCase()));
    const spamKeywords = parseSpamKeywords((env.SPAM_KEYWORDS || "").toString());
    const blockedTotal = allWords.length;
    const lines = [
      "\u{1F4DD} <b>\u5185\u5BB9\u8FC7\u6EE4\u8BCD\u5E93</b>",
      "",
      `<b>\u4E00\u3001\u5C4F\u853D\u8BCD</b>\uFF08\u547D\u4E2D\u540E\u62E6\u622A\u5E76\u63D0\u793A\u7528\u6237\uFF0C\u5171 ${blockedTotal} \u4E2A\uFF09`,
      "",
      `\u{1F527} <b>\u786C\u7F16\u7801\u8BCD</b> (${hardcoded.length} \u4E2A\uFF0C\u4FEE\u6539\u9700\u6539\u4EE3\u7801):`,
      hardcoded.length > 0 ? hardcoded.map((w) => `  \u2022 ${escapeHtml2(w)}`).join("\n") : "  (\u65E0)",
      "",
      `\u{1F4BE} <b>\u52A8\u6001\u8BCD</b> (${dynamic.length} \u4E2A\uFF0C\u53EF\u7528 /addword /delword):`,
      dynamic.length > 0 ? dynamic.map((w) => `  \u2022 ${escapeHtml2(w)}`).join("\n") : "  (\u65E0)",
      "",
      `<b>\u4E8C\u3001\u5783\u573E\u5173\u952E\u8BCD SPAM_KEYWORDS</b>\uFF08\u73AF\u5883\u53D8\u91CF\uFF0C\u5171 ${spamKeywords.length} \u4E2A\uFF09`,
      spamKeywords.length > 0 ? spamKeywords.map((w) => `  \u2022 ${escapeHtml2(w)}`).join("\n") : "  (\u672A\u914D\u7F6E\uFF1B\u5728 Cloudflare Variables \u4E2D\u8BBE\u7F6E SPAM_KEYWORDS)",
      "",
      "<i>\u8BF4\u660E\uFF1A/addword \u53EA\u5199\u5165\u52A8\u6001\u5C4F\u853D\u8BCD\uFF0C\u4E0D\u4F1A\u6539 SPAM_KEYWORDS\u3002</i>"
    ];
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: lines.join("\n"),
      parse_mode: "HTML"
    });
  }
  async function close(env, threadId, userId) {
    const key = `user:${userId}`;
    let rec = await safeGetJSON2(env, key, null);
    if (!rec) {
      rec = { thread_id: threadId, closed: true };
    } else {
      rec.closed = true;
      if (!rec.thread_id) rec.thread_id = threadId;
    }
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    if (env.TG_BOT_DB) {
      try {
        await createD1Storage2(env.TG_BOT_DB).updateUserState(userId, { status: "closed" });
      } catch (e) {
        logger.warn("close_d1_update_failed", { userId, error: e?.message });
      }
    }
    await tgCall2(env, "closeForumTopic", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId
    });
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.conversationClosedInGroup,
      parse_mode: "HTML"
    });
  }
  async function open(env, threadId, userId) {
    const key = `user:${userId}`;
    let rec = await safeGetJSON2(env, key, null);
    if (!rec) {
      rec = { thread_id: threadId, closed: false };
    } else {
      rec.closed = false;
      if (!rec.thread_id) rec.thread_id = threadId;
    }
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    if (env.TG_BOT_DB) {
      try {
        await createD1Storage2(env.TG_BOT_DB).updateUserState(userId, { status: "active" });
      } catch (e) {
        logger.warn("open_d1_update_failed", { userId, error: e?.message });
      }
    }
    await tgCall2(env, "reopenForumTopic", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId
    });
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.conversationOpenedInGroup,
      parse_mode: "HTML"
    });
  }
  async function reset(env, threadId, userId) {
    await setPersistentTrust2(env, userId, "normal");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.verificationReset,
      parse_mode: "HTML"
    });
  }
  async function trust(env, threadId, userId) {
    await setPersistentTrust2(env, userId, "trusted");
    await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.trusted,
      parse_mode: "HTML"
    });
  }
  async function ban(env, threadId, userId) {
    await env.TOPIC_MAP.put(`banned:${userId}`, "1");
    if (env.TG_BOT_DB) {
      try {
        await createD1Storage2(env.TG_BOT_DB).updateUserState(userId, { status: "banned" });
      } catch (e) {
        logger.warn("ban_d1_update_failed", { userId, error: e?.message });
      }
    }
    await bumpDailyStat2(env, "bans", 1);
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.bannedInGroup,
      parse_mode: "HTML"
    });
    const notify = await tgCall2(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.banUserNotify
    });
    if (!notify?.ok) {
      logger.warn("ban_user_notify_failed", {
        userId,
        description: notify?.description
      });
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.banNotifyFailed(notify?.description || "unknown"),
        parse_mode: "HTML"
      });
    } else {
      await env.TOPIC_MAP.put(noticeKey.ban(userId), "1", { expirationTtl: HOURLY_NOTICE_TTL_SECONDS2 });
    }
  }
  async function unban(env, threadId, userId) {
    await env.TOPIC_MAP.delete(`banned:${userId}`);
    await env.TOPIC_MAP.delete(noticeKey.ban(userId));
    if (env.TG_BOT_DB) {
      try {
        await createD1Storage2(env.TG_BOT_DB).updateUserState(userId, { status: "active" });
      } catch (e) {
        logger.warn("unban_d1_update_failed", { userId, error: e?.message });
      }
    }
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: ADMIN_COPY.unbannedInGroup,
      parse_mode: "HTML"
    });
    const notify = await tgCall2(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.unbanUserNotify
    });
    if (!notify?.ok) {
      logger.warn("unban_user_notify_failed", {
        userId,
        description: notify?.description
      });
    }
  }
  async function info(env, threadId, userId) {
    const userKey = `user:${userId}`;
    let userRec = await safeGetJSON2(env, userKey, null);
    const verifyStatus = await getVerificationState2(env, userId);
    const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);
    const from = await resolveUserFromForTopic2(env, userId, null);
    const resolvedTitle = buildTopicTitle2(from);
    if (userRec?.thread_id && resolvedTitle && resolvedTitle !== "User" && isPlaceholderTopicTitle(userRec.title)) {
      try {
        const edit = await tgCall2(env, "editForumTopic", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: userRec.thread_id,
          name: resolvedTitle
        });
        if (edit?.ok) {
          userRec = { ...userRec, title: resolvedTitle };
          await env.TOPIC_MAP.put(userKey, JSON.stringify(userRec));
        }
      } catch (e) {
        logger.warn("info_topic_title_repair_failed", { userId, error: e?.message });
      }
    }
    const displayName = escapeHtml2(formatUserName(from));
    const usernameText = from.username ? `@${escapeHtml2(from.username)}` : "\u65E0";
    const openLink = from.username ? `<a href="https://t.me/${escapeHtml2(from.username)}">\u6253\u5F00\u4E3B\u9875 @${escapeHtml2(from.username)}</a>` : `<a href="tg://user?id=${userId}">\u6253\u5F00\u7528\u6237\u8D44\u6599</a>`;
    const topicTitle = escapeHtml2(userRec?.title || resolvedTitle || "\u672A\u77E5");
    const trusted = verifyStatus?.type === "trusted" || verifyStatus?.type === "legacy_trusted";
    const verifyText = verifyStatus ? trusted ? "\u{1F31F} \u6C38\u4E45\u4FE1\u4EFB" : "\u2705 \u5DF2\u9A8C\u8BC1" : "\u274C \u672A\u9A8C\u8BC1";
    const banText = banStatus ? "\u{1F6AB} \u5DF2\u5C01\u7981" : "\u2705 \u6B63\u5E38";
    const muted = await env.TOPIC_MAP.get(`muted:${userId}`);
    const note2 = await env.TOPIC_MAP.get(`note:${userId}`);
    let lastMsgAt = null;
    let d1Status = null;
    if (env.TG_BOT_DB) {
      try {
        const u = await createD1Storage2(env.TG_BOT_DB).getUser(userId);
        lastMsgAt = u?.lastMessageAt ?? null;
        d1Status = u?.status ?? null;
      } catch {
      }
    }
    const lines = [
      "\u{1F464} <b>\u7528\u6237\u4FE1\u606F</b>",
      `\u59D3\u540D: ${displayName}`,
      `\u7528\u6237\u540D: ${usernameText}`,
      `UID: <code>${userId}</code>`,
      `Topic ID: <code>${threadId}</code>`,
      `\u8BDD\u9898\u6807\u9898: ${topicTitle}`,
      `\u9A8C\u8BC1: ${verifyText}`,
      `\u5C01\u7981: ${banText} \xB7 \u9759\u97F3: ${muted ? "\u{1F507} \u662F" : "\u5426"} \xB7 \u4F1A\u8BDD\u5173\u95ED: ${userRec?.closed ? "\u662F" : "\u5426"}`,
      d1Status ? `D1 \u72B6\u6001: <code>${escapeHtml2(d1Status)}</code>` : "",
      `\u6700\u8FD1\u6D88\u606F: ${formatTimeBoth2(lastMsgAt)}`,
      note2 ? `\u5907\u6CE8: ${escapeHtml2(note2)}` : "\u5907\u6CE8: \u65E0\uFF08/note \u5185\u5BB9\uFF09",
      `\u94FE\u63A5: ${openLink}`,
      from.username ? "" : "<i>\u65E0\u516C\u5F00\u7528\u6237\u540D\u65F6\u90E8\u5206\u5BA2\u6237\u7AEF\u65E0\u6CD5\u70B9\u51FB tg \u94FE\u63A5</i>"
    ].filter(Boolean).join("\n");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: lines,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildUserActionKeyboard2(userId, {
        banned: Boolean(banStatus),
        muted: Boolean(muted),
        closed: Boolean(userRec?.closed),
        trusted
      })
    });
  }
  async function cleanup(threadId, env) {
    const lockKey = "cleanup:lock";
    const locked = await env.TOPIC_MAP.get(lockKey);
    if (locked) {
      await tgCall2(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: ADMIN_COPY.cleanupBusy,
        parse_mode: "HTML"
      }, threadId));
      return;
    }
    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: config.CLEANUP_LOCK_TTL_SECONDS });
    await tgCall2(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: ADMIN_COPY.cleanupScanning,
      parse_mode: "HTML"
    }, threadId));
    let cleanedCount = 0;
    let errorCount = 0;
    const cleanedUsers = [];
    let scannedCount = 0;
    try {
      let cursor = void 0;
      do {
        const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
        const names = (result.keys || []).map((k) => k.name);
        scannedCount += names.length;
        for (let i = 0; i < names.length; i += config.CLEANUP_BATCH_SIZE) {
          const batch = names.slice(i, i + config.CLEANUP_BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (name) => {
              const rec = await safeGetJSON2(env, name, null);
              if (!rec || !rec.thread_id) return null;
              const userId = name.slice(5);
              const topicThreadId = rec.thread_id;
              const probe = await probeForumThread2(env, topicThreadId, {
                userId,
                reason: "cleanup_check",
                doubleCheckOnMissingThreadId: false
              });
              if (probe.status === "redirected" || probe.status === "missing") {
                await env.TOPIC_MAP.delete(name);
                await setPersistentTrust2(env, userId, "normal");
                await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);
                return {
                  userId,
                  threadId: topicThreadId,
                  title: rec.title || "\u672A\u77E5"
                };
              } else if (probe.status === "probe_invalid") {
                logger.warn("cleanup_probe_invalid_message", {
                  userId,
                  threadId: topicThreadId,
                  errorDescription: probe.description
                });
              } else if (probe.status === "unknown_error") {
                logger.warn("cleanup_probe_failed_unknown", {
                  userId,
                  threadId: topicThreadId,
                  errorDescription: probe.description
                });
              } else if (probe.status === "missing_thread_id") {
                logger.warn("cleanup_probe_missing_thread_id", { userId, threadId: topicThreadId });
              }
              return null;
            })
          );
          results.forEach((result2) => {
            if (result2.status === "fulfilled" && result2.value) {
              cleanedCount++;
              cleanedUsers.push(result2.value);
              logger.info("cleanup_user", {
                userId: result2.value.userId,
                threadId: result2.value.threadId
              });
            } else if (result2.status === "rejected") {
              errorCount++;
              logger.error("cleanup_batch_error", result2.reason);
            }
          });
          if (i + config.CLEANUP_BATCH_SIZE < names.length) {
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        cursor = result.list_complete ? void 0 : result.cursor;
        if (cursor) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } while (cursor);
      const reportText = ADMIN_COPY.cleanupReport({
        scannedCount,
        cleanedCount,
        errorCount,
        cleanedUsers,
        maxDisplay: config.MAX_CLEANUP_DISPLAY
      });
      logger.info("cleanup_completed", {
        cleanedCount,
        errorCount,
        totalUsers: scannedCount
      });
      await tgCall2(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: reportText,
        parse_mode: "HTML"
      }, threadId));
    } catch (e) {
      logger.error("cleanup_failed", e, { threadId });
      await tgCall2(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: ADMIN_COPY.cleanupFailed(e?.message || String(e)),
        parse_mode: "HTML"
      }, threadId));
    } finally {
      await env.TOPIC_MAP.delete(lockKey);
    }
  }
  return {
    panel,
    info,
    note,
    mute,
    unmute,
    close,
    open,
    ban,
    unban,
    trust,
    reset,
    addWord,
    delWord,
    listWords,
    cleanup
  };
}

// src/verify-copy.js
var VERIFY_COPY = {
  /** Turnstile 私聊提示 */
  turnstileChallenge: "\u{1F6E1} <b>\u4EBA\u673A\u9A8C\u8BC1</b>\n\n\u8BF7\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u5B8C\u6210\u9A8C\u8BC1\u3002\n\u901A\u8FC7\u540E\u60A8\u521A\u624D\u7684\u6D88\u606F\u4F1A\u81EA\u52A8\u9001\u8FBE\u7BA1\u7406\u5458\u3002",
  /** 本地题库提示（expireMinutes 由调用方按 VERIFY_EXPIRE_SECONDS 换算注入，防文案与配置漂移） */
  quizChallenge(question, expireMinutes) {
    const minutes = Math.max(1, Math.round(Number(expireMinutes) || 0));
    return `\u{1F6E1} <b>\u4EBA\u673A\u9A8C\u8BC1</b>

${question}

\u8BF7\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u4F5C\u7B54\uFF08\u7EA6 ${minutes} \u5206\u949F\u5185\u6709\u6548\uFF09\uFF1B\u7B54\u5BF9\u540E\u6D88\u606F\u4F1A\u81EA\u52A8\u9001\u8FBE\u3002`;
  },
  buttonTurnstile: "\u{1F510} \u70B9\u51FB\u9A8C\u8BC1",
  /** 验证请求触发速率限制（minutes 由调用方按窗口秒数换算，保持口径一致） */
  verifyRateLimited(minutes) {
    return `\u26A0\uFE0F \u9A8C\u8BC1\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7EA6 ${minutes} \u5206\u949F\u540E\u518D\u8BD5\u3002`;
  },
  /** callback toast / alert */
  expired: "\u274C \u9A8C\u8BC1\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u4E00\u6761\u6D88\u606F",
  dataError: "\u274C \u9A8C\u8BC1\u6570\u636E\u5F02\u5E38\uFF0C\u8BF7\u91CD\u65B0\u53D1\u6D88\u606F",
  invalidUser: "\u274C \u9A8C\u8BC1\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u53D1\u6D88\u606F",
  invalidOption: "\u274C \u65E0\u6548\u9009\u9879",
  wrongAnswer: "\u274C \u56DE\u7B54\u9519\u8BEF\uFF0C\u8BF7\u518D\u8BD5\u4E00\u6B21",
  successToast: "\u2705 \u9A8C\u8BC1\u901A\u8FC7",
  systemError: "\u26A0\uFE0F \u7CFB\u7EDF\u7E41\u5FD9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
  /** 验证通过后自动送达失败（用户需重发） */
  pendingSendFailed: "\u26A0\uFE0F \u81EA\u52A8\u9001\u8FBE\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u60A8\u7684\u6D88\u606F\u3002",
  /** 编辑/私聊成功正文 */
  successBody: "\u2705 <b>\u9A8C\u8BC1\u6210\u529F</b>\n\n\u60A8\u73B0\u5728\u53EF\u4EE5\u6B63\u5E38\u5BF9\u8BDD\u4E86\u3002\u76F4\u63A5\u53D1\u6D88\u606F\u5373\u53EF\u8054\u7CFB\u7BA1\u7406\u5458\u3002",
  successBodyWithPending: "\u2705 <b>\u9A8C\u8BC1\u6210\u529F</b>\n\n\u6B63\u5728\u4E3A\u60A8\u9001\u8FBE\u521A\u624D\u7684\u6D88\u606F\uFF0C\u8BF7\u7A0D\u5019\u2026",
  /** 答错时在题目下追加的提示（编辑消息用） */
  wrongAnswerHint: "\n\n\u26A0\uFE0F \u56DE\u7B54\u4E0D\u6B63\u786E\uFF0C\u8BF7\u518D\u9009\u4E00\u6B21\u3002\u94FE\u63A5\u672A\u8FC7\u671F\u524D\u53EF\u7EE7\u7EED\u5C1D\u8BD5\u3002",
  /** 验证页缺参/未配置时的错误页文案（worker.js 渲染错误页时注入，收拢避免散落） */
  pageErrorMissingParams: {
    message: "\u9A8C\u8BC1\u94FE\u63A5\u7F3A\u5C11\u5FC5\u8981\u53C2\u6570\u6216\u7CFB\u7EDF\u672A\u914D\u7F6E Turnstile\u3002",
    hintResend: "\u8BF7\u8FD4\u56DE Telegram \u540E\u5411\u673A\u5668\u4EBA\u91CD\u65B0\u53D1\u9001\u6D88\u606F\u83B7\u53D6\u65B0\u94FE\u63A5\u3002",
    hintNoSiteKey: "\u7BA1\u7406\u5458\u5C1A\u672A\u914D\u7F6E TURNSTILE_SITE_KEY\uFF0C\u53EF\u6682\u65F6\u6539\u7528\u672C\u5730\u9898\u5E93\u9A8C\u8BC1\u3002"
  }
};

// src/verification.js
var VERIFY_RATE_WINDOW_SECONDS = 300;
var TURNSTILE_VERIFY_TIMEOUT_MS = 1e4;
var FORWARDED_MARK_TTL_SECONDS = 3600;
var LOCAL_QUESTIONS = [
  { "question": "\u51B0\u878D\u5316\u540E\u4F1A\u53D8\u6210\u4EC0\u4E48\uFF1F", "correct_answer": "\u6C34", "incorrect_answers": ["\u77F3\u5934", "\u6728\u5934", "\u706B"] },
  { "question": "\u6B63\u5E38\u4EBA\u6709\u51E0\u53EA\u773C\u775B\uFF1F", "correct_answer": "2", "incorrect_answers": ["1", "3", "4"] },
  { "question": "\u4EE5\u4E0B\u54EA\u4E2A\u5C5E\u4E8E\u6C34\u679C\uFF1F", "correct_answer": "\u9999\u8549", "incorrect_answers": ["\u767D\u83DC", "\u732A\u8089", "\u5927\u7C73"] },
  { "question": "1 \u52A0 2 \u7B49\u4E8E\u51E0\uFF1F", "correct_answer": "3", "incorrect_answers": ["2", "4", "5"] },
  { "question": "5 \u51CF 2 \u7B49\u4E8E\u51E0\uFF1F", "correct_answer": "3", "incorrect_answers": ["1", "2", "4"] },
  { "question": "2 \u4E58\u4EE5 3 \u7B49\u4E8E\u51E0\uFF1F", "correct_answer": "6", "incorrect_answers": ["4", "5", "7"] },
  { "question": "10 \u52A0 5 \u7B49\u4E8E\u51E0\uFF1F", "correct_answer": "15", "incorrect_answers": ["10", "12", "20"] },
  { "question": "8 \u51CF 4 \u7B49\u4E8E\u51E0\uFF1F", "correct_answer": "4", "incorrect_answers": ["2", "3", "5"] },
  { "question": "\u5728\u5929\u4E0A\u98DE\u7684\u4EA4\u901A\u5DE5\u5177\u662F\u4EC0\u4E48\uFF1F", "correct_answer": "\u98DE\u673A", "incorrect_answers": ["\u6C7D\u8F66", "\u8F6E\u8239", "\u81EA\u884C\u8F66"] },
  { "question": "\u661F\u671F\u4E00\u7684\u540E\u9762\u662F\u661F\u671F\u51E0\uFF1F", "correct_answer": "\u661F\u671F\u4E8C", "incorrect_answers": ["\u661F\u671F\u65E5", "\u661F\u671F\u4E94", "\u661F\u671F\u4E09"] },
  { "question": "\u9C7C\u901A\u5E38\u751F\u6D3B\u5728\u54EA\u91CC\uFF1F", "correct_answer": "\u6C34\u91CC", "incorrect_answers": ["\u6811\u4E0A", "\u571F\u91CC", "\u706B\u91CC"] },
  { "question": "\u6211\u4EEC\u7528\u4EC0\u4E48\u5668\u5B98\u6765\u542C\u58F0\u97F3\uFF1F", "correct_answer": "\u8033\u6735", "incorrect_answers": ["\u773C\u775B", "\u9F3B\u5B50", "\u5634\u5DF4"] },
  { "question": "\u6674\u6717\u7684\u5929\u7A7A\u901A\u5E38\u662F\u4EC0\u4E48\u989C\u8272\u7684\uFF1F", "correct_answer": "\u84DD\u8272", "incorrect_answers": ["\u7EFF\u8272", "\u7EA2\u8272", "\u7D2B\u8272"] },
  { "question": "\u592A\u9633\u4ECE\u54EA\u4E2A\u65B9\u5411\u5347\u8D77\uFF1F", "correct_answer": "\u4E1C\u65B9", "incorrect_answers": ["\u897F\u65B9", "\u5357\u65B9", "\u5317\u65B9"] },
  { "question": "\u5C0F\u72D7\u53D1\u51FA\u7684\u53EB\u58F0\u901A\u5E38\u662F\uFF1F", "correct_answer": "\u6C6A\u6C6A", "incorrect_answers": ["\u55B5\u55B5", "\u54A9\u54A9", "\u5471\u5471"] }
];
function buildQuizKeyboard(options, verifyId, columns = 2) {
  const buttons = (options || []).map((opt, idx) => ({
    text: String(opt),
    callback_data: `verify:${verifyId}:${idx}`
  }));
  const cols = Math.max(1, Number(columns) || 2);
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += cols) {
    keyboard.push(buttons.slice(i, i + cols));
  }
  return { inline_keyboard: keyboard };
}
function createVerificationModule(deps) {
  const {
    config,
    tgCall: tgCall2,
    safeGetJSON: safeGetJSON2,
    ephemeralStore: ephemeralStore2,
    checkRateLimit: checkRateLimit2,
    bumpDailyStat: bumpDailyStat2,
    resolveUserFromForTopic: resolveUserFromForTopic2,
    forwardToTopic: forwardToTopic2,
    saveUserProfileSnapshot: saveUserProfileSnapshot2,
    shuffleArray: shuffleArray2,
    secureRandomInt: secureRandomInt2,
    secureRandomId: secureRandomId2,
    logger
  } = deps;
  async function verifyTurnstileToken(token, secretKey, remoteIp) {
    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token);
    if (remoteIp) {
      formData.append("remoteip", remoteIp);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURNSTILE_VERIFY_TIMEOUT_MS);
    try {
      const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
        signal: controller.signal
      });
      const result = await resp.json();
      return { success: result.success === true, error: result["error-codes"]?.join(", ") };
    } catch (e) {
      if (e?.name === "AbortError") {
        logger.warn("turnstile_verify_timeout");
        return { success: false, error: "timeout" };
      }
      logger.error("turnstile_verify_error", e);
      return { success: false, error: e.message };
    } finally {
      clearTimeout(timer);
    }
  }
  async function sendVerificationChallenge(userId, env, pendingMsgId, from = null) {
    if (from) await saveUserProfileSnapshot2(env, userId, from);
    const writtenKeys = [];
    try {
      await _sendVerificationChallengeInner(userId, env, pendingMsgId, writtenKeys);
    } catch (e) {
      logger.error("verification_challenge_failed", e, { userId });
      for (const key of writtenKeys) {
        try {
          await env.TOPIC_MAP.delete(key);
        } catch {
        }
      }
      throw e;
    }
  }
  async function _sendVerificationChallengeInner(userId, env, pendingMsgId, writtenKeys) {
    const existingChallenge = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
    if (existingChallenge) {
      const chalKey = `chal:${existingChallenge}`;
      const state = await safeGetJSON2(env, chalKey, null);
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
            if (pendingIds.length > config.PENDING_MAX_MESSAGES) {
              pendingIds = pendingIds.slice(pendingIds.length - config.PENDING_MAX_MESSAGES);
            }
            state.pending_ids = pendingIds;
            delete state.pending;
            await env.TOPIC_MAP.put(chalKey, JSON.stringify(state), { expirationTtl: config.VERIFY_EXPIRE_SECONDS });
          }
        }
        logger.debug("verification_duplicate_skipped", { userId, verifyId: existingChallenge, hasPending: !!pendingMsgId });
        return;
      }
    }
    const verifyLimit = await checkRateLimit2(userId, env, "verify", config.RATE_LIMIT_VERIFY, VERIFY_RATE_WINDOW_SECONDS);
    if (!verifyLimit.allowed) {
      await tgCall2(env, "sendMessage", {
        chat_id: userId,
        text: VERIFY_COPY.verifyRateLimited(VERIFY_RATE_WINDOW_SECONDS / 60)
      });
      return;
    }
    const hasTurnstile = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.VERIFICATION_PAGE_URL);
    if (hasTurnstile) {
      await sendTurnstileChallenge(userId, env, pendingMsgId, writtenKeys);
    } else {
      await sendLocalQuizChallenge(userId, env, pendingMsgId, writtenKeys);
    }
  }
  async function sendTurnstileChallenge(userId, env, pendingMsgId, writtenKeys) {
    const verifyCode = generateVerifyCode();
    const verifyUrl = `${env.VERIFICATION_PAGE_URL}/verify?code=${verifyCode}&uid=${userId}`;
    await env.TOPIC_MAP.put(`turnstile_code:${verifyCode}`, String(userId), { expirationTtl: config.TURNSTILE_VERIFY_TTL });
    writtenKeys.push(`turnstile_code:${verifyCode}`);
    if (pendingMsgId) {
      const pendingKey = `pending_turnstile:${userId}`;
      let pendingIds = [];
      try {
        const raw = await env.TOPIC_MAP.get(pendingKey);
        if (raw) pendingIds = JSON.parse(raw);
      } catch {
      }
      if (!Array.isArray(pendingIds)) pendingIds = [];
      if (!pendingIds.includes(pendingMsgId)) {
        pendingIds.push(pendingMsgId);
        if (pendingIds.length > config.PENDING_MAX_MESSAGES) {
          pendingIds = pendingIds.slice(pendingIds.length - config.PENDING_MAX_MESSAGES);
        }
        await env.TOPIC_MAP.put(pendingKey, JSON.stringify(pendingIds), { expirationTtl: config.TURNSTILE_VERIFY_TTL });
        writtenKeys.push(pendingKey);
      }
    }
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, `turnstile:${verifyCode}`, { expirationTtl: config.TURNSTILE_VERIFY_TTL });
    writtenKeys.push(`user_challenge:${userId}`);
    logger.info("turnstile_verification_sent", { userId, verifyCode });
    const verifyMsg = await tgCall2(env, "sendMessage", {
      chat_id: userId,
      text: VERIFY_COPY.turnstileChallenge,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: VERIFY_COPY.buttonTurnstile, url: verifyUrl }
        ]]
      }
    });
    if (!verifyMsg.ok) {
      throw new Error(`Turnstile \u9A8C\u8BC1\u6D88\u606F\u53D1\u9001\u5931\u8D25: ${verifyMsg.description || "\u672A\u77E5\u9519\u8BEF"}`);
    }
    if (verifyMsg.result?.message_id) {
      await env.TOPIC_MAP.put(`turnstile_msg:${verifyCode}`, String(verifyMsg.result.message_id), { expirationTtl: config.TURNSTILE_VERIFY_TTL });
      writtenKeys.push(`turnstile_msg:${verifyCode}`);
    }
  }
  async function sendLocalQuizChallenge(userId, env, pendingMsgId, writtenKeys) {
    const q = LOCAL_QUESTIONS[secureRandomInt2(0, LOCAL_QUESTIONS.length)];
    const challenge = {
      question: q.question,
      correct: q.correct_answer,
      options: shuffleArray2([...q.incorrect_answers, q.correct_answer])
    };
    const verifyId = secureRandomId2(config.VERIFY_ID_LENGTH);
    const answerIndex = challenge.options.indexOf(challenge.correct);
    const state = {
      answerIndex,
      options: challenge.options,
      pending_ids: pendingMsgId ? [pendingMsgId] : [],
      userId
    };
    await env.TOPIC_MAP.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: config.VERIFY_EXPIRE_SECONDS });
    writtenKeys.push(`chal:${verifyId}`);
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, verifyId, { expirationTtl: config.VERIFY_EXPIRE_SECONDS });
    writtenKeys.push(`user_challenge:${userId}`);
    logger.info("verification_sent", {
      userId,
      verifyId,
      pendingCount: state.pending_ids.length
    });
    const keyboard = buildQuizKeyboard(challenge.options, verifyId, config.BUTTON_COLUMNS);
    const quizMsg = await tgCall2(env, "sendMessage", {
      chat_id: userId,
      // 有效期分钟数按 VERIFY_EXPIRE_SECONDS 换算注入，避免文案与配置漂移
      text: VERIFY_COPY.quizChallenge(escapeHtml(challenge.question), config.VERIFY_EXPIRE_SECONDS / 60),
      parse_mode: "HTML",
      reply_markup: keyboard
    });
    if (!quizMsg.ok) {
      throw new Error(`\u672C\u5730\u9898\u5E93\u9A8C\u8BC1\u6D88\u606F\u53D1\u9001\u5931\u8D25: ${quizMsg.description || "\u672A\u77E5\u9519\u8BEF"}`);
    }
  }
  async function handleCallbackQuery(query, env, ctx) {
    try {
      const data = query.data;
      if (!data.startsWith("verify:")) return;
      const parts = data.split(":");
      if (parts.length !== 3) return;
      const verifyId = parts[1];
      const selectedIndex = parseInt(parts[2], 10);
      const userId = query.from.id;
      const stateStr = await env.TOPIC_MAP.get(`chal:${verifyId}`);
      if (!stateStr) {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: VERIFY_COPY.expired,
          show_alert: true
        });
        return;
      }
      let state;
      try {
        state = JSON.parse(stateStr);
      } catch (e) {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: VERIFY_COPY.dataError,
          show_alert: true
        });
        return;
      }
      if (state.userId && state.userId !== userId) {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: VERIFY_COPY.invalidUser,
          show_alert: true
        });
        return;
      }
      if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: VERIFY_COPY.invalidOption,
          show_alert: true
        });
        return;
      }
      if (selectedIndex === state.answerIndex) {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: VERIFY_COPY.successToast
        });
        logger.info("verification_passed", {
          userId,
          verifyId,
          // 只记索引不记选项文本：避免正确答案落入日志，收紧日志脱敏边界
          selectedIndex
        });
        await bumpDailyStat2(env, "verifies", 1);
        await ephemeralStore2(env).setVerification(userId, {
          ttl: config.VERIFIED_EXPIRE_SECONDS,
          verifiedAt: Date.now()
        });
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await env.TOPIC_MAP.delete(`chal:${verifyId}`);
        await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
        const hasPending = Array.isArray(state.pending_ids) && state.pending_ids.length > 0 || !!state.pending;
        await tgCall2(env, "editMessageText", {
          chat_id: userId,
          message_id: query.message.message_id,
          text: hasPending ? VERIFY_COPY.successBodyWithPending : VERIFY_COPY.successBody,
          parse_mode: "HTML",
          // 清空答题按钮，避免验证通过后残留可点击的选项（再点只会提示「已过期」）
          reply_markup: { inline_keyboard: [] }
        });
        if (hasPending) {
          await forwardPendingMessages(state, userId, query, env, ctx);
        }
      } else {
        logger.info("verification_failed", {
          userId,
          verifyId,
          selectedIndex,
          correctIndex: state.answerIndex
        });
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: VERIFY_COPY.wrongAnswer,
          show_alert: true
        });
        try {
          const prev = String(query.message?.text || "");
          const hint = VERIFY_COPY.wrongAnswerHint.trim();
          if (prev && !prev.includes(hint) && query.message?.message_id) {
            const keyboard = buildQuizKeyboard(state.options, verifyId, config.BUTTON_COLUMNS);
            await tgCall2(env, "editMessageText", {
              chat_id: userId,
              message_id: query.message.message_id,
              text: `${prev}${VERIFY_COPY.wrongAnswerHint}`,
              parse_mode: "HTML",
              reply_markup: keyboard
            });
          }
        } catch {
        }
      }
    } catch (e) {
      logger.error("callback_query_error", e, {
        userId: query.from?.id,
        callbackData: query.data
      });
      await tgCall2(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: VERIFY_COPY.systemError,
        show_alert: true
      });
    }
  }
  async function forwardPendingMessageIds(userId, pendingIds, env, ctx, { from = null } = {}) {
    const limited = (Array.isArray(pendingIds) ? pendingIds : []).filter(Boolean).slice(-config.PENDING_MAX_MESSAGES);
    const CONCURRENT_FORWARDS = 3;
    let forwardedCount = 0;
    let skippedCount = 0;
    for (let i = 0; i < limited.length; i += CONCURRENT_FORWARDS) {
      const batch = limited.slice(i, i + CONCURRENT_FORWARDS);
      const results = await Promise.allSettled(batch.map(async (pendingId) => {
        const forwardedKey = `forwarded:${userId}:${pendingId}`;
        const alreadyForwarded = await env.TOPIC_MAP.get(forwardedKey);
        if (alreadyForwarded) {
          logger.info("message_forward_duplicate_skipped", { userId, messageId: pendingId });
          return { forwarded: false, reason: "already_forwarded" };
        }
        const topicFrom = await resolveUserFromForTopic2(env, userId, from);
        const fakeMsg = {
          message_id: pendingId,
          chat: { id: Number(userId), type: "private" },
          from: topicFrom
        };
        await forwardToTopic2(fakeMsg, userId, `user:${userId}`, env, ctx);
        await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: FORWARDED_MARK_TTL_SECONDS });
        return { forwarded: true };
      }));
      for (const r of results) {
        if (r.status === "fulfilled" && r.value?.forwarded) {
          forwardedCount++;
        } else if (r.status === "fulfilled") {
          skippedCount++;
        } else if (r.status === "rejected") {
          logger.warn("pending_forward_item_failed", { userId, error: r.reason?.message });
        }
      }
    }
    if (forwardedCount > 0) {
      await tgCall2(env, "sendMessage", {
        chat_id: Number(userId),
        text: USER_COPY.pendingDelivered(forwardedCount),
        parse_mode: "HTML"
      });
    }
    return { forwardedCount, skippedCount };
  }
  async function forwardPendingMessages(state, userId, query, env, ctx) {
    try {
      let pendingIds = [];
      if (Array.isArray(state.pending_ids)) {
        pendingIds = state.pending_ids.slice();
      } else if (state.pending) {
        pendingIds = [state.pending];
      }
      await forwardPendingMessageIds(userId, pendingIds, env, ctx, { from: query?.from });
    } catch (e) {
      logger.error("pending_message_forward_failed", e, { userId });
      await tgCall2(env, "sendMessage", {
        chat_id: userId,
        text: VERIFY_COPY.pendingSendFailed
      });
    }
  }
  return {
    verifyTurnstileToken,
    sendVerificationChallenge,
    handleCallbackQuery,
    forwardPendingMessageIds
  };
}

// src/media-group.js
function createMediaGroupModule(deps) {
  const {
    config,
    tgCall: tgCall2,
    safeGetJSON: safeGetJSON2,
    logger
  } = deps;
  async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
      await tgCall2(env, "copyMessage", withMessageThreadId({
        chat_id: targetChat,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id
      }, threadId));
      return;
    }
    let rec = await safeGetJSON2(env, key, null);
    if (!rec) rec = { direction, targetChat, threadId: threadId === null ? void 0 : threadId, items: [], last_ts: Date.now() };
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: config.MEDIA_GROUP_EXPIRE_SECONDS });
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
  }
  function extractMedia(msg) {
    if (msg.photo && msg.photo.length > 0) {
      const highestResolution = msg.photo[msg.photo.length - 1];
      return {
        type: "photo",
        id: highestResolution.file_id,
        cap: msg.caption || ""
      };
    }
    if (msg.video) {
      return {
        type: "video",
        id: msg.video.file_id,
        cap: msg.caption || ""
      };
    }
    if (msg.document) {
      return {
        type: "document",
        id: msg.document.file_id,
        cap: msg.caption || ""
      };
    }
    if (msg.audio) {
      return {
        type: "audio",
        id: msg.audio.file_id,
        cap: msg.caption || ""
      };
    }
    if (msg.animation) {
      return {
        type: "animation",
        id: msg.animation.file_id,
        cap: msg.caption || ""
      };
    }
    return null;
  }
  async function flushExpiredMediaGroups(env, now) {
    try {
      const result = await env.TOPIC_MAP.list({ prefix: "mg:", limit: 100 });
      let deletedCount = 0;
      for (const { name } of result.keys || []) {
        const rec = await safeGetJSON2(env, name, null);
        if (rec && rec.last_ts && now - rec.last_ts > config.MEDIA_GROUP_EXPIRE_SECONDS * 1e3) {
          await env.TOPIC_MAP.delete(name);
          deletedCount++;
        }
      }
      if (deletedCount > 0) {
        logger.info("media_groups_cleaned", { deletedCount });
      }
    } catch (e) {
      logger.error("media_group_cleanup_failed", e);
    }
  }
  async function delaySend(env, key, ts) {
    await new Promise((r) => setTimeout(r, config.MEDIA_GROUP_DELAY_MS));
    const rec = await safeGetJSON2(env, key, null);
    if (rec && rec.last_ts === ts) {
      if (!rec.items || rec.items.length === 0) {
        logger.warn("media_group_empty", { key });
        await env.TOPIC_MAP.delete(key);
        return;
      }
      const media = [];
      let captionAssigned = false;
      for (const it of rec.items) {
        if (!it.type || !it.id) {
          logger.warn("media_group_invalid_item", { key, item: it });
          continue;
        }
        const caption = !captionAssigned ? (it.cap || "").substring(0, 1024) : "";
        if (caption) captionAssigned = true;
        media.push({ type: it.type, media: it.id, caption });
      }
      if (media.length > 0) {
        try {
          const result = await tgCall2(env, "sendMediaGroup", withMessageThreadId({
            chat_id: rec.targetChat,
            media
          }, rec.threadId));
          if (!result.ok) {
            logger.error("media_group_send_failed", result.description, {
              key,
              mediaCount: media.length
            });
          } else {
            logger.info("media_group_sent", {
              key,
              mediaCount: media.length,
              targetChat: rec.targetChat
            });
          }
        } catch (e) {
          logger.error("media_group_send_exception", e, { key });
        }
      }
      await env.TOPIC_MAP.delete(key);
    }
  }
  return {
    handleMediaGroup,
    extractMedia,
    flushExpiredMediaGroups
  };
}

// src/spam.js
var MESSAGE_HASH_MAX_ENTRIES = 5e3;
var SPAM_SNIPPET_MAX_LENGTH = 120;
var SPAM_STATS_TTL_SECONDS = 30 * 24 * 3600;
function createSpamModule(deps) {
  const {
    config,
    logger,
    escapeHtml: escapeHtml2,
    adminCopy,
    safeGetJSON: safeGetJSON2,
    tgCall: tgCall2,
    getVerificationTimestamp,
    setBoundedCache: setBoundedCache2
  } = deps;
  let spamKeywordsCache = null;
  const messageHashCache = /* @__PURE__ */ new Map();
  function getSpamKeywords(env) {
    if (spamKeywordsCache) return spamKeywordsCache;
    const raw = (env.SPAM_KEYWORDS || "").toString().trim();
    spamKeywordsCache = parseSpamKeywords(raw);
    if (spamKeywordsCache.length > 0) {
      logger.info("spam_keywords_loaded", { count: spamKeywordsCache.length });
    }
    return spamKeywordsCache;
  }
  async function detectRepeatMessage(userId, msg) {
    const hash = computeMessageHash(msg);
    if (!hash) return { isRepeat: false, count: 0 };
    const cacheKey = `msghash:${userId}:${hash}`;
    const now = Date.now();
    const cached = messageHashCache.get(cacheKey);
    if (cached && now - cached.ts > config.SPAM_MESSAGE_HASH_TTL * 1e3) {
      messageHashCache.delete(cacheKey);
      const count2 = 1;
      setBoundedCache2(messageHashCache, cacheKey, { count: count2, ts: now }, MESSAGE_HASH_MAX_ENTRIES);
      return { isRepeat: false, count: count2 };
    }
    const count = (cached?.count || 0) + 1;
    setBoundedCache2(messageHashCache, cacheKey, { count, ts: now }, MESSAGE_HASH_MAX_ENTRIES);
    if (count >= config.SPAM_REPEAT_MESSAGE_LIMIT) {
      return { isRepeat: true, count };
    }
    return { isRepeat: false, count };
  }
  function pruneMessageHashCache2(now) {
    const ttl = config.SPAM_MESSAGE_HASH_TTL * 1e3;
    for (const [key, value] of messageHashCache) {
      if (now - value.ts > ttl) {
        messageHashCache.delete(key);
      }
    }
  }
  async function spamCheck2(msg, userId, env) {
    const reasons = [];
    const details = {};
    const text = buildSpamCheckText(msg).trim();
    const keywords = getSpamKeywords(env);
    const keywordResult = detectSpamKeywords(text, keywords);
    if (keywordResult.isSpam) {
      reasons.push("keyword");
      details.keyword = keywordResult.matchedWord;
    }
    if (containsLink(text)) {
      const verifyTs = await getVerificationTimestamp(env, userId);
      if (!verifyTs) {
        reasons.push("new_user_link");
        details.linkBlockRemainingHours = Math.ceil(config.NEW_USER_LINK_BLOCK_SECONDS / 3600);
      } else {
        const elapsed = (Date.now() - parseInt(verifyTs, 10)) / 1e3;
        if (elapsed < config.NEW_USER_LINK_BLOCK_SECONDS) {
          const remainingHours = Math.ceil((config.NEW_USER_LINK_BLOCK_SECONDS - elapsed) / 3600);
          reasons.push("new_user_link");
          details.linkBlockRemainingHours = remainingHours;
        }
      }
    }
    const repeatResult = await detectRepeatMessage(userId, msg);
    if (repeatResult.isRepeat) {
      reasons.push("repeat_message");
      details.repeatCount = repeatResult.count;
    }
    return {
      isSpam: reasons.length > 0,
      reasons,
      details
    };
  }
  async function updateSpamStats(env, reasons) {
    try {
      const countKeys = [
        ...(reasons || []).map((reason) => `stats:spam:${reason}`),
        "stats:spam:total"
      ];
      await Promise.all(countKeys.map(async (countKey) => {
        const current = parseInt(await env.TOPIC_MAP.get(countKey) || "0", 10);
        await env.TOPIC_MAP.put(countKey, String(current + 1), { expirationTtl: SPAM_STATS_TTL_SECONDS });
      }));
    } catch (e) {
      logger.warn("spam_stats_update_failed", { error: e.message });
    }
  }
  async function handleSpamMessage2(env, userId, msg, spamResult, threadId, ctx) {
    logger.warn("spam_detected", {
      userId,
      reasons: spamResult.reasons,
      details: spamResult.details
    });
    if (ctx?.waitUntil) {
      ctx.waitUntil(updateSpamStats(env, spamResult.reasons));
    }
    if (config.SPAM_NOTIFY_ADMIN && !config.SPAM_SILENCE_MODE) {
      let notifyThreadId = threadId;
      if (!notifyThreadId) {
        const rec = await safeGetJSON2(env, `user:${userId}`, null);
        notifyThreadId = rec?.thread_id || null;
      }
      const reasonText = spamResult.reasons.map((r) => {
        switch (r) {
          case "keyword":
            return `\u{1F511} \u5173\u952E\u8BCD: <code>${escapeHtml2(spamResult.details.keyword)}</code>`;
          case "new_user_link":
            return `\u{1F517} \u65B0\u7528\u6237\u94FE\u63A5 (\u5269\u4F59 ${spamResult.details.linkBlockRemainingHours}h)`;
          case "repeat_message":
            return `\u{1F504} \u91CD\u590D\u6D88\u606F (${spamResult.details.repeatCount}\u6B21)`;
          default:
            return escapeHtml2(String(r));
        }
      }).join("\n");
      const rawText = extractMessageText(msg).trim();
      const snippet = rawText ? escapeHtml2(rawText.length > SPAM_SNIPPET_MAX_LENGTH ? `${rawText.slice(0, SPAM_SNIPPET_MAX_LENGTH)}\u2026` : rawText) : "";
      const body = notifyThreadId ? { message_thread_id: notifyThreadId } : {};
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        text: adminCopy.spamIntercepted(escapeHtml2(String(userId)), reasonText, { threadId: notifyThreadId, snippet }),
        parse_mode: "HTML",
        ...body
      });
    }
  }
  return {
    getSpamKeywords,
    detectRepeatMessage,
    pruneMessageHashCache: pruneMessageHashCache2,
    spamCheck: spamCheck2,
    updateSpamStats,
    handleSpamMessage: handleSpamMessage2
  };
}

// src/activity-summary.js
var OPS_TZ_OFFSET_HOURS = 8;
function opsDayKey(now = Date.now(), offsetHours = OPS_TZ_OFFSET_HOURS) {
  const off = Number(offsetHours);
  const shifted = new Date(Number(now) + off * 36e5);
  return shifted.toISOString().slice(0, 10);
}
function opsYesterdayKey(now = Date.now(), offsetHours = OPS_TZ_OFFSET_HOURS) {
  return opsDayKey(Number(now) - 864e5, offsetHours);
}
function opsDayStartMs(now = Date.now(), offsetHours = OPS_TZ_OFFSET_HOURS) {
  const key = opsDayKey(now, offsetHours);
  const [y, m, d] = key.split("-").map(Number);
  const off = Number(offsetHours);
  return Date.UTC(y, m - 1, d) - off * 36e5;
}
var BLOCK_CHARS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
function toBlockLevels(values) {
  const list = (values || []).map((n) => Math.max(0, Number(n) || 0));
  const max = Math.max(0, ...list);
  if (max <= 0) return list.map(() => "\xB7");
  return list.map((n) => {
    if (n <= 0) return "\xB7";
    const level = Math.min(8, Math.max(1, Math.ceil(n / max * 8)));
    return BLOCK_CHARS[level - 1];
  });
}
function formatSparkline(values) {
  const list = (values || []).map((n) => Math.max(0, Number(n) || 0));
  if (!list.length) return "";
  return toBlockLevels(list).join("");
}
function pickPeakDays(series, topN = 1) {
  const n = Math.min(Math.max(Number(topN) || 1, 1), 7);
  return [...series || []].map((d) => ({
    day: String(d?.day || ""),
    messages_in: Math.max(0, Number(d?.messages_in) || 0)
  })).filter((d) => d.day && d.messages_in > 0).sort((a, b) => b.messages_in - a.messages_in || a.day.localeCompare(b.day)).slice(0, n);
}
function formatPeakDays(peaks) {
  if (!peaks?.length) return "\u6682\u65E0";
  return peaks.map((p) => `${String(p.day).slice(5)}\xD7${p.messages_in}`).join(" \xB7 ");
}
function summarizeInboundActivity(rows, opts = {}) {
  const topN = Math.min(Math.max(Number(opts.topN) || 10, 1), 30);
  const hours = Array.from({ length: 24 }, () => 0);
  const byUser = /* @__PURE__ */ new Map();
  let total = 0;
  for (const row of rows || []) {
    const createdAt = Number(row?.createdAt || 0);
    if (!createdAt) continue;
    total += 1;
    const hour = new Date(createdAt).getUTCHours();
    hours[hour] += 1;
    const uid = String(row.userId || "");
    if (!uid) continue;
    byUser.set(uid, (byUser.get(uid) || 0) + 1);
  }
  const ranking = [...byUser.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([userId, count]) => ({ userId, count }));
  return {
    total,
    hours,
    ranking,
    peakHours: peakHoursFromBuckets(hours, 3),
    uniqueUsers: byUser.size
  };
}
function shiftHourBuckets(hours, offsetHours = OPS_TZ_OFFSET_HOURS) {
  const list = Array.isArray(hours) && hours.length === 24 ? hours.map((n) => Math.max(0, Number(n) || 0)) : Array.from({ length: 24 }, () => 0);
  const off = (Number(offsetHours) % 24 + 24) % 24;
  if (off === 0) return list;
  const out = Array.from({ length: 24 }, () => 0);
  for (let utc = 0; utc < 24; utc += 1) {
    out[(utc + off) % 24] = list[utc];
  }
  return out;
}
function peakHoursFromBuckets(hours, topN = 3) {
  const list = Array.isArray(hours) && hours.length === 24 ? hours : Array.from({ length: 24 }, () => 0);
  return list.map((count, hour) => ({ hour, count: Number(count) || 0 })).filter((item) => item.count > 0).sort((a, b) => b.count - a.count || a.hour - b.hour).slice(0, Math.min(Math.max(Number(topN) || 3, 1), 24));
}
function formatHeatBars(hours) {
  const list = Array.isArray(hours) && hours.length === 24 ? hours.map((n) => Math.max(0, Number(n) || 0)) : Array.from({ length: 24 }, () => 0);
  return toBlockLevels(list).join("");
}
function formatHeatAxis() {
  return "0\xB7\xB7\xB7\xB7\xB76\xB7\xB7\xB7\xB712\xB7\xB7\xB7\xB718\xB7\xB7\xB723";
}
function formatPeakHours(peakHours) {
  if (!peakHours?.length) return "\u6682\u65E0";
  return peakHours.map((p) => `${String(p.hour).padStart(2, "0")}:00\xD7${p.count}`).join(" \xB7 ");
}
function rankMedal(index0) {
  if (index0 === 0) return "\u{1F947}";
  if (index0 === 1) return "\u{1F948}";
  if (index0 === 2) return "\u{1F949}";
  return `${index0 + 1}.`;
}
function displayUserLabel2(u) {
  if (!u || typeof u !== "object") return "\u672A\u77E5";
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (u.username) return `@${u.username}`;
  return String(u.userId || "\u672A\u77E5");
}
function shouldAppendUsername(u, label) {
  if (!u?.username) return false;
  const un = String(u.username);
  const lb = String(label || "");
  return lb !== `@${un}` && lb !== un;
}
function formatDelta(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  const d = c - p;
  if (d === 0) return "\u6301\u5E73";
  return d > 0 ? `\u2191${d}` : `\u2193${Math.abs(d)}`;
}
function activitySourceLabel(source) {
  switch (String(source || "")) {
    case "message_links":
      return "\u6D88\u606F\u6620\u5C04";
    case "kv_hours":
      return "KV \u5C0F\u65F6\u6876";
    case "last_message":
      return "\u6700\u8FD1\u6D3B\u8DC3";
    case "kv_hours+last_message":
      return "KV\u70ED\u529B+\u6700\u8FD1\u6D3B\u8DC3";
    case "none":
      return "\u6682\u65E0";
    default:
      return source || "\u672A\u77E5";
  }
}

// src/daily-stats.js
var DAILY_STATS_TTL_SECONDS = 21 * 86400;
function emptyDailyStats(day) {
  return {
    day,
    messages_in: 0,
    bans: 0,
    verifies: 0,
    spam: 0,
    hours: Array.from({ length: 24 }, () => 0)
  };
}
async function bumpDailyStat(env, field, n = 1) {
  if (!env?.TOPIC_MAP) return;
  try {
    const day = opsDayKey();
    const key = `stats:${day}`;
    let obj = {};
    try {
      const raw = await env.TOPIC_MAP.get(key);
      if (raw) obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
    if (!obj || typeof obj !== "object") obj = {};
    obj[field] = Number(obj[field] || 0) + Number(n || 0);
    obj.tz = `UTC+${OPS_TZ_OFFSET_HOURS}`;
    if (field === "messages_in") {
      if (!Array.isArray(obj.hours) || obj.hours.length !== 24) {
        obj.hours = Array.from({ length: 24 }, () => 0);
      }
      const h = (/* @__PURE__ */ new Date()).getUTCHours();
      obj.hours[h] = Number(obj.hours[h] || 0) + Number(n || 0);
    }
    obj.updated_at = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(obj), { expirationTtl: DAILY_STATS_TTL_SECONDS });
  } catch {
  }
}
async function getDailyStats(env, day = opsDayKey()) {
  try {
    const raw = await env.TOPIC_MAP.get(`stats:${day}`);
    if (!raw) return emptyDailyStats(day);
    const obj = JSON.parse(raw);
    const hours = Array.isArray(obj.hours) && obj.hours.length === 24 ? obj.hours.map((n) => Number(n || 0)) : Array.from({ length: 24 }, () => 0);
    return {
      day,
      messages_in: Number(obj.messages_in || 0),
      bans: Number(obj.bans || 0),
      verifies: Number(obj.verifies || 0),
      spam: Number(obj.spam || 0),
      hours,
      updated_at: obj.updated_at
    };
  } catch {
    return emptyDailyStats(day);
  }
}
async function getRecentDailySeries(env, days = 7) {
  const n = Math.min(Math.max(Number(days) || 7, 1), 14);
  const series = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = opsDayKey(now - i * 864e5);
    const s = await getDailyStats(env, day);
    series.push({
      day,
      messages_in: s.messages_in,
      verifies: s.verifies,
      bans: s.bans,
      spam: s.spam
    });
  }
  return series;
}

// src/admin-ui-format.js
var SEP_LINE = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500";
function formatSysTime(ts) {
  if (ts == null || ts === "" || Number(ts) <= 0) return "\u65E0";
  try {
    return new Date(Number(ts)).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  } catch {
    return String(ts);
  }
}
function formatCstTime(ts) {
  if (ts == null || ts === "" || Number(ts) <= 0) return "\u65E0";
  try {
    const shifted = new Date(Number(ts) + OPS_TZ_OFFSET_HOURS * 36e5);
    return `${shifted.toISOString().slice(0, 19).replace("T", " ")} CST`;
  } catch {
    return String(ts);
  }
}
function formatRelativeTime(ts, now = Date.now()) {
  const n = Number(ts);
  if (!n || n <= 0) return "\u65E0";
  const diff = Number(now) - n;
  if (diff < 0) return formatSysTime(ts);
  const sec = Math.floor(diff / 1e3);
  if (sec < 60) return `${sec} \u79D2\u524D`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} \u5206\u949F\u524D`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} \u5C0F\u65F6\u524D`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} \u5929\u524D`;
  return formatSysTime(ts);
}
function formatTimeBoth(ts, now = Date.now()) {
  if (ts == null || Number(ts) <= 0) return "\u65E0";
  return `${formatRelativeTime(ts, now)} \xB7 <code>${formatCstTime(ts)}</code>`;
}
function statusChip(ok, okText = "\u6B63\u5E38", badText = "\u5F02\u5E38") {
  return ok ? `\u{1F7E2} ${okText}` : `\u{1F534} ${badText}`;
}
function formatUserStatusChips({ banned, muted, closed } = {}) {
  const chips = [];
  if (banned) chips.push("\u{1F6AB} \u5DF2\u5C01\u7981");
  if (muted) chips.push("\u{1F507} \u5DF2\u9759\u97F3");
  if (closed) chips.push("\u{1F512} \u5DF2\u5173\u95ED");
  return chips.length ? chips.join(" \xB7 ") : "\u2705 \u72B6\u6001\u6B63\u5E38";
}
function buildUserActionKeyboard(userId, state = {}) {
  const id = String(userId);
  const {
    banned = false,
    muted = false,
    closed = false,
    trusted = false
  } = state;
  const action = (active, activeButton, inactiveButton) => active ? activeButton : inactiveButton;
  return {
    inline_keyboard: [
      [action(
        banned,
        { text: "\u2705 \u89E3\u5C01", callback_data: `adm:u:unban:${id}` },
        { text: "\u{1F6AB} \u5C01\u7981", callback_data: `adm:u:banask:${id}` }
      )],
      [action(
        closed,
        { text: "\u{1F513} \u6253\u5F00", callback_data: `adm:u:open:${id}` },
        { text: "\u{1F512} \u5173\u95ED", callback_data: `adm:u:closeask:${id}` }
      )],
      [action(
        trusted,
        { text: "\u{1F504} \u91CD\u7F6E", callback_data: `adm:u:resetask:${id}` },
        { text: "\u{1F31F} \u4FE1\u4EFB", callback_data: `adm:u:trust:${id}` }
      )],
      [action(
        muted,
        { text: "\u{1F50A} \u53D6\u6D88\u9759\u97F3", callback_data: `adm:u:unmute:${id}` },
        { text: "\u{1F507} \u9759\u97F3", callback_data: `adm:u:mute:${id}` }
      )],
      [
        { text: "\u{1F464} \u8D44\u6599", callback_data: `adm:u:info:${id}` },
        { text: "\u{1F4DD} \u770B\u5907\u6CE8", callback_data: `adm:u:shownote:${id}` }
      ]
    ]
  };
}
function buildSysinfoKeyboard(page = "overview") {
  const mark = (p, label) => p === page ? `\xB7${label}\xB7` : label;
  const refreshPage = ["overview", "storage", "errors", "stats", "activity"].includes(page) ? page : "overview";
  return {
    inline_keyboard: [
      [
        { text: mark("overview", "\u6982\u89C8"), callback_data: "adm:sys:overview" },
        { text: mark("storage", "\u5B58\u50A8"), callback_data: "adm:sys:storage" },
        { text: mark("errors", "\u9519\u8BEF"), callback_data: "adm:sys:errors" }
      ],
      [
        { text: mark("stats", "\u4ECA\u65E5"), callback_data: "adm:sys:stats" },
        { text: mark("activity", "\u6D3B\u8DC3"), callback_data: "adm:sys:activity" },
        { text: "\u{1F504} \u5237\u65B0", callback_data: `adm:sys:${refreshPage}` }
      ],
      [
        { text: "\u{1F3E0} \u83DC\u5355", callback_data: "adm:nav:menu" }
      ]
    ]
  };
}
function truncateLabel(text, maxLen) {
  return truncateText(text, maxLen - 1);
}
function buildUserJumpKeyboard(users, { includeMenu = true, columns = 2 } = {}) {
  const cols = Math.min(Math.max(Number(columns) || 2, 1), 3);
  const list = (users || []).slice(0, 8);
  const rows = [];
  for (let i = 0; i < list.length; i += cols) {
    const chunk = list.slice(i, i + cols).map((u) => {
      const label = truncateLabel(displayUserLabel2(u), cols === 1 ? 24 : 14);
      return {
        text: `\u{1F464} ${label}`,
        callback_data: `adm:u:panel:${u.userId}`
      };
    });
    rows.push(chunk);
  }
  if (includeMenu) {
    rows.push([
      { text: "\u{1F525} \u6D3B\u8DC3", callback_data: "adm:nav:rank" },
      { text: "\u{1F3E0} \u83DC\u5355", callback_data: "adm:nav:menu" }
    ]);
  }
  return { inline_keyboard: rows };
}
function statusBadge(status) {
  if (status === "banned") return " \u{1F6AB}";
  if (status === "closed") return " \u{1F512}";
  return "";
}
function formatRankingBlock(rankingUsers, { withCount = true, now = Date.now() } = {}) {
  if (!rankingUsers?.length) {
    return ["\u6682\u65E0\u4ECA\u65E5\u6D3B\u8DC3\u7528\u6237", ...formatEmptyActivityHints()];
  }
  const lines = [];
  rankingUsers.slice(0, 10).forEach((u, i) => {
    const label = displayUserLabel2(u);
    const name = escapeHtml(label);
    const un = shouldAppendUsername(u, label) ? ` @${escapeHtml(u.username)}` : "";
    const cnt = withCount && u.count != null ? ` \xB7 <b>${u.count}</b> \u6761` : "";
    const when = u.lastMessageAt && u.count == null ? ` \xB7 ${formatRelativeTime(u.lastMessageAt, now)}` : "";
    lines.push(`${rankMedal(i)} ${name}${un}${cnt}${when}${statusBadge(u.status)}`);
    lines.push(`   <code>${escapeHtml(u.userId)}</code>${u.topicId ? ` \xB7 T${escapeHtml(u.topicId)}` : ""}`);
  });
  return lines;
}
function formatHeatBlock(utcHours) {
  const localHours = shiftHourBuckets(utcHours, OPS_TZ_OFFSET_HOURS);
  const peaks = peakHoursFromBuckets(localHours, 3);
  return [
    `\u{1F321} <b>\u5C0F\u65F6\u70ED\u529B</b> <i>CST UTC+${OPS_TZ_OFFSET_HOURS} \xB7 0\u201323</i>`,
    `<code>${formatHeatBars(localHours)}</code>`,
    `<code>${formatHeatAxis()}</code>`,
    `\u9AD8\u5CF0 ${escapeHtml(formatPeakHours(peaks))}`
  ];
}
function formatCompareLine(label, todayVal, ydayVal) {
  const t = Number(todayVal) || 0;
  const y = Number(ydayVal) || 0;
  return `  ${label}  <b>${t}</b>  <i>\u8F83\u6628 ${escapeHtml(formatDelta(t, y))}</i>`;
}
function buildAdminHomeKeyboard(isOwner = false) {
  const rows = [
    [
      { text: "\u{1F5A5} \u7CFB\u7EDF", callback_data: "adm:nav:sysinfo" },
      { text: "\u{1F4CA} \u4ECA\u65E5", callback_data: "adm:nav:stats" },
      { text: "\u{1F525} \u6D3B\u8DC3", callback_data: "adm:nav:rank" }
    ],
    [
      { text: "\u{1F50D} \u67E5\u627E\u7528\u6237", callback_data: "adm:nav:find" },
      { text: "\u{1F50E} \u641C\u5907\u6CE8", callback_data: "adm:nav:notes" },
      { text: "\u{1F4DD} \u8BCD\u5E93", callback_data: "adm:nav:listwords" }
    ],
    [
      { text: "\u{1F9F9} \u6E05\u7406", callback_data: "adm:nav:cleanup_ask" },
      { text: "\u{1FAAA} \u8EAB\u4EFD", callback_data: "adm:nav:whoami" },
      { text: "\u2753 \u5E2E\u52A9", callback_data: "adm:nav:help" }
    ]
  ];
  if (isOwner) {
    rows.push([{ text: "\u{1F4E1} \u540C\u6B65 Bot \u83DC\u5355", callback_data: "adm:nav:synccommands" }]);
  }
  return { inline_keyboard: rows };
}
function buildBanConfirmKeyboard(userId) {
  const id = String(userId);
  return {
    inline_keyboard: [[
      { text: "\u786E\u8BA4\u5C01\u7981", callback_data: `adm:u:banok:${id}` },
      { text: "\u53D6\u6D88", callback_data: `adm:u:bancancel:${id}` }
    ]]
  };
}
function buildCloseConfirmKeyboard(userId) {
  const id = String(userId);
  return {
    inline_keyboard: [[
      { text: "\u786E\u8BA4\u5173\u95ED", callback_data: `adm:u:closeok:${id}` },
      { text: "\u53D6\u6D88", callback_data: `adm:u:closecancel:${id}` }
    ]]
  };
}
function buildResetConfirmKeyboard(userId) {
  const id = String(userId);
  return {
    inline_keyboard: [[
      { text: "\u786E\u8BA4\u91CD\u7F6E", callback_data: `adm:u:resetok:${id}` },
      { text: "\u53D6\u6D88", callback_data: `adm:u:resetcancel:${id}` }
    ]]
  };
}
function buildCleanupConfirmKeyboard() {
  return {
    inline_keyboard: [[
      { text: "\u786E\u8BA4\u6E05\u7406", callback_data: "adm:nav:cleanup_ok" },
      { text: "\u53D6\u6D88", callback_data: "adm:nav:cleanup_cancel" }
    ]]
  };
}
function confirmBanText(userId) {
  return `\u26A0\uFE0F <b>\u786E\u8BA4\u5C01\u7981\u7528\u6237</b> <code>${escapeHtml(String(userId))}</code>\uFF1F
\u5BF9\u65B9\u5C06\u6536\u5230\u901A\u77E5\u4E14\u65E0\u6CD5\u7EE7\u7EED\u53D1\u6D88\u606F\u3002`;
}
function confirmCloseText(userId) {
  return `\u26A0\uFE0F <b>\u786E\u8BA4\u5173\u95ED\u5BF9\u8BDD</b> <code>${escapeHtml(String(userId))}</code>\uFF1F
\u5C06\u5173\u95ED Forum Topic\uFF0C\u7528\u6237\u6D88\u606F\u4E0D\u518D\u63A5\u5165\uFF08\u53EF\u7528\u6253\u5F00\u6062\u590D\uFF09\u3002`;
}
function confirmResetText(userId) {
  return `\u26A0\uFE0F <b>\u786E\u8BA4\u91CD\u7F6E\u9A8C\u8BC1</b> <code>${escapeHtml(String(userId))}</code>\uFF1F
\u5C06\u53D6\u6D88\u6C38\u4E45\u4FE1\u4EFB\uFF0C\u7528\u6237\u4E0B\u6B21\u9700\u91CD\u65B0\u9A8C\u8BC1\u3002`;
}
var CLEANUP_CONFIRM_TEXT = "\u{1F9F9} <b>\u786E\u8BA4\u6E05\u7406\u65E0\u6548\u8BDD\u9898\uFF1F</b>\n\u5C06\u626B\u63CF\u5E76\u5904\u7406\u5931\u6548 Topic \u6620\u5C04\uFF0C\u53EF\u80FD\u8017\u65F6\u3002";
var DANGER_CANCEL_TEXT = {
  ban: "\u5DF2\u53D6\u6D88\u5C01\u7981\u3002",
  close: "\u5DF2\u53D6\u6D88\u5173\u95ED\u5BF9\u8BDD\u3002",
  reset: "\u5DF2\u53D6\u6D88\u91CD\u7F6E\u9A8C\u8BC1\u3002"
};
function dangerCancelText(action) {
  return DANGER_CANCEL_TEXT[action] || "\u5DF2\u53D6\u6D88\u64CD\u4F5C\u3002";
}
function formatEmptyActivityHints() {
  return [
    "\u{1F4A1} <b>\u8FD8\u6CA1\u6709\u4ECA\u65E5\u6570\u636E\uFF1F</b>",
    "\u2022 \u7528\u6237\u79C1\u804A Bot \u5E76\u901A\u8FC7\u9A8C\u8BC1\u540E\u4F1A\u51FA\u73B0\u5728\u6392\u884C",
    "\u2022 \u65E5\u5207\u6309 <b>\u4E2D\u56FD\u65F6\u95F4 CST</b>\uFF0C\u51CC\u6668\u540E\u91CD\u65B0\u7D2F\u8BA1",
    "\u2022 \u4E5F\u53EF\u7528 <code>/find \u59D3\u540D</code> \u6216 <code>/notes \u8BCD</code> \u5B9A\u4F4D\u7528\u6237"
  ];
}

// src/admin-commands.js
function createAdminCommandHandlers(deps) {
  const {
    tgCall: tgCall2,
    gatewayVersion: GATEWAY_VERSION2,
    gatewayRepo: GATEWAY_REPO_LINK = GATEWAY_REPO,
    recordSystemError: recordSystemError2,
    isOwnerUser: isOwnerUser2,
    isAdminUser: isAdminUser2,
    parseIdAllowlist: parseIdAllowlist2,
    safeGetJSON: safeGetJSON2,
    resolveThreadIdForUser: resolveThreadIdForUser2,
    getRecentSystemErrors,
    handleCleanupCommand,
    handleListWordsCommand,
    // 存储依赖注入：由调用方提供，避免本模块直连 D1/migrations
    createD1Storage: createD1Storage2,
    ensureMigrations: ensureMigrations2,
    userActions = {}
  } = deps;
  const sysinfoKvCache = { ts: 0, data: null, ttlMs: 45e3 };
  async function loadTodayActivity(env) {
    const dayStart = opsDayStartMs();
    const day = opsDayKey();
    const today = await getDailyStats(env, day);
    let summary = summarizeInboundActivity([], { topN: 10 });
    let source = "none";
    const storage = env.TG_BOT_DB ? createD1Storage2(env.TG_BOT_DB) : null;
    if (storage) {
      try {
        await ensureMigrations2(env.TG_BOT_DB);
        const rows = await storage.getInboundMessageRows(dayStart, 2e3);
        if (rows.length) {
          summary = summarizeInboundActivity(rows, { topN: 10 });
          source = "message_links";
        }
      } catch (e) {
        recordSystemError2("activity_links_failed", e, {}, env);
      }
    }
    if (summary.total === 0 && today.hours?.some((n) => n > 0)) {
      summary = {
        ...summary,
        total: today.messages_in || today.hours.reduce((a, b) => a + b, 0),
        hours: today.hours,
        peakHours: today.hours.map((count, hour) => ({ hour, count })).filter((item) => item.count > 0).sort((a, b) => b.count - a.count || a.hour - b.hour).slice(0, 3)
      };
      source = source === "none" ? "kv_hours" : source;
    }
    let rankingUsers = [];
    if (storage) {
      try {
        if (summary.ranking.length) {
          const map = await storage.getUsersByIds(summary.ranking.map((r) => r.userId));
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
              status: u?.status || null
            };
          });
        } else {
          const active = await storage.getUsersActiveSince(dayStart, 10);
          rankingUsers = active.map((u) => ({
            userId: u.userId,
            count: null,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            topicId: u.topicId,
            lastMessageAt: u.lastMessageAt,
            status: u.status
          }));
          if (rankingUsers.length && source === "none") source = "last_message";
          else if (rankingUsers.length && source === "kv_hours") source = "kv_hours+last_message";
        }
      } catch (e) {
        recordSystemError2("activity_rank_failed", e, {}, env);
      }
    }
    return {
      day,
      dayStart,
      today,
      summary,
      rankingUsers,
      source
    };
  }
  async function handleHelpCommand(env, threadId, senderId = null) {
    const helpText = `\u{1F4CB} <b>\u7BA1\u7406\u5E2E\u52A9</b> \xB7 v${GATEWAY_VERSION2}

<b>\u6743\u9650</b>
\u7FA4\u4E3B/\u7BA1\u7406\u5458\u3001<code>ADMIN_IDS</code> \u6216 <code>OWNER_IDS</code>
\u79C1\u804A\u7528\u6237\u4EC5 <code>/start</code> <code>/help</code> \xB7 \u547D\u4EE4\u83DC\u5355\uFF1ABotFather \u6216 Owner <code>/synccommands</code>

<b>\u63A8\u8350\u7528\u6CD5</b>
\u2022 <code>/menu</code> \u2014 \u6309\u94AE\u9996\u9875\uFF08\u6700\u7701\u4E8B\uFF09
\u2022 \u7528\u6237\u8BDD\u9898\u5185 <code>/panel</code> \u6216 <code>/info</code> \u2014 \u4E00\u952E\u64CD\u4F5C
\u2022 <code>/sysinfo</code> / <code>/rank</code> \u2014 \u7CFB\u7EDF\u4E0E\u4ECA\u65E5\u6D3B\u8DC3\u770B\u677F
\u2022 \u7EDF\u8BA1\u300C\u4ECA\u65E5\u300D\u6309 <b>\u4E2D\u56FD\u65F6\u95F4 CST</b> \u65E5\u5207

<b>\u5168\u5C40\u547D\u4EE4</b>
/menu /sysinfo /stats /rank /whoami
/find \u8BCD \xB7 /notes \u5173\u952E\u8BCD
/cleanup /listwords /addword /delword
/synccommands <i>(Owner)</i>

<b>\u8BDD\u9898\u5185</b>
/panel /info /note \u5907\u6CE8
/ban(\u9700\u786E\u8BA4) /unban /close /open /mute /unmute /trust /reset

<b>\u6765\u6E90</b>
\u{1F517} <a href="${escapeHtml(GATEWAY_REPO_LINK)}">\u9879\u76EE\u5730\u5740 GitHub</a>`;
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: helpText,
      parse_mode: "HTML",
      reply_markup: buildAdminHomeKeyboard(isOwnerUser2(env, senderId))
    });
  }
  async function handleMenuCommand(env, threadId, senderId) {
    const text = [
      `\u{1F3E0} <b>\u7BA1\u7406\u83DC\u5355</b> \xB7 v${GATEWAY_VERSION2}`,
      SEP_LINE,
      "\u70B9\u4E0B\u65B9\u6309\u94AE\u5373\u53EF\uFF0C\u65E0\u9700\u8BB0\u5FC6\u547D\u4EE4\u3002",
      "",
      "\u{1F4CA} \u4ECA\u65E5\u7EDF\u8BA1 \xB7 \u{1F525} \u6D3B\u8DC3\u6392\u884C\uFF08CST\uFF09",
      "\u{1F50D} /find \xB7 \u{1F50E} /notes \xB7 \u{1F39B} \u8BDD\u9898\u5185 /panel",
      "",
      "<i>\u5371\u9669\u64CD\u4F5C\uFF08\u5C01\u7981/\u5173\u95ED/\u91CD\u7F6E\uFF09\u5747\u9700\u4E8C\u6B21\u786E\u8BA4</i>"
    ].join("\n");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text,
      parse_mode: "HTML",
      reply_markup: buildAdminHomeKeyboard(isOwnerUser2(env, senderId))
    });
  }
  const KV_COUNT_MAX_PAGES = 20;
  async function countKvPrefix(env, prefix) {
    if (!env?.TOPIC_MAP?.list) return null;
    let total = 0;
    let cursor;
    let pages = 0;
    do {
      const result = await env.TOPIC_MAP.list({ prefix, cursor, limit: 1e3 });
      total += (result.keys || []).length;
      cursor = result.list_complete ? void 0 : result.cursor;
      pages += 1;
    } while (cursor && pages < KV_COUNT_MAX_PAGES);
    return { total, truncated: Boolean(cursor) };
  }
  async function collectRecentErrors(env) {
    let kvErrors = [];
    try {
      if (env?.TOPIC_MAP) {
        const raw = await env.TOPIC_MAP.get("sys:recent_errors");
        if (raw) kvErrors = JSON.parse(raw);
      }
    } catch {
      kvErrors = [];
    }
    if (!Array.isArray(kvErrors)) kvErrors = [];
    const merged = [];
    const seen = /* @__PURE__ */ new Set();
    for (const rawItem of [...getRecentSystemErrors(), ...kvErrors]) {
      const item = normalizeRecentErrorItem(rawItem);
      if (!item) continue;
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
      ["user:", "\u7528\u6237\u4F1A\u8BDD"],
      ["thread:", "\u8BDD\u9898\u53CD\u67E5"],
      ["banned:", "\u5C01\u7981"],
      ["muted:", "\u9759\u97F3"],
      ["profile:", "\u8D44\u6599\u5FEB\u7167"],
      ["note:", "\u5907\u6CE8"],
      ["chal:", "\u9A8C\u8BC1\u6311\u6218"],
      ["turnstile_code:", "Turnstile"],
      ["pending_turnstile:", "\u5F85\u8F6C\u53D1"],
      ["stats:", "\u65E5\u7EDF\u8BA1"],
      ["sys:", "\u7CFB\u7EDF\u952E"]
    ];
    const rows = await Promise.all(prefixes.map(async ([prefix, label]) => {
      const c = await countKvPrefix(env, prefix);
      return { prefix, label, ...c || { total: 0, truncated: false } };
    }));
    sysinfoKvCache.ts = now;
    sysinfoKvCache.data = rows;
    return rows;
  }
  async function renderOverviewStatsSection(env, page) {
    const hasKv = Boolean(env.TOPIC_MAP && typeof env.TOPIC_MAP.get === "function");
    const hasD1 = Boolean(env.TG_BOT_DB && typeof env.TG_BOT_DB.prepare === "function");
    const baseUrl = String(env.VERIFICATION_PAGE_URL || "").replace(/\/$/, "") || "(\u672A\u914D\u7F6E VERIFICATION_PAGE_URL)";
    const turnstileOn = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.VERIFICATION_PAGE_URL);
    const lines = [];
    let activity = null;
    lines.push(`\u{1F5A5} <b>\u7CFB\u7EDF \xB7 ${page === "stats" ? "\u4ECA\u65E5\u7EDF\u8BA1" : "\u6982\u89C8"}</b>`);
    lines.push(`<code>v${GATEWAY_VERSION2}</code>`);
    lines.push(SEP_LINE);
    lines.push("\u2705 Worker \u8FD0\u884C\u4E2D");
    lines.push(`${statusChip(hasKv, "KV \u5DF2\u7ED1\u5B9A", "KV \u7F3A\u5931")} \xB7 ${statusChip(hasD1, "D1 \u5DF2\u7ED1\u5B9A", "D1 \u7F3A\u5931")}`);
    lines.push(`\u9A8C\u8BC1: ${turnstileOn ? "\u{1F6E1} Turnstile" : "\u{1F4DD} \u672C\u5730\u9898\u5E93"} \xB7 Owner: ${parseIdAllowlist2(env.OWNER_IDS).length > 0 ? "\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E"}`);
    lines.push(`\u8D85\u7EA7\u7FA4 ID: ${String(env.SUPERGROUP_ID || "").startsWith("-100") ? "\u2705 \u683C\u5F0F\u6B63\u786E" : "\u274C \u9700 -100 \u5F00\u5934"}`);
    lines.push("");
    if (hasD1) {
      try {
        await ensureMigrations2(env.TG_BOT_DB);
        const stats = await createD1Storage2(env.TG_BOT_DB).getSystemStats();
        lines.push("\u{1F4CA} <b>\u4F1A\u8BDD</b>");
        lines.push(`  \u7528\u6237 <b>${stats.usersTotal}</b>  \xB7  Topic ${stats.usersWithTopic}`);
        lines.push(`  \u5C01\u7981 ${stats.usersBanned}  \xB7  \u5173\u95ED ${stats.usersClosed || 0}`);
        lines.push("\u{1F5C2} <b>\u6570\u636E</b>");
        lines.push(`  \u6620\u5C04 ${stats.messageLinks}  \xB7  \u89C4\u5219 ${stats.rulesTotal}`);
        lines.push(`  Update \u5904\u7406\u4E2D/\u53EF\u91CD\u8BD5  ${stats.updatesProcessing}/${stats.updatesRetryable}`);
        const recent = stats.recentActiveUsers?.length ? stats.recentActiveUsers : stats.lastActiveUser ? [stats.lastActiveUser] : [];
        if (recent.length) {
          lines.push("");
          lines.push("<b>\u6700\u8FD1\u6D3B\u8DC3</b>");
          for (const u of recent.slice(0, 5)) {
            const name = escapeHtml(formatUserName(u));
            const un = u.username ? `@${escapeHtml(u.username)}` : "\u65E0\u7528\u6237\u540D";
            lines.push(`\u2022 ${name} \xB7 ${un}`);
            lines.push(`  <code>${escapeHtml(u.userId)}</code> \xB7 ${formatTimeBoth(u.lastMessageAt)}`);
          }
        } else {
          lines.push("\u6700\u8FD1\u6D3B\u8DC3: \u6682\u65E0");
        }
        if (stats.updatesProcessing > 20) {
          lines.push("");
          lines.push("\u26A0\uFE0F Update \u5904\u7406\u4E2D\u6570\u91CF\u504F\u9AD8\uFF0C\u8BF7\u68C0\u67E5 Webhook \u662F\u5426\u6301\u7EED 5xx");
        }
      } catch (e) {
        recordSystemError2("sysinfo_d1_failed", e, {}, env);
        lines.push(`D1 \u8BFB\u53D6\u5931\u8D25: ${escapeHtml(e?.message || String(e))}`);
      }
    } else {
      lines.push("D1 \u672A\u7ED1\u5B9A\uFF0C\u65E0\u6CD5\u663E\u793A\u4F1A\u8BDD\u7EDF\u8BA1");
    }
    if (page === "overview") {
      try {
        const recentErrs = await collectRecentErrors(env);
        if (recentErrs.length) {
          lines.push("");
          lines.push(`\u26A0\uFE0F \u6700\u8FD1\u9519\u8BEF <b>${recentErrs.length}</b> \u6761 \xB7 \u70B9\u4E0B\u65B9\u300C\u9519\u8BEF\u300D\u5206\u9875\u67E5\u770B`);
        }
      } catch {
      }
    }
    if (page === "stats") {
      activity = await loadTodayActivity(env);
      const today = activity.today;
      const yday = await getDailyStats(env, opsYesterdayKey());
      const week = await getRecentDailySeries(env, 7);
      const peaks = pickPeakDays(week, 2);
      lines.push("");
      lines.push(`\u{1F4C5} <b>\u4ECA\u65E5</b> <code>${escapeHtml(today.day)}</code> <i>CST UTC+${OPS_TZ_OFFSET_HOURS}</i>`);
      lines.push(formatCompareLine("\u{1F4AC} \u5165\u7AD9", today.messages_in, yday.messages_in));
      lines.push(formatCompareLine("\u2705 \u9A8C\u8BC1", today.verifies, yday.verifies));
      lines.push(formatCompareLine("\u{1F6AB} \u5C01\u7981", today.bans, yday.bans));
      lines.push(formatCompareLine("\u{1F6E1} \u5783\u573E", today.spam, yday.spam));
      lines.push(`  <i>\u6628 ${escapeHtml(yday.day)}\uFF1A\u5165\u7AD9 ${yday.messages_in} \xB7 \u9A8C\u8BC1 ${yday.verifies} \xB7 \u5783\u573E ${yday.spam}</i>`);
      if (today.messages_in === 0 && yday.messages_in === 0) {
        lines.push("");
        lines.push(...formatEmptyActivityHints());
      }
      lines.push("");
      lines.push("\u{1F4C8} <b>\u8FD1 7 \u65E5\u5165\u7AD9</b> <i>CST</i>");
      lines.push(`<code>${formatSparkline(week.map((d) => d.messages_in))}</code>`);
      lines.push(week.map((d) => {
        const mmdd = d.day.slice(5);
        return `${mmdd}:${d.messages_in}`;
      }).join(" \xB7 "));
      lines.push(`\u5CF0\u503C\u65E5 ${escapeHtml(formatPeakDays(peaks))}`);
      lines.push("");
      lines.push(...formatHeatBlock(activity.summary.hours));
      if (activity.rankingUsers.length) {
        lines.push("");
        lines.push("\u{1F3C6} <b>\u4ECA\u65E5 Top</b> <i>\uFF08\u5B8C\u6574\u89C1 /rank\uFF09</i>");
        lines.push(...formatRankingBlock(activity.rankingUsers.slice(0, 3)));
      }
    }
    lines.push("");
    lines.push("\u{1F517} <b>\u7AEF\u70B9</b>");
    if (baseUrl.startsWith("https://") || baseUrl.startsWith("http://")) {
      lines.push(`<code>${escapeHtml(baseUrl)}/health</code>`);
      lines.push(`<code>\u2026/health/env</code> \xB7 <code>\u2026/health/d1</code> \xB7 <code>\u2026/verify</code>`);
      lines.push(`Webhook <code>POST ${escapeHtml(baseUrl)}/</code>`);
    } else {
      lines.push("<i>\u672A\u914D\u7F6E VERIFICATION_PAGE_URL\uFF0C\u4EC5\u5C55\u793A\u76F8\u5BF9\u8DEF\u5F84</i>");
      lines.push("<code>/health</code> \xB7 <code>/health/env</code> \xB7 <code>/health/d1</code>");
    }
    return { lines, activity };
  }
  async function renderActivityPage(env) {
    const lines = [];
    const activity = await loadTodayActivity(env);
    const unique = activity.summary.uniqueUsers || activity.rankingUsers.length;
    lines.push("\u{1F525} <b>\u7CFB\u7EDF \xB7 \u4ECA\u65E5\u6D3B\u8DC3</b>");
    lines.push(`<code>v${GATEWAY_VERSION2}</code> \xB7 <code>${escapeHtml(activity.day)}</code> CST`);
    lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    lines.push(`\u5165\u7AD9\u6837\u672C <b>${activity.summary.total}</b> \xB7 \u72EC\u7ACB\u7528\u6237 <b>${unique}</b>`);
    lines.push(`\u6570\u636E\u6E90: ${escapeHtml(activitySourceLabel(activity.source))}`);
    lines.push("");
    if (activity.summary.total === 0 && !activity.rankingUsers.length) {
      lines.push(...formatEmptyActivityHints());
      lines.push("");
    }
    lines.push(...formatHeatBlock(activity.summary.hours));
    lines.push("");
    lines.push("\u{1F3C6} <b>\u6D3B\u8DC3\u6392\u884C</b>");
    lines.push(...formatRankingBlock(activity.rankingUsers, {
      withCount: activity.rankingUsers.some((u) => u.count != null)
    }));
    lines.push("");
    lines.push("<i>\u70B9\u4E0B\u65B9\u7528\u6237\u6309\u94AE\u6253\u5F00\u9762\u677F \xB7 \u65E5\u5207\u4E0E\u70ED\u529B\u5747\u4E3A\u4E2D\u56FD\u65F6\u95F4 CST</i>");
    return { lines, activity };
  }
  async function renderStoragePage(env) {
    const hasKv = Boolean(env.TOPIC_MAP && typeof env.TOPIC_MAP.get === "function");
    const hasD1 = Boolean(env.TG_BOT_DB && typeof env.TG_BOT_DB.prepare === "function");
    const lines = [];
    lines.push("\u{1F5C4} <b>\u7CFB\u7EDF \xB7 \u5B58\u50A8</b>");
    lines.push(`<code>v${GATEWAY_VERSION2}</code>`);
    lines.push(SEP_LINE);
    if (hasD1) {
      try {
        const stats = await createD1Storage2(env.TG_BOT_DB).getSystemStats();
        lines.push("<b>D1</b>");
        lines.push(`\u2022 users: ${stats.usersTotal} (topic ${stats.usersWithTopic})`);
        lines.push(`\u2022 banned ${stats.usersBanned} \xB7 closed ${stats.usersClosed || 0}`);
        lines.push(`\u2022 message_links ${stats.messageLinks} \xB7 rules ${stats.rulesTotal}`);
        lines.push(`\u2022 processed processing/retryable: ${stats.updatesProcessing}/${stats.updatesRetryable}`);
      } catch (e) {
        lines.push(`D1: ${escapeHtml(e?.message || String(e))}`);
      }
    } else lines.push("D1: \u672A\u7ED1\u5B9A");
    lines.push("");
    lines.push("<b>KV \u524D\u7F00</b>");
    if (hasKv) {
      try {
        const rows = await getCachedKvPrefixCounts(env);
        for (const r of rows) {
          lines.push(`\u2022 ${r.label} <code>${r.prefix}</code> ${r.total}${r.truncated ? "+" : ""}`);
        }
        lines.push("<i>\u8BA1\u6570\u7F13\u5B58\u7EA6 45s</i>");
      } catch (e) {
        lines.push(`KV: ${escapeHtml(e?.message || String(e))}`);
      }
    } else lines.push("KV: \u672A\u7ED1\u5B9A");
    return lines;
  }
  async function renderErrorsPage(env) {
    const lines = [];
    lines.push("\u26A0\uFE0F <b>\u7CFB\u7EDF \xB7 \u6700\u8FD1\u9519\u8BEF</b>");
    lines.push(`<code>v${GATEWAY_VERSION2}</code>`);
    lines.push(SEP_LINE);
    const top = await collectRecentErrors(env);
    if (!top.length) {
      lines.push("\u2728 \u6682\u65E0\u9519\u8BEF\u8BB0\u5F55");
      lines.push("<i>\u51B7\u542F\u52A8\u540E\u5185\u5B58\u7F13\u51B2\u4F1A\u6E05\u7A7A\uFF1B\u6301\u7EED 5xx \u65F6\u8BF7\u67E5 /health \u4E0E CF \u65E5\u5FD7</i>");
    } else {
      lines.push(`\u{1F534} \u6700\u8FD1 <b>${top.length}</b> \u6761\u9519\u8BEF\u8BB0\u5F55\uFF08\u5185\u5B58 + KV \u5408\u5E76\u53BB\u91CD\uFF09`);
      for (const err of top) {
        const act = escapeHtml(err.action || "?");
        const msg = escapeHtml(String(err.error || "").slice(0, 140));
        const identifiers = [
          err.userId ? `uid ${escapeHtml(err.userId)}` : "",
          err.updateId ? `update ${escapeHtml(err.updateId)}` : "",
          err.correlationId ? `corr ${escapeHtml(err.correlationId)}` : ""
        ].filter(Boolean).join(" \xB7 ");
        lines.push(`\u{1F534} <b>${act}</b>${identifiers ? ` \xB7 ${identifiers}` : ""}`);
        lines.push(`   ${formatRelativeTime(err.ts)} \xB7 ${msg}`);
      }
      lines.push("");
      lines.push("<i>\u5EFA\u8BAE\uFF1A\u5BF9\u7167 Webhook \u662F\u5426 5xx\u3001D1/KV \u7ED1\u5B9A\u662F\u5426\u6B63\u5E38</i>");
    }
    return lines;
  }
  async function buildSysinfoPageText(env, page = "overview") {
    const started = Date.now();
    let lines = [];
    let activity = null;
    if (page === "overview" || page === "stats") {
      ({ lines, activity } = await renderOverviewStatsSection(env, page));
    } else if (page === "activity") {
      ({ lines, activity } = await renderActivityPage(env));
    } else if (page === "storage") {
      lines = await renderStoragePage(env);
    } else if (page === "errors") {
      lines = await renderErrorsPage(env);
    }
    lines.push("");
    lines.push(`\u{1F517} \u9879\u76EE\u5730\u5740: <a href="${escapeHtml(GATEWAY_REPO_LINK)}">${escapeHtml(GATEWAY_REPO_LINK)}</a>`);
    lines.push(`\u23F1 ${Date.now() - started} ms \xB7 \u70B9\u4E0B\u65B9\u5207\u6362\u5206\u9875`);
    let text = lines.join("\n");
    if (text.length > 3500) text = `${text.slice(0, 3500)}
\u2026`;
    return { text, activity };
  }
  async function handleSysinfoCommand(env, threadId, opts = {}) {
    const page = opts.page || "overview";
    const { text, activity } = await buildSysinfoPageText(env, page);
    let markup = buildSysinfoKeyboard(page);
    if (page === "activity" && activity?.rankingUsers?.length) {
      const jump = buildUserJumpKeyboard(activity.rankingUsers, { includeMenu: false });
      markup = {
        inline_keyboard: [
          ...buildSysinfoKeyboard("activity").inline_keyboard,
          ...jump.inline_keyboard
        ]
      };
    } else if (page === "stats") {
      const base = buildSysinfoKeyboard("stats").inline_keyboard;
      markup = {
        inline_keyboard: [
          base[0],
          base[1],
          [{ text: "\u{1F525} \u5B8C\u6574\u6D3B\u8DC3\u6392\u884C", callback_data: "adm:sys:activity" }],
          base[2]
        ].filter(Boolean)
      };
    }
    if (opts.edit?.chatId && opts.edit?.messageId) {
      const res = await tgCall2(env, "editMessageText", {
        chat_id: opts.edit.chatId,
        message_id: opts.edit.messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: markup
      });
      if (!res?.ok) {
        await tgCall2(env, "sendMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: threadId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: markup
        });
      }
      return;
    }
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: markup
    });
  }
  async function handleStatsCommand(env, threadId) {
    await handleSysinfoCommand(env, threadId, { page: "stats" });
  }
  async function handleRankCommand(env, threadId, opts = {}) {
    await handleSysinfoCommand(env, threadId, { page: "activity", edit: opts.edit || null });
  }
  async function handleNotesCommand(env, threadId, queryText = "") {
    const q = commandArgument(queryText, "notes");
    if (!env.TOPIC_MAP?.list) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.kvNotBoundNotes
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
        const result = await env.TOPIC_MAP.list({ prefix: "note:", cursor, limit: 100 });
        const batchKeys = (result.keys || []).map((key) => String(key.name || "")).filter((name) => {
          const uid = name.slice(5);
          return uid && (!needle || uid.includes(needle));
        });
        for (let i = 0; i < batchKeys.length && matches.length < 12; i += 20) {
          const chunk = batchKeys.slice(i, i + 20);
          const notes = await Promise.all(chunk.map((name) => env.TOPIC_MAP.get(name)));
          for (let j = 0; j < chunk.length && matches.length < 12; j += 1) {
            const note = notes[j];
            if (!note) continue;
            const userId = String(chunk[j]).slice(5);
            const noteStr = String(note);
            if (needle && !noteStr.toLowerCase().includes(needle)) continue;
            matches.push({ userId, note: noteStr });
          }
        }
        cursor = result.list_complete ? void 0 : result.cursor;
        pages += 1;
      } while (cursor && pages < maxPages && matches.length < 12);
    } catch (e) {
      recordSystemError2("notes_search_failed", e, {}, env);
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.notesSearchFailed(e?.message || String(e)),
        parse_mode: "HTML"
      });
      return;
    }
    if (!matches.length) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: q ? `\u{1F50E} \u672A\u627E\u5230\u542B\u300C${escapeHtml(q)}\u300D\u7684\u5907\u6CE8

\u7528\u6CD5: <code>/notes \u5173\u952E\u8BCD</code>
\u4E5F\u53EF: <code>/find ${escapeHtml(q)}</code> \u627E\u7528\u6237` : "\u{1F4DD} \u6682\u65E0\u5907\u6CE8\u3002\n\u5728\u7528\u6237\u8BDD\u9898\u5185\u7528 <code>/note \u5185\u5BB9</code> \u6DFB\u52A0\uFF0C\u518D\u7528 <code>/notes \u5173\u952E\u8BCD</code> \u68C0\u7D22\u3002",
        parse_mode: "HTML",
        reply_markup: buildAdminHomeKeyboard(false)
      });
      return;
    }
    let userMap = /* @__PURE__ */ new Map();
    if (env.TG_BOT_DB) {
      try {
        await ensureMigrations2(env.TG_BOT_DB);
        userMap = await createD1Storage2(env.TG_BOT_DB).getUsersByIds(matches.map((m) => m.userId));
      } catch {
      }
    }
    const truncated = matches.length >= 12 || Boolean(cursor);
    const lines = [
      `\u{1F50E} <b>\u5907\u6CE8\u641C\u7D22</b>${q ? ` \xB7 \u300C${escapeHtml(q)}\u300D` : " \xB7 \u6700\u8FD1"}`,
      `\u5171 ${matches.length} \u6761${truncated ? "\uFF08\u5DF2\u622A\u65AD\uFF0C\u53EF\u52A0\u5173\u952E\u8BCD\u7F29\u5C0F\uFF09" : ""}`,
      SEP_LINE
    ];
    const jumpUsers = [];
    for (const m of matches) {
      const u = userMap.get(m.userId) || { userId: m.userId };
      jumpUsers.push(u);
      const label = escapeHtml(displayUserLabel(u));
      lines.push(`\u2022 ${label} \xB7 <code>${escapeHtml(m.userId)}</code>`);
      lines.push(`  \u{1F4DD} ${escapeHtml(m.note.slice(0, 120))}${m.note.length > 120 ? "\u2026" : ""}`);
    }
    lines.push("", "<i>\u70B9\u4E0B\u65B9\u6309\u94AE\u6253\u5F00\u7528\u6237\u9762\u677F</i>");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      reply_markup: buildUserJumpKeyboard(jumpUsers)
    });
  }
  async function handleWhoamiCommand(env, threadId, senderId) {
    const admin = await isAdminUser2(env, senderId);
    const owner = isOwnerUser2(env, senderId);
    let member = "unknown";
    try {
      const res = await tgCall2(env, "getChatMember", {
        chat_id: env.SUPERGROUP_ID,
        user_id: senderId
      });
      member = res.result?.status || res.description || "unknown";
    } catch {
    }
    const memberLabel = {
      creator: "\u521B\u5EFA\u8005",
      administrator: "\u7BA1\u7406\u5458",
      member: "\u6210\u5458",
      restricted: "\u53D7\u9650",
      left: "\u5DF2\u79BB\u5F00",
      kicked: "\u5DF2\u79FB\u51FA"
    }[member] || member;
    const text = [
      "\u{1FAAA} <b>Whoami</b>",
      SEP_LINE,
      `UID: <code>${senderId}</code>`,
      `\u7FA4\u8EAB\u4EFD: <code>${escapeHtml(member)}</code> \xB7 ${escapeHtml(memberLabel)}`,
      `\u7BA1\u7406\u6307\u4EE4: ${admin ? "\u2705 \u53EF\u7528" : "\u274C \u4E0D\u53EF\u7528"}`,
      `OWNER_IDS: ${owner ? "\u2705 \u662F\uFF08\u542B\u540C\u6B65\u547D\u4EE4\u83DC\u5355\uFF09" : "\u274C \u5426"}`,
      "",
      "<i>\u6743\u9650 = \u7FA4\u4E3B/\u7BA1\u7406\u5458 \u6216 ADMIN_IDS \u6216 OWNER_IDS</i>"
    ].join("\n");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text,
      parse_mode: "HTML",
      reply_markup: buildAdminHomeKeyboard(owner)
    });
  }
  async function handleFindCommand(env, threadId, queryText) {
    const q = commandArgument(queryText, "find").slice(0, 100);
    if (!q) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.findUsage,
        parse_mode: "HTML"
      });
      return;
    }
    if (!env.TG_BOT_DB) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.d1NotBoundFind
      });
      return;
    }
    try {
      await ensureMigrations2(env.TG_BOT_DB);
      const hits = await createD1Storage2(env.TG_BOT_DB).searchUsers(q, 10);
      if (!hits.length) {
        await tgCall2(env, "sendMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: threadId,
          text: [
            `\u672A\u627E\u5230\u5339\u914D\u300C${escapeHtml(q)}\u300D\u7684\u7528\u6237`,
            "",
            "\u2022 \u4EC5\u6536\u5F55 <b>\u79C1\u804A\u8FC7\u673A\u5668\u4EBA</b> \u7684\u7528\u6237\uFF1B\u53EF\u8BF7\u5BF9\u65B9\u5148\u5411\u673A\u5668\u4EBA\u53D1\u4E00\u6761\u6D88\u606F",
            `\u2022 \u4E5F\u53EF\u8BD5 <code>/notes ${escapeHtml(q)}</code> \u641C\u7D22\u7BA1\u7406\u5458\u5907\u6CE8`
          ].join("\n"),
          parse_mode: "HTML"
        });
        return;
      }
      const statusLabel = (s) => {
        if (s === "banned") return "\u{1F6AB} \u5C01\u7981";
        if (s === "closed") return "\u{1F512} \u5173\u95ED";
        if (s === "active") return "\u2705 \u6B63\u5E38";
        return escapeHtml(s || "?");
      };
      const lines = [`\u{1F50E} <b>\u67E5\u627E\u7ED3\u679C</b> \xB7 ${hits.length} \u6761`, ""];
      for (const u of hits) {
        const name = escapeHtml([u.firstName, u.lastName].filter(Boolean).join(" ").trim() || "\u672A\u77E5");
        const un = u.username ? `@${escapeHtml(u.username)}` : "\u65E0\u7528\u6237\u540D";
        lines.push(`\u2022 ${name} \xB7 ${un}`);
        lines.push(`  UID <code>${escapeHtml(u.userId)}</code> \xB7 Topic <code>${escapeHtml(u.topicId || "-")}</code> \xB7 ${statusLabel(u.status)}`);
        lines.push(`  \u6700\u8FD1: ${formatTimeBoth(u.lastMessageAt)}`);
      }
      lines.push("", "<i>\u70B9\u4E0B\u65B9\u6309\u94AE\u76F4\u63A5\u6253\u5F00\u7528\u6237\u9762\u677F</i>");
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        reply_markup: buildUserJumpKeyboard(hits)
      });
    } catch (e) {
      recordSystemError2("find_failed", e, {}, env);
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.searchFailed(e?.message || String(e)),
        parse_mode: "HTML"
      });
    }
  }
  async function handleSyncCommandsCommand(env, threadId, senderId) {
    if (!isOwnerUser2(env, senderId)) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.syncCommandsDenied,
        parse_mode: "HTML"
      });
      return;
    }
    const commands = [
      { command: "start", description: "\u5F00\u59CB\u5BF9\u8BDD" },
      { command: "help", description: "\u5E2E\u52A9" },
      { command: "menu", description: "\u7BA1\u7406\u83DC\u5355" },
      { command: "sysinfo", description: "\u7CFB\u7EDF\u4FE1\u606F" },
      { command: "stats", description: "\u4ECA\u65E5\u7EDF\u8BA1" },
      { command: "rank", description: "\u4ECA\u65E5\u6D3B\u8DC3\u6392\u884C" },
      { command: "panel", description: "\u7528\u6237\u5FEB\u6377\u9762\u677F" },
      { command: "info", description: "\u7528\u6237\u8D44\u6599" },
      { command: "find", description: "\u67E5\u627E\u7528\u6237" },
      { command: "notes", description: "\u641C\u7D22\u5907\u6CE8" },
      { command: "note", description: "\u5199/\u770B\u5907\u6CE8" },
      { command: "whoami", description: "\u67E5\u770B\u6211\u7684\u6743\u9650" },
      { command: "ban", description: "\u5C01\u7981\uFF08\u9700\u786E\u8BA4\uFF09" },
      { command: "unban", description: "\u89E3\u5C01\u7528\u6237" },
      { command: "mute", description: "\u9759\u97F3\u7528\u6237" },
      { command: "unmute", description: "\u53D6\u6D88\u9759\u97F3" },
      { command: "close", description: "\u5173\u95ED\u5BF9\u8BDD" },
      { command: "open", description: "\u6253\u5F00\u5BF9\u8BDD" },
      { command: "listwords", description: "\u5C4F\u853D\u8BCD\u5217\u8868" },
      { command: "cleanup", description: "\u6E05\u7406\u65E0\u6548\u8BDD\u9898" },
      { command: "synccommands", description: "\u540C\u6B65\u547D\u4EE4\u83DC\u5355" }
    ];
    const res = await tgCall2(env, "setMyCommands", { commands });
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: res?.ok ? ADMIN_COPY.commandsSynced(commands.length) : `\u274C \u540C\u6B65\u5931\u8D25: ${escapeHtml(res?.description || "unknown")}`,
      parse_mode: "HTML"
    });
  }
  async function handleAdminUiCallback(query, env, ctx) {
    const data = String(query.data || "");
    const senderId = query.from?.id;
    try {
      if (!senderId || !await isAdminUser2(env, senderId)) {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: ADMIN_COPY.cbNoPermission,
          show_alert: true
        });
        return;
      }
      const threadId = query.message?.message_thread_id;
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      const parts = data.split(":");
      if (parts[0] === "adm" && parts[1] === "sys") {
        const page = parts[2] || "overview";
        await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: ADMIN_COPY.cbUpdated });
        await handleSysinfoCommand(env, threadId, {
          page: ["overview", "storage", "errors", "stats", "activity"].includes(page) ? page : "overview",
          edit: chatId && messageId ? { chatId, messageId } : null
        });
        return;
      }
      if (parts[0] === "adm" && parts[1] === "nav") {
        const nav = parts[2];
        if (nav === "cleanup_ask") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id });
          await tgCall2(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: threadId,
            text: CLEANUP_CONFIRM_TEXT,
            parse_mode: "HTML",
            reply_markup: buildCleanupConfirmKeyboard()
          });
          return;
        }
        if (nav === "cleanup_ok") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: ADMIN_COPY.cbCleanupStarted });
          if (handleCleanupCommand) {
            if (ctx?.waitUntil) ctx.waitUntil(handleCleanupCommand(threadId, env));
            else await handleCleanupCommand(threadId, env);
          }
          return;
        }
        if (nav === "cleanup_cancel") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: ADMIN_COPY.cbCancelled });
          if (chatId && messageId) {
            await tgCall2(env, "editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: ADMIN_COPY.cleanupCancelled
            });
          }
          return;
        }
        const navHandlers = {
          sysinfo: () => handleSysinfoCommand(env, threadId, { page: "overview" }),
          stats: () => handleStatsCommand(env, threadId),
          rank: () => handleRankCommand(env, threadId),
          activity: () => handleRankCommand(env, threadId),
          notes: () => handleNotesCommand(env, threadId, "/notes"),
          find: async () => {
            await tgCall2(env, "sendMessage", {
              chat_id: env.SUPERGROUP_ID,
              message_thread_id: threadId,
              text: ADMIN_COPY.findNavHelp,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  { text: "\u{1F50E} \u5907\u6CE8\u5217\u8868", callback_data: "adm:nav:notes" },
                  { text: "\u{1F525} \u6D3B\u8DC3", callback_data: "adm:nav:rank" },
                  { text: "\u{1F3E0} \u83DC\u5355", callback_data: "adm:nav:menu" }
                ]]
              }
            });
          },
          whoami: () => handleWhoamiCommand(env, threadId, senderId),
          listwords: () => {
            if (typeof handleListWordsCommand === "function") {
              return handleListWordsCommand(env, threadId);
            }
            return tgCall2(env, "sendMessage", {
              chat_id: env.SUPERGROUP_ID,
              message_thread_id: threadId,
              text: ADMIN_COPY.listWordsUnavailable,
              parse_mode: "HTML"
            });
          },
          help: () => handleHelpCommand(env, threadId, senderId),
          menu: () => handleMenuCommand(env, threadId, senderId),
          synccommands: () => handleSyncCommandsCommand(env, threadId, senderId)
        };
        const navFn = navHandlers[nav];
        if (!navFn) {
          await tgCall2(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: ADMIN_COPY.cbUnknownNav,
            show_alert: true
          });
          return;
        }
        await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id });
        await navFn();
        return;
      }
      if (parts[0] === "adm" && parts[1] === "u" && parts.length >= 4) {
        const action = parts[2];
        const userId = parts[3];
        if (!/^\d{1,20}$/.test(String(userId))) {
          await tgCall2(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: ADMIN_COPY.cbInvalidUserId,
            show_alert: true
          });
          return;
        }
        const tid = await resolveThreadIdForUser2(env, userId) || threadId;
        if (!tid) {
          await tgCall2(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: ADMIN_COPY.cbNoUserTopic,
            show_alert: true
          });
          return;
        }
        const confirmAsk = async (confirmText, keyboard) => {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id });
          await tgCall2(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: tid,
            text: confirmText,
            parse_mode: "HTML",
            reply_markup: keyboard
          });
        };
        const confirmCancel = async (cancelText) => {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: ADMIN_COPY.cbCancelled });
          if (chatId && messageId) {
            await tgCall2(env, "editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: cancelText
            });
          }
        };
        if (action === "banask") {
          await confirmAsk(
            confirmBanText(userId),
            buildBanConfirmKeyboard(userId)
          );
          return;
        }
        if (action === "bancancel") {
          await confirmCancel(dangerCancelText("ban"));
          return;
        }
        if (action === "closeask") {
          await confirmAsk(
            confirmCloseText(userId),
            buildCloseConfirmKeyboard(userId)
          );
          return;
        }
        if (action === "closecancel") {
          await confirmCancel(dangerCancelText("close"));
          return;
        }
        if (action === "resetask") {
          await confirmAsk(
            confirmResetText(userId),
            buildResetConfirmKeyboard(userId)
          );
          return;
        }
        if (action === "resetcancel") {
          await confirmCancel(dangerCancelText("reset"));
          return;
        }
        if (action === "shownote") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id });
          await userActions.note?.(env, tid, userId, "/note");
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
          panel: () => userActions.panel?.(env, tid, userId)
        };
        const fn = map[action];
        if (!fn) {
          await tgCall2(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: ADMIN_COPY.cbUnknownAction,
            show_alert: true
          });
          return;
        }
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: ADMIN_COPY.callbackBusy(action)
        });
        await fn();
        const refreshPanel = [
          "banok",
          "ban",
          "unban",
          "closeok",
          "close",
          "open",
          "mute",
          "unmute",
          "trust",
          "resetok",
          "reset"
        ].includes(action);
        if (refreshPanel && typeof userActions.panel === "function") {
          try {
            await userActions.panel(env, tid, userId);
          } catch (e) {
            try {
              recordSystemError2("admin_panel_refresh_failed", e, { userId }, env);
            } catch {
            }
          }
        }
        return;
      }
      await tgCall2(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: ADMIN_COPY.cbUnknownCallback,
        show_alert: true
      });
    } catch (e) {
      recordSystemError2("admin_ui_callback_failed", e, { data }, env);
      try {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: ADMIN_COPY.cbOperationFailed,
          show_alert: true
        });
      } catch {
      }
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
    handleAdminUiCallback
  };
}

// src/verify-page.js
var VERIFY_SHARED_STYLE = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#f0f2f5;--card:#ffffff;--text:#1a1a1a;--sub:#5b6472;--muted:#9aa3af;
  --accent:#0088cc;--border:#e4e7ec;
  --success-bg:#e8f7ee;--success-text:#0f7a45;
  --error-bg:#fdecec;--error-text:#b42318;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0f172a;--card:#1e293b;--text:#f1f5f9;--sub:#94a3b8;--muted:#64748b;
    --accent:#38bdf8;--border:#334155;
    --success-bg:#0b2e21;--success-text:#4ade80;
    --error-bg:#3b1212;--error-text:#fca5a5;
  }
}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px;padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right));padding-top:max(20px,env(safe-area-inset-top));padding-bottom:max(20px,env(safe-area-inset-bottom));color:var(--text)}
.card{background:var(--card);border-radius:20px;padding:36px 24px 28px;max-width:400px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(15,23,42,0.08);border:1px solid var(--border)}
.icon{font-size:52px;margin-bottom:14px}
h2{color:var(--text);margin-bottom:8px;font-size:20px;font-weight:600}
p.desc{color:var(--sub);font-size:14px;margin-bottom:26px;line-height:1.7}
#back-btn{display:inline-block;margin:20px auto 0;background:var(--accent);color:#fff;border:none;padding:13px 28px;border-radius:12px;font-size:16px;text-decoration:none;font-weight:600;transition:opacity .2s,transform .1s;box-shadow:0 2px 8px rgba(0,136,204,0.3)}
#back-btn:hover{opacity:.92}
#back-btn:focus-visible{outline:3px solid var(--text);outline-offset:3px}
#back-btn:active{transform:scale(.98)}
.footer{margin-top:22px;font-size:11px;color:var(--muted)}
.footer a{color:var(--sub);text-decoration:none}
.footer a:hover{text-decoration:underline}
@media (prefers-reduced-motion: reduce){
  *{animation:none!important;transition:none!important}
  #back-btn:active{transform:none}
}
`;
var VERIFY_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
<meta name="format-detection" content="telephone=no">
<title>\u4EBA\u673A\u9A8C\u8BC1</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>${VERIFY_SHARED_STYLE}
.turnstile-container{display:flex;justify-content:center;margin-bottom:10px;min-height:65px}
#status{display:inline-flex;align-items:center;gap:7px;font-size:13px;line-height:1.5;color:var(--sub);margin-top:14px;padding:9px 16px;border-radius:999px;background:var(--bg);border:1px solid var(--border);min-height:38px;transition:background .2s,color .2s}
#status.success{background:var(--success-bg);color:var(--success-text);border-color:transparent}
#status.error{background:var(--error-bg);color:var(--error-text);border-color:transparent}
.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;display:inline-block;animation:spin .8s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
#tech-wrap{margin-top:18px;text-align:left;font-size:12px;color:var(--muted)}
#tech-wrap summary{cursor:pointer;user-select:none;color:var(--sub)}
#tech-detail{white-space:pre-wrap;word-break:break-all;margin-top:6px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.footer span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.noscript-tip{display:block;margin-top:14px;font-size:13px;line-height:1.6;color:var(--error-text);background:var(--error-bg);padding:10px 16px;border-radius:12px}
</style>
</head>
<body>
<div class="card">
  <div class="icon" aria-hidden="true">\u{1F6E1}\uFE0F</div>
  <h2>\u4EBA\u673A\u9A8C\u8BC1</h2>
  <p class="desc">\u8BF7\u5B8C\u6210\u4E0B\u65B9\u9A8C\u8BC1\u4EE5\u786E\u8BA4\u60A8\u4E0D\u662F\u673A\u5668\u4EBA\u3002<br>\u9A8C\u8BC1\u901A\u8FC7\u540E\u60A8\u7684\u6D88\u606F\u5C06\u81EA\u52A8\u9001\u8FBE\u3002</p>
  <div class="turnstile-container">
    <div class="cf-turnstile" data-sitekey="{{SITE_KEY}}" data-callback="onTurnstileSuccess" data-error-callback="onTurnstileError"></div>
  </div>
  <div id="status" role="status" aria-live="polite" aria-atomic="true"></div>
  <noscript>
    <p class="noscript-tip">\u5F53\u524D\u6D4F\u89C8\u5668\u5DF2\u7981\u7528 JavaScript\uFF0C\u65E0\u6CD5\u5B8C\u6210\u4EBA\u673A\u9A8C\u8BC1\u3002\u8BF7\u542F\u7528 JavaScript \u540E\u5237\u65B0\u672C\u9875\uFF0C\u6216\u6539\u7528\u7CFB\u7EDF\u6D4F\u89C8\u5668\u6253\u5F00\u94FE\u63A5\u3002</p>
  </noscript>
  <a id="back-btn" href="tg://resolve">\u{1F4F1} \u8FD4\u56DE Telegram</a>
  <details id="tech-wrap" hidden>
    <summary>\u6280\u672F\u8BE6\u60C5\uFF08\u6392\u969C\u7528\uFF09</summary>
    <div id="tech-detail"></div>
  </details>
  <div class="footer" data-user-id="{{USER_ID}}" data-code="{{CODE}}" data-worker-url="{{WORKER_URL}}">
    <span id="footer-status">\u79C1\u804A\u7F51\u5173 \xB7 \u4EBA\u673A\u9A8C\u8BC1</span><br>
    <a href="${GATEWAY_REPO}" target="_blank" rel="noopener noreferrer">\u9879\u76EE\u5730\u5740 GitHub \u2197</a>
  </div>
</div>
<script>
// Turnstile \u7EC4\u4EF6\u4E3B\u9898\u8DDF\u968F\u7CFB\u7EDF\u504F\u597D\uFF08\u9700\u5728 widget \u6E32\u67D3\u524D\u8BBE\u7F6E\uFF0C\u5E76\u968F\u7CFB\u7EDF\u5207\u6362\u5B9E\u65F6\u91CD\u5EFA\uFF09
(function(){
  var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  var el = document.querySelector('.cf-turnstile');
  if (!mq) return;
  function applyTheme() {
    var theme = mq.matches ? 'dark' : 'light';
    if (el) el.setAttribute('data-theme', theme);
    // \u5DF2\u9A8C\u8BC1\u6D41\u7A0B\u5F00\u59CB\u540E\u4E0D\u518D\u91CD\u5EFA\uFF0C\u907F\u514D\u6253\u65AD\u7528\u6237\u64CD\u4F5C
    if (window.turnstile && !submitted) {
      try {
        window.turnstile.remove(el);
        window.turnstile.render(el, {
          sitekey: el.getAttribute('data-sitekey'),
          callback: el.getAttribute('data-callback'),
          'error-callback': el.getAttribute('data-error-callback'),
          theme: theme
        });
      } catch (e) { /* \u91CD\u5EFA\u5931\u8D25\u65F6\u4FDD\u6301\u73B0\u72B6\uFF0C\u4E0D\u963B\u585E\u9875\u9762 */ }
    }
  }
  applyTheme();
  if (mq.addEventListener) {
    mq.addEventListener('change', applyTheme);
  } else if (mq.addListener) { // \u65E7 Safari
    mq.addListener(applyTheme);
  }
})();
var submitted = false;
function updateFooter(status) {
  var el = document.getElementById('footer-status');
  if (el) el.textContent = status;
}
function showStatus(msg, cls) {
  var el = document.getElementById('status');
  if (!el) return;
  el.className = cls || '';
  el.innerHTML = '';
  if (cls === 'loading') {
    var sp = document.createElement('span');
    sp.className = 'spinner';
    el.appendChild(sp);
  }
  var t = document.createElement('span');
  t.textContent = msg;
  el.appendChild(t);
  // \u9875\u9762\u6807\u9898\u968F\u72B6\u6001\u66F4\u65B0\uFF0C\u4FBF\u4E8E\u591A\u6807\u7B7E\u9875/\u540E\u53F0\u6392\u969C\u8BC6\u522B
  var titles = { loading: '\u4EBA\u673A\u9A8C\u8BC1\u4E2D', success: '\u2705 \u9A8C\u8BC1\u6210\u529F', error: '\u274C \u9A8C\u8BC1\u5931\u8D25' };
  if (titles[cls]) document.title = titles[cls];
  // \u9875\u811A\u72B6\u6001\u884C\u540C\u6B65\uFF0C\u7ED9\u7528\u6237\u4E00\u4E2A\u300C\u672C\u9875\u53EF\u5173\u95ED\u300D\u7684\u660E\u786E\u4FE1\u53F7
  var footers = { loading: '\u6B63\u5728\u9A8C\u8BC1\u8EAB\u4EFD\u2026', success: '\u9A8C\u8BC1\u5DF2\u5B8C\u6210\uFF0C\u672C\u9875\u53EF\u5173\u95ED', error: '\u9A8C\u8BC1\u672A\u5B8C\u6210\uFF0C\u53EF\u7A0D\u540E\u91CD\u8BD5' };
  if (footers[cls]) updateFooter(footers[cls]);
}
function onTurnstileSuccess(token) {
  if (submitted) return;
  submitted = true;
  showStatus('\u2705 \u9A8C\u8BC1\u901A\u8FC7\uFF0C\u6B63\u5728\u901A\u77E5\u673A\u5668\u4EBA\u2026', 'loading');
  var footer = document.querySelector('.footer');
  var code = footer ? (footer.getAttribute('data-code') || '') : '';
  var userId = footer ? (footer.getAttribute('data-user-id') || '') : '';
  var workerUrl = footer ? (footer.getAttribute('data-worker-url') || '') : '';
  var targetUrl = (workerUrl ? workerUrl : '') + '/verify-callback';
  fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, code: code, userId: userId })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      var msg = '\u2705 \u9A8C\u8BC1\u6210\u529F\uFF01\u8BF7\u8FD4\u56DE Telegram \u7EE7\u7EED\u5BF9\u8BDD\u3002';
      if (data.pendingCount > 0) {
        msg += '\uFF08' + data.pendingCount + ' \u6761\u6D88\u606F\u5C06\u4E8E\u6570\u79D2\u5185\u9001\u8FBE\uFF09';
      }
      showStatus(msg, 'success');
      document.querySelector('.desc').textContent = '\u9A8C\u8BC1\u5B8C\u6210\uFF0C\u8BF7\u8FD4\u56DE Telegram \u67E5\u770B\u673A\u5668\u4EBA\u6D88\u606F\u3002';
      // \u6210\u529F\u540E\u9690\u85CF\u9A8C\u8BC1\u7EC4\u4EF6\uFF0C\u907F\u514D\u7528\u6237\u91CD\u590D\u70B9\u51FB\u6216\u8BEF\u4EE5\u4E3A\u9700\u8981\u518D\u9A8C\u8BC1
      var turnstileContainer = document.querySelector('.turnstile-container');
      if (turnstileContainer) turnstileContainer.style.display = 'none';
      // \u952E\u76D8/\u8BFB\u5C4F\u5668\u7528\u6237\uFF1A\u805A\u7126\u8FD4\u56DE\u6309\u94AE\uFF0C\u76F4\u63A5\u56DE\u8F66\u5373\u53EF\u8FD4\u56DE
      var backBtn = document.getElementById('back-btn');
      if (backBtn) backBtn.focus();
    } else {
      var errMap = {
        'rate_limited': '\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u5019\u518D\u8BD5',
        'turnstile_failed': '\u4EBA\u673A\u9A8C\u8BC1\u672A\u901A\u8FC7\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5',
        'code_invalid_or_expired': '\u9A8C\u8BC1\u94FE\u63A5\u5DF2\u8FC7\u671F\uFF08\u7EA6 {{VERIFY_EXPIRE_MINUTES}} \u5206\u949F\uFF09\uFF0C\u8BF7\u8FD4\u56DE Telegram \u91CD\u65B0\u53D1\u6D88\u606F\u83B7\u53D6\u65B0\u94FE\u63A5',
        'server_not_configured': '\u670D\u52A1\u5668\u672A\u5B8C\u6210\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458',
        // Turnstile siteverify \u5E38\u89C1\u9519\u8BEF\u7801\uFF08\u6765\u81EA error-codes\uFF09\uFF1A
        // https://developers.cloudflare.com/turnstile/troubleshooting/server-side-errors/error-codes/
        'timeout-or-duplicate': '\u9A8C\u8BC1\u4EE4\u724C\u5DF2\u4F7F\u7528\u6216\u8FC7\u671F\uFF0C\u8BF7\u8FD4\u56DE Telegram \u91CD\u65B0\u83B7\u53D6\u94FE\u63A5',
        'invalid-input-secret': '\u670D\u52A1\u5668\u9A8C\u8BC1\u914D\u7F6E\u5F02\u5E38\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458',
        'bad-request': '\u9A8C\u8BC1\u8BF7\u6C42\u5F02\u5E38\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5',
        'missing-input-response': '\u672A\u6536\u5230\u9A8C\u8BC1\u7ED3\u679C\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5',
        'invalid-input-response': '\u9A8C\u8BC1\u7ED3\u679C\u65E0\u6548\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5'
      };
      var errMsg = errMap[data.error] || ('\u9A8C\u8BC1\u5931\u8D25: ' + (data.detail || data.error || '\u672A\u77E5\u9519\u8BEF'));
      showStatus(errMsg, 'error');
      submitted = false;
      if (window.turnstile) {
        window.turnstile.reset();
      }
    }
  })
  .catch(function(e) {
    showStatus('\u274C \u7F51\u7EDC\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u5237\u65B0\u9875\u9762\u91CD\u8BD5', 'error');
    submitted = false;
    if (window.turnstile) {
      window.turnstile.reset();
    }
  });
}
function onTurnstileError(errorCode) {
  // \u7528\u6237\u4FA7\u53EA\u5C55\u793A\u53CB\u597D\u63D0\u793A\uFF1B\u7BA1\u7406\u5458\u6392\u969C\u6240\u9700\u7684\u9519\u8BEF\u7801\u4E0E\u4FEE\u590D\u5EFA\u8BAE\u6298\u53E0\u5728\u300C\u6280\u672F\u8BE6\u60C5\u300D\u4E2D\uFF0C
  // \u907F\u514D\u5411\u666E\u901A\u7528\u6237\u66B4\u9732\u90E8\u7F72\u7EC6\u8282\uFF08\u57DF\u540D\u6388\u6743\u3001Site Key \u7B49\uFF09\u3002
  // Turnstile \u5BA2\u6237\u7AEF\u9519\u8BEF\u7801\uFF1Ahttps://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/
  var code = (errorCode == null || errorCode === '') ? '' : String(errorCode);
  var hint = '';
  if (code === '110200') {
    hint = '\u57DF\u540D\u672A\u6388\u6743\uFF1A\u8BF7\u5728 Cloudflare Turnstile \u2192 Hostname \u4E2D\u6DFB\u52A0\u5F53\u524D Worker \u57DF\u540D\uFF0C\u5982 xxx.workers.dev';
  } else if (code === '110110') {
    hint = 'Site Key \u65E0\u6548\uFF1A\u8BF7\u68C0\u67E5 Dashboard \u4E2D\u7684 TURNSTILE_SITE_KEY';
  } else if (code === '110600') {
    hint = '\u6311\u6218\u8D85\u65F6\uFF1A\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\uFF1B\u82E5\u5728 Telegram \u5185\u7F6E\u6D4F\u89C8\u5668\u5931\u8D25\uFF0C\u53EF\u6539\u7528\u7CFB\u7EDF\u6D4F\u89C8\u5668\u6253\u5F00\u94FE\u63A5';
  } else if (code === '300030' || code === '300031') {
    hint = '\u7EC4\u4EF6\u521D\u59CB\u5316\u5931\u8D25\uFF1A\u591A\u4E3A CSP/\u7F51\u7EDC\u62E6\u622A challenges.cloudflare.com';
  } else if (!code) {
    hint = '\u65E0\u6CD5\u52A0\u8F7D challenges.cloudflare.com\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC/\u4EE3\u7406/\u5730\u533A\u8BBF\u95EE';
  }
  showStatus('\u26A0\uFE0F \u9A8C\u8BC1\u7EC4\u4EF6\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5\uFF1B\u82E5\u591A\u6B21\u5931\u8D25\uFF0C\u8BF7\u8FD4\u56DE Telegram \u91CD\u65B0\u83B7\u53D6\u94FE\u63A5\u3002', 'error');
  var wrap = document.getElementById('tech-wrap');
  var detailEl = document.getElementById('tech-detail');
  if (wrap && detailEl) {
    // \u6CE8\u610F\uFF1A\u672C\u6A21\u677F\u662F JS \u6A21\u677F\u5B57\u9762\u91CF\uFF0C\u811A\u672C\u5185\u9700\u8981\u5B57\u9762\u6362\u884C\u8F6C\u4E49\u65F6\u5FC5\u987B\u53CC\u5199\u53CD\u659C\u6760\uFF0C\u5426\u5219\u6E32\u67D3\u8F93\u51FA\u4E3A\u771F\u5B9E\u6362\u884C\u5BFC\u81F4 SyntaxError
    detailEl.textContent = (code ? '\u9519\u8BEF\u7801: ' + code + '\\n' : '') + (hint || '\u672A\u77E5\u9519\u8BEF');
    wrap.hidden = false;
  }
}
// \u521D\u59CB\u52A0\u8F7D\u72B6\u6001\uFF1A\u811A\u672C\u672A\u5C31\u7EEA\u65F6\u663E\u793A\u52A0\u8F7D\u52A8\u753B\uFF08\u533A\u5206\u811A\u672C\u88AB\u5899\u4E0E widget \u914D\u7F6E\u9519\u8BEF\uFF09
showStatus('\u6B63\u5728\u52A0\u8F7D\u9A8C\u8BC1\u7EC4\u4EF6\u2026', 'loading');
// \u811A\u672C\u957F\u65F6\u95F4\u672A\u5C31\u7EEA\u65F6\u7ED9\u51FA\u63D0\u793A\uFF08\u533A\u5206\u811A\u672C\u88AB\u5899\u4E0E widget \u914D\u7F6E\u9519\u8BEF\uFF09
setTimeout(function() {
  if (!window.turnstile && !submitted) {
    showStatus('\u26A0\uFE0F \u672A\u80FD\u52A0\u8F7D Turnstile \u811A\u672C\uFF08challenges.cloudflare.com\uFF09\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\uFF0C\u6216\u8BA9\u7BA1\u7406\u5458\u6682\u65F6\u5173\u95ED TURNSTILE_* \u53D8\u91CF\u4EE5\u4F7F\u7528\u672C\u5730\u9898\u5E93\u9A8C\u8BC1\u3002', 'error');
  }
}, 8000);
</script>
</body>
</html>`;
function renderVerifyPage({ siteKey, code, userId, workerUrl, verifyExpireMinutes }) {
  const expireMinutes = Number(verifyExpireMinutes) > 0 ? Math.round(Number(verifyExpireMinutes)) : 10;
  return VERIFY_PAGE_HTML.replace(/{{SITE_KEY}}/g, escapeHtml(siteKey)).replace(/{{CODE}}/g, escapeHtml(code)).replace(/{{USER_ID}}/g, escapeHtml(userId)).replace(/{{WORKER_URL}}/g, escapeHtml(workerUrl)).replace(/{{VERIFY_EXPIRE_MINUTES}}/g, String(expireMinutes));
}
var VERIFY_ERROR_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
<meta name="format-detection" content="telephone=no">
<title>\u9A8C\u8BC1\u4E0D\u53EF\u7528</title>
<style>${VERIFY_SHARED_STYLE}
.error{display:inline-flex;align-items:center;gap:7px;font-size:13px;line-height:1.5;color:var(--error-text);margin-top:14px;padding:9px 16px;border-radius:999px;background:var(--error-bg);border:1px solid transparent}
</style>
</head>
<body>
<div class="card">
  <div class="icon" aria-hidden="true">\u26A0\uFE0F</div>
  <h2>\u9A8C\u8BC1\u4E0D\u53EF\u7528</h2>
  <p class="desc">{{DESC}}</p>
  <div class="error">\u274C \u65E0\u6CD5\u7EE7\u7EED\u9A8C\u8BC1</div>
  <a id="back-btn" href="tg://resolve">\u{1F4F1} \u8FD4\u56DE Telegram</a>
  <div class="footer">\u79C1\u804A\u7F51\u5173 \xB7 \u4EBA\u673A\u9A8C\u8BC1<br>
    <a href="${GATEWAY_REPO}" target="_blank" rel="noopener noreferrer">\u9879\u76EE\u5730\u5740 GitHub \u2197</a>
  </div>
</div>
</body>
</html>`;
function renderVerifyErrorPage({ message = "\u9A8C\u8BC1\u94FE\u63A5\u65E0\u6548\u6216\u5DF2\u5931\u6548\u3002", hint = "" } = {}) {
  const desc = [escapeHtml(message), escapeHtml(hint)].filter(Boolean).join("<br>");
  return VERIFY_ERROR_PAGE_HTML.replace(/{{DESC}}/g, desc);
}

// worker.js
var CONFIG = {
  VERIFY_ID_LENGTH: 12,
  VERIFY_EXPIRE_SECONDS: 300,
  // 5分钟
  VERIFIED_EXPIRE_SECONDS: 2592e3,
  // 30天
  MEDIA_GROUP_EXPIRE_SECONDS: 60,
  MEDIA_GROUP_DELAY_MS: 3e3,
  // 3秒（从2秒增加）
  PENDING_MAX_MESSAGES: 10,
  // 验证期间最多暂存的消息数
  ADMIN_CACHE_TTL_SECONDS: 300,
  // 管理员权限缓存 5 分钟
  NEEDS_REVERIFY_TTL_SECONDS: 600,
  // 标记需重新验证的 TTL（用于并发兜底）
  RATE_LIMIT_MESSAGE: 45,
  RATE_LIMIT_VERIFY: 3,
  RATE_LIMIT_WINDOW: 60,
  RATE_LIMIT_VERIFY_CALLBACK: 15,
  // verify-callback IP 限流：15 次/分钟
  BUTTON_COLUMNS: 2,
  MAX_TITLE_LENGTH: 128,
  MAX_NAME_LENGTH: 30,
  API_TIMEOUT_MS: 1e4,
  CLEANUP_BATCH_SIZE: 10,
  MAX_CLEANUP_DISPLAY: 20,
  CLEANUP_LOCK_TTL_SECONDS: 1800,
  // /cleanup 防并发锁 30 分钟
  MAX_RETRY_ATTEMPTS: 3,
  THREAD_HEALTH_TTL_MS: 6e4,
  // PR #12: Turnstile 和垃圾检测配置
  TURNSTILE_VERIFY_TTL: 600,
  // Turnstile 验证 code 有效期 10 分钟
  NEW_USER_LINK_BLOCK_SECONDS: 86400,
  // 新用户 24 小时内禁止发链接
  SPAM_MESSAGE_HASH_TTL: 3600,
  // 消息去重 hash 缓存 1 小时
  SPAM_REPEAT_MESSAGE_LIMIT: 3,
  // 相同内容重复次数阈值
  SPAM_NOTIFY_ADMIN: true,
  // 是否通知管理员有骚扰消息
  SPAM_SILENCE_MODE: false,
  // 静默丢弃模式（不通知管理员）
  ALERT_THROTTLE_MS: 6e4,
  // 管理告警节流：同类型 60 秒内最多一条
  WORD_MAX_LENGTH: 50,
  // /addword 单词长度上限，防 KV 词库被超长输入污染
  MEDIA_GROUP_CLEANUP_PROBABILITY: 0.05,
  // 过期媒体组扫描概率：键自带 60s TTL，孤儿键极少，无需每条消息全量扫 KV
  RETRY_COUNT_TTL_SECONDS: 3600
  // 话题健康重试计数有效期：超过即视为从未失败，避免历史失败永久生效
};
var GATEWAY_VERSION = "1.4.0";
var TOPIC_TITLE_PLACEHOLDER = "User";
var HOURLY_NOTICE_TTL_SECONDS = 3600;
var threadHealthCache = /* @__PURE__ */ new Map();
var topicCreateInFlight = /* @__PURE__ */ new Map();
var adminStatusCache = /* @__PURE__ */ new Map();
var threadNotFoundCache = /* @__PURE__ */ new Map();
var threadMappingCache = /* @__PURE__ */ new Map();
var THREAD_MAPPING_CACHE_TTL_MS = 10 * 60 * 1e3;
var THREAD_MAPPING_CACHE_MAX_ENTRIES = 2e3;
var ruleCache = /* @__PURE__ */ new WeakMap();
var THREAD_NOT_FOUND_TTL_MS = 5 * 60 * 1e3;
var THREAD_NOT_FOUND_MAX_ENTRIES = 1e3;
var ADMIN_STATUS_MAX_ENTRIES = 1e3;
var THREAD_HEALTH_MAX_ENTRIES = 1e3;
var TOPIC_SCAN_MAX_PAGES = 20;
var TOPIC_LOCK_RETRY_DELAYS_MS = [150, 225, 300];
function setBoundedCache(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}
var Logger = createLogger({}, console, {
  onError: (action, error, data = {}) => {
    try {
      recordSystemError(action, error, data, data?.env || null);
    } catch {
    }
  }
});
var RECENT_SYSTEM_ERRORS_MAX = 12;
var recentSystemErrors = [];
var systemErrorKvThrottle = createThrottle({ windowMs: 3e4 });
function recordSystemError(action, error, data = {}, env = null) {
  const entry = normalizeRecentErrorItem({
    ts: Date.now(),
    action,
    error: error instanceof Error ? error.message : String(error ?? ""),
    userId: data?.userId,
    updateId: data?.updateId,
    correlationId: data?.correlationId
  });
  recentSystemErrors.unshift(entry);
  if (recentSystemErrors.length > RECENT_SYSTEM_ERRORS_MAX) {
    recentSystemErrors.length = RECENT_SYSTEM_ERRORS_MAX;
  }
  if (env?.TOPIC_MAP && systemErrorKvThrottle("sys:recent_errors")) {
    Promise.resolve().then(async () => {
      let list = [];
      try {
        const raw = await env.TOPIC_MAP.get("sys:recent_errors");
        if (raw) list = JSON.parse(raw);
      } catch {
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      list = list.map(normalizeRecentErrorItem).filter(Boolean);
      list.unshift(entry);
      await env.TOPIC_MAP.put(
        "sys:recent_errors",
        JSON.stringify(list.slice(0, RECENT_SYSTEM_ERRORS_MAX)),
        { expirationTtl: 7 * 24 * 3600 }
      );
    }).catch(() => {
    });
  }
}
var adminActions = createAdminActions({
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
  logger: Logger
});
var verificationModule = createVerificationModule({
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
  logger: Logger
});
var mediaGroup = createMediaGroupModule({
  config: CONFIG,
  tgCall,
  safeGetJSON,
  logger: Logger
});
var spamModule = createSpamModule({
  config: CONFIG,
  logger: Logger,
  escapeHtml,
  adminCopy: ADMIN_COPY,
  safeGetJSON,
  tgCall,
  getVerificationTimestamp: (env, userId) => ephemeralStore(env).getVerificationTimestamp(userId),
  setBoundedCache
});
var {
  spamCheck,
  handleSpamMessage,
  pruneMessageHashCache
} = spamModule;
var adminHandlers = createAdminCommandHandlers({
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
  userActions: adminActions
});
function ephemeralStore(env) {
  return createEphemeralStore(env.TOPIC_MAP);
}
async function getVerificationState(env, userId) {
  const temporary = await ephemeralStore(env).getVerification(userId);
  if (temporary?.type === "temporary") return temporary;
  const persistent = env.TG_BOT_DB ? await createD1Storage(env.TG_BOT_DB).getUser(userId) : null;
  if (persistent?.trustLevel === "trusted") return { type: "trusted" };
  if (temporary?.type === "legacy_trusted" && env.TG_BOT_DB) {
    await setPersistentTrust(env, userId, "trusted");
    return { type: "trusted" };
  }
  return temporary;
}
async function getStoredRules(env) {
  if (!env.TG_BOT_DB) return [];
  const cached = ruleCache.get(env.TG_BOT_DB);
  const now = Date.now();
  if (cached && now - cached.ts < 3e4) return cached.rules;
  const rules = await createD1Storage(env.TG_BOT_DB).listEnabledRules();
  ruleCache.set(env.TG_BOT_DB, { ts: now, rules });
  return rules;
}
async function evaluateLegacyPolicy(env, message, user = {}) {
  const [blockedWords, verification, storedRules] = await Promise.all([
    getBlockedWords(env, false, Logger),
    getVerificationState(env, user.userId ?? message.chat?.id),
    getStoredRules(env)
  ]);
  const rules = buildLegacyBlockedRules(blockedWords);
  return evaluateMessagePolicy({
    message,
    user: {
      ...user,
      status: user.status || "active",
      trustLevel: user.trustLevel || (verification?.type === "trusted" ? "trusted" : "normal")
    },
    verification,
    rules: [...rules, ...storedRules]
  });
}
function createLegacyConversationService(env) {
  return createConversationService({
    storage: createD1Storage(env.TG_BOT_DB),
    telegram: { call: (method, body) => tgCall(env, method, body) },
    policy: ({ message, user }) => evaluateLegacyPolicy(env, message, user)
  });
}
var idAllowlistParseCache = /* @__PURE__ */ new Map();
var ID_ALLOWLIST_CACHE_MAX = 64;
function parseIdAllowlistSet(raw) {
  const key = String(raw || "");
  let set = idAllowlistParseCache.get(key);
  if (!set) {
    set = new Set(
      key.split(/[,;\s]+/g).map((value) => value.trim()).filter((value) => /^\d{1,20}$/.test(value))
    );
    if (idAllowlistParseCache.size >= ID_ALLOWLIST_CACHE_MAX) {
      idAllowlistParseCache.delete(idAllowlistParseCache.keys().next().value);
    }
    idAllowlistParseCache.set(key, set);
  }
  return set;
}
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
    onRulesChanged: () => ruleCache.delete(env.TG_BOT_DB)
  });
}
async function setPersistentTrust(env, userId, trustLevel) {
  if (!env.TG_BOT_DB) throw new Error("D1 'TG_BOT_DB' not bound");
  const d1Storage = createD1Storage(env.TG_BOT_DB);
  const existing = await d1Storage.getUser(userId) || await readLegacyKvUser(env, userId) || { userId: String(userId) };
  await d1Storage.upsertUser({ ...existing, userId: String(userId), trustLevel });
  await ephemeralStore(env).clearVerification(userId);
}
async function readLegacyKvUser(env, userId) {
  const rec = await safeGetJSON(env, `user:${userId}`, null);
  if (!rec || typeof rec !== "object") return null;
  return {
    userId: String(userId),
    username: rec.username ?? null,
    firstName: rec.first_name ?? null,
    lastName: rec.last_name ?? null,
    topicId: rec.thread_id == null ? null : String(rec.thread_id)
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
    updatedAt: Date.now()
  });
}
function secureRandomInt(min, max) {
  const range = max - min;
  if (range <= 0) return min;
  const limit = Math.floor(4294967296 / range) * range;
  const bytes = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(bytes);
    value = bytes[0];
  } while (value >= limit);
  return min + value % range;
}
async function safeGetJSON(env, key, defaultValue = null) {
  try {
    const data = await env.TOPIC_MAP.get(key, { type: "json" });
    if (data === null || data === void 0) {
      return defaultValue;
    }
    if (typeof data !== "object") {
      Logger.warn("kv_invalid_type", { key, type: typeof data });
      return defaultValue;
    }
    return data;
  } catch (e) {
    Logger.error("kv_parse_failed", e, { key });
    return defaultValue;
  }
}
function verifyJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
function isSparseTelegramFrom(from) {
  if (!from || typeof from !== "object") return true;
  const hasName = Boolean(String(from.first_name || "").trim() || String(from.last_name || "").trim());
  const hasUsername = Boolean(String(from.username || "").trim());
  return !hasName && !hasUsername;
}
var profileSnapshotCache = /* @__PURE__ */ new Map();
var PROFILE_SNAPSHOT_TTL_MS = 5 * 60 * 1e3;
var PROFILE_SNAPSHOT_MAX_ENTRIES = 2e3;
function profileFingerprint(from) {
  return [from.first_name || "", from.last_name || "", from.username || ""].join("");
}
async function saveUserProfileSnapshot(env, userId, from) {
  if (!env?.TOPIC_MAP || !userId || isSparseTelegramFrom(from)) return;
  const fingerprint = profileFingerprint(from);
  const now = Date.now();
  const cached = profileSnapshotCache.get(String(userId));
  if (cached && cached.fingerprint === fingerprint && now - cached.ts < PROFILE_SNAPSHOT_TTL_MS) {
    return;
  }
  try {
    await env.TOPIC_MAP.put(`profile:${userId}`, JSON.stringify({
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      username: from.username || null,
      saved_at: Date.now()
    }), { expirationTtl: 30 * 24 * 3600 });
    setBoundedCache(profileSnapshotCache, String(userId), { fingerprint, ts: now }, PROFILE_SNAPSHOT_MAX_ENTRIES);
  } catch (e) {
    Logger.warn("profile_snapshot_save_failed", { userId, error: e?.message });
  }
}
async function resolveUserFromForTopic(env, userId, from) {
  if (!isSparseTelegramFrom(from)) {
    return {
      id: Number(from.id ?? userId),
      first_name: from.first_name || "",
      last_name: from.last_name || "",
      username: from.username || ""
    };
  }
  try {
    const raw = await env.TOPIC_MAP?.get(`profile:${userId}`);
    if (raw) {
      const snap = JSON.parse(raw);
      if (!isSparseTelegramFrom(snap)) {
        return {
          id: Number(userId),
          first_name: snap.first_name || "",
          last_name: snap.last_name || "",
          username: snap.username || ""
        };
      }
    }
  } catch {
  }
  if (env.TG_BOT_DB) {
    try {
      const user = await createD1Storage(env.TG_BOT_DB).getUser(userId);
      if (user && (user.firstName || user.lastName || user.username)) {
        return {
          id: Number(userId),
          first_name: user.firstName || "",
          last_name: user.lastName || "",
          username: user.username || ""
        };
      }
    } catch {
    }
  }
  try {
    const res = await tgCall(env, "getChat", { chat_id: userId });
    if (res?.ok && res.result) {
      const chat = res.result;
      const resolved = {
        id: Number(userId),
        first_name: chat.first_name || "",
        last_name: chat.last_name || "",
        username: chat.username || ""
      };
      if (!isSparseTelegramFrom(resolved)) {
        await saveUserProfileSnapshot(env, userId, resolved);
        return resolved;
      }
    }
  } catch {
  }
  return {
    id: Number(from?.id ?? userId),
    first_name: from?.first_name || "",
    last_name: from?.last_name || "",
    username: from?.username || ""
  };
}
async function getOrCreateUserTopicRec(from, key, env, userId) {
  const existing = await safeGetJSON(env, key, null);
  if (existing && existing.thread_id) return existing;
  const inflight = topicCreateInFlight.get(String(userId));
  if (inflight) return await inflight;
  const p = (async () => {
    const again = await safeGetJSON(env, key, null);
    if (again && again.thread_id) return again;
    const resolvedFrom = await resolveUserFromForTopic(env, userId, from);
    await saveUserProfileSnapshot(env, userId, resolvedFrom);
    const storage = createD1Storage(env.TG_BOT_DB);
    let user = await storage.getUser(userId);
    if (!user) {
      user = await storage.ensureUser({
        userId: String(userId),
        username: resolvedFrom?.username || null,
        firstName: resolvedFrom?.first_name || null,
        lastName: resolvedFrom?.last_name || null
      });
    } else if (isSparseTelegramFrom({
      first_name: user.firstName,
      last_name: user.lastName,
      username: user.username
    }) && !isSparseTelegramFrom(resolvedFrom)) {
      try {
        await storage.updateUserState(userId, {
          username: resolvedFrom.username || null,
          firstName: resolvedFrom.first_name || null,
          lastName: resolvedFrom.last_name || null
        });
      } catch {
      }
    }
    if (user?.topicId) {
      const rec = { thread_id: user.topicId, title: buildTopicTitle(resolvedFrom), closed: false };
      await env.TOPIC_MAP.put(key, JSON.stringify(rec));
      await env.TOPIC_MAP.put(`thread:${user.topicId}`, String(userId));
      return rec;
    }
    const token = secureRandomId(20);
    const acquired = await storage.acquireTopicLock(userId, token, Date.now(), 3e4);
    if (acquired) {
      try {
        const rec = await createTopic(resolvedFrom, key, env, userId);
        const saved = await storage.setTopic(userId, rec.thread_id, token, Date.now());
        if (!saved) throw new Error("Topic \u9501\u6240\u6709\u6743\u5DF2\u4E22\u5931");
        return rec;
      } finally {
        await storage.releaseTopicLock(userId, token, Date.now());
      }
    }
    for (const delay of TOPIC_LOCK_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const refreshed = await storage.getUser(userId);
      if (refreshed?.topicId) {
        const rec = { thread_id: refreshed.topicId, title: buildTopicTitle(resolvedFrom), closed: false };
        await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        await env.TOPIC_MAP.put(`thread:${refreshed.topicId}`, String(userId));
        return rec;
      }
    }
    throw Object.assign(new Error("Topic \u521B\u5EFA\u9501\u7E41\u5FD9"), {
      category: "topic_lock_busy",
      retryable: true
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
      text: "\u{1F50E}"
    });
    const actualThreadId = res.result?.message_thread_id;
    const probeMessageId = res.result?.message_id;
    if (res.ok && probeMessageId) {
      try {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: probeMessageId
        });
      } catch (e) {
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
    if (actualThreadId === void 0 || actualThreadId === null) {
      return { status: "missing_thread_id" };
    }
    if (Number(actualThreadId) !== Number(expectedThreadId)) {
      return { status: "redirected", actualThreadId };
    }
    return { status: "ok" };
  };
  const first = await attemptOnce();
  if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;
  const second = await attemptOnce();
  if (second.status === "missing_thread_id") {
    Logger.warn("thread_probe_missing_thread_id", { userId, expectedThreadId, reason });
  }
  return second;
}
async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason }) {
  await setPersistentTrust(env, userId, "normal");
  await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
  await env.TOPIC_MAP.delete(`retry:${userId}`);
  if (userKey) {
    await env.TOPIC_MAP.delete(userKey);
  }
  if (oldThreadId !== void 0 && oldThreadId !== null) {
    await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
    await ephemeralStore(env).clearTopicHealth(oldThreadId);
    threadHealthCache.delete(oldThreadId);
  }
  Logger.info("verification_reset_due_to_topic_loss", {
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
  if (idAllowlistHas(env.OWNER_IDS, userId)) return true;
  const allowlist = parseAdminIdAllowlist(env);
  if (allowlist && allowlist.has(String(userId))) return true;
  const cacheKey = String(userId);
  const now = Date.now();
  const cached = adminStatusCache.get(cacheKey);
  if (cached && now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1e3) {
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
    Logger.warn("admin_check_failed", { userId, error: e?.message });
    return false;
  }
}
async function getAllKeys(env, prefix, maxPages = 0) {
  const allKeys = [];
  let cursor = void 0;
  let pages = 0;
  do {
    const result = await env.TOPIC_MAP.list({ prefix, cursor });
    allKeys.push(...result.keys);
    cursor = result.list_complete ? void 0 : result.cursor;
    pages += 1;
  } while (cursor && (maxPages <= 0 || pages < maxPages));
  return allKeys;
}
function shuffleArray(arr) {
  const array = [...arr];
  for (let i = array.length - 1; i > 0; i--) {
    const j = secureRandomInt(0, i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
async function checkRateLimit(userId, env, action = "message", limit = 20, window = 60) {
  return ephemeralStore(env).checkRateLimit(userId, action, limit, window);
}
var legacyApp = {
  /**
   * 业务层 HTTP 入口。
   * @param {Request} request
   * @param {object} env - 已由 app.js normalize 的 env
   * @param {object} ctx
   * @param {object|null} [parsedUpdate] - POST / 的 webhook update 由 app.js 解析后透传，
   *   避免此处二次读取请求体（GET /verify 与 POST /verify-callback 仍自行处理）
   */
  async fetch(request, env, ctx, parsedUpdate = null) {
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");
    const normalizedEnv = env;
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
      return new Response("Error: SUPERGROUP_ID must start with -100");
    }
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response("OK", {
          headers: { "Cache-Control": "no-store" }
        });
      }
      if (url.pathname === "/verify" || url.pathname.endsWith("/verify")) {
        const code = url.searchParams.get("code");
        const userId = url.searchParams.get("uid");
        const siteKey = (env.TURNSTILE_SITE_KEY || "").toString().trim();
        if (!code || !userId || !siteKey || !/^\d{1,20}$/.test(userId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(code)) {
          const hint = siteKey ? VERIFY_COPY.pageErrorMissingParams.hintResend : VERIFY_COPY.pageErrorMissingParams.hintNoSiteKey;
          return new Response(renderVerifyErrorPage({
            message: VERIFY_COPY.pageErrorMissingParams.message,
            hint
          }), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer"
            }
          });
        }
        const workerUrl = url.origin;
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
          "frame-ancestors 'none'"
        ].join("; ");
        return new Response(
          renderVerifyPage({
            siteKey,
            code,
            userId,
            workerUrl,
            // 过期提示分钟数对齐 TURNSTILE_VERIFY_TTL，避免页面文案与后端有效期漂移
            verifyExpireMinutes: CONFIG.TURNSTILE_VERIFY_TTL / 60
          }),
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              // 验证链接单次有效：禁用一切缓存，防止浏览器/Telegram 内置浏览器复用旧页面
              "Cache-Control": "no-store",
              "Content-Security-Policy": csp,
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer"
            }
          }
        );
      }
      return new Response("Not Found", { status: 404 });
    }
    if ((url.pathname === "/verify-callback" || url.pathname.endsWith("/verify-callback")) && request.method === "POST") {
      const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
      const ipRateLimit = await checkRateLimit(clientIp, env, "verify_cb_ip", CONFIG.RATE_LIMIT_VERIFY_CALLBACK, 60);
      if (!ipRateLimit.allowed) {
        Logger.warn("turnstile_callback_rate_limited", { clientIp });
        return verifyJsonResponse({ success: false, error: "rate_limited" }, 429);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return verifyJsonResponse({ success: false, error: "invalid_json" }, 400);
      }
      try {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return verifyJsonResponse({ success: false, error: "missing_params" }, 400);
        }
        const { token, code, userId } = body;
        if (typeof token !== "string" || token.trim() === "" || token.length > 2048 || typeof code !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(code) || typeof userId !== "string" && typeof userId !== "number" || !/^\d{1,20}$/.test(String(userId))) {
          return verifyJsonResponse({ success: false, error: "missing_params" }, 400);
        }
        const turnstileSecret = (env.TURNSTILE_SECRET_KEY || "").toString().trim();
        if (!turnstileSecret) {
          return verifyJsonResponse({ success: false, error: "server_not_configured" }, 500);
        }
        const verifyResult = await verificationModule.verifyTurnstileToken(token, turnstileSecret);
        if (!verifyResult.success) {
          Logger.warn("turnstile_token_invalid", { userId, error: verifyResult.error });
          return verifyJsonResponse({ success: false, error: "turnstile_failed", detail: verifyResult.error }, 403);
        }
        const storedUserId = await env.TOPIC_MAP.get(`turnstile_code:${code}`);
        if (!storedUserId || storedUserId !== String(userId)) {
          if (storedUserId) {
            await env.TOPIC_MAP.delete(`turnstile_code:${code}`);
            Logger.warn("turnstile_code_mismatch_cleared", { userId, storedUserId, clientIp });
          }
          return verifyJsonResponse({ success: false, error: "code_invalid_or_expired" }, 403);
        }
        await ephemeralStore(env).setVerification(userId, {
          ttl: CONFIG.VERIFIED_EXPIRE_SECONDS,
          verifiedAt: Date.now()
        });
        await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        await env.TOPIC_MAP.delete(`turnstile_code:${code}`);
        await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
        Logger.info("turnstile_verification_success", { userId });
        await bumpDailyStat(normalizedEnv, "verifies", 1);
        const verifyMsgId = await env.TOPIC_MAP.get(`turnstile_msg:${code}`);
        ctx.waitUntil((async () => {
          if (verifyMsgId) {
            try {
              await tgCall(normalizedEnv, "deleteMessage", {
                chat_id: Number(userId),
                message_id: parseInt(verifyMsgId, 10)
              });
            } catch (e) {
            }
            await env.TOPIC_MAP.delete(`turnstile_msg:${code}`);
          }
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: Number(userId),
            text: VERIFY_COPY.successBody,
            parse_mode: "HTML"
          });
        })());
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
                  Logger.error("pending_turnstile_forward_failed", e, { userId });
                }
                await env.TOPIC_MAP.delete(pendingKey);
              })());
            }
          } catch (e) {
            Logger.error("pending_turnstile_parse_failed", e, { userId });
          }
        }
        return verifyJsonResponse({ success: true, pendingCount });
      } catch (e) {
        Logger.error("verify_callback_error", e);
        return verifyJsonResponse({ success: false, error: "server_error" }, 500);
      }
    }
    let update = parsedUpdate;
    if (update === null || update === void 0 || typeof update !== "object") {
      Logger.warn("invalid_update_payload", {
        hasUpdate: update !== null && update !== void 0
      });
      return new Response("Bad Request", { status: 400 });
    }
    if (update.edited_message) {
      const handleUpdate = createUpdateHandler({
        conversation: createLegacyConversationService(normalizedEnv),
        supergroupId: normalizedEnv.SUPERGROUP_ID
      });
      await handleUpdate(update);
      return new Response("OK");
    }
    if (update.callback_query) {
      const cbData = String(update.callback_query.data || "");
      if (cbData.startsWith("adm:")) {
        await adminHandlers.handleAdminUiCallback(update.callback_query, normalizedEnv, ctx);
      } else if (cbData.startsWith("v1:")) {
        await createLegacyAdminService(normalizedEnv).handleCallbackQuery(update.callback_query);
      } else {
        await verificationModule.handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      }
      return new Response("OK");
    }
    const msg = update.message;
    if (!msg) return new Response("OK");
    if (Math.random() < CONFIG.MEDIA_GROUP_CLEANUP_PROBABILITY) {
      ctx.waitUntil(mediaGroup.flushExpiredMediaGroups(normalizedEnv, Date.now()));
    }
    if (Math.random() < 0.01) {
      pruneMessageHashCache(Date.now());
    }
    if (msg.chat && msg.chat.type === "private") {
      try {
        const ptext = removeCommandBotSuffix((msg.text || "").trim());
        if (ptext === "/help") {
          const rateLimitMinutes = Math.max(1, Math.round(CONFIG.RATE_LIMIT_WINDOW / 60));
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: msg.chat.id,
            text: USER_COPY.helpText(rateLimitMinutes),
            parse_mode: "HTML"
          });
          return new Response("OK");
        }
        if (ptext === "/start" || ptext === "/cancel") {
          const adminResult = await createLegacyAdminService(normalizedEnv).handlePrivateAdminMessage(msg);
          if (adminResult.status === "menu" || adminResult.status === "cancelled") {
            return new Response("OK");
          }
        }
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        try {
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: msg.chat.id,
            text: USER_COPY.systemBusy
          });
        } catch (notifyError) {
          Logger.warn("system_busy_notify_failed", { userId: msg.chat.id, error: notifyError?.message });
        }
        Logger.error("private_message_failed", e, {
          userId: msg.chat.id,
          updateId: update?.update_id
        });
      }
      return new Response("OK");
    }
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
      if (msg.forum_topic_closed && msg.message_thread_id) {
        await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
        return new Response("OK");
      }
      if (msg.forum_topic_reopened && msg.message_thread_id) {
        await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
        return new Response("OK");
      }
      const text = (msg.text || "").trim();
      const isCommand = !!text && text.startsWith("/");
      if (msg.message_thread_id || isCommand) {
        await handleAdminReply(msg, normalizedEnv, ctx, update?.update_id);
        return new Response("OK");
      }
    }
    return new Response("OK");
  }
};
async function sendHourlyNotice(env, userId, kvKey, text) {
  try {
    if (await env.TOPIC_MAP.get(kvKey)) return false;
    await tgCall(env, "sendMessage", { chat_id: userId, text });
    await env.TOPIC_MAP.put(kvKey, "1", { expirationTtl: HOURLY_NOTICE_TTL_SECONDS });
    return true;
  } catch (e) {
    Logger.warn("hourly_notice_failed", { userId, noticeKey: kvKey, error: e?.message });
    return false;
  }
}
async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;
  const rateLimit = await checkRateLimit(userId, env, "message", CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.rateLimited(Math.max(1, Math.round(CONFIG.RATE_LIMIT_WINDOW / 60)))
    });
    return;
  }
  await saveUserProfileSnapshot(env, userId, msg.from);
  const privateCommand = removeCommandBotSuffix((msg.text || "").trim());
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
    env.TOPIC_MAP.get(`muted:${userId}`)
  ]);
  const policyResult = await evaluateLegacyPolicy(env, msg, {
    userId,
    status: isBanned ? "banned" : "active"
  });
  if (policyResult.reason === "banned") {
    await sendHourlyNotice(env, userId, noticeKey.ban(userId), USER_COPY.bannedHourly);
    return;
  }
  if (isMuted) {
    await sendHourlyNotice(env, userId, noticeKey.mute(userId), USER_COPY.mutedHourly);
    return;
  }
  if (policyResult.reason === "blocked_keyword") {
    const ruleId2 = policyResult.matchedRuleId || "";
    let word = ruleId2;
    if (ruleId2.startsWith("legacy_blocked:")) {
      const matchedIndex = Number(ruleId2.split(":")[1]);
      const blockedWords = await getBlockedWords(env, false, Logger);
      word = blockedWords[matchedIndex] ?? ruleId2;
    }
    Logger.info("message_blocked_by_word", { userId, word });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: USER_COPY.blockedWord
    });
    return;
  }
  const spamResult = await spamCheck(msg, userId, env);
  if (spamResult.isSpam) {
    await bumpDailyStat(env, "spam", 1);
    await handleSpamMessage(env, userId, msg, spamResult, void 0, ctx);
    return;
  }
  if (policyResult.action === "require_verification") {
    const isStart = msg.text && /^\/start(\s|$)/i.test(removeCommandBotSuffix(msg.text.trim()));
    const pendingMsgId = isStart ? null : msg.message_id;
    await verificationModule.sendVerificationChallenge(userId, env, pendingMsgId, msg.from);
    return;
  }
  if (policyResult.autoReply) {
    try {
      await tgCall(env, "sendMessage", { chat_id: userId, text: policyResult.autoReply });
    } catch (error) {
      Logger.warn("auto_reply_failed", { userId, ruleId: policyResult.matchedRuleId });
      if (policyResult.action === "auto_reply_only") throw error;
    }
  }
  if (policyResult.action === "auto_reply_only") return;
  const commandText = removeCommandBotSuffix((msg.text || "").trim());
  if (/^\/start(\s|$)/i.test(commandText) || commandText === "/cancel") return;
  if (ctx?.waitUntil) {
    ctx.waitUntil(bumpDailyStat(env, "messages_in", 1));
  } else {
    await bumpDailyStat(env, "messages_in", 1);
  }
  await forwardToTopic(msg, userId, key, env, ctx);
}
async function forwardToTopic(msg, userId, key, env, ctx) {
  const retryKey = `retry:${userId}`;
  const [needsVerify, initialRec, retryRaw] = await Promise.all([
    env.TOPIC_MAP.get(`needs_verify:${userId}`),
    safeGetJSON(env, key, null),
    env.TOPIC_MAP.get(retryKey)
  ]);
  if (needsVerify) {
    await verificationModule.sendVerificationChallenge(userId, env, msg.message_id || null, msg.from);
    return;
  }
  let rec = initialRec;
  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: USER_COPY.conversationClosed });
    return;
  }
  const retryCount = parseInt(retryRaw ?? "0", 10);
  if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: USER_COPY.retryExceeded });
    await env.TOPIC_MAP.delete(retryKey);
    return;
  }
  if (!rec || !rec.thread_id) {
    rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
    if (!rec || !rec.thread_id) {
      throw new Error("\u521B\u5EFA\u8BDD\u9898\u5931\u8D25");
    }
  } else if (isPlaceholderTopicTitle(rec.title)) {
    try {
      const resolvedFrom = await resolveUserFromForTopic(env, userId, msg.from);
      const title = buildTopicTitle(resolvedFrom);
      if (title && title !== TOPIC_TITLE_PLACEHOLDER && title !== rec.title) {
        const edit = await tgCall(env, "editForumTopic", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: rec.thread_id,
          name: title
        });
        if (edit?.ok) {
          rec.title = title;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
        }
      }
    } catch (e) {
      Logger.warn("topic_title_repair_failed", { userId, error: e?.message });
    }
  }
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
  if (msg.media_group_id) {
    await mediaGroup.handleMediaGroup(msg, env, ctx, {
      direction: "p2t",
      targetChat: env.SUPERGROUP_ID,
      threadId: rec.thread_id
    });
    return;
  }
  await executeMessageForward(msg, userId, rec.thread_id, env);
}
async function checkThreadHealth(threadId, env, { userId, retryKey }) {
  const cacheKey = threadId;
  const now = Date.now();
  const cached = threadHealthCache.get(cacheKey);
  const withinTTL = cached && now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS;
  if (withinTTL) {
    return { action: "ok", status: cached.ok ? "ok" : "missing" };
  }
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
    Logger.warn("topic_health_probe_invalid_message", {
      userId,
      threadId,
      errorDescription: probe.description
    });
    setBoundedCache(threadHealthCache, cacheKey, { ts: now, ok: true }, THREAD_HEALTH_MAX_ENTRIES);
    await ephemeralStore(env).setTopicHealth(
      threadId,
      true,
      Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1e3)
    );
    return { action: "ok", status: "ok" };
  }
  if (probe.status === "unknown_error") {
    Logger.warn("topic_test_failed_unknown", {
      userId,
      threadId,
      errorDescription: probe.description
    });
    const currentRetry = parseInt(await env.TOPIC_MAP.get(retryKey) ?? "0", 10);
    await env.TOPIC_MAP.put(retryKey, String(currentRetry + 1), { expirationTtl: CONFIG.RETRY_COUNT_TTL_SECONDS });
    return { action: "ok", status: "unknown" };
  }
  await env.TOPIC_MAP.delete(retryKey);
  setBoundedCache(threadHealthCache, cacheKey, { ts: now, ok: true }, THREAD_HEALTH_MAX_ENTRIES);
  await ephemeralStore(env).setTopicHealth(
    threadId,
    true,
    Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1e3)
  );
  return { action: "ok", status: "ok" };
}
async function executeMessageForward(msg, userId, threadId, env) {
  const res = await tgCall(env, "forwardMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: threadId
  });
  const resThreadId = res.result?.message_thread_id;
  if (res.ok && resThreadId !== void 0 && resThreadId !== null && Number(resThreadId) !== Number(threadId)) {
    await handleForwardRedirect(res, msg, userId, threadId, env, "forward_redirected_to_general");
    return;
  }
  if (res.ok && (resThreadId === void 0 || resThreadId === null)) {
    const probe = await probeForumThread(env, threadId, { userId, reason: "forward_result_missing_thread_id" });
    if (probe.status !== "ok") {
      await handleForwardRedirect(res, msg, userId, threadId, env, `forward_missing_thread_id:${probe.status}`);
      return;
    }
  }
  if (!res.ok) {
    await handleForwardFailure(res, msg, userId, threadId, env);
    return;
  }
  await saveLegacyMessageLink(env, {
    direction: "user_to_admin",
    message: msg,
    targetChatId: env.SUPERGROUP_ID,
    targetMessageId: res.result?.message_id,
    topicId: threadId,
    userId
  });
}
async function handleForwardRedirect(res, msg, userId, threadId, env, reason) {
  Logger.warn("forward_redirected", { userId, expectedThreadId: threadId, reason });
  if (res.result?.message_id) {
    try {
      await tgCall(env, "deleteMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_id: res.result.message_id
      });
    } catch {
    }
  }
  await resetUserVerificationAndRequireReverify(env, {
    userId,
    userKey: `user:${userId}`,
    oldThreadId: threadId,
    pendingMsgId: msg?.message_id || res.result?.message_id,
    reason
  });
}
var adminAlertThrottle = createThrottle({ windowMs: CONFIG.ALERT_THROTTLE_MS });
async function notifyAdmin(env, type, text) {
  if (!adminAlertThrottle(`admin_alert:${type}`)) {
    Logger.warn("admin_alert_throttled", { type });
    return;
  }
  try {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      text,
      parse_mode: "HTML"
    });
  } catch (e) {
    Logger.warn("admin_alert_failed", { type, error: e?.message });
  }
}
async function handleForwardFailure(res, msg, userId, threadId, env) {
  const desc = normalizeTgDescription(res.description);
  if (isTopicMissingOrDeleted(desc)) {
    Logger.warn("forward_failed_topic_missing", {
      userId,
      threadId,
      errorDescription: res.description
    });
    await resetUserVerificationAndRequireReverify(env, {
      userId,
      userKey: `user:${userId}`,
      oldThreadId: threadId,
      pendingMsgId: msg.message_id,
      reason: "forward_failed_topic_missing"
    });
    return;
  }
  const category = classifyTelegramError({
    status: res.error_code,
    description: res.description
  }).category;
  if (category === "chat_not_found") throw new Error(`\u7FA4\u7EC4ID\u9519\u8BEF: ${env.SUPERGROUP_ID}`);
  if (desc.includes("not enough rights")) throw new Error("\u673A\u5668\u4EBA\u6743\u9650\u4E0D\u8DB3 (\u9700 Manage Topics)");
  Logger.warn("forward_fallback_to_copy", {
    userId,
    threadId,
    originalError: res.description
  });
  const copyRes = await tgCall(env, "copyMessage", {
    chat_id: env.SUPERGROUP_ID,
    from_chat_id: userId,
    message_id: msg.message_id,
    message_thread_id: threadId
  });
  if (!copyRes.ok) {
    Logger.error("forward_and_copy_both_failed", copyRes.description, { userId, threadId });
    await notifyAdmin(
      env,
      "forward_failed",
      ADMIN_COPY.forwardTotalFail(
        String(userId),
        String(threadId),
        res.description || "",
        copyRes.description || ""
      )
    );
  }
}
function removeCommandBotSuffix(text) {
  if (!text || !text.startsWith("/")) return text;
  return text.replace(/^\/([a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "/$1");
}
async function handleAdminReply(msg, env, ctx, updateId) {
  try {
    await _handleAdminReplyInner(msg, env, ctx);
  } catch (e) {
    Logger.error("admin_reply_failed", e, {
      threadId: msg?.message_thread_id,
      senderId: msg?.from?.id,
      updateId
    });
  }
}
function isOwnerUser(env, userId) {
  return idAllowlistHas(env.OWNER_IDS, userId);
}
async function resolveThreadIdForUser(env, userId) {
  const rec = await safeGetJSON(env, `user:${userId}`, null);
  if (rec?.thread_id) return rec.thread_id;
  if (env.TG_BOT_DB) {
    try {
      const u = await createD1Storage(env.TG_BOT_DB).getUser(userId);
      if (u?.topicId) return u.topicId;
    } catch {
    }
  }
  return null;
}
async function _handleAdminReplyInner(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const rawText = (msg.text || "").trim();
  const text = removeCommandBotSuffix(rawText);
  const senderId = msg.from?.id;
  const isCommand = !!text && text.startsWith("/");
  if (!senderId || !await isAdminUser(env, senderId)) {
    if (isCommand && senderId && isAdminCommandText(text)) {
      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.noPermissionHint
      });
    }
    return;
  }
  if (text === "/cleanup") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: CLEANUP_CONFIRM_TEXT,
      parse_mode: "HTML",
      reply_markup: buildCleanupConfirmKeyboard()
    });
    return;
  }
  if (text === "/help") {
    await adminHandlers.handleHelpCommand(env, threadId, senderId);
    return;
  }
  if (text === "/menu" || text === "/dashboard") {
    await adminHandlers.handleMenuCommand(env, threadId, senderId);
    return;
  }
  if (text === "/sysinfo" || text === "/system" || text === "/status") {
    await adminHandlers.handleSysinfoCommand(env, threadId, { page: "overview" });
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
  let userId = null;
  const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mappedUser) {
    userId = Number(mappedUser);
  } else if (threadNotFoundCache.has(threadId) && Date.now() - threadNotFoundCache.get(threadId) < THREAD_NOT_FOUND_TTL_MS) {
    if (isCommand) {
      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.threadNotLinked
      });
    }
    return;
  } else {
    const scanLimit = 200;
    const scanBatch = 20;
    const listed = await env.TOPIC_MAP.list({ prefix: "user:", limit: scanLimit });
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
    if (!userId) {
      if (threadNotFoundCache.size >= THREAD_NOT_FOUND_MAX_ENTRIES) {
        threadNotFoundCache.delete(threadNotFoundCache.keys().next().value);
      }
      threadNotFoundCache.set(threadId, Date.now());
    }
  }
  if (!userId) {
    if (isCommand) {
      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: ADMIN_COPY.threadNotLinkedGlobal
      });
    }
    return;
  }
  if (text === "/close") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: confirmCloseText(userId),
      parse_mode: "HTML",
      reply_markup: buildCloseConfirmKeyboard(userId)
    });
    return;
  }
  if (text === "/open") {
    await adminActions.open(env, threadId, userId);
    return;
  }
  if (text === "/reset") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: confirmResetText(userId),
      parse_mode: "HTML",
      reply_markup: buildResetConfirmKeyboard(userId)
    });
    return;
  }
  if (text === "/trust") {
    await adminActions.trust(env, threadId, userId);
    return;
  }
  if (text === "/ban") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: confirmBanText(userId),
      parse_mode: "HTML",
      reply_markup: buildBanConfirmKeyboard(userId)
    });
    return;
  }
  if (text === "/unban") {
    await adminActions.unban(env, threadId, userId);
    return;
  }
  if (text === "/info") {
    await adminActions.info(env, threadId, userId);
    return;
  }
  if (text === "/panel") {
    await adminActions.panel(env, threadId, userId);
    return;
  }
  if (text === "/mute") {
    await adminActions.mute(env, threadId, userId);
    return;
  }
  if (text === "/unmute") {
    await adminActions.unmute(env, threadId, userId);
    return;
  }
  if (text.startsWith("/note")) {
    await adminActions.note(env, threadId, userId, text);
    return;
  }
  if (msg.media_group_id) {
    await mediaGroup.handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: void 0 });
    return;
  }
  const response = await tgCall(env, "copyMessage", {
    chat_id: userId,
    from_chat_id: env.SUPERGROUP_ID,
    message_id: msg.message_id
  });
  if (response.ok) {
    await saveLegacyMessageLink(env, {
      direction: "admin_to_user",
      message: msg,
      targetChatId: userId,
      targetMessageId: response.result?.message_id,
      topicId: threadId,
      userId
    });
  }
}
async function createTopic(from, key, env, userId) {
  const title = buildTopicTitle(from);
  if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID\u5FC5\u987B\u4EE5-100\u5F00\u5934");
  const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
  if (!res.ok) throw new Error(`\u521B\u5EFA\u8BDD\u9898\u5931\u8D25: ${res.description}`);
  const rec = { thread_id: res.result.message_thread_id, title, closed: false };
  await env.TOPIC_MAP.put(key, JSON.stringify(rec));
  if (userId) {
    await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
  }
  return rec;
}
async function updateThreadStatus(threadId, isClosed, env) {
  try {
    const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
    if (mappedUser) {
      const userKey = `user:${mappedUser}`;
      const rec = await safeGetJSON(env, userKey, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        rec.closed = isClosed;
        await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
        Logger.info("thread_status_updated", { threadId, isClosed, updatedCount: 1 });
        return;
      }
      await env.TOPIC_MAP.delete(`thread:${threadId}`);
    }
    const allKeys = await getAllKeys(env, "user:", TOPIC_SCAN_MAX_PAGES);
    const updates = [];
    const scanBatch = 20;
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
    Logger.info("thread_status_updated", { threadId, isClosed, updatedCount: updates.length });
  } catch (e) {
    Logger.error("thread_status_update_failed", e, { threadId, isClosed });
    throw e;
  }
}
function buildTopicTitle(from) {
  const src = from || {};
  const firstName = (src.first_name || src.firstName || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (src.last_name || src.lastName || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  let username = "";
  const rawUsername = src.username || "";
  if (rawUsername) {
    username = String(rawUsername).replace(/[^\w]/g, "").substring(0, 20);
  }
  const cleanName = cleanProfileText(firstName + " " + lastName);
  const name = cleanName || TOPIC_TITLE_PLACEHOLDER;
  const usernameStr = username ? ` @${username}` : "";
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);
  return title;
}
var telegramClientCache = /* @__PURE__ */ new Map();
function getTelegramClient(env, timeout = CONFIG.API_TIMEOUT_MS) {
  const key = `${env.BOT_TOKEN}|${env.API_BASE || ""}|${timeout}`;
  let client = telegramClientCache.get(key);
  if (!client) {
    client = createTelegramClient({
      botToken: env.BOT_TOKEN,
      apiBase: env.API_BASE,
      timeoutMs: timeout,
      // 动态解析全局 fetch：测试通过 stubGlobal 替换时也能生效
      fetchImpl: (...args) => fetch(...args),
      logger: Logger
    });
    telegramClientCache.set(key, client);
  }
  return client;
}
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  const client = getTelegramClient(env, timeout);
  try {
    return await client.call(method, body);
  } catch (error) {
    if (error instanceof TelegramApiError) {
      Logger.error("telegram_api_failed", error, {
        method,
        category: error.category,
        attempts: error.attempts
      });
      return error.response || {
        ok: false,
        error_code: error.status || void 0,
        description: error.message,
        parameters: error.retryAfter ? { retry_after: error.retryAfter } : void 0
      };
    }
    throw error;
  }
}
var workerApp = createApp({
  handleFetch: legacyApp.fetch.bind(legacyApp)
});
var worker_default = {
  fetch: workerApp.fetch.bind(workerApp),
  scheduled(event, env, ctx) {
    ctx.waitUntil(
      workerApp.scheduled(event, env, ctx).catch((error) => {
        Logger.error("scheduled_failed", error);
      })
    );
  }
};
export {
  worker_default as default
};
