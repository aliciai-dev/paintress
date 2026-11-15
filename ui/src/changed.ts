/**
 * 变更高亮的展示寿命：从**最后一次写入**起算，与 daemon 的 ChangesStore TTL 保持一致。
 * 独立成纯函数，避免 UI 测试为了验证时间计算去等真实的三分钟。
 */
export const CHANGED_TTL_MS = 3 * 60_000;

/**
 * 一条变更记录还剩多久可以亮。
 * `at` 是 daemon 记录的写入时间；缺时间戳（旧 daemon）时给完整窗口，向前兼容。
 */
export function changedRemainingMs(at: number, now = Date.now()): number {
  const elapsed = Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : 0;
  return Math.max(0, CHANGED_TTL_MS - elapsed);
}
