function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

export function createMockD1() {
  const tables = new Map();
  const indexes = new Set();

  function ensureTable(name) {
    if (!tables.has(name)) tables.set(name, []);
  }

  function createStatement(sql, bindings = []) {
    const normalized = normalizeSql(sql);

    return {
      bind(...values) {
        return createStatement(sql, values);
      },

      async first() {
        if (/^SELECT 1 AS ok$/i.test(normalized) || /^SELECT 1 as ok$/i.test(normalized)) {
          return { ok: 1 };
        }
        if (/^SELECT version(?:,\s*name)? FROM schema_migrations/i.test(normalized)) {
          const rows = [...(tables.get('schema_migrations') || [])]
            .sort((left, right) => right.version - left.version);
          return rows[0] || null;
        }
        if (/FROM processed_updates WHERE update_id = \?/i.test(normalized)) {
          const [updateId] = bindings;
          const row = (tables.get('processed_updates') || [])
            .find(item => item.update_id === String(updateId));
          return row ? { ...row } : null;
        }
        if (/^SELECT \* FROM users WHERE user_id = \?/i.test(normalized)) {
          const [userId] = bindings;
          const row = (tables.get('users') || [])
            .find(item => item.user_id === String(userId));
          return row ? { ...row } : null;
        }
        if (/^SELECT \* FROM users WHERE topic_id = \?/i.test(normalized)) {
          const [topicId] = bindings;
          const row = (tables.get('users') || [])
            .find(item => item.topic_id === String(topicId));
          return row ? { ...row } : null;
        }
        if (/^SELECT \* FROM message_links WHERE direction = \?/i.test(normalized)) {
          const [direction, sourceChatId, sourceMessageId] = bindings;
          const row = (tables.get('message_links') || []).find(item => (
            item.direction === direction
            && item.source_chat_id === String(sourceChatId)
            && item.source_message_id === String(sourceMessageId)
          ));
          return row ? { ...row } : null;
        }
        if (/^SELECT \* FROM admin_users WHERE user_id = \?/i.test(normalized)) {
          const row = (tables.get('admin_users') || [])
            .find(item => item.user_id === String(bindings[0]));
          return row ? { ...row } : null;
        }
        if (/^SELECT \* FROM rules WHERE rule_id = \?/i.test(normalized)) {
          const row = (tables.get('rules') || [])
            .find(item => item.rule_id === String(bindings[0]));
          return row ? { ...row } : null;
        }
        if (/^SELECT COUNT\(\*\) AS total FROM rules/i.test(normalized)) {
          return { total: (tables.get('rules') || []).length };
        }
        if (/^SELECT COUNT\(\*\) AS total FROM users WHERE topic_id IS NOT NULL/i.test(normalized)) {
          return {
            total: (tables.get('users') || []).filter(row => row.topic_id != null).length,
          };
        }
        if (/^SELECT COUNT\(\*\) AS total FROM users WHERE status = 'banned'/i.test(normalized)) {
          return {
            total: (tables.get('users') || []).filter(row => row.status === 'banned').length,
          };
        }
        if (/^SELECT COUNT\(\*\) AS total FROM users WHERE status = 'closed'/i.test(normalized)) {
          return {
            total: (tables.get('users') || []).filter(row => row.status === 'closed').length,
          };
        }
        if (/^SELECT COUNT\(\*\) AS total FROM users/i.test(normalized)) {
          return { total: (tables.get('users') || []).length };
        }
        if (/^SELECT COUNT\(\*\) AS total FROM processed_updates WHERE status = 'processing'/i.test(normalized)) {
          return {
            total: (tables.get('processed_updates') || []).filter(row => row.status === 'processing').length,
          };
        }
        if (/^SELECT COUNT\(\*\) AS total FROM processed_updates WHERE status = 'retryable'/i.test(normalized)) {
          return {
            total: (tables.get('processed_updates') || []).filter(row => row.status === 'retryable').length,
          };
        }
        if (/^SELECT COUNT\(\*\) AS total FROM message_links/i.test(normalized)) {
          return { total: (tables.get('message_links') || []).length };
        }
        if (/FROM users[\s\S]*ORDER BY COALESCE\(last_message_at/i.test(normalized)) {
          const rows = [...(tables.get('users') || [])]
            .sort((a, b) => Number(b.last_message_at || 0) - Number(a.last_message_at || 0));
          return rows[0] ? { ...rows[0] } : null;
        }
        throw new Error(`Mock D1 first() 不支持 SQL: ${normalized}`);
      },

      async all() {
        if (/FROM users[\s\S]*ORDER BY COALESCE\(last_message_at[\s\S]*LIMIT 5/i.test(normalized)) {
          const rows = [...(tables.get('users') || [])]
            .sort((a, b) => Number(b.last_message_at || 0) - Number(a.last_message_at || 0))
            .slice(0, 5);
          return { results: rows.map(row => ({ ...row })) };
        }
        if (/FROM users[\s\S]*WHERE username LIKE \?/i.test(normalized)) {
          const [like1] = bindings;
          const needle = String(like1 || '').replace(/%/g, '').toLowerCase();
          const rows = (tables.get('users') || []).filter(row => {
            const u = String(row.username || '').toLowerCase();
            const f = String(row.first_name || '').toLowerCase();
            const l = String(row.last_name || '').toLowerCase();
            return u.includes(needle) || f.includes(needle) || l.includes(needle);
          }).slice(0, Number(bindings[3] || 10));
          return { results: rows.map(row => ({ ...row })) };
        }
        if (/^SELECT \* FROM rules WHERE enabled = 1 ORDER BY priority/i.test(normalized)) {
          const rows = [...(tables.get('rules') || [])]
            .filter(row => Number(row.enabled) === 1)
            .sort((left, right) => left.priority - right.priority || left.rule_id.localeCompare(right.rule_id));
          return { results: rows.map(row => ({ ...row })) };
        }
        if (/^SELECT \* FROM rules ORDER BY priority/i.test(normalized)) {
          const [limit, offset] = bindings;
          const rows = [...(tables.get('rules') || [])]
            .sort((left, right) => left.priority - right.priority || left.rule_id.localeCompare(right.rule_id));
          return { results: rows.slice(offset, offset + limit).map(row => ({ ...row })) };
        }
        throw new Error(`Mock D1 all() 不支持 SQL: ${normalized}`);
      },

      async run() {
        const tableMatch = normalized.match(
          /^CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/i,
        );
        if (tableMatch) {
          ensureTable(tableMatch[1]);
          return { success: true, meta: { changes: 0 } };
        }

        const indexMatch = normalized.match(
          /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_][a-z0-9_]*)/i,
        );
        if (indexMatch) {
          indexes.add(indexMatch[1]);
          return { success: true, meta: { changes: 0 } };
        }

        if (/^INSERT OR IGNORE INTO schema_migrations/i.test(normalized)) {
          ensureTable('schema_migrations');
          const [version, name, appliedAt] = bindings;
          const rows = tables.get('schema_migrations');
          if (rows.some(row => row.version === version)) {
            return { success: true, meta: { changes: 0 } };
          }
          rows.push({ version, name, applied_at: appliedAt });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^INSERT OR IGNORE INTO processed_updates/i.test(normalized)) {
          ensureTable('processed_updates');
          const [updateId, updateType, claimedAt] = bindings;
          const rows = tables.get('processed_updates');
          if (rows.some(row => row.update_id === String(updateId))) {
            return { success: true, meta: { changes: 0 } };
          }
          rows.push({
            update_id: String(updateId),
            update_type: updateType,
            claimed_at: claimedAt,
            completed_at: null,
            status: 'processing',
            error_code: null,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^INSERT OR IGNORE INTO users/i.test(normalized)) {
          ensureTable('users');
          const [userId, username, firstName, lastName, createdAt, updatedAt] = bindings;
          const rows = tables.get('users');
          if (rows.some(row => row.user_id === String(userId))) {
            return { success: true, meta: { changes: 0 } };
          }
          rows.push({
            user_id: String(userId), username, first_name: firstName,
            last_name: lastName, status: 'active', trust_level: 'normal',
            is_muted: 0, violation_count: 0, topic_id: null,
            info_card_message_id: null, profile_snapshot: null,
            topic_lock_token: null, topic_lock_until: null,
            created_at: createdAt, updated_at: updatedAt, last_message_at: null,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE processed_updates SET status = 'processing'/i.test(normalized)) {
          const [claimedAt, updateType, updateId, staleBefore] = bindings;
          const row = (tables.get('processed_updates') || [])
            .find(item => item.update_id === String(updateId));
          const reclaimable = row && (
            row.status === 'retryable'
            || (row.status === 'processing' && row.claimed_at < staleBefore)
          );
          if (!reclaimable) return { success: true, meta: { changes: 0 } };
          Object.assign(row, {
            status: 'processing',
            claimed_at: claimedAt,
            update_type: updateType,
            completed_at: null,
            error_code: null,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE processed_updates SET status = 'completed'/i.test(normalized)) {
          const [completedAt, updateId] = bindings;
          const row = (tables.get('processed_updates') || [])
            .find(item => item.update_id === String(updateId));
          if (!row) return { success: true, meta: { changes: 0 } };
          Object.assign(row, {
            status: 'completed',
            completed_at: completedAt,
            error_code: null,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE processed_updates SET status = 'retryable'/i.test(normalized)) {
          const [errorCode, updateId] = bindings;
          const row = (tables.get('processed_updates') || [])
            .find(item => item.update_id === String(updateId));
          if (!row) return { success: true, meta: { changes: 0 } };
          Object.assign(row, { status: 'retryable', error_code: errorCode });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^INSERT INTO users /i.test(normalized)) {
          ensureTable('users');
          const [
            userId, username, firstName, lastName, status, trustLevel,
            isMuted, violationCount, topicId, infoCardMessageId,
            profileSnapshot, createdAt, updatedAt, lastMessageAt,
          ] = bindings;
          const rows = tables.get('users');
          const existing = rows.find(row => row.user_id === String(userId));
          const next = {
            user_id: String(userId),
            username,
            first_name: firstName,
            last_name: lastName,
            status,
            trust_level: trustLevel,
            is_muted: isMuted,
            violation_count: violationCount,
            topic_id: topicId,
            info_card_message_id: infoCardMessageId,
            profile_snapshot: profileSnapshot,
            created_at: existing?.created_at ?? createdAt,
            updated_at: updatedAt,
            last_message_at: lastMessageAt,
            topic_lock_token: existing?.topic_lock_token ?? null,
            topic_lock_until: existing?.topic_lock_until ?? null,
          };
          if (existing) Object.assign(existing, next);
          else rows.push(next);
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE users SET topic_lock_token = \?/i.test(normalized)) {
          const [token, lockUntil, updatedAt, userId, now, currentToken] = bindings;
          const row = (tables.get('users') || [])
            .find(item => item.user_id === String(userId));
          const available = row
            && row.topic_id == null
            && (
              row.topic_lock_token == null
              || row.topic_lock_until < now
              || row.topic_lock_token === currentToken
            );
          if (!available) return { success: true, meta: { changes: 0 } };
          Object.assign(row, {
            topic_lock_token: token,
            topic_lock_until: lockUntil,
            updated_at: updatedAt,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE users SET topic_lock_token = NULL/i.test(normalized)) {
          const [updatedAt, userId, token] = bindings;
          const row = (tables.get('users') || []).find(item => (
            item.user_id === String(userId) && item.topic_lock_token === token
          ));
          if (!row) return { success: true, meta: { changes: 0 } };
          Object.assign(row, {
            topic_lock_token: null,
            topic_lock_until: null,
            updated_at: updatedAt,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE users SET topic_id = \?/i.test(normalized)) {
          const [topicId, updatedAt, userId, token] = bindings;
          const row = (tables.get('users') || []).find(item => (
            item.user_id === String(userId) && item.topic_lock_token === token
          ));
          if (!row) return { success: true, meta: { changes: 0 } };
          Object.assign(row, {
            topic_id: String(topicId),
            topic_lock_token: null,
            topic_lock_until: null,
            updated_at: updatedAt,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE users SET topic_id = NULL/i.test(normalized)) {
          const [updatedAt, userId, topicId] = bindings;
          const row = (tables.get('users') || []).find(item => (
            item.user_id === String(userId) && item.topic_id === String(topicId)
          ));
          if (!row) return { success: true, meta: { changes: 0 } };
          Object.assign(row, {
            topic_id: null,
            topic_lock_token: null,
            topic_lock_until: null,
            updated_at: updatedAt,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE users SET /i.test(normalized)) {
          const userId = String(bindings.at(-1));
          const row = (tables.get('users') || []).find(item => item.user_id === userId);
          if (!row) return { success: true, meta: { changes: 0 } };
          const setClause = normalized.match(/^UPDATE users SET (.+) WHERE user_id = \?/i)?.[1];
          const columns = setClause?.split(',').map(part => part.trim().match(/^([a-z_]+) = \?$/i)?.[1]);
          if (!columns?.every(Boolean)) throw new Error(`Mock D1 无法解析用户更新: ${normalized}`);
          columns.forEach((column, index) => { row[column] = bindings[index]; });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^INSERT INTO message_links /i.test(normalized)) {
          ensureTable('message_links');
          const [
            direction, sourceChatId, sourceMessageId, targetChatId,
            targetMessageId, topicId, userId, contentSnapshot,
            contentHash, createdAt, updatedAt,
          ] = bindings;
          const rows = tables.get('message_links');
          const existing = rows.find(item => (
            item.direction === direction
            && item.source_chat_id === String(sourceChatId)
            && item.source_message_id === String(sourceMessageId)
          ));
          const next = {
            direction,
            source_chat_id: String(sourceChatId),
            source_message_id: String(sourceMessageId),
            target_chat_id: String(targetChatId),
            target_message_id: String(targetMessageId),
            topic_id: topicId == null ? null : String(topicId),
            user_id: String(userId),
            content_snapshot: contentSnapshot,
            content_hash: contentHash,
            created_at: existing?.created_at ?? createdAt,
            updated_at: updatedAt,
          };
          if (existing) Object.assign(existing, next);
          else rows.push(next);
          return { success: true, meta: { changes: 1 } };
        }

        if (/^INSERT INTO admin_users /i.test(normalized)) {
          ensureTable('admin_users');
          const [userId, role, enabled, grantedBy, createdAt, updatedAt] = bindings;
          const rows = tables.get('admin_users');
          const existing = rows.find(item => item.user_id === String(userId));
          const next = {
            user_id: String(userId), role, enabled, granted_by: grantedBy,
            created_at: existing?.created_at ?? createdAt, updated_at: updatedAt,
          };
          if (existing) Object.assign(existing, next); else rows.push(next);
          return { success: true, meta: { changes: 1 } };
        }

        if (/^INSERT INTO admin_audit_log /i.test(normalized)) {
          ensureTable('admin_audit_log');
          const [id, adminId, action, resourceType, resourceId, beforeState, afterState, createdAt] = bindings;
          tables.get('admin_audit_log').push({
            id, admin_id: String(adminId), action, resource_type: resourceType,
            resource_id: resourceId, before_state: beforeState,
            after_state: afterState, created_at: createdAt,
          });
          return { success: true, meta: { changes: 1 } };
        }

        if (/^INSERT INTO rules /i.test(normalized)) {
          ensureTable('rules');
          const [ruleId, ruleType, pattern, responseText, action, priority, enabled, metadata, createdBy, createdAt, updatedAt] = bindings;
          const rows = tables.get('rules');
          const existing = rows.find(item => item.rule_id === String(ruleId));
          const next = {
            rule_id: String(ruleId), rule_type: ruleType, pattern,
            response_text: responseText, action, priority, enabled, metadata,
            created_by: createdBy, created_at: existing?.created_at ?? createdAt,
            updated_at: updatedAt,
          };
          if (existing) Object.assign(existing, next); else rows.push(next);
          return { success: true, meta: { changes: 1 } };
        }

        if (/^DELETE FROM rules WHERE rule_id = \?/i.test(normalized)) {
          const rows = tables.get('rules') || [];
          const index = rows.findIndex(item => item.rule_id === String(bindings[0]));
          if (index < 0) return { success: true, meta: { changes: 0 } };
          rows.splice(index, 1);
          return { success: true, meta: { changes: 1 } };
        }

        if (/^UPDATE rules SET enabled = \?/i.test(normalized)) {
          const [enabled, updatedAt, ruleId] = bindings;
          const row = (tables.get('rules') || []).find(item => item.rule_id === String(ruleId));
          if (!row) return { success: true, meta: { changes: 0 } };
          Object.assign(row, { enabled, updated_at: updatedAt });
          return { success: true, meta: { changes: 1 } };
        }

        const retentionDelete = normalized.match(/^DELETE FROM (processed_updates|message_links|admin_audit_log) WHERE (claimed_at|created_at) < \?$/i);
        if (retentionDelete) {
          const [, tableName, columnName] = retentionDelete;
          const rows = tables.get(tableName) || [];
          const before = rows.length;
          const retained = rows.filter(row => Number(row[columnName]) >= Number(bindings[0]));
          tables.set(tableName, retained);
          return { success: true, meta: { changes: before - retained.length } };
        }

        throw new Error(`Mock D1 run() 不支持 SQL: ${normalized}`);
      },
    };
  }

  return {
    prepare(sql) {
      return createStatement(sql);
    },
    async batch(statements) {
      return Promise.all(statements.map(statement => statement.run()));
    },
    _table(name) {
      return tables.get(name) || [];
    },
    _tableNames() {
      return [...tables.keys()];
    },
    _indexNames() {
      return [...indexes];
    },
  };
}
