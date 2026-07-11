import { describe, it, expect } from 'vitest';
import {
  utcDayStartMs,
  utcYesterdayKey,
  opsDayKey,
  opsYesterdayKey,
  opsDayStartMs,
  summarizeInboundActivity,
  shiftHourBuckets,
  peakHoursFromBuckets,
  formatHeatBars,
  formatHeatAxis,
  formatSparkline,
  formatPeakHours,
  rankMedal,
  displayUserLabel,
  shouldAppendUsername,
  formatDelta,
  activitySourceLabel,
} from '../../src/activity-summary.js';

describe('activity-summary', () => {
  it('utcDayStartMs 对齐 UTC 零点', () => {
    const ms = Date.UTC(2026, 6, 11, 15, 30, 0);
    expect(utcDayStartMs(ms)).toBe(Date.UTC(2026, 6, 11, 0, 0, 0));
  });

  it('utcYesterdayKey 为前一 UTC 日', () => {
    const ms = Date.UTC(2026, 6, 11, 12, 0, 0);
    expect(utcYesterdayKey(ms)).toBe('2026-07-10');
  });

  it('opsDayKey / opsDayStartMs 按 CST 日切', () => {
    // 2026-07-11 20:00 UTC = 2026-07-12 04:00 CST → 日历日 07-12
    const lateUtc = Date.UTC(2026, 6, 11, 20, 0, 0);
    expect(opsDayKey(lateUtc, 8)).toBe('2026-07-12');
    // 2026-07-11 15:00 UTC = 2026-07-11 23:00 CST → 仍是 07-11
    const earlyUtc = Date.UTC(2026, 6, 11, 15, 0, 0);
    expect(opsDayKey(earlyUtc, 8)).toBe('2026-07-11');
    // CST 日界：07-12 00:00 CST = 07-11 16:00 UTC
    expect(opsDayStartMs(lateUtc, 8)).toBe(Date.UTC(2026, 6, 11, 16, 0, 0));
    expect(opsYesterdayKey(lateUtc, 8)).toBe('2026-07-11');
  });

  it('汇总总量、排行与高峰小时', () => {
    const day = Date.UTC(2026, 6, 11, 0, 0, 0);
    const rows = [
      { userId: '1', createdAt: day + 14 * 3600_000 },
      { userId: '1', createdAt: day + 14 * 3600_000 + 1000 },
      { userId: '1', createdAt: day + 15 * 3600_000 },
      { userId: '2', createdAt: day + 14 * 3600_000 },
      { userId: '3', createdAt: day + 9 * 3600_000 },
    ];
    const s = summarizeInboundActivity(rows, { topN: 2 });
    expect(s.total).toBe(5);
    expect(s.uniqueUsers).toBe(3);
    expect(s.ranking).toEqual([
      { userId: '1', count: 3 },
      { userId: '2', count: 1 },
    ]);
    expect(s.hours[14]).toBe(3);
    expect(s.hours[15]).toBe(1);
    expect(s.hours[9]).toBe(1);
    expect(s.peakHours[0]).toMatchObject({ hour: 14, count: 3 });
  });

  it('空数据热力为全点', () => {
    expect(formatHeatBars([])).toBe('·'.repeat(24));
    expect(formatPeakHours([])).toBe('暂无');
    expect(formatHeatAxis()).toHaveLength(24);
  });

  it('热力条随最大值缩放', () => {
    const hours = Array.from({ length: 24 }, () => 0);
    hours[0] = 1;
    hours[1] = 8;
    const bar = formatHeatBars(hours);
    expect(bar).toHaveLength(24);
    expect(bar[0]).not.toBe('·');
    expect(bar[1]).toBe('█');
  });

  it('UTC 小时桶平移到 CST(+8)', () => {
    const hours = Array.from({ length: 24 }, () => 0);
    hours[0] = 5; // UTC 0 → CST 8
    hours[16] = 3; // UTC 16 → CST 0
    const local = shiftHourBuckets(hours, 8);
    expect(local[8]).toBe(5);
    expect(local[0]).toBe(3);
    expect(peakHoursFromBuckets(local, 1)[0]).toMatchObject({ hour: 8, count: 5 });
  });

  it('sparkline 可变长度', () => {
    expect(formatSparkline([0, 0, 0])).toBe('···');
    expect(formatSparkline([1, 4, 8])).toHaveLength(3);
    expect(formatSparkline([1, 4, 8])[2]).toBe('█');
  });

  it('名次徽章', () => {
    expect(rankMedal(0)).toBe('🥇');
    expect(rankMedal(1)).toBe('🥈');
    expect(rankMedal(2)).toBe('🥉');
    expect(rankMedal(3)).toBe('4.');
  });

  it('用户标签不重复 @username', () => {
    expect(displayUserLabel({ firstName: 'Ada', username: 'ada' })).toBe('Ada');
    expect(displayUserLabel({ username: 'bob' })).toBe('@bob');
    expect(displayUserLabel({ userId: '9' })).toBe('9');
    expect(shouldAppendUsername({ username: 'bob' }, '@bob')).toBe(false);
    expect(shouldAppendUsername({ username: 'ada' }, 'Ada')).toBe(true);
  });

  it('delta 与数据源标签', () => {
    expect(formatDelta(10, 7)).toBe('↑3');
    expect(formatDelta(3, 5)).toBe('↓2');
    expect(formatDelta(4, 4)).toBe('持平');
    expect(activitySourceLabel('message_links')).toBe('消息映射');
    expect(activitySourceLabel('none')).toBe('暂无');
  });
});
