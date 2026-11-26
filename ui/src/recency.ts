/**
 * 设计稿列表里的「最近编辑」时间文字。
 *
 * 为什么不用 `Intl.RelativeTimeFormat`：界面只有中/英两档文案，且这里的结果要被
 * `test/ui-state.spec.ts` 直接断言——手写三个分支比分隔符与复数规则更可控。
 * 超过 24 小时返回 `null`：列表不该被满屏的固定时间占满（规格 D2）。
 */

import { messages, type Lang } from './i18n.js';

/** 与规格一致：24 小时内才显示文字，更早的文件只在悬停时给绝对时间 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * 相对时间文案；超出窗口（或时间戳不可用）返回 `null`。
 * 未来时间（时钟漂移、NFS 时间戳）按「刚刚」处理，不显示负数。
 */
export function formatRelative(at: number, now: number, lang: Lang): string | null {
  const t = messages(lang);
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) return null;
  const elapsed = now - at;
  if (elapsed >= RECENT_WINDOW_MS) return null;
  if (elapsed < MINUTE_MS) return t.justNow;
  if (elapsed < HOUR_MS) return t.minutesAgo(Math.floor(elapsed / MINUTE_MS));
  return t.hoursAgo(Math.floor(elapsed / HOUR_MS));
}
