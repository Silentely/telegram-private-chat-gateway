const UPDATE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const USER_UPDATE_COLUMNS = {
  username: 'username',
  firstName: 'first_name',
  lastName: 'last_name',
  status: 'status',
  trustLevel: 'trust_level',
  isMuted: 'is_muted',
  violationCount: 'violation_count',
  topicId: 'topic_id',
  infoCardMessageId: 'info_card_message_id',
  profileSnapshot: 'profile_snapshot',
  lastMessageAt: 'last_message_at',
};

function storageValue(key, value) {
  if (key === 'isMuted') return value ? 1 : 0;
  if (key === 'violationCount') return Number(value || 0);
  if (key === 'topicId' || key === 'infoCardMessageId') {
    return value == null ? null : String(value);
  }
  return value ?? null;
}

export function createD1Storage(db) {
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
      infoCardMessageId: row.info_card_message_id == null
        ? null
        : String(row.info_card_message_id),
      profileSnapshot: row.profile_snapshot ?? null,
      topicLockToken: row.topic_lock_token ?? null,
      topicLockUntil: row.topic_lock_until ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at ?? null,
    };
  }

  function mapRule(row) {
    if (!row) return null;
    let metadata = {};
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { metadata = {}; }
    return {
      ruleId: row.rule_id,
      ruleType: row.rule_type,
      matchType: metadata.matchType || 'contains',
      pattern: row.pattern,
      responseText: row.response_text,
      action: row.action,
      priority: Number(row.priority ?? 100),
      enabled: Boolean(row.enabled),
      createdBy: row.created_by,
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
        user.updatedAt ?? now,
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
        user.status ?? 'active',
        user.trustLevel ?? 'normal',
        user.isMuted ? 1 : 0,
        Number(user.violationCount || 0),
        user.topicId == null ? null : String(user.topicId),
        user.infoCardMessageId == null ? null : String(user.infoCardMessageId),
        user.profileSnapshot ?? null,
        user.createdAt ?? now,
        user.updatedAt ?? now,
        user.lastMessageAt ?? null,
      ).run();
    },

    async findUserByTopic(topicId) {
      const row = await db.prepare(`
        SELECT * FROM users WHERE topic_id = ?
      `).bind(String(topicId)).first();
      return mapUser(row);
    },

    async updateUserState(userId, changes) {
      const entries = Object.entries(changes)
        .filter(([key]) => USER_UPDATE_COLUMNS[key]);
      if (entries.length === 0) return storage.getUser(userId);
      const assignments = entries.map(([key]) => `${USER_UPDATE_COLUMNS[key]} = ?`);
      const values = entries.map(([key, value]) => storageValue(key, value));
      await db.prepare(`
        UPDATE users
        SET ${assignments.join(', ')}, updated_at = ?
        WHERE user_id = ?
      `).bind(...values, Date.now(), String(userId)).run();
      return storage.getUser(userId);
    },

    async acquireTopicLock(userId, token, now, ttlMs = 30000) {
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
        now,
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
        updatedAt: row.updated_at,
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
        grantedBy: row.granted_by,
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
        String(admin.userId), admin.role, admin.enabled === false ? 0 : 1,
        String(admin.grantedBy), admin.createdAt ?? now, now,
      ).run();
    },

    async appendAudit(entry) {
      await db.prepare(`
        INSERT INTO admin_audit_log (
          id, admin_id, action, resource_type, resource_id,
          before_state, after_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.id, String(entry.adminId), entry.action, entry.resourceType,
        entry.resourceId == null ? null : String(entry.resourceId),
        entry.beforeState == null ? null : JSON.stringify(entry.beforeState),
        entry.afterState == null ? null : JSON.stringify(entry.afterState),
        entry.createdAt ?? Date.now(),
      ).run();
    },

    async getRule(ruleId) {
      const row = await db.prepare('SELECT * FROM rules WHERE rule_id = ?')
        .bind(String(ruleId)).first();
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
        metadata=excluded.metadata, updated_at=excluded.updated_at`)
        .bind(rule.ruleId, rule.ruleType, rule.pattern ?? null, rule.responseText ?? null,
          rule.action, Number(rule.priority ?? 100), rule.enabled === false ? 0 : 1,
          JSON.stringify({ matchType: rule.matchType || 'contains' }), rule.createdBy ?? null,
          rule.createdAt ?? Date.now(), rule.updatedAt ?? Date.now()).run();
    },

    async listRules(offset = 0, limit = 20) {
      const [result, count] = await Promise.all([
        db.prepare('SELECT * FROM rules ORDER BY priority, rule_id LIMIT ? OFFSET ?')
          .bind(limit, offset).all(),
        db.prepare('SELECT COUNT(*) AS total FROM rules').first(),
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

    async deleteRule(ruleId) {
      const result = await db.prepare('DELETE FROM rules WHERE rule_id = ?').bind(String(ruleId)).run();
      return result.meta?.changes === 1;
    },

    async setRuleEnabled(ruleId, enabled, updatedAt = Date.now()) {
      const result = await db.prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE rule_id = ?')
        .bind(enabled ? 1 : 0, updatedAt, String(ruleId)).run();
      return result.meta?.changes === 1;
    },

    async cleanupRetention({ updatesBefore, linksBefore, auditsBefore }) {
      const [updates, links, audits] = await db.batch([
        db.prepare('DELETE FROM processed_updates WHERE claimed_at < ?').bind(updatesBefore),
        db.prepare('DELETE FROM message_links WHERE created_at < ?').bind(linksBefore),
        db.prepare('DELETE FROM admin_audit_log WHERE created_at < ?').bind(auditsBefore),
      ]);
      return {
        updates: Number(updates.meta?.changes || 0),
        links: Number(links.meta?.changes || 0),
        audits: Number(audits.meta?.changes || 0),
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
      if (inserted.meta?.changes === 1) return 'claimed';

      const existing = await this.getProcessedUpdate(id);
      if (!existing || existing.status === 'completed') return 'duplicate';

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
        now - UPDATE_PROCESSING_TIMEOUT_MS,
      ).run();

      return reclaimed.meta?.changes === 1 ? 'reclaimed' : 'duplicate';
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
      `).bind(String(errorCode || 'temporary'), String(updateId)).run();
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
        recentActive,
      ] = await Promise.all([
        db.prepare('SELECT COUNT(*) AS total FROM users').first(),
        db.prepare('SELECT COUNT(*) AS total FROM users WHERE topic_id IS NOT NULL').first(),
        db.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'banned'").first(),
        db.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'closed'").first(),
        db.prepare("SELECT COUNT(*) AS total FROM processed_updates WHERE status = 'processing'").first(),
        db.prepare("SELECT COUNT(*) AS total FROM processed_updates WHERE status = 'retryable'").first(),
        db.prepare('SELECT COUNT(*) AS total FROM message_links').first(),
        db.prepare('SELECT COUNT(*) AS total FROM rules').first(),
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
        `).all(),
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
        recentActiveUsers: (recentActive?.results || []).map(mapUser),
      };
    },

    /**
     * 按 UID 精确或用户名/姓名模糊查找（管理员 /find）
     */
    async searchUsers(query, limit = 10) {
      const q = String(query || '').trim();
      if (!q) return [];
      const lim = Math.min(Math.max(Number(limit) || 10, 1), 20);
      // 纯数字优先按 user_id 精确查
      if (/^\d{1,20}$/.test(q)) {
        const one = await this.getUser(q);
        return one ? [one] : [];
      }
      const like = `%${q.replace(/%/g, '')}%`;
      const result = await db.prepare(`
        SELECT user_id, username, first_name, last_name, last_message_at, topic_id, status, trust_level
        FROM users
        WHERE username LIKE ? OR first_name LIKE ? OR last_name LIKE ?
        ORDER BY COALESCE(last_message_at, 0) DESC
        LIMIT ?
      `).bind(like, like, like, lim).all();
      return (result.results || []).map(mapUser);
    },
  };

  return storage;
}
