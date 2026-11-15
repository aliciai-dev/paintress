import { describe, expect, it } from 'vitest';
import { detectLang } from '../ui/src/i18n.js';
import { CHANGED_TTL_MS, changedRemainingMs } from '../ui/src/changed.js';
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
