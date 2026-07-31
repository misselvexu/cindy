/**
 * usageFormat.test.ts
 * ---------------------------------------------------------------------------
 * token 紧凑口径 —— desktop 消息动作行与 mobile 操作行共用这一份,
 * 同一轮在两端必须读到同一个数字。
 */

import { describe, expect, it } from 'vitest';

import { formatCompactTokens } from '../usageFormat';

describe('formatCompactTokens', () => {
  it('小于 1k 原样输出', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(1)).toBe('1');
    expect(formatCompactTokens(999)).toBe('999');
  });

  it('千位档一位小数', () => {
    expect(formatCompactTokens(1000)).toBe('1.0k');
    expect(formatCompactTokens(12_400)).toBe('12.4k');
    expect(formatCompactTokens(999_999)).toBe('1000.0k');
  });

  it('百万档一位小数', () => {
    expect(formatCompactTokens(1_000_000)).toBe('1.0M');
    expect(formatCompactTokens(2_107_700)).toBe('2.1M');
  });

  it('十亿档一位小数(重度会话的 cache read 会到这个量级)', () => {
    expect(formatCompactTokens(1_000_000_000)).toBe('1.0B');
    expect(formatCompactTokens(9_290_698_420)).toBe('9.3B');
  });
});
