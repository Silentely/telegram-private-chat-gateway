import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker.js';
import { createD1Storage } from '../../src/storage/d1-storage.js';
import { createMockEnv } from '../helpers/mock-env.js';

function createWebhookRequest(update) {
  return new Request('https://worker.test/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'test-webhook-secret-at-least-32-bytes',
    },
    body: JSON.stringify(update),
  });
}

describe('临时状态与永久信任集成', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('OWNER_IDS 即视为管理权限，无需群管身份', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { message_id: 9100, status: 'member' },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', telegramFetch);
    const env = createMockEnv({
      ADMIN_IDS: '',
      OWNER_IDS: '777001',
    });

    const response = await worker.fetch(createWebhookRequest({
      update_id: 8100,
      message: {
        message_id: 600,
        message_thread_id: 1,
        text: '/whoami',
        chat: { id: Number(env.SUPERGROUP_ID), type: 'supergroup' },
        from: { id: 777001 },
      },
    }), env, { waitUntil() {} });

    expect(response.status).toBe(200);
    // 至少应发出 whoami 回复，而不是权限拒绝
    const bodies = telegramFetch.mock.calls
      .map(([, init]) => {
        try { return JSON.parse(init?.body || '{}'); } catch { return {}; }
      })
      .filter(b => typeof b.text === 'string');
    expect(bodies.some(b => b.text.includes('Whoami') && b.text.includes('777001'))).toBe(true);
    expect(bodies.some(b => b.text.includes('无管理权限'))).toBe(false);
  });

  it('管理员永久信任只写入 D1，不写 verified KV', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { message_id: 9001 },
    }), {
      headers: { 'content-type': 'application/json' },
    })));
    const env = createMockEnv();
    await env.TOPIC_MAP.put('thread:88', '42');
    await env.TOPIC_MAP.put('user:42', JSON.stringify({
      thread_id: 88,
      title: '测试用户',
    }));

    const response = await worker.fetch(createWebhookRequest({
      update_id: 8001,
      message: {
        message_id: 501,
        message_thread_id: 88,
        text: '/trust',
        chat: { id: Number(env.SUPERGROUP_ID), type: 'supergroup' },
        from: { id: 123456789 },
      },
    }), env, { waitUntil() {} });

    expect(response.status).toBe(200);
    await expect(env.TOPIC_MAP.get('verified:42')).resolves.toBe(null);
    await expect(createD1Storage(env.TG_BOT_DB).getUser('42')).resolves.toMatchObject({
      userId: '42',
      trustLevel: 'trusted',
      topicId: '88',
    });
  });

  it('恢复 Owner 私聊 /start 打开管理后台而不是进入用户验证', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, result: { message_id: 9002 },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', telegramFetch);
    const env = createMockEnv();

    const response = await worker.fetch(createWebhookRequest({
      update_id: 8002,
      message: {
        message_id: 502,
        text: '/start',
        chat: { id: 123456789, type: 'private' },
        from: { id: 123456789 },
      },
    }), env, { waitUntil() {} });

    expect(response.status).toBe(200);
    const telegramBodies = telegramFetch.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(telegramBodies).toContainEqual(expect.objectContaining({
      chat_id: 123456789,
      text: '管理后台',
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    }));
    expect(await env.TOPIC_MAP.get('user_challenge:123456789')).toBe(null);
  });

  it('资料卡用户 Callback 通过 Worker 更新 D1 并写审计', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, result: true,
    }), { headers: { 'content-type': 'application/json' } })));
    const env = createMockEnv();
    const storage = createD1Storage(env.TG_BOT_DB);
    await storage.upsertUser({ userId: '42', status: 'active' });

    const response = await worker.fetch(createWebhookRequest({
      update_id: 8003,
      callback_query: {
        id: 'cb-8003',
        data: 'v1:user:ban:42',
        from: { id: 123456789 },
      },
    }), env, { waitUntil() {} });

    expect(response.status).toBe(200);
    await expect(storage.getUser('42')).resolves.toMatchObject({ status: 'banned' });
    expect(env.TG_BOT_DB._table('admin_audit_log')).toHaveLength(1);
  });
});
