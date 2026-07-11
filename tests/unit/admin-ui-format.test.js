import { describe, it, expect } from 'vitest';
import {
  buildAdminHomeKeyboard,
  buildSysinfoKeyboard,
  buildUserJumpKeyboard,
  formatRankingBlock,
  formatHeatBlock,
  escapeHtml,
  buildBanConfirmKeyboard,
  buildCloseConfirmKeyboard,
  buildResetConfirmKeyboard,
  formatEmptyActivityHints,
} from '../../src/admin-ui-format.js';

describe('admin-ui-format', () => {
  it('buildAdminHomeKeyboard 含活跃与查找', () => {
    const kb = buildAdminHomeKeyboard(false);
    const flat = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(flat).toContain('adm:nav:rank');
    expect(flat).toContain('adm:nav:find');
    expect(flat).not.toContain('adm:nav:synccommands');
  });

  it('Owner 菜单含 synccommands', () => {
    const flat = buildAdminHomeKeyboard(true).inline_keyboard.flat().map(b => b.callback_data);
    expect(flat).toContain('adm:nav:synccommands');
  });

  it('sysinfo 键盘含 activity 页', () => {
    const flat = buildSysinfoKeyboard('activity').inline_keyboard.flat().map(b => b.callback_data);
    expect(flat).toContain('adm:sys:activity');
  });

  it('formatHeatBlock 标注 CST', () => {
    const hours = Array.from({ length: 24 }, () => 0);
    hours[0] = 3;
    const lines = formatHeatBlock(hours);
    expect(lines.join('\n')).toMatch(/CST/);
  });

  it('formatRankingBlock 空列表有引导', () => {
    const lines = formatRankingBlock([]);
    expect(lines.some(l => l.includes('暂无'))).toBe(true);
  });

  it('escapeHtml 转义尖括号', () => {
    expect(escapeHtml('<a>')).toContain('&lt;');
  });

  it('用户跳转键盘双列并含 panel 回调', () => {
    const kb = buildUserJumpKeyboard([
      { userId: '1', firstName: 'A' },
      { userId: '2', firstName: 'B' },
    ], { includeMenu: false });
    expect(kb.inline_keyboard[0]).toHaveLength(2);
    expect(kb.inline_keyboard[0][0].callback_data).toBe('adm:u:panel:1');
  });

  it('封禁确认键盘', () => {
    const flat = buildBanConfirmKeyboard('99').inline_keyboard.flat().map(b => b.callback_data);
    expect(flat).toContain('adm:u:banok:99');
    expect(flat).toContain('adm:u:bancancel:99');
  });

  it('关闭/重置确认键盘与危险操作入口', () => {
    expect(buildCloseConfirmKeyboard('1').inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(expect.arrayContaining(['adm:u:closeok:1', 'adm:u:closecancel:1']));
    expect(buildResetConfirmKeyboard('2').inline_keyboard.flat().map(b => b.callback_data))
      .toEqual(expect.arrayContaining(['adm:u:resetok:2', 'adm:u:resetcancel:2']));
    const kb = buildUserActionKeyboard('3');
    const data = kb.inline_keyboard.flat().map(b => b.callback_data);
    expect(data).toContain('adm:u:closeask:3');
    expect(data).toContain('adm:u:resetask:3');
    expect(data).toContain('adm:u:banask:3');
  });

  it('空活跃引导提示', () => {
    const hints = formatEmptyActivityHints().join('\n');
    expect(hints).toMatch(/CST/);
    expect(hints).toMatch(/find/);
  });
});
