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
function createD1Storage(db) {
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
      const like = `%${q.replace(/%/g, "")}%`;
      const result = await db.prepare(`
        SELECT user_id, username, first_name, last_name, last_message_at, topic_id, status, trust_level
        FROM users
        WHERE username LIKE ? OR first_name LIKE ? OR last_name LIKE ?
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
     */
    async getUsersByIds(userIds) {
      const ids = [...new Set((userIds || []).map(String).filter(Boolean))].slice(0, 30);
      if (!ids.length) return /* @__PURE__ */ new Map();
      const map = /* @__PURE__ */ new Map();
      await Promise.all(ids.map(async (id) => {
        const u = await this.getUser(id);
        if (u) map.set(id, u);
      }));
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
async function routeUpdate(update, {
  storage,
  handleUpdate,
  now = Date.now
}) {
  const updateId = update?.update_id;
  if (updateId === void 0 || updateId === null) {
    return new Response("Bad Request", { status: 400 });
  }
  let claim;
  try {
    claim = await storage.claimUpdate(updateId, getUpdateType(update), now());
  } catch (error) {
    return new Response(
      `Error: claimUpdate failed: ${error?.message || String(error)}`,
      { status: 500 }
    );
  }
  if (claim === "duplicate") return new Response("OK");
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
      return new Response(
        `Error: completeUpdate failed: ${error?.message || String(error)}`,
        { status: 500 }
      );
    }
    return response instanceof Response ? response : new Response("OK");
  } catch (error) {
    try {
      await storage.markUpdateRetryable(updateId, error?.category || "temporary");
    } catch {
    }
    return new Response(
      `Error: handleUpdate failed: ${error?.message || String(error)}`,
      { status: 500 }
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
  try {
    JSON.parse(await readRequestBodyWithLimit(request.clone()));
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "Bad Request");
  }
}
async function notFoundHandler() {
  return new Response("Not Found", { status: 404 });
}
function createApp({ handleFetch = notFoundHandler } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return new Response("OK");
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
        });
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
          });
        } catch (error) {
          return Response.json({
            ok: false,
            error: error?.message || String(error),
            name: error?.name || "Error",
            binding: inspectEnvPresence(env).bindings.TG_BOT_DB
          }, { status: 500 });
        }
      }
      try {
        const normalizedEnv = normalizeEnv(env);
        if (request.method === "POST" && url.pathname !== "/") {
          try {
            await readRequestBodyWithLimit(request.clone());
          } catch (error) {
            if (error instanceof HttpRequestError) {
              return new Response(error.message, { status: error.status });
            }
            throw error;
          }
        }
        if (request.method === "POST" && url.pathname === "/") {
          try {
            await validateTelegramWebhookRequest(request, normalizedEnv);
          } catch (error) {
            if (error instanceof HttpRequestError) {
              return new Response(error.message, { status: error.status });
            }
            return new Response(`Error: ${error.message}`, { status: 500 });
          }
        }
        try {
          validateBaseEnv(normalizedEnv);
        } catch (error) {
          return new Response(
            `Error: ${error.message}${formatEnvPresenceDetail(normalizedEnv)}`,
            { status: 500 }
          );
        }
        if (request.method === "POST" && url.pathname === "/") {
          try {
            assertD1Binding(normalizedEnv.TG_BOT_DB, "TG_BOT_DB");
          } catch (error) {
            return new Response(`Error: ${error.message}`, { status: 500 });
          }
          try {
            await ensureMigrations(normalizedEnv.TG_BOT_DB);
          } catch (error) {
            return new Response(
              `Error: D1 migration failed: ${error?.message || String(error)}`,
              { status: 500 }
            );
          }
          let update;
          try {
            update = await request.clone().json();
          } catch (error) {
            return new Response("Bad Request", { status: 400 });
          }
          try {
            return await routeUpdate(update, {
              storage: createD1Storage(normalizedEnv.TG_BOT_DB),
              handleUpdate: () => handleFetch(request, normalizedEnv, ctx)
            });
          } catch (error) {
            return new Response(
              `Error: update routing failed: ${error?.message || String(error)}`,
              { status: 500 }
            );
          }
        }
        return await handleFetch(request, normalizedEnv, ctx);
      } catch (error) {
        return new Response(
          `Error: unhandled ${error?.name || "Error"}: ${error?.message || String(error)}`,
          { status: 500 }
        );
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
function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  return [message.text, message.caption].filter((value) => typeof value === "string" && value.trim().length > 0).join(" ").trim();
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
  if (!MATCH_TYPES.has(matchType)) throw new Error(`unsupported matchType: ${matchType}`);
  if (!pattern) throw new Error("pattern is required");
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error("pattern must not exceed 200 characters");
  }
  if (responseText.length > MAX_RESPONSE_LENGTH) {
    throw new Error("responseText must not exceed 4000 characters");
  }
  if (ruleType && !RULE_ACTIONS[ruleType]) throw new Error(`unsupported ruleType: ${ruleType}`);
  if (ruleType && rule.action && !RULE_ACTIONS[ruleType].has(rule.action)) {
    throw new Error(`unsupported action: ${rule.action}`);
  }
  if (ruleType === "auto_reply" && rule.action !== "forward_only" && responseText.length === 0) {
    throw new Error("responseText is required for auto reply");
  }
  if (matchType !== "regex") return;
  if (hasUnsafeNestedQuantifier(pattern)) {
    throw new Error("regex contains unsafe nested quantifiers");
  }
  if (hasOverlappingQuantifiedAlternatives(pattern)) {
    throw new Error("regex contains unsafe overlapping alternatives");
  }
  let expression;
  try {
    expression = new RegExp(pattern, "i");
  } catch {
    throw new Error("regex is invalid");
  }
  if (expression.test("")) throw new Error("regex must not match empty text");
}
function matchRule(text, rule) {
  validateRuleInput(rule);
  const input = String(text ?? "").slice(0, MAX_INPUT_LENGTH);
  const pattern = String(rule.pattern);
  const matchType = ruleValue(rule, "matchType", "match_type") || "contains";
  if (matchType === "regex") return new RegExp(pattern, "i").test(input);
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
      text: "\u7BA1\u7406\u540E\u53F0",
      reply_markup: buildAdminMenu()
    });
    return { status: "menu" };
  }
  async function handleCallbackQuery2(query) {
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
        text: "\u65E0\u6548\u64CD\u4F5C",
        show_alert: true
      });
      return { status: "invalid" };
    }
    const allowed = adminId && await authorize(adminId, permission);
    if (allowed && resourceId) {
      const before = await storage.getUser(resourceId);
      if (!before) {
        await telegram.call("answerCallbackQuery", {
          callback_query_id: query.id,
          text: "\u7528\u6237\u4E0D\u5B58\u5728",
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
    const responseText = resourceId ? "\u5DF2\u5904\u7406" : "\u540E\u53F0\u8FDE\u63A5\u6B63\u5E38";
    await telegram.call("answerCallbackQuery", {
      callback_query_id: query.id,
      text: allowed ? responseText : "\u6743\u9650\u5DF2\u5931\u6548",
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
    handleCallbackQuery: handleCallbackQuery2,
    createRule,
    listRules,
    deleteRule,
    setRuleEnabled
  };
}

// src/conversation-service.js
var SNAPSHOT_LIMIT = 5e3;
var TOPIC_LOCK_TTL_MS = 3e4;
var TOPIC_TITLE_LIMIT = 128;
var TOPIC_UPDATE_INTERVAL_MS = 60 * 60 * 1e3;
function cleanProfileText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
function buildTopicTitle(user) {
  const userId = cleanProfileText(user.userId) || "unknown";
  const username = cleanProfileText(user.username).replace(/[^\w]/g, "");
  const displayName = cleanProfileText(
    [user.firstName, user.lastName].filter(Boolean).join(" ")
  ) || "User";
  const suffix = `${username ? ` \xB7 @${username}` : ""} \xB7 ${userId}`;
  return `${displayName.slice(0, Math.max(0, TOPIC_TITLE_LIMIT - suffix.length))}${suffix}`;
}
function buildProfileCard(user) {
  const status = user.status === "banned" ? "\u5DF2\u5C01\u7981" : user.status === "closed" ? "\u5DF2\u5173\u95ED" : "\u6B63\u5E38";
  const trust = user.trustLevel === "trusted" ? "\u6C38\u4E45\u4FE1\u4EFB" : "\u666E\u901A";
  const muted = user.isMuted ? "\u5DF2\u9759\u97F3" : "\u672A\u9759\u97F3";
  const username = user.username ? `@${user.username}` : "\u65E0";
  return {
    text: [
      "\u{1F464} \u7528\u6237\u8D44\u6599",
      `UID: ${user.userId}`,
      `\u7528\u6237\u540D: ${username}`,
      `\u59D3\u540D: ${cleanProfileText([user.firstName, user.lastName].filter(Boolean).join(" ")) || "\u672A\u77E5"}`,
      `\u4F1A\u8BDD\u72B6\u6001: ${status}`,
      `\u4FE1\u4EFB\u72B6\u6001: ${trust}`,
      `\u9759\u97F3\u72B6\u6001: ${muted}`,
      `\u8FDD\u89C4\u6B21\u6570: ${Number(user.violationCount || 0)}`
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "\u4FE1\u4EFB/\u53D6\u6D88", callback_data: `v1:user:trust:${user.userId}` },
          { text: "\u5C01\u7981/\u89E3\u5C01", callback_data: `v1:user:ban:${user.userId}` }
        ],
        [
          { text: "\u5173\u95ED/\u6253\u5F00", callback_data: `v1:user:close:${user.userId}` },
          { text: "\u9759\u97F3/\u53D6\u6D88", callback_data: `v1:user:mute:${user.userId}` }
        ]
      ]
    }
  };
}
async function syncUserProfile(user, {
  storage,
  telegram,
  logger,
  now = Date.now,
  supergroupId
}) {
  try {
    let previous = {};
    try {
      previous = user.profileSnapshot ? JSON.parse(user.profileSnapshot) : {};
    } catch {
      previous = {};
    }
    const profile = {
      username: user.username ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null
    };
    const profileChanged = JSON.stringify(previous.profile || null) !== JSON.stringify(profile);
    if (!profileChanged && user.infoCardMessageId) return { status: "unchanged" };
    const titleUpdateDue = user.topicId && profileChanged && (!previous.titleUpdatedAt || now() - previous.titleUpdatedAt >= TOPIC_UPDATE_INTERVAL_MS);
    if (titleUpdateDue) {
      await telegram.call("editForumTopic", {
        chat_id: supergroupId,
        message_thread_id: user.topicId,
        name: buildTopicTitle(user)
      });
    }
    const card = buildProfileCard(user);
    let infoCardMessageId = user.infoCardMessageId;
    if (user.topicId && !infoCardMessageId) {
      const response = await telegram.call("sendMessage", {
        chat_id: supergroupId,
        message_thread_id: user.topicId,
        text: card.text,
        reply_markup: card.replyMarkup
      });
      infoCardMessageId = telegramResultValue(response, "message_id") ?? null;
    } else if (user.topicId && infoCardMessageId && profileChanged) {
      await telegram.call("editMessageText", {
        chat_id: supergroupId,
        message_id: infoCardMessageId,
        text: card.text,
        reply_markup: card.replyMarkup
      });
    }
    await storage.updateUserState(user.userId, {
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      infoCardMessageId,
      profileSnapshot: JSON.stringify({
        profile,
        titleUpdatedAt: titleUpdateDue ? now() : previous.titleUpdatedAt ?? null
      })
    });
    return { status: "synced" };
  } catch (error) {
    logger?.warn?.("profile_sync_failed", {
      userId: user.userId,
      error: error?.message || "unknown"
    });
    return { status: "failed" };
  }
}
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
function telegramResultValue(response, key) {
  return response?.result?.[key] ?? response?.[key];
}
function createRetryableError(message, category) {
  return Object.assign(new Error(message), { category, retryable: true });
}
function createConversationService({
  storage,
  telegram,
  policy,
  logger,
  now = Date.now,
  randomId = () => crypto.randomUUID(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  supergroupId,
  syncProfiles = true
}) {
  async function evaluate(message, user) {
    return policy ? policy({ message, user }) : {
      action: "allow",
      reason: null,
      shouldForward: true,
      shouldIncrementViolation: false
    };
  }
  async function ensureUser(message) {
    const userId = String(message.from?.id ?? message.chat?.id);
    const existing = await storage.getUser(userId);
    if (existing) return existing;
    const user = {
      userId,
      username: message.from?.username ?? null,
      firstName: message.from?.first_name ?? null,
      lastName: message.from?.last_name ?? null,
      status: "active",
      trustLevel: "normal"
    };
    if (storage.ensureUser) return storage.ensureUser(user);
    await storage.upsertUser(user);
    return storage.getUser(userId);
  }
  async function createTopic2(user, token) {
    const response = await telegram.call("createForumTopic", {
      chat_id: supergroupId,
      name: buildTopicTitle(user)
    });
    const topicId = telegramResultValue(response, "message_thread_id");
    if (topicId == null) throw createRetryableError("createForumTopic missing topic id", "temporary");
    const saved = await storage.setTopic(user.userId, topicId, token, now());
    if (!saved) throw createRetryableError("topic lock ownership lost", "topic_lock_lost");
    return String(topicId);
  }
  async function getOrCreateTopic(user) {
    const current = await storage.getUser(user.userId);
    if (current?.topicId) return current.topicId;
    const token = randomId();
    const acquired = await storage.acquireTopicLock(
      user.userId,
      token,
      now(),
      TOPIC_LOCK_TTL_MS
    );
    if (acquired) {
      try {
        return await createTopic2(current || user, token);
      } finally {
        await storage.releaseTopicLock(user.userId, token, now());
      }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sleep(150 + attempt * 75);
      const refreshed = await storage.getUser(user.userId);
      if (refreshed?.topicId) return refreshed.topicId;
    }
    throw createRetryableError("topic creation is locked", "topic_lock_busy");
  }
  async function saveLink({ direction, message, response, userId, topicId, targetChatId }) {
    const contentSnapshot = snapshotMessage(message);
    await storage.saveMessageLink({
      direction,
      sourceChatId: message.chat.id,
      sourceMessageId: message.message_id,
      targetChatId,
      targetMessageId: telegramResultValue(response, "message_id"),
      topicId,
      userId,
      contentSnapshot,
      contentHash: hashContent(contentSnapshot),
      createdAt: now(),
      updatedAt: now()
    });
  }
  async function copyPrivateMessage(message, user, topicId) {
    try {
      const response = await telegram.call("copyMessage", {
        chat_id: supergroupId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        message_thread_id: topicId
      });
      await saveLink({
        direction: "user_to_admin",
        message,
        response,
        userId: user.userId,
        topicId,
        targetChatId: supergroupId
      });
      return { status: "forwarded", topicId };
    } catch (error) {
      if (error?.category !== "topic_missing") throw error;
      await storage.clearTopic(user.userId, topicId, now());
      const replacementTopicId = await getOrCreateTopic(user);
      return copyPrivateMessage(message, user, replacementTopicId);
    }
  }
  async function handlePrivateMessage2(message) {
    const user = await ensureUser(message);
    const policyResult = await evaluate(message, user);
    if (!policyResult.shouldForward) {
      return { status: policyResult.action, reason: policyResult.reason };
    }
    const topicId = await getOrCreateTopic(user);
    if (syncProfiles) {
      await syncUserProfile({
        ...user,
        topicId,
        username: message.from?.username ?? user.username,
        firstName: message.from?.first_name ?? user.firstName,
        lastName: message.from?.last_name ?? user.lastName
      }, {
        storage,
        telegram,
        logger,
        now,
        supergroupId
      });
    }
    return copyPrivateMessage(message, user, topicId);
  }
  async function handleAdminMessage(message) {
    const user = await storage.findUserByTopic(message.message_thread_id);
    if (!user) return { status: "missing_user" };
    const response = await telegram.call("copyMessage", {
      chat_id: user.userId,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    });
    await saveLink({
      direction: "admin_to_user",
      message,
      response,
      userId: user.userId,
      topicId: user.topicId,
      targetChatId: user.userId
    });
    return { status: "forwarded" };
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
        chat_id: link.targetChatId,
        message_thread_id: link.topicId,
        text: `\u{1F6AB} \u7528\u6237\u7F16\u8F91\u5DF2\u62E6\u622A\uFF1A${policyResult.reason || policyResult.action}`
      });
      return { status: "blocked", reason: policyResult.reason };
    }
    const contentSnapshot = snapshotMessage(message);
    if (hashContent(contentSnapshot) === link.contentHash) return { status: "unchanged" };
    await telegram.call("sendMessage", {
      chat_id: link.targetChatId,
      message_thread_id: link.topicId,
      text: `\u270F\uFE0F \u7528\u6237\u4FEE\u6539\u4E86\u6D88\u606F
\u539F\u5185\u5BB9\uFF1A${link.contentSnapshot || "(\u7A7A)"}
\u65B0\u5185\u5BB9\uFF1A${contentSnapshot || "(\u7A7A)"}`
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
      text: `\u270F\uFE0F \u7BA1\u7406\u5458\u4FEE\u6539\u4E86\u56DE\u590D
\u539F\u5185\u5BB9\uFF1A${link.contentSnapshot || "(\u7A7A)"}
\u65B0\u5185\u5BB9\uFF1A${contentSnapshot || "(\u7A7A)"}`
    });
    await updateLinkSnapshot(link, message, contentSnapshot);
    return { status: "notified" };
  }
  return {
    handlePrivateMessage: handlePrivateMessage2,
    handleAdminMessage,
    handleEditedPrivateMessage,
    handleEditedAdminMessage
  };
}

// src/logger.js
var REDACTED_KEYS = /* @__PURE__ */ new Set([
  "BOT_TOKEN",
  "TURNSTILE_SECRET_KEY",
  "WEBHOOK_SECRET",
  "botToken",
  "turnstileToken",
  "webhookSecret",
  "verifyCode",
  "verifyId",
  "text",
  "caption"
]);
function redactValue(key, value, seen) {
  if (REDACTED_KEYS.has(key)) return "[REDACTED]";
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
function createLogger(baseContext = {}, sink = console) {
  function emit(level, action, data = {}) {
    const method = level.toLowerCase();
    const log = redactLogData({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      action,
      ...baseContext,
      ...data
    });
    const output = JSON.stringify(log);
    (sink[method] || sink.log).call(sink, output);
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
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : void 0,
        ...data
      });
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

// src/storage/kv-storage.js
async function readJson(kv, key) {
  const value = await kv.get(key, { type: "json" });
  return value && typeof value === "object" ? value : null;
}
function createKVStorage(kv) {
  const storage = {
    async getUser(userId) {
      const id = String(userId);
      const record = await readJson(kv, `user:${id}`);
      if (!record) return null;
      const [banned, verification] = await Promise.all([
        kv.get(`banned:${id}`),
        kv.get(`verified:${id}`)
      ]);
      return {
        userId: id,
        username: record.username || null,
        firstName: record.first_name || null,
        lastName: record.last_name || null,
        status: banned ? "banned" : record.closed ? "closed" : "active",
        trustLevel: verification === "trusted" ? "trusted" : "normal",
        isMuted: Boolean(record.is_muted),
        violationCount: Number(record.violation_count || 0),
        topicId: record.thread_id == null ? null : String(record.thread_id),
        infoCardMessageId: record.info_card_message_id == null ? null : String(record.info_card_message_id),
        profileSnapshot: record.user_info_json || null,
        title: record.title || null,
        createdAt: record.created_at || null,
        updatedAt: record.updated_at || null,
        lastMessageAt: record.last_message_at || null
      };
    },
    async upsertUser(user) {
      const id = String(user.userId);
      const existing = await readJson(kv, `user:${id}`) || {};
      const record = {
        ...existing,
        thread_id: user.topicId ?? existing.thread_id ?? null,
        title: user.title ?? existing.title ?? null,
        closed: user.status === "closed",
        username: user.username ?? existing.username ?? null,
        first_name: user.firstName ?? existing.first_name ?? null,
        last_name: user.lastName ?? existing.last_name ?? null,
        is_muted: user.isMuted ?? existing.is_muted ?? false,
        violation_count: user.violationCount ?? existing.violation_count ?? 0,
        info_card_message_id: user.infoCardMessageId ?? existing.info_card_message_id ?? null,
        user_info_json: user.profileSnapshot ?? existing.user_info_json ?? null,
        created_at: user.createdAt ?? existing.created_at ?? Date.now(),
        updated_at: user.updatedAt ?? Date.now(),
        last_message_at: user.lastMessageAt ?? existing.last_message_at ?? null
      };
      await kv.put(`user:${id}`, JSON.stringify(record));
      if (record.thread_id != null) {
        await kv.put(`thread:${record.thread_id}`, id);
      }
      if (user.status === "banned") await kv.put(`banned:${id}`, "1");
      else await kv.delete(`banned:${id}`);
      if (user.trustLevel !== "trusted" && await kv.get(`verified:${id}`) === "trusted") {
        await kv.delete(`verified:${id}`);
      }
    },
    async findUserByTopic(topicId) {
      const userId = await kv.get(`thread:${topicId}`);
      return userId ? storage.getUser(userId) : null;
    },
    async updateUserState(userId, changes) {
      const existing = await storage.getUser(userId);
      if (!existing) return null;
      const updated = { ...existing, ...changes, userId: String(userId) };
      await storage.upsertUser(updated);
      return updated;
    }
  };
  return storage;
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
function formatSparkline(values) {
  const list = (values || []).map((n) => Math.max(0, Number(n) || 0));
  if (!list.length) return "";
  const max = Math.max(0, ...list);
  if (max <= 0) return "\xB7".repeat(list.length);
  const blocks = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  return list.map((n) => {
    if (n <= 0) return "\xB7";
    const level = Math.min(8, Math.max(1, Math.ceil(n / max * 8)));
    return blocks[level - 1];
  }).join("");
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
  const max = Math.max(0, ...list);
  if (max <= 0) return "\xB7".repeat(24);
  const blocks = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  return list.map((n) => {
    if (n <= 0) return "\xB7";
    const level = Math.min(8, Math.max(1, Math.ceil(n / max * 8)));
    return blocks[level - 1];
  }).join("");
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

// src/admin-ui-format.js
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatSysTime(ts) {
  if (ts == null || ts === "" || Number(ts) <= 0) return "\u65E0";
  try {
    return new Date(Number(ts)).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
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
  return `${formatRelativeTime(ts, now)} \xB7 <code>${formatSysTime(ts)}</code>`;
}
function statusChip(ok, okText = "\u6B63\u5E38", badText = "\u5F02\u5E38") {
  return ok ? `\u{1F7E2} ${okText}` : `\u{1F534} ${badText}`;
}
function buildUserActionKeyboard(userId) {
  const id = String(userId);
  return {
    inline_keyboard: [
      [
        { text: "\u{1F6AB} \u5C01\u7981", callback_data: `adm:u:banask:${id}` },
        { text: "\u2705 \u89E3\u5C01", callback_data: `adm:u:unban:${id}` }
      ],
      [
        { text: "\u{1F512} \u5173\u95ED", callback_data: `adm:u:closeask:${id}` },
        { text: "\u{1F513} \u6253\u5F00", callback_data: `adm:u:open:${id}` }
      ],
      [
        { text: "\u{1F31F} \u4FE1\u4EFB", callback_data: `adm:u:trust:${id}` },
        { text: "\u{1F504} \u91CD\u7F6E", callback_data: `adm:u:resetask:${id}` }
      ],
      [
        { text: "\u{1F507} \u9759\u97F3", callback_data: `adm:u:mute:${id}` },
        { text: "\u{1F50A} \u53D6\u6D88\u9759\u97F3", callback_data: `adm:u:unmute:${id}` }
      ],
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
function buildUserJumpKeyboard(users, { includeMenu = true, columns = 2 } = {}) {
  const cols = Math.min(Math.max(Number(columns) || 2, 1), 3);
  const list = (users || []).slice(0, 8);
  const rows = [];
  for (let i = 0; i < list.length; i += cols) {
    const chunk = list.slice(i, i + cols).map((u) => {
      const label = displayUserLabel2(u).slice(0, cols === 1 ? 24 : 14);
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
    const badge = u.status === "banned" ? " \u{1F6AB}" : u.status === "closed" ? " \u{1F512}" : "";
    lines.push(`${rankMedal(i)} ${name}${un}${cnt}${when}${badge}`);
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
      { text: "\u{1F50D} \u67E5\u627E", callback_data: "adm:nav:find" },
      { text: "\u{1F50E} \u5907\u6CE8", callback_data: "adm:nav:notes" },
      { text: "\u{1F4DD} \u5C4F\u853D\u8BCD", callback_data: "adm:nav:listwords" }
    ],
    [
      { text: "\u{1F9F9} \u6E05\u7406", callback_data: "adm:nav:cleanup_ask" },
      { text: "\u{1FAAA} \u6211", callback_data: "adm:nav:whoami" },
      { text: "\u2753 \u5E2E\u52A9", callback_data: "adm:nav:help" }
    ]
  ];
  if (isOwner) {
    rows.push([{ text: "\u{1F4E1} \u540C\u6B65\u547D\u4EE4\u83DC\u5355", callback_data: "adm:nav:synccommands" }]);
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
    recordSystemError: recordSystemError2,
    isOwnerUser: isOwnerUser2,
    isAdminUser: isAdminUser2,
    parseIdAllowlist: parseIdAllowlist2,
    safeGetJSON: safeGetJSON2,
    resolveThreadIdForUser: resolveThreadIdForUser2,
    getRecentSystemErrors,
    handleCleanupCommand: handleCleanupCommand2,
    handleListWordsCommand: handleListWordsCommand2,
    userActions = {}
  } = deps;
  const sysinfoKvCache = { ts: 0, data: null, ttlMs: 45e3 };
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
  async function bumpDailyStat2(env, field, n = 1) {
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
      await env.TOPIC_MAP.put(key, JSON.stringify(obj), { expirationTtl: 21 * 86400 });
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
  async function loadTodayActivity(env) {
    const dayStart = opsDayStartMs();
    const day = opsDayKey();
    const today = await getDailyStats(env, day);
    let summary = summarizeInboundActivity([], { topN: 10 });
    let source = "none";
    const storage = env.TG_BOT_DB ? createD1Storage(env.TG_BOT_DB) : null;
    if (storage) {
      try {
        await ensureMigrations(env.TG_BOT_DB);
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
  async function handleHelpCommand2(env, threadId, senderId = null) {
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
/ban(\u9700\u786E\u8BA4) /unban /close /open /mute /unmute /trust /reset`;
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: helpText,
      parse_mode: "HTML",
      reply_markup: buildAdminHomeKeyboard(isOwnerUser2(env, senderId))
    });
  }
  async function handleMenuCommand2(env, threadId, senderId) {
    const text = [
      `\u{1F3E0} <b>\u7BA1\u7406\u83DC\u5355</b> \xB7 v${GATEWAY_VERSION2}`,
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      "\u70B9\u4E0B\u65B9\u6309\u94AE\u5FEB\u901F\u6253\u5F00\u529F\u80FD\uFF0C\u65E0\u9700\u8BB0\u5FC6\u547D\u4EE4\u3002",
      "",
      "\u{1F525} <b>\u6D3B\u8DC3</b> \u4ECA\u65E5\u6392\u884C + \u4E2D\u56FD\u65F6\u95F4\u70ED\u529B",
      "\u{1F50D} <b>\u67E5\u627E</b> /find \xB7 \u{1F50E} <b>\u5907\u6CE8</b> /notes",
      "\u{1F4A1} \u7528\u6237\u4F1A\u8BDD\u8BF7\u8FDB\u5165\u5BF9\u5E94 Forum Topic \u4F7F\u7528 <b>\u9762\u677F/\u8D44\u6599</b>\u3002"
    ].join("\n");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text,
      parse_mode: "HTML",
      reply_markup: buildAdminHomeKeyboard(isOwnerUser2(env, senderId))
    });
  }
  async function countKvPrefix(env, prefix) {
    if (!env?.TOPIC_MAP?.list) return null;
    let total = 0;
    let cursor;
    let pages = 0;
    const maxPages = 20;
    do {
      const result = await env.TOPIC_MAP.list({ prefix, cursor, limit: 1e3 });
      total += (result.keys || []).length;
      cursor = result.list_complete ? void 0 : result.cursor;
      pages += 1;
    } while (cursor && pages < maxPages);
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
    for (const item of [...getRecentSystemErrors(), ...kvErrors]) {
      if (!item || typeof item !== "object") continue;
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
    const rows = [];
    for (const [prefix, label] of prefixes) {
      const c = await countKvPrefix(env, prefix);
      rows.push({ prefix, label, ...c || { total: 0, truncated: false } });
    }
    sysinfoKvCache.ts = now;
    sysinfoKvCache.data = rows;
    return rows;
  }
  async function buildSysinfoPageText(env, page = "overview") {
    const started = Date.now();
    const hasKv = Boolean(env.TOPIC_MAP && typeof env.TOPIC_MAP.get === "function");
    const hasD1 = Boolean(env.TG_BOT_DB && typeof env.TG_BOT_DB.prepare === "function");
    const baseUrl = String(env.VERIFICATION_PAGE_URL || "").replace(/\/$/, "") || "(\u672A\u914D\u7F6E VERIFICATION_PAGE_URL)";
    const turnstileOn = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY && env.VERIFICATION_PAGE_URL);
    const lines = [];
    let activity = null;
    if (page === "overview" || page === "stats") {
      lines.push(`\u{1F5A5} <b>\u7CFB\u7EDF \xB7 ${page === "stats" ? "\u4ECA\u65E5\u7EDF\u8BA1" : "\u6982\u89C8"}</b>`);
      lines.push(`<code>v${GATEWAY_VERSION2}</code>`);
      lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      lines.push(`${statusChip(true, "Worker \u8FD0\u884C\u4E2D")}`);
      lines.push(`${statusChip(hasKv, "KV \u5DF2\u7ED1\u5B9A", "KV \u7F3A\u5931")} \xB7 ${statusChip(hasD1, "D1 \u5DF2\u7ED1\u5B9A", "D1 \u7F3A\u5931")}`);
      lines.push(`\u9A8C\u8BC1: ${turnstileOn ? "\u{1F6E1} Turnstile" : "\u{1F4DD} \u672C\u5730\u9898\u5E93"} \xB7 Owner: ${parseIdAllowlist2(env.OWNER_IDS).length > 0 ? "\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E"}`);
      lines.push(`\u8D85\u7EA7\u7FA4 ID: ${String(env.SUPERGROUP_ID || "").startsWith("-100") ? "\u2705 \u683C\u5F0F\u6B63\u786E" : "\u274C \u9700 -100 \u5F00\u5934"}`);
      lines.push("");
      if (hasD1) {
        try {
          await ensureMigrations(env.TG_BOT_DB);
          const stats = await createD1Storage(env.TG_BOT_DB).getSystemStats();
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
              const name = escapeHtml([u.firstName, u.lastName].filter(Boolean).join(" ").trim() || "\u672A\u77E5");
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
      if (page === "stats") {
        activity = await loadTodayActivity(env);
        const today = activity.today;
        const yday = await getDailyStats(env, opsYesterdayKey());
        const week = await getRecentDailySeries(env, 7);
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
      lines.push(`<code>${escapeHtml(baseUrl)}/health</code>`);
      lines.push(`<code>\u2026/health/env</code> \xB7 <code>\u2026/health/d1</code> \xB7 <code>\u2026/verify</code>`);
      lines.push(`Webhook <code>POST ${escapeHtml(baseUrl)}/</code>`);
    }
    if (page === "activity") {
      activity = await loadTodayActivity(env);
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
    }
    if (page === "storage") {
      lines.push("\u{1F5C4} <b>\u7CFB\u7EDF \xB7 \u5B58\u50A8</b>");
      lines.push(`<code>v${GATEWAY_VERSION2}</code>`);
      lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      if (hasD1) {
        try {
          const stats = await createD1Storage(env.TG_BOT_DB).getSystemStats();
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
    }
    if (page === "errors") {
      lines.push("\u26A0\uFE0F <b>\u7CFB\u7EDF \xB7 \u6700\u8FD1\u9519\u8BEF</b>");
      lines.push(`<code>v${GATEWAY_VERSION2}</code>`);
      lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      const top = await collectRecentErrors(env);
      if (!top.length) {
        lines.push("\u2728 \u6682\u65E0\u9519\u8BEF\u8BB0\u5F55");
        lines.push("<i>\u51B7\u542F\u52A8\u540E\u5185\u5B58\u7F13\u51B2\u4F1A\u6E05\u7A7A</i>");
      } else {
        for (const err of top) {
          const act = escapeHtml(err.action || "?");
          const msg = escapeHtml(String(err.error || "").slice(0, 140));
          const uid = err.userId ? ` \xB7 uid ${escapeHtml(err.userId)}` : "";
          lines.push(`\u{1F534} <b>${act}</b>${uid}`);
          lines.push(`   ${formatRelativeTime(err.ts)} \xB7 ${msg}`);
        }
      }
    }
    lines.push("");
    lines.push(`\u23F1 ${Date.now() - started} ms \xB7 \u70B9\u4E0B\u65B9\u5207\u6362\u5206\u9875`);
    let text = lines.join("\n");
    if (text.length > 3500) text = `${text.slice(0, 3500)}
\u2026`;
    return { text, activity };
  }
  async function handleSysinfoCommand2(env, threadId, opts = {}) {
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
  async function handleStatsCommand2(env, threadId) {
    await handleSysinfoCommand2(env, threadId, { page: "stats" });
  }
  async function handleRankCommand2(env, threadId, opts = {}) {
    await handleSysinfoCommand2(env, threadId, { page: "activity", edit: opts.edit || null });
  }
  async function handleNotesCommand2(env, threadId, queryText = "") {
    const q = String(queryText || "").replace(/^\/notes(@\w+)?\s*/i, "").trim();
    if (!env.TOPIC_MAP?.list) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "\u274C KV \u672A\u7ED1\u5B9A\uFF0C\u65E0\u6CD5\u641C\u7D22\u5907\u6CE8"
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
        for (const key of result.keys || []) {
          const userId = String(key.name || "").slice(5);
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
        cursor = result.list_complete ? void 0 : result.cursor;
        pages += 1;
      } while (cursor && pages < maxPages && matches.length < 12);
    } catch (e) {
      recordSystemError2("notes_search_failed", e, {}, env);
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: `\u274C \u5907\u6CE8\u641C\u7D22\u5931\u8D25: ${escapeHtml(e?.message || String(e))}`,
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
        await ensureMigrations(env.TG_BOT_DB);
        userMap = await createD1Storage(env.TG_BOT_DB).getUsersByIds(matches.map((m) => m.userId));
      } catch {
      }
    }
    const truncated = matches.length >= 12 || Boolean(cursor);
    const lines = [
      `\u{1F50E} <b>\u5907\u6CE8\u641C\u7D22</b>${q ? ` \xB7 \u300C${escapeHtml(q)}\u300D` : " \xB7 \u6700\u8FD1"}`,
      `\u5171 ${matches.length} \u6761${truncated ? "\uFF08\u5DF2\u622A\u65AD\uFF0C\u53EF\u52A0\u5173\u952E\u8BCD\u7F29\u5C0F\uFF09" : ""}`,
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"
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
  async function handleWhoamiCommand2(env, threadId, senderId) {
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
    const text = [
      "\u{1FAAA} <b>Whoami</b>",
      `UID: <code>${senderId}</code>`,
      `\u7FA4\u8EAB\u4EFD: <code>${escapeHtml(member)}</code>`,
      `\u7BA1\u7406\u6307\u4EE4\u6743\u9650: ${admin ? "\u2705 \u662F" : "\u274C \u5426"}`,
      `OWNER_IDS: ${owner ? "\u2705 \u662F" : "\u274C \u5426"}`
    ].join("\n");
    await tgCall2(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text,
      parse_mode: "HTML",
      reply_markup: buildAdminHomeKeyboard(owner)
    });
  }
  async function handleFindCommand2(env, threadId, queryText) {
    const q = queryText.replace(/^\/find(@\w+)?\s*/i, "").trim();
    if (!q) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "\u7528\u6CD5: <code>/find UID\u6216\u7528\u6237\u540D\u6216\u59D3\u540D</code>",
        parse_mode: "HTML"
      });
      return;
    }
    if (!env.TG_BOT_DB) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "\u274C D1 \u672A\u7ED1\u5B9A\uFF0C\u65E0\u6CD5\u641C\u7D22"
      });
      return;
    }
    try {
      await ensureMigrations(env.TG_BOT_DB);
      const hits = await createD1Storage(env.TG_BOT_DB).searchUsers(q, 10);
      if (!hits.length) {
        await tgCall2(env, "sendMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: threadId,
          text: `\u672A\u627E\u5230\u5339\u914D\u300C${escapeHtml(q)}\u300D\u7684\u7528\u6237
\u4E5F\u53EF\u8BD5 <code>/notes ${escapeHtml(q)}</code> \u641C\u5907\u6CE8`,
          parse_mode: "HTML"
        });
        return;
      }
      const lines = [`\u{1F50E} <b>\u67E5\u627E\u7ED3\u679C</b> \xB7 ${hits.length} \u6761`, ""];
      for (const u of hits) {
        const name = escapeHtml([u.firstName, u.lastName].filter(Boolean).join(" ").trim() || "\u672A\u77E5");
        const un = u.username ? `@${escapeHtml(u.username)}` : "\u65E0\u7528\u6237\u540D";
        lines.push(`\u2022 ${name} \xB7 ${un}`);
        lines.push(`  UID <code>${escapeHtml(u.userId)}</code> \xB7 Topic <code>${escapeHtml(u.topicId || "-")}</code> \xB7 ${escapeHtml(u.status || "?")}`);
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
        text: `\u274C \u641C\u7D22\u5931\u8D25: ${escapeHtml(e?.message || String(e))}`,
        parse_mode: "HTML"
      });
    }
  }
  async function handleSyncCommandsCommand2(env, threadId, senderId) {
    if (!isOwnerUser2(env, senderId)) {
      await tgCall2(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "\u274C \u4EC5 <code>OWNER_IDS</code> \u53EF\u540C\u6B65 Bot \u547D\u4EE4\u83DC\u5355",
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
      text: res?.ok ? `\u2705 \u5DF2\u540C\u6B65 ${commands.length} \u6761\u547D\u4EE4\u5230 Bot \u83DC\u5355` : `\u274C \u540C\u6B65\u5931\u8D25: ${escapeHtml(res?.description || "unknown")}`,
      parse_mode: "HTML"
    });
  }
  async function handleAdminUiCallback2(query, env, ctx) {
    const data = String(query.data || "");
    const senderId = query.from?.id;
    try {
      if (!senderId || !await isAdminUser2(env, senderId)) {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: "\u65E0\u6743\u9650",
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
        await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: "\u5DF2\u66F4\u65B0" });
        await handleSysinfoCommand2(env, threadId, {
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
            text: "\u{1F9F9} <b>\u786E\u8BA4\u6E05\u7406\u65E0\u6548\u8BDD\u9898\uFF1F</b>\n\u5C06\u626B\u63CF\u5E76\u5904\u7406\u5931\u6548 Topic \u6620\u5C04\uFF0C\u53EF\u80FD\u8017\u65F6\u3002",
            parse_mode: "HTML",
            reply_markup: buildCleanupConfirmKeyboard()
          });
          return;
        }
        if (nav === "cleanup_ok") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: "\u5F00\u59CB\u6E05\u7406" });
          if (handleCleanupCommand2) {
            if (ctx?.waitUntil) ctx.waitUntil(handleCleanupCommand2(threadId, env));
            else await handleCleanupCommand2(threadId, env);
          }
          return;
        }
        if (nav === "cleanup_cancel") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: "\u5DF2\u53D6\u6D88" });
          if (chatId && messageId) {
            await tgCall2(env, "editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: "\u5DF2\u53D6\u6D88\u6E05\u7406\u3002"
            });
          }
          return;
        }
        const navHandlers = {
          sysinfo: () => handleSysinfoCommand2(env, threadId, { page: "overview" }),
          stats: () => handleStatsCommand2(env, threadId),
          rank: () => handleRankCommand2(env, threadId),
          activity: () => handleRankCommand2(env, threadId),
          notes: () => handleNotesCommand2(env, threadId, "/notes"),
          find: async () => {
            await tgCall2(env, "sendMessage", {
              chat_id: env.SUPERGROUP_ID,
              message_thread_id: threadId,
              text: [
                "\u{1F50D} <b>\u67E5\u627E\u7528\u6237</b>",
                "\u7528\u6CD5: <code>/find UID\u6216\u7528\u6237\u540D\u6216\u59D3\u540D</code>",
                "\u5907\u6CE8: <code>/notes \u5173\u952E\u8BCD</code>",
                "\u6D3B\u8DC3: <code>/rank</code>"
              ].join("\n"),
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
          whoami: () => handleWhoamiCommand2(env, threadId, senderId),
          listwords: () => {
            if (typeof handleListWordsCommand2 === "function") {
              return handleListWordsCommand2(env, threadId);
            }
            return tgCall2(env, "sendMessage", {
              chat_id: env.SUPERGROUP_ID,
              message_thread_id: threadId,
              text: "\u8BF7\u4F7F\u7528\u547D\u4EE4 <code>/listwords</code>",
              parse_mode: "HTML"
            });
          },
          help: () => handleHelpCommand2(env, threadId, senderId),
          menu: () => handleMenuCommand2(env, threadId, senderId),
          synccommands: () => handleSyncCommandsCommand2(env, threadId, senderId)
        };
        const navFn = navHandlers[nav];
        if (!navFn) {
          await tgCall2(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "\u672A\u77E5\u5BFC\u822A",
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
            text: "\u65E0\u6548\u7528\u6237 ID",
            show_alert: true
          });
          return;
        }
        const tid = await resolveThreadIdForUser2(env, userId) || threadId;
        if (!tid) {
          await tgCall2(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "\u627E\u4E0D\u5230\u7528\u6237\u8BDD\u9898",
            show_alert: true
          });
          return;
        }
        if (action === "banask") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id });
          await tgCall2(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: tid,
            text: `\u26A0\uFE0F <b>\u786E\u8BA4\u5C01\u7981\u7528\u6237</b> <code>${escapeHtml(userId)}</code>\uFF1F
\u5BF9\u65B9\u5C06\u6536\u5230\u901A\u77E5\u4E14\u65E0\u6CD5\u7EE7\u7EED\u53D1\u6D88\u606F\u3002`,
            parse_mode: "HTML",
            reply_markup: buildBanConfirmKeyboard(userId)
          });
          return;
        }
        if (action === "bancancel") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: "\u5DF2\u53D6\u6D88" });
          if (chatId && messageId) {
            await tgCall2(env, "editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: "\u5DF2\u53D6\u6D88\u5C01\u7981\u3002"
            });
          }
          return;
        }
        if (action === "closeask") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id });
          await tgCall2(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: tid,
            text: `\u26A0\uFE0F <b>\u786E\u8BA4\u5173\u95ED\u5BF9\u8BDD</b> <code>${escapeHtml(userId)}</code>\uFF1F
\u5C06\u5173\u95ED Forum Topic\uFF0C\u7528\u6237\u6D88\u606F\u4E0D\u518D\u63A5\u5165\uFF08\u53EF\u7528\u6253\u5F00\u6062\u590D\uFF09\u3002`,
            parse_mode: "HTML",
            reply_markup: buildCloseConfirmKeyboard(userId)
          });
          return;
        }
        if (action === "closecancel") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: "\u5DF2\u53D6\u6D88" });
          if (chatId && messageId) {
            await tgCall2(env, "editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: "\u5DF2\u53D6\u6D88\u5173\u95ED\u5BF9\u8BDD\u3002"
            });
          }
          return;
        }
        if (action === "resetask") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id });
          await tgCall2(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: tid,
            text: `\u26A0\uFE0F <b>\u786E\u8BA4\u91CD\u7F6E\u9A8C\u8BC1</b> <code>${escapeHtml(userId)}</code>\uFF1F
\u5C06\u53D6\u6D88\u6C38\u4E45\u4FE1\u4EFB\uFF0C\u7528\u6237\u4E0B\u6B21\u9700\u91CD\u65B0\u9A8C\u8BC1\u3002`,
            parse_mode: "HTML",
            reply_markup: buildResetConfirmKeyboard(userId)
          });
          return;
        }
        if (action === "resetcancel") {
          await tgCall2(env, "answerCallbackQuery", { callback_query_id: query.id, text: "\u5DF2\u53D6\u6D88" });
          if (chatId && messageId) {
            await tgCall2(env, "editMessageText", {
              chat_id: chatId,
              message_id: messageId,
              text: "\u5DF2\u53D6\u6D88\u91CD\u7F6E\u9A8C\u8BC1\u3002"
            });
          }
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
            text: "\u672A\u77E5\u64CD\u4F5C",
            show_alert: true
          });
          return;
        }
        const busyText = action === "banok" || action === "ban" ? "\u6B63\u5728\u5C01\u7981\u2026" : action === "closeok" || action === "close" ? "\u6B63\u5728\u5173\u95ED\u2026" : action === "resetok" || action === "reset" ? "\u6B63\u5728\u91CD\u7F6E\u2026" : "\u5904\u7406\u4E2D\u2026";
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: busyText
        });
        await fn();
        return;
      }
      await tgCall2(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "\u672A\u77E5\u56DE\u8C03",
        show_alert: true
      });
    } catch (e) {
      recordSystemError2("admin_ui_callback_failed", e, { data }, env);
      try {
        await tgCall2(env, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
          show_alert: true
        });
      } catch {
      }
    }
  }
  return {
    bumpDailyStat: bumpDailyStat2,
    getDailyStats,
    getRecentDailySeries,
    loadTodayActivity,
    handleHelpCommand: handleHelpCommand2,
    handleMenuCommand: handleMenuCommand2,
    handleSysinfoCommand: handleSysinfoCommand2,
    handleStatsCommand: handleStatsCommand2,
    handleRankCommand: handleRankCommand2,
    handleNotesCommand: handleNotesCommand2,
    handleWhoamiCommand: handleWhoamiCommand2,
    handleFindCommand: handleFindCommand2,
    handleSyncCommandsCommand: handleSyncCommandsCommand2,
    handleAdminUiCallback: handleAdminUiCallback2
  };
}

