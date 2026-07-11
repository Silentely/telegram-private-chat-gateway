import { describe, it, expect } from 'vitest';
import { createMockD1 } from '../helpers/mock-d1.js';
import { ensureMigrations } from '../../src/storage/migrations.js';
import { createD1Storage } from '../../src/storage/d1-storage.js';

describe('D1 system stats', () => {
  it('汇总用户与最近对话信息', async () => {
    const db = createMockD1();
    await ensureMigrations(db, 1000);
    const storage = createD1Storage(db);
    await storage.upsertUser({
      userId: '1',
      username: 'alice',
      firstName: 'Alice',
      topicId: '10',
      lastMessageAt: 1000,
    });
    await storage.upsertUser({
      userId: '2',
      username: 'bob',
      firstName: 'Bob',
      topicId: '20',
      status: 'banned',
      lastMessageAt: 5000,
    });
    await storage.upsertUser({
      userId: '3',
      firstName: 'Carol',
      lastMessageAt: 3000,
    });

    const stats = await storage.getSystemStats();
    expect(stats.usersTotal).toBe(3);
    expect(stats.usersWithTopic).toBe(2);
    expect(stats.usersBanned).toBe(1);
    expect(stats.lastActiveUser).toMatchObject({
      userId: '2',
      username: 'bob',
      firstName: 'Bob',
      lastMessageAt: 5000,
    });
    expect(stats.recentActiveUsers?.map(u => u.userId)).toEqual(['2', '3', '1']);
  });

  it('searchUsers 支持 UID 与用户名', async () => {
    const db = createMockD1();
    await ensureMigrations(db, 1000);
    const storage = createD1Storage(db);
    await storage.upsertUser({ userId: '99', username: 'findme', firstName: 'Find' });
    await expect(storage.searchUsers('99')).resolves.toHaveLength(1);
    await expect(storage.searchUsers('findme')).resolves.toEqual([
      expect.objectContaining({ userId: '99', username: 'findme' }),
    ]);
  });
});

describe('D1 migrations', () => {
  it('迁移重复执行不会重复应用版本', async () => {
    const db = createMockD1();

    await ensureMigrations(db, 1000);
    await ensureMigrations(db, 2000);

    expect(db._table('schema_migrations')).toHaveLength(1);
    expect(db._table('schema_migrations')[0]).toMatchObject({
      version: 1,
      name: 'initial_schema',
      applied_at: 1000,
    });
  });

  it('初始迁移创建全部长期状态表', async () => {
    const db = createMockD1();

    await ensureMigrations(db, 1000);

    expect(db._tableNames()).toEqual(expect.arrayContaining([
      'schema_migrations',
      'users',
      'processed_updates',
      'message_links',
      'rules',
      'settings',
      'admin_users',
      'admin_audit_log',
    ]));
  });

  it('初始迁移创建查询和清理所需索引', async () => {
    const db = createMockD1();

    await ensureMigrations(db, 1000);

    expect(db._indexNames()).toEqual(expect.arrayContaining([
      'idx_users_topic_id',
      'idx_users_status',
      'idx_users_last_message_at',
      'idx_rules_type_enabled_priority',
      'idx_processed_updates_claimed_at',
      'idx_message_links_created_at',
      'idx_admin_audit_created_at',
    ]));
  });
});

describe('D1 管理员与审计', () => {
  it('保存管理员角色并记录不含消息正文的审计数据', async () => {
    const db = createMockD1();
    await ensureMigrations(db, 1000);
    const storage = createD1Storage(db);
    await storage.upsertAdminUser({ userId: '1', role: 'operator', enabled: true, grantedBy: 'owner' });
    await storage.appendAudit({
      id: 'audit-1',
      adminId: 'owner',
      action: 'admin.grant',
      resourceType: 'admin',
      resourceId: '1',
      beforeState: null,
      afterState: { role: 'operator' },
      createdAt: 2000,
    });
    await expect(storage.getAdminUser('1')).resolves.toMatchObject({ role: 'operator', enabled: true });
    expect(db._table('admin_audit_log')[0]).toMatchObject({ action: 'admin.grant', resource_id: '1' });
  });
});

describe('D1 用户并发安全', () => {
  it('重复确保用户存在时不覆盖已有 Topic 和状态', async () => {
    const db = createMockD1();
    await ensureMigrations(db, 1000);
    const storage = createD1Storage(db);
    await storage.upsertUser({ userId: '1', topicId: '88', status: 'banned' });

    await storage.ensureUser({ userId: '1', firstName: 'Alice' });

    await expect(storage.getUser('1')).resolves.toMatchObject({
      topicId: '88',
      status: 'banned',
    });
  });

  it('资料字段更新不覆盖并发写入的封禁状态', async () => {
    const db = createMockD1();
    await ensureMigrations(db, 1000);
    const storage = createD1Storage(db);
    await storage.upsertUser({ userId: '1', status: 'active' });
    const originalPrepare = db.prepare.bind(db);
    let injected = false;
    db.prepare = sql => {
      const statement = originalPrepare(sql);
      if (!injected && /^\s*SELECT \* FROM users WHERE user_id/i.test(String(sql))) {
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              async first() {
                const row = await bound.first();
                db._table('users')[0].status = 'banned';
                injected = true;
                return row;
              },
            };
          },
        };
      }
      if (!injected && /UPDATE users[\s\S]*first_name = \?/i.test(String(sql))) {
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              async run() {
                db._table('users')[0].status = 'banned';
                injected = true;
                return bound.run();
              },
            };
          },
        };
      }
      return statement;
    };

    await storage.updateUserState('1', { firstName: 'Alice' });

    await expect(storage.getUser('1')).resolves.toMatchObject({
      firstName: 'Alice',
      status: 'banned',
    });
  });
});

describe('D1 保留期清理', () => {
  it('只删除过期幂等、消息映射和审计，不删除用户', async () => {
    const db = createMockD1();
    await ensureMigrations(db, 1000);
    const storage = createD1Storage(db);
    await storage.upsertUser({ userId: '1' });
    db._table('processed_updates').push(
      { update_id: 'old', claimed_at: 10 },
      { update_id: 'new', claimed_at: 100 },
    );
    db._table('message_links').push(
      { direction: 'x', source_chat_id: '1', source_message_id: '1', created_at: 10 },
      { direction: 'x', source_chat_id: '1', source_message_id: '2', created_at: 100 },
    );
    db._table('admin_audit_log').push(
      { id: 'old', created_at: 10 },
      { id: 'new', created_at: 100 },
    );

    await expect(storage.cleanupRetention({
      updatesBefore: 50,
      linksBefore: 50,
      auditsBefore: 50,
    })).resolves.toEqual({ updates: 1, links: 1, audits: 1 });
    expect(db._table('users')).toHaveLength(1);
    expect(db._table('processed_updates')).toHaveLength(1);
    expect(db._table('message_links')).toHaveLength(1);
    expect(db._table('admin_audit_log')).toHaveLength(1);
  });
});
