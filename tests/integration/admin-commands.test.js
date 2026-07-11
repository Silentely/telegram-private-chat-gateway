import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminCommandHandlers } from '../../src/admin-commands.js';
import { createMockEnv } from '../helpers/mock-env.js';

describe('admin-commands handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createHandlers(env, calls) {
    return createAdminCommandHandlers({
      tgCall: async (_env, method, body) => {
        calls.push({ method, body });
        return { ok: true, result: { message_id: 1, status: 'administrator' } };
      },
      gatewayVersion: '1.0.0-test',
      recordSystemError: () => {},
      isOwnerUser: () => true,
      isAdminUser: async () => true,
      parseIdAllowlist: () => [],
      safeGetJSON: async () => null,
      resolveThreadIdForUser: async () => 10,
      getRecentSystemErrors: () => [],
      userActions: {},
    });
  }

  it('handleMenuCommand 发送含管理菜单文案与键盘', async () => {
    const env = createMockEnv();
    const calls = [];
    const h = createHandlers(env, calls);
    await h.handleMenuCommand(env, 1, 123456789);
    const send = calls.find(c => c.method === 'sendMessage');
    expect(send?.body?.text).toMatch(/管理菜单/);
    expect(send?.body?.reply_markup?.inline_keyboard?.flat?.()
      .some(b => b.callback_data === 'adm:nav:rank')).toBe(true);
  });

  it('handleSysinfoCommand stats 页包含 CST', async () => {
    const env = createMockEnv();
    const calls = [];
    const h = createHandlers(env, calls);
    await h.handleSysinfoCommand(env, 1, { page: 'stats' });
    const send = calls.find(c => c.method === 'sendMessage');
    expect(send?.body?.text).toMatch(/CST/);
    expect(send?.body?.text).toMatch(/今日/);
  });

  it('bumpDailyStat 写入 CST 日键', async () => {
    const env = createMockEnv();
    const h = createHandlers(env, []);
    await h.bumpDailyStat(env, 'messages_in', 2);
    const keys = [];
    let cursor;
    do {
      const page = await env.TOPIC_MAP.list({ prefix: 'stats:', cursor, limit: 100 });
      keys.push(...(page.keys || []).map(k => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    expect(keys.some(k => k.startsWith('stats:'))).toBe(true);
    const raw = await env.TOPIC_MAP.get(keys.find(k => k.startsWith('stats:')));
    const obj = JSON.parse(raw);
    expect(obj.messages_in).toBe(2);
    expect(obj.tz).toMatch(/UTC\+8/);
  });
});