// worker.js
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
  if (!text || keywords.length === 0) return { isSpam: false, matchedWord: null };
  const lower = text.toLowerCase();
  for (const word of keywords) {
    if (lower.includes(word)) return { isSpam: true, matchedWord: word };
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
  SPAM_SILENCE_MODE: false
  // 静默丢弃模式（不通知管理员）
};
var GATEWAY_VERSION = "1.0.0";
var threadHealthCache = /* @__PURE__ */ new Map();
var topicCreateInFlight = /* @__PURE__ */ new Map();
var adminStatusCache = /* @__PURE__ */ new Map();
var spamKeywordsCache = null;
var messageHashCache = /* @__PURE__ */ new Map();
var threadNotFoundCache = /* @__PURE__ */ new Map();
var ruleCache = /* @__PURE__ */ new WeakMap();
var THREAD_NOT_FOUND_TTL_MS = 5 * 60 * 1e3;
var THREAD_NOT_FOUND_MAX_ENTRIES = 1e3;
var ADMIN_STATUS_MAX_ENTRIES = 1e3;
var THREAD_HEALTH_MAX_ENTRIES = 1e3;
var MESSAGE_HASH_MAX_ENTRIES = 5e3;
function setBoundedCache(cache, key, value, maxEntries) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}
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
var BLOCKED_WORDS = [
  "\u8D4C\u535A",
  "\u8272\u60C5",
  "\u4EE3\u5F00\u53D1",
  "\u52A0\u5FAE\u4FE1"
  // ↑ 在此添加更多屏蔽词，每行一个，用引号包裹、逗号结尾
];
var blockedWordsCache = { data: null, ts: 0, ttl: 6e4 };
async function getBlockedWords(env, forceRefresh = false) {
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
    Logger.warn("blocked_words_kv_parse_error", { error: e.message });
  }
  const merged = [.../* @__PURE__ */ new Set([...BLOCKED_WORDS, ...kvWords])];
  blockedWordsCache.data = merged;
  blockedWordsCache.ts = now;
  return merged;
}
var Logger = createLogger();
var RECENT_SYSTEM_ERRORS_MAX = 12;
var recentSystemErrors = [];
function recordSystemError(action, error, data = {}, env = null) {
  const entry = {
    ts: Date.now(),
    action: String(action || "unknown"),
    error: error instanceof Error ? error.message : String(error ?? ""),
    userId: data?.userId != null ? String(data.userId) : void 0
  };
  recentSystemErrors.unshift(entry);
  if (recentSystemErrors.length > RECENT_SYSTEM_ERRORS_MAX) {
    recentSystemErrors.length = RECENT_SYSTEM_ERRORS_MAX;
  }
  if (env?.TOPIC_MAP) {
    Promise.resolve().then(async () => {
      let list = [];
      try {
        const raw = await env.TOPIC_MAP.get("sys:recent_errors");
        if (raw) list = JSON.parse(raw);
      } catch {
        list = [];
      }
      if (!Array.isArray(list)) list = [];
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
var _loggerError = Logger.error.bind(Logger);
Logger.error = (action, error, data = {}) => {
  try {
    recordSystemError(action, error, data, data?.env || null);
  } catch {
  }
  return _loggerError(action, error, data);
};
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
    getBlockedWords(env),
    getVerificationState(env, user.userId ?? message.chat?.id),
    getStoredRules(env)
  ]);
  const rules = blockedWords.filter(Boolean).map((pattern, index) => ({
    ruleId: `legacy_blocked:${index}`,
    ruleType: "blocked_keyword",
    matchType: "contains",
    pattern,
    action: "reject",
    priority: index
  }));
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
    policy: ({ message, user }) => evaluateLegacyPolicy(env, message, user),
    logger: Logger,
    supergroupId: env.SUPERGROUP_ID
  });
}
function parseIdAllowlist(raw) {
  return String(raw || "").split(/[,;\s]+/g).map((value) => value.trim()).filter((value) => /^\d{1,20}$/.test(value));
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
    onRulesChanged: () => ruleCache.delete(env.TG_BOT_DB)
  });
}
async function setPersistentTrust(env, userId, trustLevel) {
  if (!env.TG_BOT_DB) throw new Error("D1 'TG_BOT_DB' not bound");
  const d1Storage = createD1Storage(env.TG_BOT_DB);
  const existing = await d1Storage.getUser(userId) || await createKVStorage(env.TOPIC_MAP).getUser(userId) || { userId: String(userId) };
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
    updatedAt: Date.now()
  });
}
function secureRandomInt(min, max) {
  const range = max - min;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return min + bytes[0] % range;
}
function secureRandomId(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
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
function isSparseTelegramFrom(from) {
  if (!from || typeof from !== "object") return true;
  const hasName = Boolean(String(from.first_name || "").trim() || String(from.last_name || "").trim());
  const hasUsername = Boolean(String(from.username || "").trim());
  return !hasName && !hasUsername;
}
async function saveUserProfileSnapshot(env, userId, from) {
  if (!env?.TOPIC_MAP || !userId || isSparseTelegramFrom(from)) return;
  try {
    await env.TOPIC_MAP.put(`profile:${userId}`, JSON.stringify({
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      username: from.username || null,
      saved_at: Date.now()
    }), { expirationTtl: 30 * 24 * 3600 });
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
      const rec = { thread_id: user.topicId, title: buildTopicTitle2(resolvedFrom), closed: false };
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 75));
      const refreshed = await storage.getUser(userId);
      if (refreshed?.topicId) {
        const rec = { thread_id: refreshed.topicId, title: buildTopicTitle2(resolvedFrom), closed: false };
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
  await sendVerificationChallenge(userId, env, pendingMsgId || null);
}
function parseAdminIdAllowlist(env) {
  const set = new Set(parseIdAllowlist(env.ADMIN_IDS));
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
    Logger.warn("admin_check_failed", { userId });
    return false;
  }
}
async function getAllKeys(env, prefix) {
  const allKeys = [];
  let cursor = void 0;
  do {
    const result = await env.TOPIC_MAP.list({ prefix, cursor });
    allKeys.push(...result.keys);
    cursor = result.list_complete ? void 0 : result.cursor;
  } while (cursor);
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
async function verifyTurnstileToken(token, secretKey, remoteIp) {
  const formData = new URLSearchParams();
  formData.append("secret", secretKey);
  formData.append("response", token);
  if (remoteIp) {
    formData.append("remoteip", remoteIp);
  }
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString()
    });
    const result = await resp.json();
    return { success: result.success === true, error: result["error-codes"]?.join(", ") };
  } catch (e) {
    Logger.error("turnstile_verify_error", e);
    return { success: false, error: e.message };
  }
}
function getSpamKeywords(env) {
  if (spamKeywordsCache) return spamKeywordsCache;
  const raw = (env.SPAM_KEYWORDS || "").toString().trim();
  spamKeywordsCache = parseSpamKeywords(raw);
  if (spamKeywordsCache.length > 0) {
    Logger.info("spam_keywords_loaded", { count: spamKeywordsCache.length });
  }
  return spamKeywordsCache;
}
async function detectRepeatMessage(userId, msg) {
  const hash = computeMessageHash(msg);
  if (!hash) return { isRepeat: false, count: 0 };
  const cacheKey = `msghash:${userId}:${hash}`;
  const now = Date.now();
  const cached = messageHashCache.get(cacheKey);
  if (cached && now - cached.ts > CONFIG.SPAM_MESSAGE_HASH_TTL * 1e3) {
    messageHashCache.delete(cacheKey);
    const count2 = 1;
    setBoundedCache(messageHashCache, cacheKey, { count: count2, ts: now }, MESSAGE_HASH_MAX_ENTRIES);
    return { isRepeat: false, count: count2 };
  }
  const count = (cached?.count || 0) + 1;
  setBoundedCache(messageHashCache, cacheKey, { count, ts: now }, MESSAGE_HASH_MAX_ENTRIES);
  if (count >= CONFIG.SPAM_REPEAT_MESSAGE_LIMIT) {
    return { isRepeat: true, count };
  }
  return { isRepeat: false, count };
}
function pruneMessageHashCache(now) {
  const ttl = CONFIG.SPAM_MESSAGE_HASH_TTL * 1e3;
  for (const [key, value] of messageHashCache) {
    if (now - value.ts > ttl) {
      messageHashCache.delete(key);
    }
  }
}
async function spamCheck(msg, userId, env) {
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
    const verifyTs = await ephemeralStore(env).getVerificationTimestamp(userId);
    if (!verifyTs) {
      reasons.push("new_user_link");
      details.linkBlockRemainingHours = Math.ceil(CONFIG.NEW_USER_LINK_BLOCK_SECONDS / 3600);
    } else {
      const elapsed = (Date.now() - parseInt(verifyTs)) / 1e3;
      if (elapsed < CONFIG.NEW_USER_LINK_BLOCK_SECONDS) {
        const remainingHours = Math.ceil((CONFIG.NEW_USER_LINK_BLOCK_SECONDS - elapsed) / 3600);
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
async function notifyAdmin(env, alertType, message, threadId) {
  Logger.warn("admin_alert", { alertType, messageLength: message.length });
  const body = threadId ? { message_thread_id: threadId } : {};
  try {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      text: message,
      parse_mode: "Markdown",
      ...body
    });
  } catch (e) {
    Logger.error("admin_alert_failed", e, { alertType });
  }
}
async function updateSpamStats(env, reasons) {
  try {
    for (const reason of reasons) {
      const countKey = `stats:spam:${reason}`;
      const current = parseInt(await env.TOPIC_MAP.get(countKey) || "0");
      await env.TOPIC_MAP.put(countKey, String(current + 1), { expirationTtl: 2592e3 });
    }
    const totalKey = "stats:spam:total";
    const total = parseInt(await env.TOPIC_MAP.get(totalKey) || "0");
    await env.TOPIC_MAP.put(totalKey, String(total + 1), { expirationTtl: 2592e3 });
  } catch (e) {
    Logger.warn("spam_stats_update_failed", { error: e.message });
  }
}
async function handleSpamMessage(env, userId, msg, spamResult, threadId, ctx) {
  Logger.warn("spam_detected", {
    userId,
    reasons: spamResult.reasons,
    details: spamResult.details
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(updateSpamStats(env, spamResult.reasons));
  }
  if (CONFIG.SPAM_NOTIFY_ADMIN && !CONFIG.SPAM_SILENCE_MODE) {
    const reasonText = spamResult.reasons.map((r) => {
      switch (r) {
        case "keyword":
          return `\u{1F511} \u5173\u952E\u8BCD: \`${spamResult.details.keyword}\``;
        case "new_user_link":
          return `\u{1F517} \u65B0\u7528\u6237\u94FE\u63A5 (\u5269\u4F59 ${spamResult.details.linkBlockRemainingHours}h)`;
        case "repeat_message":
          return `\u{1F504} \u91CD\u590D\u6D88\u606F (${spamResult.details.repeatCount}\u6B21)`;
        default:
          return r;
      }
    }).join("\n");
    const body = threadId ? { message_thread_id: threadId } : {};
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      text: `\u26A0\uFE0F **\u68C0\u6D4B\u5230\u7591\u4F3C\u9A9A\u6270\u6D88\u606F**

\u{1F464} \u7528\u6237: \`${userId}\`
${reasonText}

\u{1F4DD} \u6D88\u606F\u5DF2\u62E6\u622A\u3002\u4F7F\u7528 /ban \u5C01\u7981\u8BE5\u7528\u6237\u3002`,
      parse_mode: "Markdown",
      ...body
    });
  }
}
var VERIFY_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>\u4EBA\u673A\u9A8C\u8BC1</title>
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
  <div class="icon">\u{1F6E1}\uFE0F</div>
  <h2>\u4EBA\u673A\u9A8C\u8BC1</h2>
  <p class="desc">\u8BF7\u5B8C\u6210\u4E0B\u65B9\u9A8C\u8BC1\u4EE5\u786E\u8BA4\u60A8\u4E0D\u662F\u673A\u5668\u4EBA\u3002<br>\u9A8C\u8BC1\u901A\u8FC7\u540E\u60A8\u7684\u6D88\u606F\u5C06\u81EA\u52A8\u9001\u8FBE\u3002</p>
  <div class="turnstile-container">
    <div class="cf-turnstile" data-sitekey="{{SITE_KEY}}" data-callback="onTurnstileSuccess" data-error-callback="onTurnstileError" data-theme="light"></div>
  </div>
  <div id="status">\u6B63\u5728\u52A0\u8F7D\u9A8C\u8BC1\u7EC4\u4EF6...</div>
  <a id="back-btn" href="tg://resolve" style="display:none;margin-top:16px;background:#0088cc;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:16px;text-decoration:none;">\u{1F4F1} \u8FD4\u56DE Telegram</a>
  <div class="footer">
    User: <span>{{USER_ID}}</span> \xB7 Code: <span>{{CODE}}</span>
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
  showStatus('\u2705 \u9A8C\u8BC1\u901A\u8FC7\uFF01\u6B63\u5728\u901A\u77E5\u673A\u5668\u4EBA...', 'success');
  fetch('{{WORKER_URL}}/verify-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, code: '{{CODE}}', userId: '{{USER_ID}}' })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      var msg = '\u2705 \u9A8C\u8BC1\u6210\u529F\uFF01\u673A\u5668\u4EBA\u5DF2\u6536\u5230\u60A8\u7684\u6D88\u606F\u3002';
      if (data.pendingCount > 0) {
        msg += '\uFF08' + data.pendingCount + ' \u6761\u6D88\u606F\u5C06\u4E8E\u6570\u79D2\u5185\u9001\u8FBE\uFF09';
      }
      showStatus(msg, 'success');
      document.querySelector('.desc').textContent = '\u8BF7\u8FD4\u56DE Telegram\uFF0C\u673A\u5668\u4EBA\u5DF2\u5411\u60A8\u53D1\u9001\u4E86\u9A8C\u8BC1\u901A\u8FC7\u901A\u77E5\u3002';
      // \u663E\u793A\u8FD4\u56DE Telegram \u6309\u94AE
      var btn = document.getElementById('back-btn');
      if (btn) {
        btn.style.display = 'inline-block';
      }
    } else {
      var errMap = {
        'turnstile_failed': '\u4EBA\u673A\u9A8C\u8BC1\u672A\u901A\u8FC7\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5',
        'code_invalid_or_expired': '\u9A8C\u8BC1\u94FE\u63A5\u5DF2\u8FC7\u671F\uFF08\u6709\u6548\u671F10\u5206\u949F\uFF09\uFF0C\u8BF7\u8FD4\u56DE Telegram \u91CD\u65B0\u53D1\u9001\u6D88\u606F\u83B7\u53D6\u65B0\u7684\u9A8C\u8BC1\u94FE\u63A5',
        'server_not_configured': '\u670D\u52A1\u5668\u672A\u5B8C\u6210\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458'
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
  // Turnstile \u5BA2\u6237\u7AEF\u9519\u8BEF\u7801\uFF1Ahttps://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/
  var code = (errorCode == null || errorCode === '') ? '' : String(errorCode);
  var hint = '';
  if (code === '110200') {
    hint = '\uFF08\u57DF\u540D\u672A\u6388\u6743\uFF1A\u8BF7\u5728 Cloudflare Turnstile \u2192 Hostname \u4E2D\u6DFB\u52A0\u5F53\u524D Worker \u57DF\u540D\uFF0C\u5982 xxx.workers.dev\uFF09';
  } else if (code === '110110') {
    hint = '\uFF08Site Key \u65E0\u6548\uFF1A\u8BF7\u68C0\u67E5 Dashboard \u4E2D\u7684 TURNSTILE_SITE_KEY\uFF09';
  } else if (code === '110600') {
    hint = '\uFF08\u6311\u6218\u8D85\u65F6\uFF1A\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\uFF1B\u82E5\u5728 Telegram \u5185\u7F6E\u6D4F\u89C8\u5668\u5931\u8D25\uFF0C\u53EF\u6539\u7528\u7CFB\u7EDF\u6D4F\u89C8\u5668\u6253\u5F00\u94FE\u63A5\uFF09';
  } else if (code === '300030' || code === '300031') {
    hint = '\uFF08\u7EC4\u4EF6\u521D\u59CB\u5316\u5931\u8D25\uFF1A\u591A\u4E3A CSP/\u7F51\u7EDC\u62E6\u622A challenges.cloudflare.com\uFF09';
  } else if (!code) {
    hint = '\uFF08\u65E0\u6CD5\u52A0\u8F7D challenges.cloudflare.com\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC/\u4EE3\u7406/\u5730\u533A\u8BBF\u95EE\uFF09';
  }
  showStatus('\u26A0\uFE0F \u9A8C\u8BC1\u7EC4\u4EF6\u5931\u8D25' + (code ? ' [' + code + ']' : '') + '\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5' + hint, 'error');
}
// \u811A\u672C\u957F\u65F6\u95F4\u672A\u5C31\u7EEA\u65F6\u7ED9\u51FA\u63D0\u793A\uFF08\u533A\u5206\u811A\u672C\u88AB\u5899\u4E0E widget \u914D\u7F6E\u9519\u8BEF\uFF09
setTimeout(function() {
  if (!window.turnstile && !submitted) {
    showStatus('\u26A0\uFE0F \u672A\u80FD\u52A0\u8F7D Turnstile \u811A\u672C\uFF08challenges.cloudflare.com\uFF09\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\uFF0C\u6216\u8BA9\u7BA1\u7406\u5458\u6682\u65F6\u5173\u95ED TURNSTILE_* \u53D8\u91CF\u4EE5\u4F7F\u7528\u672C\u5730\u9898\u5E93\u9A8C\u8BC1\u3002', 'error');
  }
}, 8000);
</script>
</body>
</html>`;
var legacyApp = {
  async fetch(request, env, ctx) {
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");
    const normalizedEnv = {
      ...env,
      SUPERGROUP_ID: String(env.SUPERGROUP_ID),
      BOT_TOKEN: String(env.BOT_TOKEN)
    };
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
      return new Response("Error: SUPERGROUP_ID must start with -100");
    }
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response("OK");
      }
      if (url.pathname === "/verify" || url.pathname.endsWith("/verify")) {
        const code = url.searchParams.get("code");
        const userId = url.searchParams.get("uid");
        const siteKey = (env.TURNSTILE_SITE_KEY || "").toString().trim();
        if (!code || !userId || !siteKey) {
          return new Response(
            '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h2>\u274C \u53C2\u6570\u65E0\u6548</h2><p>\u7F3A\u5C11\u9A8C\u8BC1\u4FE1\u606F\u6216\u7CFB\u7EDF\u672A\u914D\u7F6E Turnstile\u3002</p></body></html>',
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
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
          VERIFY_PAGE_HTML.replace(/{{SITE_KEY}}/g, escapeHtml(siteKey)).replace(/{{CODE}}/g, escapeHtml(code)).replace(/{{USER_ID}}/g, escapeHtml(userId)).replace(/{{WORKER_URL}}/g, escapeHtml(workerUrl)),
          { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp } }
        );
      }
      return new Response("Not Found", { status: 404 });
    }
    if ((url.pathname === "/verify-callback" || url.pathname.endsWith("/verify-callback")) && request.method === "POST") {
      try {
        const body = await request.json();
        const { token, code, userId } = body || {};
        if (!token || !code || !userId) {
          return new Response(JSON.stringify({ success: false, error: "missing_params" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
        const turnstileSecret = (env.TURNSTILE_SECRET_KEY || "").toString().trim();
        if (!turnstileSecret) {
          return new Response(JSON.stringify({ success: false, error: "server_not_configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
        const verifyResult = await verifyTurnstileToken(token, turnstileSecret);
        if (!verifyResult.success) {
          Logger.warn("turnstile_token_invalid", { userId, error: verifyResult.error });
          return new Response(JSON.stringify({ success: false, error: "turnstile_failed", detail: verifyResult.error }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          });
        }
        const storedUserId = await env.TOPIC_MAP.get(`turnstile_code:${code}`);
        if (!storedUserId || storedUserId !== String(userId)) {
          return new Response(JSON.stringify({ success: false, error: "code_invalid_or_expired" }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          });
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
                message_id: parseInt(verifyMsgId)
              });
            } catch (e) {
            }
            await env.TOPIC_MAP.delete(`turnstile_msg:${code}`);
          }
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: Number(userId),
            text: "\u2726 \u9A8C\u8BC1\u901A\u8FC7\n\n\u6709\u4EC0\u4E48\u53EF\u4EE5\u5E2E\u4F60\u7684\uFF1F\u76F4\u63A5\u53D1\u6D88\u606F\u5C31\u597D\u3002",
            parse_mode: "Markdown"
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
              ctx.waitUntil((async () => {
                let forwardedCount = 0;
                const limited = pendingIds.slice(0, CONFIG.PENDING_MAX_MESSAGES);
                const topicFrom = await resolveUserFromForTopic(normalizedEnv, userId, null);
                for (const pendingId of limited) {
                  if (!pendingId) continue;
                  const fakeMsg = {
                    message_id: pendingId,
                    chat: { id: Number(userId), type: "private" },
                    from: topicFrom
                  };
                  try {
                    await forwardToTopic(fakeMsg, userId, `user:${userId}`, normalizedEnv, ctx);
                    forwardedCount++;
                  } catch (e) {
                    Logger.error("pending_turnstile_forward_failed", e, { userId, messageId: pendingId });
                  }
                }
                if (forwardedCount > 0) {
                  await tgCall(normalizedEnv, "sendMessage", {
                    chat_id: Number(userId),
                    text: `\u{1F4E9} \u521A\u624D\u7684 ${forwardedCount} \u6761\u6D88\u606F\u5DF2\u5E2E\u60A8\u9001\u8FBE\u3002`
                  });
                }
                await env.TOPIC_MAP.delete(pendingKey);
              })());
            }
          } catch (e) {
            Logger.error("pending_turnstile_parse_failed", e, { userId });
          }
        }
        return new Response(JSON.stringify({ success: true, pendingCount }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        Logger.error("verify_callback_error", e);
        return new Response(JSON.stringify({ success: false, error: "server_error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      Logger.warn("invalid_content_type", { contentType });
      return new Response("OK");
    }
    let update;
    try {
      update = await request.json();
      if (!update || typeof update !== "object") {
        Logger.warn("invalid_json_structure", { update: typeof update });
        return new Response("OK");
      }
    } catch (e) {
      Logger.error("json_parse_failed", e);
      return new Response("OK");
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
        await handleAdminUiCallback(update.callback_query, normalizedEnv, ctx);
      } else if (cbData.startsWith("v1:")) {
        await createLegacyAdminService(normalizedEnv).handleCallbackQuery(update.callback_query);
      } else {
        await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      }
      return new Response("OK");
    }
    const msg = update.message;
    if (!msg) return new Response("OK");
    const now = Date.now();
    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, now));
    if (Math.random() < 0.01) {
      pruneMessageHashCache(now);
    }
    if (msg.chat && msg.chat.type === "private") {
      try {
        const ptext = removeCommandBotSuffix((msg.text || "").trim());
        if (ptext === "/help") {
          await tgCall(normalizedEnv, "sendMessage", {
            chat_id: msg.chat.id,
            text: [
              "\u{1F44B} <b>\u79C1\u804A\u7F51\u5173</b>",
              "",
              "\u76F4\u63A5\u53D1\u9001\u6587\u5B57/\u56FE\u7247/\u6587\u4EF6\u5373\u53EF\u8054\u7CFB\u7BA1\u7406\u5458\u3002",
              "\u9996\u6B21\u4F7F\u7528\u53EF\u80FD\u9700\u8981\u5B8C\u6210\u4EBA\u673A\u9A8C\u8BC1\u3002",
              "",
              "\u5E38\u7528\uFF1A",
              "\u2022 /start \u2014 \u5F00\u59CB\u6216\u91CD\u65B0\u89E6\u53D1\u9A8C\u8BC1",
              "\u2022 /help \u2014 \u663E\u793A\u672C\u8BF4\u660E",
              "",
              "\u7BA1\u7406\u6307\u4EE4\u4EC5\u5728\u8D85\u7EA7\u7FA4\u8BDD\u9898\u5185\u7531\u7BA1\u7406\u5458\u4F7F\u7528\u3002"
            ].join("\n"),
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
        const errText = `\u26A0\uFE0F \u7CFB\u7EDF\u7E41\u5FD9\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error("private_message_failed", e, { userId: msg.chat.id });
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
        await handleAdminReply(msg, normalizedEnv, ctx);
        return new Response("OK");
      }
    }
    return new Response("OK");
  }
};
async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;
  await saveUserProfileSnapshot(env, userId, msg.from);
  const rateLimit = await checkRateLimit(userId, env, "message", CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "\u26A0\uFE0F \u53D1\u9001\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002"
    });
    return;
  }
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
    return;
  }
  const [isBanned, isMuted, blockedWords, verification] = await Promise.all([
    env.TOPIC_MAP.get(`banned:${userId}`),
    env.TOPIC_MAP.get(`muted:${userId}`),
    getBlockedWords(env),
    getVerificationState(env, userId)
  ]);
  const blockedRules = blockedWords.map((pattern, index) => ({
    ruleId: `legacy_blocked:${index}`,
    ruleType: "blocked_keyword",
    matchType: "contains",
    pattern,
    action: "reject",
    priority: index
  }));
  const policyResult = evaluateMessagePolicy({
    message: msg,
    user: {
      status: isBanned ? "banned" : "active",
      trustLevel: verification?.type === "trusted" ? "trusted" : "normal"
    },
    verification,
    rules: blockedRules
  });
  if (policyResult.reason === "banned") {
    try {
      const noticeKey = `ban_notice:${userId}`;
      const noticed = await env.TOPIC_MAP.get(noticeKey);
      if (!noticed) {
        await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "\u{1F6AB} \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u5C01\u7981\uFF0C\u6682\u65F6\u65E0\u6CD5\u7EE7\u7EED\u53D1\u9001\u6D88\u606F\u3002\u5982\u6709\u7591\u95EE\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u5904\u7406\u3002"
        });
        await env.TOPIC_MAP.put(noticeKey, "1", { expirationTtl: 3600 });
      }
    } catch (e) {
      Logger.warn("ban_notice_failed", { userId, error: e?.message });
    }
    return;
  }
  if (isMuted) {
    try {
      const noticeKey = `mute_notice:${userId}`;
      if (!await env.TOPIC_MAP.get(noticeKey)) {
        await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "\u{1F507} \u60A8\u5F53\u524D\u5904\u4E8E\u9759\u97F3\u72B6\u6001\uFF0C\u6D88\u606F\u4E0D\u4F1A\u9001\u8FBE\u7BA1\u7406\u5458\u3002\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u53D6\u6D88\u9759\u97F3\u3002"
        });
        await env.TOPIC_MAP.put(noticeKey, "1", { expirationTtl: 3600 });
      }
    } catch {
    }
    return;
  }
  if (policyResult.reason === "blocked_keyword") {
    const matchedIndex = Number(policyResult.matchedRuleId?.split(":")[1]);
    Logger.info("message_blocked_by_word", { userId, word: blockedWords[matchedIndex] });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "\u{1F6AB} \u60A8\u7684\u6D88\u606F\u5305\u542B\u8FDD\u89C4\u5185\u5BB9\uFF0C\u5DF2\u88AB\u62E6\u622A\uFF0C\u8BF7\u4FEE\u6539\u540E\u91CD\u65B0\u53D1\u9001\u3002"
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
    const isStart = msg.text && msg.text.trim() === "/start";
    const pendingMsgId = isStart ? null : msg.message_id;
    await sendVerificationChallenge(userId, env, pendingMsgId, msg.from);
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
  await bumpDailyStat(env, "messages_in", 1);
  await forwardToTopic(msg, userId, key, env, ctx);
}
async function forwardToTopic(msg, userId, key, env, ctx) {
  const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
  if (needsVerify) {
    await sendVerificationChallenge(userId, env, msg.message_id || null, msg.from);
    return;
  }
  let rec = await safeGetJSON(env, key, null);
  if (rec && rec.closed) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: "\u{1F6AB} \u5F53\u524D\u5BF9\u8BDD\u5DF2\u88AB\u7BA1\u7406\u5458\u5173\u95ED\u3002" });
    return;
  }
  const retryKey = `retry:${userId}`;
  let retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) ?? "0", 10);
  if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
    await tgCall(env, "sendMessage", { chat_id: userId, text: "\u274C \u7CFB\u7EDF\u7E41\u5FD9\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002" });
    await env.TOPIC_MAP.delete(retryKey);
    return;
  }
  if (!rec || !rec.thread_id) {
    rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
    if (!rec || !rec.thread_id) {
      throw new Error("\u521B\u5EFA\u8BDD\u9898\u5931\u8D25");
    }
  } else if (!rec.title || rec.title === "User" || /^User @/i.test(rec.title)) {
    try {
      const resolvedFrom = await resolveUserFromForTopic(env, userId, msg.from);
      const title = buildTopicTitle2(resolvedFrom);
      if (title && title !== "User" && title !== rec.title) {
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
    const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
    if (!mappedUser) {
      await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
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
    await handleMediaGroup(msg, env, ctx, {
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
  if (desc.includes("chat not found")) throw new Error(`\u7FA4\u7EC4ID\u9519\u8BEF: ${env.SUPERGROUP_ID}`);
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
      `\u26A0\uFE0F **\u6D88\u606F\u8F6C\u53D1\u5B8C\u5168\u5931\u8D25**

\u{1F464} \u7528\u6237: \`${userId}\`
\u{1F4DD} \u8BDD\u9898: \`${threadId}\`
\u274C forwardMessage: \`${res.description}\`
\u274C copyMessage: \`${copyRes.description}\``
    );
  }
}
function removeCommandBotSuffix(text) {
  if (!text || !text.startsWith("/")) return text;
  return text.replace(/^\/([a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "/$1");
}
async function handleAdminReply(msg, env, ctx) {
  try {
    await _handleAdminReplyInner(msg, env, ctx);
  } catch (e) {
    Logger.error("admin_reply_failed", e, {
      threadId: msg?.message_thread_id,
      senderId: msg?.from?.id
    });
  }
}
function isOwnerUser(env, userId) {
  return idAllowlistHas(env.OWNER_IDS, userId);
}
var _adminHandlersCache = null;
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
      note: handleNoteCommand
    }
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
function handleNotesCommand(env, threadId, queryText = "") {
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
    } catch {
    }
  }
  return null;
}
async function handlePanelCommand(env, threadId, userId) {
  const from = await resolveUserFromForTopic(env, userId, null);
  const name = escapeHtml([from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "\u672A\u77E5");
  const un = from.username ? `@${escapeHtml(from.username)}` : "\u65E0\u7528\u6237\u540D";
  const ban = await env.TOPIC_MAP.get(`banned:${userId}`);
  const muted = await env.TOPIC_MAP.get(`muted:${userId}`);
  const rec = await safeGetJSON(env, `user:${userId}`, null);
  const note = await env.TOPIC_MAP.get(`note:${userId}`);
  const text = [
    "\u{1F39B} <b>\u7528\u6237\u9762\u677F</b>",
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    `\u{1F464} ${name} \xB7 ${un}`,
    `UID <code>${userId}</code>`,
    `\u72B6\u6001  \u5C01\u7981:${ban ? "\u662F" : "\u5426"} \xB7 \u9759\u97F3:${muted ? "\u662F" : "\u5426"} \xB7 \u5173\u95ED:${rec?.closed ? "\u662F" : "\u5426"}`,
    note ? `\u{1F4DD} ${escapeHtml(String(note).slice(0, 80))}` : "\u{1F4DD} \u65E0\u5907\u6CE8",
    "",
    "\u{1F447} \u70B9\u6309\u94AE\u64CD\u4F5C \xB7 \u5C01\u7981\u9700\u4E8C\u6B21\u786E\u8BA4"
  ].join("\n");
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text,
    parse_mode: "HTML",
    reply_markup: buildUserActionKeyboard(userId)
  });
}
async function handleMuteCommand(env, threadId, userId) {
  await env.TOPIC_MAP.put(`muted:${userId}`, "1");
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { isMuted: true });
    } catch {
    }
  }
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u{1F507} <b>\u5DF2\u9759\u97F3</b>\uFF1A\u7528\u6237\u6D88\u606F\u4E0D\u518D\u8F6C\u53D1\u5230\u672C\u7FA4",
    parse_mode: "HTML"
  });
  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: "\u{1F507} \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u9759\u97F3\uFF0C\u6D88\u606F\u6682\u65F6\u4E0D\u4F1A\u9001\u8FBE\u7BA1\u7406\u5458\u3002"
  });
}
async function handleUnmuteCommand(env, threadId, userId) {
  await env.TOPIC_MAP.delete(`muted:${userId}`);
  await env.TOPIC_MAP.delete(`mute_notice:${userId}`);
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { isMuted: false });
    } catch {
    }
  }
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u{1F50A} <b>\u5DF2\u53D6\u6D88\u9759\u97F3</b>",
    parse_mode: "HTML"
  });
  await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: "\u{1F50A} \u60A8\u7684\u9759\u97F3\u5DF2\u53D6\u6D88\uFF0C\u53EF\u4EE5\u7EE7\u7EED\u8054\u7CFB\u7BA1\u7406\u5458\u3002"
  });
}
async function handleNoteCommand(env, threadId, userId, text) {
  const note = text.replace(/^\/note(@\w+)?\s*/i, "").trim();
  if (!note) {
    const existing = await env.TOPIC_MAP.get(`note:${userId}`);
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: existing ? `\u{1F4DD} <b>\u5F53\u524D\u5907\u6CE8</b>
${escapeHtml(existing)}

\u7528\u6CD5: <code>/note \u65B0\u5907\u6CE8</code>\uFF08\u53D1 <code>/note clear</code> \u6E05\u7A7A\uFF09` : "\u{1F4DD} \u6682\u65E0\u5907\u6CE8\u3002\u7528\u6CD5: <code>/note \u5185\u5BB9</code>",
      parse_mode: "HTML"
    });
    return;
  }
  if (note.toLowerCase() === "clear" || note === "-" || note === "\u6E05\u9664") {
    await env.TOPIC_MAP.delete(`note:${userId}`);
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: "\u2705 \u5907\u6CE8\u5DF2\u6E05\u9664"
    });
    return;
  }
  await env.TOPIC_MAP.put(`note:${userId}`, note.slice(0, 500), { expirationTtl: 365 * 86400 });
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: `\u2705 \u5907\u6CE8\u5DF2\u4FDD\u5B58\uFF1A
${escapeHtml(note.slice(0, 500))}`,
    parse_mode: "HTML"
  });
}
async function handleAddWordCommand(env, threadId, text, senderId) {
  const word = text.slice(9).trim();
  if (!word) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "\u26A0\uFE0F \u7528\u6CD5: `/addword \u5C4F\u853D\u8BCD`", parse_mode: "Markdown" });
    return;
  }
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) kvWords = JSON.parse(raw);
  } catch {
  }
  if (!Array.isArray(kvWords)) kvWords = [];
  const allWords = [.../* @__PURE__ */ new Set([...BLOCKED_WORDS, ...kvWords])];
  if (allWords.map((w) => w.toLowerCase()).includes(word.toLowerCase())) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `\u26A0\uFE0F \u5C4F\u853D\u8BCD\u300C${word}\u300D\u5DF2\u5B58\u5728\u3002`, parse_mode: "Markdown" });
    return;
  }
  kvWords.push(word);
  await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
  blockedWordsCache.data = null;
  Logger.info("blocked_word_added", { word, by: senderId });
  await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `\u2705 \u5DF2\u6DFB\u52A0\u5C4F\u853D\u8BCD\u300C${word}\u300D
\u5F53\u524D\u52A8\u6001\u8BCD\u5E93\u5171 ${kvWords.length} \u4E2A\u8BCD`, parse_mode: "Markdown" });
}
async function handleDelWordCommand(env, threadId, text, senderId) {
  const word = text.slice(9).trim();
  if (!word) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "\u26A0\uFE0F \u7528\u6CD5: `/delword \u5C4F\u853D\u8BCD`", parse_mode: "Markdown" });
    return;
  }
  if (BLOCKED_WORDS.map((w) => w.toLowerCase()).includes(word.toLowerCase())) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `\u26A0\uFE0F\u300C${word}\u300D\u662F\u786C\u7F16\u7801\u5C4F\u853D\u8BCD\uFF0C\u65E0\u6CD5\u901A\u8FC7\u547D\u4EE4\u5220\u9664\uFF0C\u8BF7\u76F4\u63A5\u4FEE\u6539\u4EE3\u7801\u4E2D\u7684 BLOCKED_WORDS \u6570\u7EC4\u3002`, parse_mode: "Markdown" });
    return;
  }
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) kvWords = JSON.parse(raw);
  } catch {
  }
  if (!Array.isArray(kvWords)) kvWords = [];
  const before = kvWords.length;
  kvWords = kvWords.filter((w) => w.toLowerCase() !== word.toLowerCase());
  if (kvWords.length === before) {
    await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `\u26A0\uFE0F \u5C4F\u853D\u8BCD\u300C${word}\u300D\u4E0D\u5B58\u5728\u4E8E\u52A8\u6001\u8BCD\u5E93\u4E2D\u3002`, parse_mode: "Markdown" });
    return;
  }
  await env.TOPIC_MAP.put("blocked_words_kv", JSON.stringify(kvWords));
  blockedWordsCache.data = null;
  Logger.info("blocked_word_removed", { word, by: senderId });
  await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: `\u2705 \u5DF2\u5220\u9664\u5C4F\u853D\u8BCD\u300C${word}\u300D
\u5F53\u524D\u52A8\u6001\u8BCD\u5E93\u5171 ${kvWords.length} \u4E2A\u8BCD`, parse_mode: "Markdown" });
}
async function handleListWordsCommand(env, threadId) {
  const allWords = await getBlockedWords(env, true);
  let kvWords = [];
  try {
    const raw = await env.TOPIC_MAP.get("blocked_words_kv");
    if (raw) kvWords = JSON.parse(raw);
  } catch {
  }
  if (!Array.isArray(kvWords)) kvWords = [];
  const hardcoded = BLOCKED_WORDS;
  const dynamic = kvWords.filter((w) => !BLOCKED_WORDS.map((h) => h.toLowerCase()).includes(w.toLowerCase()));
  const spamKeywords = parseSpamKeywords((env.SPAM_KEYWORDS || "").toString());
  const blockedTotal = allWords.length;
  let reply = `\u{1F4DD} **\u5185\u5BB9\u8FC7\u6EE4\u8BCD\u5E93**

`;
  reply += `**\u4E00\u3001\u5C4F\u853D\u8BCD**\uFF08\u547D\u4E2D\u540E\u62E6\u622A\u5E76\u63D0\u793A\u7528\u6237\uFF0C\u5171 ${blockedTotal} \u4E2A\uFF09

`;
  reply += `\u{1F527} **\u786C\u7F16\u7801\u8BCD** (${hardcoded.length} \u4E2A\uFF0C\u4FEE\u6539\u9700\u6539\u4EE3\u7801):
`;
  reply += hardcoded.length > 0 ? hardcoded.map((w) => `  \u2022 ${w}`).join("\n") : "  (\u65E0)";
  reply += `

\u{1F4BE} **\u52A8\u6001\u8BCD** (${dynamic.length} \u4E2A\uFF0C\u53EF\u901A\u8FC7 /addword /delword \u7BA1\u7406):
`;
  reply += dynamic.length > 0 ? dynamic.map((w) => `  \u2022 ${w}`).join("\n") : "  (\u65E0)";
  reply += `

**\u4E8C\u3001\u5783\u573E\u5173\u952E\u8BCD SPAM_KEYWORDS**\uFF08\u73AF\u5883\u53D8\u91CF\uFF0C\u8D70 spam \u68C0\u6D4B\uFF1B\u5171 ${spamKeywords.length} \u4E2A\uFF09
`;
  reply += spamKeywords.length > 0 ? spamKeywords.map((w) => `  \u2022 ${w}`).join("\n") : "  (\u672A\u914D\u7F6E\u6216\u4E3A\u7A7A\uFF1B\u5728 Cloudflare Variables \u4E2D\u8BBE\u7F6E SPAM_KEYWORDS\uFF0C\u9017\u53F7\u5206\u9694)";
  reply += `

\u8BF4\u660E\uFF1A/addword \u53EA\u5199\u5165\u300C\u52A8\u6001\u5C4F\u853D\u8BCD\u300D\uFF0C\u4E0D\u4F1A\u6539 SPAM_KEYWORDS \u73AF\u5883\u53D8\u91CF\u3002`;
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
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: "closed" });
    } catch (e) {
      Logger.warn("close_d1_update_failed", { userId, error: e?.message });
    }
  }
  await tgCall(env, "closeForumTopic", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId
  });
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u{1F6AB} <b>\u5BF9\u8BDD\u5DF2\u5F3A\u5236\u5173\u95ED</b>",
    parse_mode: "HTML"
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
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: "active" });
    } catch (e) {
      Logger.warn("open_d1_update_failed", { userId, error: e?.message });
    }
  }
  await tgCall(env, "reopenForumTopic", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId
  });
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u2705 <b>\u5BF9\u8BDD\u5DF2\u6062\u590D</b>",
    parse_mode: "HTML"
  });
}
async function handleResetCommand(env, threadId, userId) {
  await setPersistentTrust(env, userId, "normal");
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u{1F504} <b>\u9A8C\u8BC1\u91CD\u7F6E</b>\uFF08\u5DF2\u53D6\u6D88\u6C38\u4E45\u4FE1\u4EFB\uFF0C\u4E0B\u6B21\u9700\u91CD\u65B0\u9A8C\u8BC1\uFF09",
    parse_mode: "HTML"
  });
}
async function handleTrustCommand(env, threadId, userId) {
  await setPersistentTrust(env, userId, "trusted");
  await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u{1F31F} <b>\u5DF2\u8BBE\u7F6E\u6C38\u4E45\u4FE1\u4EFB</b>",
    parse_mode: "HTML"
  });
}
async function handleBanCommand(env, threadId, userId) {
  await env.TOPIC_MAP.put(`banned:${userId}`, "1");
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: "banned" });
    } catch (e) {
      Logger.warn("ban_d1_update_failed", { userId, error: e?.message });
    }
  }
  await bumpDailyStat(env, "bans", 1);
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u{1F6AB} <b>\u7528\u6237\u5DF2\u5C01\u7981</b>\uFF08\u5DF2\u5C1D\u8BD5\u901A\u77E5\u5BF9\u65B9\uFF09",
    parse_mode: "HTML"
  });
  const notify = await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: "\u{1F6AB} \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u5C01\u7981\uFF0C\u6682\u65F6\u65E0\u6CD5\u7EE7\u7EED\u53D1\u9001\u6D88\u606F\u3002\u5982\u6709\u7591\u95EE\u8BF7\u7B49\u5F85\u7BA1\u7406\u5458\u5904\u7406\u3002"
  });
  if (!notify?.ok) {
    Logger.warn("ban_user_notify_failed", {
      userId,
      description: notify?.description
    });
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `\u26A0\uFE0F \u5DF2\u5C01\u7981\uFF0C\u4F46\u901A\u77E5\u7528\u6237\u5931\u8D25\uFF08\u53EF\u80FD\u5BF9\u65B9\u672A\u79C1\u804A\u8FC7\u673A\u5668\u4EBA\u6216\u5DF2\u62C9\u9ED1\uFF09\uFF1A${escapeHtml(notify?.description || "unknown")}`,
      parse_mode: "HTML"
    });
  } else {
    await env.TOPIC_MAP.put(`ban_notice:${userId}`, "1", { expirationTtl: 3600 });
  }
}
async function handleUnbanCommand(env, threadId, userId) {
  await env.TOPIC_MAP.delete(`banned:${userId}`);
  await env.TOPIC_MAP.delete(`ban_notice:${userId}`);
  if (env.TG_BOT_DB) {
    try {
      await createD1Storage(env.TG_BOT_DB).updateUserState(userId, { status: "active" });
    } catch (e) {
      Logger.warn("unban_d1_update_failed", { userId, error: e?.message });
    }
  }
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: "\u2705 <b>\u7528\u6237\u5DF2\u89E3\u5C01</b>\uFF08\u5DF2\u5C1D\u8BD5\u901A\u77E5\u5BF9\u65B9\uFF09",
    parse_mode: "HTML"
  });
  const notify = await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: "\u2705 \u60A8\u5DF2\u88AB\u7BA1\u7406\u5458\u89E3\u5C01\uFF0C\u53EF\u4EE5\u7EE7\u7EED\u53D1\u9001\u6D88\u606F\u4E86\u3002"
  });
  if (!notify?.ok) {
    Logger.warn("unban_user_notify_failed", {
      userId,
      description: notify?.description
    });
  }
}
async function handleInfoCommand(env, threadId, userId) {
  const userKey = `user:${userId}`;
  let userRec = await safeGetJSON(env, userKey, null);
  const verifyStatus = await getVerificationState(env, userId);
  const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);
  const from = await resolveUserFromForTopic(env, userId, null);
  const resolvedTitle = buildTopicTitle2(from);
  if (userRec?.thread_id && resolvedTitle && resolvedTitle !== "User" && (!userRec.title || userRec.title === "User" || /^User(\s@|$)/i.test(userRec.title))) {
    try {
      const edit = await tgCall(env, "editForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: userRec.thread_id,
        name: resolvedTitle
      });
      if (edit?.ok) {
        userRec = { ...userRec, title: resolvedTitle };
        await env.TOPIC_MAP.put(userKey, JSON.stringify(userRec));
      }
    } catch (e) {
      Logger.warn("info_topic_title_repair_failed", { userId, error: e?.message });
    }
  }
  const displayName = escapeHtml(
    [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "\u672A\u77E5"
  );
  const usernameText = from.username ? `@${escapeHtml(from.username)}` : "\u65E0";
  const openLink = from.username ? `<a href="https://t.me/${escapeHtml(from.username)}">\u6253\u5F00\u4E3B\u9875 @${escapeHtml(from.username)}</a>` : `<a href="tg://user?id=${userId}">\u6253\u5F00\u7528\u6237\u8D44\u6599</a>`;
  const topicTitle = escapeHtml(userRec?.title || resolvedTitle || "\u672A\u77E5");
  const verifyText = verifyStatus ? verifyStatus.type === "trusted" ? "\u{1F31F} \u6C38\u4E45\u4FE1\u4EFB" : "\u2705 \u5DF2\u9A8C\u8BC1" : "\u274C \u672A\u9A8C\u8BC1";
  const banText = banStatus ? "\u{1F6AB} \u5DF2\u5C01\u7981" : "\u2705 \u6B63\u5E38";
  const muted = await env.TOPIC_MAP.get(`muted:${userId}`);
  const note = await env.TOPIC_MAP.get(`note:${userId}`);
  let lastMsgAt = null;
  let d1Status = null;
  if (env.TG_BOT_DB) {
    try {
      const u = await createD1Storage(env.TG_BOT_DB).getUser(userId);
      lastMsgAt = u?.lastMessageAt ?? null;
      d1Status = u?.status ?? null;
    } catch {
    }
  }
  const info = [
    "\u{1F464} <b>\u7528\u6237\u4FE1\u606F</b>",
    `\u59D3\u540D: ${displayName}`,
    `\u7528\u6237\u540D: ${usernameText}`,
    `UID: <code>${userId}</code>`,
    `Topic ID: <code>${threadId}</code>`,
    `\u8BDD\u9898\u6807\u9898: ${topicTitle}`,
    `\u9A8C\u8BC1: ${verifyText}`,
    `\u5C01\u7981: ${banText} \xB7 \u9759\u97F3: ${muted ? "\u{1F507} \u662F" : "\u5426"} \xB7 \u4F1A\u8BDD\u5173\u95ED: ${userRec?.closed ? "\u662F" : "\u5426"}`,
    d1Status ? `D1 \u72B6\u6001: <code>${escapeHtml(d1Status)}</code>` : "",
    `\u6700\u8FD1\u6D88\u606F: ${formatTimeBoth(lastMsgAt)}`,
    note ? `\u5907\u6CE8: ${escapeHtml(note)}` : "\u5907\u6CE8: \u65E0\uFF08/note \u5185\u5BB9\uFF09",
    `\u94FE\u63A5: ${openLink}`,
    from.username ? "" : "<i>\u65E0\u516C\u5F00\u7528\u6237\u540D\u65F6\u90E8\u5206\u5BA2\u6237\u7AEF\u65E0\u6CD5\u70B9\u51FB tg \u94FE\u63A5</i>"
  ].filter(Boolean).join("\n");
  await tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: threadId,
    text: info,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildUserActionKeyboard(userId)
  });
}
async function _handleAdminReplyInner(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const rawText = (msg.text || "").trim();
  const text = removeCommandBotSuffix(rawText);
  const senderId = msg.from?.id;
  const isCommand = !!text && text.startsWith("/");
  if (!senderId || !await isAdminUser(env, senderId)) {
    const known = /^\/(help|menu|dashboard|sysinfo|system|status|stats|rank|activity|heat|whoami|find|notes|cleanup|listwords|addword|delword|panel|info|ban|unban|close|open|mute|unmute|trust|reset|note|synccommands)(@|\s|$)/i;
    if (isCommand && senderId && known.test(text)) {
      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "\u26D4 \u65E0\u7BA1\u7406\u6743\u9650\uFF1A\u4EC5\u7FA4\u4E3B/\u7BA1\u7406\u5458\u6216 ADMIN_IDS \u53EF\u4F7F\u7528\u8BE5\u6307\u4EE4\u3002"
      });
    }
    return;
  }
  if (text === "/cleanup") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: "\u{1F9F9} <b>\u786E\u8BA4\u6E05\u7406\u65E0\u6548\u8BDD\u9898\uFF1F</b>\n\u5C06\u626B\u63CF\u5931\u6548 Topic \u6620\u5C04\uFF0C\u53EF\u80FD\u8017\u65F6\u3002",
      parse_mode: "HTML",
      reply_markup: buildCleanupConfirmKeyboard()
    });
    return;
  }
  if (text === "/help") {
    await handleHelpCommand(env, threadId, senderId);
    return;
  }
  if (text === "/menu" || text === "/dashboard") {
    await handleMenuCommand(env, threadId, senderId);
    return;
  }
  if (text === "/sysinfo" || text === "/system" || text === "/status") {
    await handleSysinfoCommand(env, threadId, { page: "overview" });
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
  let userId = null;
  const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mappedUser) {
    userId = Number(mappedUser);
  } else if (threadNotFoundCache.has(threadId) && Date.now() - threadNotFoundCache.get(threadId) < THREAD_NOT_FOUND_TTL_MS) {
    if (isCommand) {
      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: threadId,
        text: "\u26A0\uFE0F \u5F53\u524D\u8BDD\u9898\u672A\u5173\u8054\u7528\u6237\uFF08\u8BF7\u5728\u5BF9\u5E94\u7528\u6237 Forum Topic \u5185\u6267\u884C\uFF0C\u6216\u4F7F\u7528 /find\uFF09\u3002"
      });
    }
    return;
  } else {
    const allKeys = await getAllKeys(env, "user:");
    let scanned = 0;
    for (const { name } of allKeys) {
      if (++scanned > 200) break;
      const rec = await safeGetJSON(env, name, null);
      if (rec && Number(rec.thread_id) === Number(threadId)) {
        userId = Number(name.slice(5));
        break;
      }
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
        text: "\u26A0\uFE0F \u5F53\u524D\u8BDD\u9898\u672A\u5173\u8054\u7528\u6237\u3002\u5168\u5C40\u547D\u4EE4\uFF1A/sysinfo /stats /rank /find /notes /help"
      });
    }
    return;
  }
  if (text === "/close") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `\u26A0\uFE0F <b>\u786E\u8BA4\u5173\u95ED\u5BF9\u8BDD</b> <code>${escapeHtml(String(userId))}</code>\uFF1F
\u5C06\u5173\u95ED Forum Topic\uFF0C\u7528\u6237\u6D88\u606F\u4E0D\u518D\u63A5\u5165\uFF08\u53EF\u7528\u6253\u5F00\u6062\u590D\uFF09\u3002`,
      parse_mode: "HTML",
      reply_markup: buildCloseConfirmKeyboard(userId)
    });
    return;
  }
  if (text === "/open") {
    await handleOpenCommand(env, threadId, userId);
    return;
  }
  if (text === "/reset") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `\u26A0\uFE0F <b>\u786E\u8BA4\u91CD\u7F6E\u9A8C\u8BC1</b> <code>${escapeHtml(String(userId))}</code>\uFF1F
\u5C06\u53D6\u6D88\u6C38\u4E45\u4FE1\u4EFB\uFF0C\u7528\u6237\u4E0B\u6B21\u9700\u91CD\u65B0\u9A8C\u8BC1\u3002`,
      parse_mode: "HTML",
      reply_markup: buildResetConfirmKeyboard(userId)
    });
    return;
  }
  if (text === "/trust") {
    await handleTrustCommand(env, threadId, userId);
    return;
  }
  if (text === "/ban") {
    await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: threadId,
      text: `\u26A0\uFE0F <b>\u786E\u8BA4\u5C01\u7981\u7528\u6237</b> <code>${escapeHtml(String(userId))}</code>\uFF1F
\u5BF9\u65B9\u5C06\u6536\u5230\u901A\u77E5\u4E14\u65E0\u6CD5\u7EE7\u7EED\u53D1\u6D88\u606F\u3002`,
      parse_mode: "HTML",
      reply_markup: buildBanConfirmKeyboard(userId)
    });
    return;
  }
  if (text === "/unban") {
    await handleUnbanCommand(env, threadId, userId);
    return;
  }
  if (text === "/info") {
    await handleInfoCommand(env, threadId, userId);
    return;
  }
  if (text === "/panel") {
    await handlePanelCommand(env, threadId, userId);
    return;
  }
  if (text === "/mute") {
    await handleMuteCommand(env, threadId, userId);
    return;
  }
  if (text === "/unmute") {
    await handleUnmuteCommand(env, threadId, userId);
    return;
  }
  if (text.startsWith("/note")) {
    await handleNoteCommand(env, threadId, userId, text);
    return;
  }
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: void 0 });
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
async function sendVerificationChallenge(userId, env, pendingMsgId, from = null) {
  if (from) await saveUserProfileSnapshot(env, userId, from);
  const writtenKeys = [];
  try {
    await _sendVerificationChallengeInner(userId, env, pendingMsgId, writtenKeys);
  } catch (e) {
    Logger.error("verification_challenge_failed", e, { userId });
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
    const state = await safeGetJSON(env, chalKey, null);
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
      Logger.debug("verification_duplicate_skipped", { userId, verifyId: existingChallenge, hasPending: !!pendingMsgId });
      return;
    }
  }
  const verifyLimit = await checkRateLimit(userId, env, "verify", CONFIG.RATE_LIMIT_VERIFY, 300);
  if (!verifyLimit.allowed) {
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "\u26A0\uFE0F \u9A8C\u8BC1\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF75\u5206\u949F\u540E\u518D\u8BD5\u3002"
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
  await env.TOPIC_MAP.put(`turnstile_code:${verifyCode}`, String(userId), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
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
      if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
        pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
      }
      await env.TOPIC_MAP.put(pendingKey, JSON.stringify(pendingIds), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
      writtenKeys.push(pendingKey);
    }
  }
  await env.TOPIC_MAP.put(`user_challenge:${userId}`, `turnstile:${verifyCode}`, { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
  writtenKeys.push(`user_challenge:${userId}`);
  Logger.info("turnstile_verification_sent", { userId, verifyCode });
  const verifyMsg = await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: `\u{1F6E1}\uFE0F **\u4EBA\u673A\u9A8C\u8BC1**

\u8BF7\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u5B8C\u6210\u9A8C\u8BC1\uFF0C\u9A8C\u8BC1\u901A\u8FC7\u540E\u60A8\u7684\u6D88\u606F\u5C06\u81EA\u52A8\u9001\u8FBE\u3002`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "\u{1F510} \u70B9\u51FB\u9A8C\u8BC1", url: verifyUrl }
      ]]
    }
  });
  if (!verifyMsg.ok) {
    throw new Error(`Turnstile \u9A8C\u8BC1\u6D88\u606F\u53D1\u9001\u5931\u8D25: ${verifyMsg.description || "\u672A\u77E5\u9519\u8BEF"}`);
  }
  if (verifyMsg.result?.message_id) {
    await env.TOPIC_MAP.put(`turnstile_msg:${verifyCode}`, String(verifyMsg.result.message_id), { expirationTtl: CONFIG.TURNSTILE_VERIFY_TTL });
    writtenKeys.push(`turnstile_msg:${verifyCode}`);
  }
}
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
    answerIndex,
    options: challenge.options,
    pending_ids: pendingMsgId ? [pendingMsgId] : [],
    userId
  };
  await env.TOPIC_MAP.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
  writtenKeys.push(`chal:${verifyId}`);
  await env.TOPIC_MAP.put(`user_challenge:${userId}`, verifyId, { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
  writtenKeys.push(`user_challenge:${userId}`);
  Logger.info("verification_sent", {
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
  const quizMsg = await tgCall(env, "sendMessage", {
    chat_id: userId,
    text: `\u{1F6E1}\uFE0F **\u4EBA\u673A\u9A8C\u8BC1**

${challenge.question}

\u8BF7\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u56DE\u7B54 (\u56DE\u7B54\u6B63\u786E\u540E\u5C06\u81EA\u52A8\u53D1\u9001\u60A8\u521A\u624D\u7684\u6D88\u606F)\u3002`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
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
    const selectedIndex = parseInt(parts[2]);
    const userId = query.from.id;
    const stateStr = await env.TOPIC_MAP.get(`chal:${verifyId}`);
    if (!stateStr) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "\u274C \u9A8C\u8BC1\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u53D1\u6D88\u606F",
        show_alert: true
      });
      return;
    }
    let state;
    try {
      state = JSON.parse(stateStr);
    } catch (e) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "\u274C \u6570\u636E\u9519\u8BEF",
        show_alert: true
      });
      return;
    }
    if (state.userId && state.userId !== userId) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "\u274C \u65E0\u6548\u7684\u9A8C\u8BC1",
        show_alert: true
      });
      return;
    }
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "\u274C \u65E0\u6548\u9009\u9879",
        show_alert: true
      });
      return;
    }
    if (selectedIndex === state.answerIndex) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "\u2705 \u9A8C\u8BC1\u901A\u8FC7"
      });
      Logger.info("verification_passed", {
        userId,
        verifyId,
        selectedOption: state.options[selectedIndex]
      });
      await bumpDailyStat(env, "verifies", 1);
      await ephemeralStore(env).setVerification(userId, {
        ttl: CONFIG.VERIFIED_EXPIRE_SECONDS,
        verifiedAt: Date.now()
      });
      await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
      await env.TOPIC_MAP.delete(`chal:${verifyId}`);
      await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
      await tgCall(env, "editMessageText", {
        chat_id: userId,
        message_id: query.message.message_id,
        text: "\u2705 **\u9A8C\u8BC1\u6210\u529F**\n\n\u60A8\u73B0\u5728\u53EF\u4EE5\u81EA\u7531\u5BF9\u8BDD\u4E86\u3002",
        parse_mode: "Markdown"
      });
      const hasPending = Array.isArray(state.pending_ids) && state.pending_ids.length > 0 || !!state.pending;
      if (hasPending) {
        await forwardPendingMessages(state, userId, query, env, ctx);
      }
    } else {
      Logger.info("verification_failed", {
        userId,
        verifyId,
        selectedIndex,
        correctIndex: state.answerIndex
      });
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "\u274C \u7B54\u6848\u9519\u8BEF",
        show_alert: true
      });
    }
  } catch (e) {
    Logger.error("callback_query_error", e, {
      userId: query.from?.id,
      callbackData: query.data
    });
    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: `\u26A0\uFE0F \u7CFB\u7EDF\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5`,
      show_alert: true
    });
  }
}
async function forwardPendingMessages(state, userId, query, env, ctx) {
  try {
    let pendingIds = [];
    if (Array.isArray(state.pending_ids)) {
      pendingIds = state.pending_ids.slice();
    } else if (state.pending) {
      pendingIds = [state.pending];
    }
    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
      pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
    }
    const CONCURRENT_FORWARDS = 3;
    let forwardedCount = 0;
    let skippedCount = 0;
    for (let i = 0; i < pendingIds.length; i += CONCURRENT_FORWARDS) {
      const batch = pendingIds.slice(i, i + CONCURRENT_FORWARDS);
      const results = await Promise.allSettled(batch.map(async (pendingId) => {
        if (!pendingId) return { forwarded: false, reason: "empty_id" };
        const forwardedKey = `forwarded:${userId}:${pendingId}`;
        const alreadyForwarded = await env.TOPIC_MAP.get(forwardedKey);
        if (alreadyForwarded) {
          Logger.info("message_forward_duplicate_skipped", { userId, messageId: pendingId });
          return { forwarded: false, reason: "already_forwarded" };
        }
        const topicFrom = await resolveUserFromForTopic(env, userId, query?.from);
        const fakeMsg = {
          message_id: pendingId,
          chat: { id: userId, type: "private" },
          from: topicFrom
        };
        await forwardToTopic(fakeMsg, userId, `user:${userId}`, env, ctx);
        await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
        return { forwarded: true };
      }));
      for (const r of results) {
        if (r.status === "fulfilled" && r.value?.forwarded) {
          forwardedCount++;
        } else if (r.status === "fulfilled" && !r.value?.forwarded) {
          skippedCount++;
        } else if (r.status === "rejected") {
          Logger.warn("pending_forward_item_failed", { userId, error: r.reason?.message });
        }
      }
    }
    if (forwardedCount > 0) {
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: `\u{1F4E9} \u521A\u624D\u7684 ${forwardedCount} \u6761\u6D88\u606F\u5DF2\u5E2E\u60A8\u9001\u8FBE\u3002`
      });
    }
  } catch (e) {
    Logger.error("pending_message_forward_failed", e, { userId });
    await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "\u26A0\uFE0F \u81EA\u52A8\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u60A8\u7684\u6D88\u606F\u3002"
    });
  }
}
async function handleCleanupCommand(threadId, env) {
  const lockKey = "cleanup:lock";
  const locked = await env.TOPIC_MAP.get(lockKey);
  if (locked) {
    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: "\u23F3 **\u5DF2\u6709\u6E05\u7406\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002**",
      parse_mode: "Markdown"
    }, threadId));
    return;
  }
  await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });
  await tgCall(env, "sendMessage", withMessageThreadId({
    chat_id: env.SUPERGROUP_ID,
    text: "\u{1F504} **\u6B63\u5728\u626B\u63CF\u9700\u8981\u6E05\u7406\u7684\u7528\u6237...**",
    parse_mode: "Markdown"
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
      for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
        const batch = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (name) => {
            const rec = await safeGetJSON(env, name, null);
            if (!rec || !rec.thread_id) return null;
            const userId = name.slice(5);
            const topicThreadId = rec.thread_id;
            const probe = await probeForumThread(env, topicThreadId, {
              userId,
              reason: "cleanup_check",
              doubleCheckOnMissingThreadId: false
            });
            if (probe.status === "redirected" || probe.status === "missing") {
              await env.TOPIC_MAP.delete(name);
              await setPersistentTrust(env, userId, "normal");
              await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);
              return {
                userId,
                threadId: topicThreadId,
                title: rec.title || "\u672A\u77E5"
              };
            } else if (probe.status === "probe_invalid") {
              Logger.warn("cleanup_probe_invalid_message", {
                userId,
                threadId: topicThreadId,
                errorDescription: probe.description
              });
            } else if (probe.status === "unknown_error") {
              Logger.warn("cleanup_probe_failed_unknown", {
                userId,
                threadId: topicThreadId,
                errorDescription: probe.description
              });
            } else if (probe.status === "missing_thread_id") {
              Logger.warn("cleanup_probe_missing_thread_id", { userId, threadId: topicThreadId });
            }
            return null;
          })
        );
        results.forEach((result2) => {
          if (result2.status === "fulfilled" && result2.value) {
            cleanedCount++;
            cleanedUsers.push(result2.value);
            Logger.info("cleanup_user", {
              userId: result2.value.userId,
              threadId: result2.value.threadId
            });
          } else if (result2.status === "rejected") {
            errorCount++;
            Logger.error("cleanup_batch_error", result2.reason);
          }
        });
        if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      cursor = result.list_complete ? void 0 : result.cursor;
      if (cursor) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } while (cursor);
    let reportText = `\u2705 **\u6E05\u7406\u5B8C\u6210**

`;
    reportText += `\u{1F4CA} **\u7EDF\u8BA1\u4FE1\u606F**
`;
    reportText += `- \u626B\u63CF\u7528\u6237\u6570: ${scannedCount}
`;
    reportText += `- \u5DF2\u6E05\u7406\u7528\u6237\u6570: ${cleanedCount}
`;
    reportText += `- \u9519\u8BEF\u6570: ${errorCount}

`;
    if (cleanedCount > 0) {
      reportText += `\u{1F5D1}\uFE0F **\u5DF2\u6E05\u7406\u7684\u7528\u6237** (\u8BDD\u9898\u5DF2\u5220\u9664):
`;
      for (const user of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY)) {
        reportText += `- UID: \`${user.userId}\` | \u8BDD\u9898: ${user.title}
`;
      }
      if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY) {
        reportText += `
...(\u8FD8\u6709 ${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} \u4E2A\u7528\u6237)
`;
      }
      reportText += `
\u{1F4A1} \u8FD9\u4E9B\u7528\u6237\u4E0B\u6B21\u53D1\u6D88\u606F\u65F6\u5C06\u91CD\u65B0\u8FDB\u884C\u4EBA\u673A\u9A8C\u8BC1\u5E76\u521B\u5EFA\u65B0\u8BDD\u9898\u3002`;
    } else {
      reportText += `\u2728 \u6CA1\u6709\u53D1\u73B0\u9700\u8981\u6E05\u7406\u7684\u7528\u6237\u8BB0\u5F55\u3002`;
    }
    Logger.info("cleanup_completed", {
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
    Logger.error("cleanup_failed", e, { threadId });
    await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text: `\u274C **\u6E05\u7406\u8FC7\u7A0B\u51FA\u9519**

\u9519\u8BEF\u4FE1\u606F: \`${e.message}\``,
      parse_mode: "Markdown"
    }, threadId));
  } finally {
    await env.TOPIC_MAP.delete(lockKey);
  }
}
async function createTopic(from, key, env, userId) {
  const title = buildTopicTitle2(from);
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
    Logger.info("thread_status_updated", { threadId, isClosed, updatedCount: updates.length });
  } catch (e) {
    Logger.error("thread_status_update_failed", e, { threadId, isClosed });
    throw e;
  }
}
function buildTopicTitle2(from) {
  const src = from || {};
  const firstName = (src.first_name || src.firstName || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (src.last_name || src.lastName || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  let username = "";
  const rawUsername = src.username || "";
  if (rawUsername) {
    username = String(rawUsername).replace(/[^\w]/g, "").substring(0, 20);
  }
  const cleanName = (firstName + " " + lastName).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);
  return title;
}
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  const client = createTelegramClient({
    botToken: env.BOT_TOKEN,
    apiBase: env.API_BASE,
    timeoutMs: timeout,
    logger: Logger
  });
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
  if (!rec) rec = { direction, targetChat, threadId: threadId === null ? void 0 : threadId, items: [], last_ts: Date.now() };
  rec.items.push({ ...item, msg_id: msg.message_id });
  rec.last_ts = Date.now();
  await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
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
    const prefix = "mg:";
    const allKeys = await getAllKeys(env, prefix);
    let deletedCount = 0;
    for (const { name } of allKeys) {
      const rec = await safeGetJSON(env, name, null);
      if (rec && rec.last_ts && now - rec.last_ts > 3e5) {
        await env.TOPIC_MAP.delete(name);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      Logger.info("media_groups_cleaned", { deletedCount });
    }
  } catch (e) {
    Logger.error("media_group_cleanup_failed", e);
  }
}
async function delaySend(env, key, ts) {
  await new Promise((r) => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));
  const rec = await safeGetJSON(env, key, null);
  if (rec && rec.last_ts === ts) {
    if (!rec.items || rec.items.length === 0) {
      Logger.warn("media_group_empty", { key });
      await env.TOPIC_MAP.delete(key);
      return;
    }
    const media = rec.items.map((it, i) => {
      if (!it.type || !it.id) {
        Logger.warn("media_group_invalid_item", { key, item: it });
        return null;
      }
      const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
      return {
        type: it.type,
        media: it.id,
        caption
      };
    }).filter(Boolean);
    if (media.length > 0) {
      try {
        const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({
          chat_id: rec.targetChat,
          media
        }, rec.threadId));
        if (!result.ok) {
          Logger.error("media_group_send_failed", result.description, {
            key,
            mediaCount: media.length
          });
        } else {
          Logger.info("media_group_sent", {
            key,
            mediaCount: media.length,
            targetChat: rec.targetChat
          });
        }
      } catch (e) {
        Logger.error("media_group_send_exception", e, { key });
      }
    }
    await env.TOPIC_MAP.delete(key);
  }
}
var workerApp = createApp({
  handleFetch: legacyApp.fetch.bind(legacyApp)
});
var worker_default = {
  fetch: workerApp.fetch.bind(workerApp),
  scheduled(event, env, ctx) {
    ctx.waitUntil(workerApp.scheduled(event, env, ctx));
  }
};
export {
  worker_default as default
};
