import { describe, expect, it } from 'vitest';
import { detectLang } from '../ui/src/i18n.js';
import { CHANGED_TTL_MS, changedRemainingMs } from '../ui/src/changed.js';
import { formatRelative, RECENT_WINDOW_MS } from '../ui/src/recency.js';
import { CHANGE_TTL_MS } from '../src/web/changes.js';

describe('查看器语言检测', () => {
  it('中文区域设置均为中文', () => {
    for (const language of ['zh', 'zh-CN', 'zh-TW', 'ZH-hans-CN']) {
      expect(detectLang({ language }), language).toBe('zh');
    }
  });

  it('首选语言优先于备用语言；非中文一律英文', () => {
    expect(detectLang({ languages: ['en-US', 'zh-CN'], language: 'zh-CN' })).toBe('en');
    expect(detectLang({ languages: ['ja-JP'], language: 'ja-JP' })).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });
});

describe('变更高亮的剩余寿命', () => {
  const now = 1_800_000_000_000;

  it('前后端使用同一个 3 分钟窗口', () => {
    expect(CHANGED_TTL_MS).toBe(3 * 60_000);
    expect(CHANGED_TTL_MS).toBe(CHANGE_TTL_MS);
  });

  it('从最后一次写入起算：已过去 2 分钟只剩 1 分钟，而不是重新给 3 分钟', () => {
    expect(changedRemainingMs(now, now)).toBe(3 * 60_000);
    expect(changedRemainingMs(now - 2 * 60_000, now)).toBe(60_000);
    expect(changedRemainingMs(now - 4 * 60_000, now)).toBe(0);
  });

  it('未来时间按新变更处理；缺时间戳兼容旧 daemon，给完整窗口', () => {
    expect(changedRemainingMs(now + 1000, now)).toBe(3 * 60_000);
    expect(changedRemainingMs(0, now)).toBe(3 * 60_000);
    expect(changedRemainingMs(Number.NaN, now)).toBe(3 * 60_000);
  });
});

describe('列表「最近编辑」的相对时间', () => {
  const now = 1_800_000_000_000;

  it('窗口就是 24 小时（与规格 D2 一致）', () => {
    expect(RECENT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('一分钟内是「刚刚」，之后按分钟、再按小时', () => {
    expect(formatRelative(now, now, 'zh')).toBe('刚刚');
    expect(formatRelative(now - 59_000, now, 'zh')).toBe('刚刚');
    expect(formatRelative(now - 60_000, now, 'zh')).toBe('1 分钟前');
    expect(formatRelative(now - 59 * 60_000, now, 'zh')).toBe('59 分钟前');
    expect(formatRelative(now - 60 * 60_000, now, 'zh')).toBe('1 小时前');
    expect(formatRelative(now - 23 * 3600_000, now, 'zh')).toBe('23 小时前');
  });

  it('超过 24 小时不画文字（悬停的绝对时间由调用方给）', () => {
    expect(formatRelative(now - 24 * 3600_000, now, 'zh')).toBeNull();
    expect(formatRelative(now - 48 * 3600_000, now, 'zh')).toBeNull();
  });

  it('未来时间（时钟漂移）按「刚刚」，不可用的时间戳返回 null', () => {
    expect(formatRelative(now + 5_000, now, 'zh')).toBe('刚刚');
    expect(formatRelative(0, now, 'zh')).toBeNull();
    expect(formatRelative(Number.NaN, now, 'zh')).toBeNull();
    expect(formatRelative(now, Number.NaN, 'zh')).toBeNull();
  });

  it('英文文案不跟中文混', () => {
    expect(formatRelative(now, now, 'en')).toBe('just now');
    expect(formatRelative(now - 2 * 60_000, now, 'en')).toBe('2 min ago');
    expect(formatRelative(now - 3 * 3600_000, now, 'en')).toBe('3 h ago');
  });
});
