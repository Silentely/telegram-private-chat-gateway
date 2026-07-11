import { describe, expect, it } from 'vitest';

/**
 * 与 worker.js buildTopicTitle 保持一致的标题规则（避免引入打包依赖）。
 * 用于锁定「缺 first_name 时不得默默变成 User」相关回归。
 */
function buildTopicTitle(from, maxNameLength = 64, maxTitleLength = 128) {
  const src = from || {};
  const firstName = (src.first_name || src.firstName || '').trim().substring(0, maxNameLength);
  const lastName = (src.last_name || src.lastName || '').trim().substring(0, maxNameLength);
  let username = '';
  const rawUsername = src.username || '';
  if (rawUsername) {
    username = String(rawUsername).replace(/[^\w]/g, '').substring(0, 20);
  }
  const cleanName = `${firstName} ${lastName}`
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = cleanName || 'User';
  const usernameStr = username ? ` @${username}` : '';
  return (name + usernameStr).substring(0, maxTitleLength);
}

function isSparseTelegramFrom(from) {
  if (!from || typeof from !== 'object') return true;
  const hasName = Boolean(String(from.first_name || '').trim() || String(from.last_name || '').trim());
  const hasUsername = Boolean(String(from.username || '').trim());
  return !hasName && !hasUsername;
}

describe('话题标题 from 资料', () => {
  it('完整资料生成 名称 @用户名', () => {
    expect(buildTopicTitle({
      id: 5790788359,
      first_name: '小明',
      last_name: '张',
      username: 'xiaoming_z',
    })).toBe('小明 张 @xiaoming_z');
  });

  it('仅有 id 的 fakeMsg 会退化为 User（说明调用方必须先 resolve）', () => {
    expect(buildTopicTitle({ id: 5790788359 })).toBe('User');
    expect(isSparseTelegramFrom({ id: 5790788359 })).toBe(true);
  });

  it('补全 first_name 与 username 后不再是 User', () => {
    const sparse = { id: 1 };
    const resolved = {
      id: 1,
      first_name: 'Ada',
      username: 'ada_test',
    };
    expect(isSparseTelegramFrom(sparse)).toBe(true);
    expect(isSparseTelegramFrom(resolved)).toBe(false);
    expect(buildTopicTitle(resolved)).toBe('Ada @ada_test');
  });

  it('兼容 D1 驼峰字段 firstName', () => {
    expect(buildTopicTitle({
      firstName: 'Bob',
      lastName: 'Lee',
      username: 'boblee',
    })).toBe('Bob Lee @boblee');
  });
});
