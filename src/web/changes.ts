/**
 * 变更记录：AI 写完文件后，把受影响的节点 id 记下来，前端据此高亮。
 * 只存在 daemon 内存里，带 TTL（过期自动失效，避免刷新页面时旧高亮复活）。
 */

export interface ChangeSet {
  project: string;
  /** 相对项目根的文件路径，统一用 / */
  file: string;
  ids: string[];
  at: number;
}

/** 同一次操作内的多次写入合并窗口 */
const MERGE_WINDOW_MS = 1500;
/**
 * 高亮有效期：最后一次写入起算。
 * 客户端会用同一个窗口自己把已画上的金边撤掉（长时间停留的页面不会永远闪）；
 * 这里管的是「刷新 / 重渲染后还能不能重新画上」，两边保持同一个值。
 */
const TTL_MS = 5 * 60_000;

export class ChangesStore {
  private readonly byKey = new Map<string, ChangeSet>();

  private static key(project: string, file: string): string {
    return `${project}\u0000${file}`;
  }

  /** 记录一次变更；窗口期内合并 ids（避免一次 batch 产生多条记录） */
  record(project: string, file: string, ids: string[]): ChangeSet {
    const key = ChangesStore.key(project, file);
    const now = Date.now();
    const prev = this.byKey.get(key);
    if (prev && now - prev.at < MERGE_WINDOW_MS) {
      prev.ids = [...new Set([...prev.ids, ...ids])];
      prev.at = now;
      return prev;
    }
    const set: ChangeSet = { project, file, ids: [...new Set(ids)], at: now };
    this.byKey.set(key, set);
    return set;
  }

  /** 读取未过期的变更 */
  get(project: string, file: string): ChangeSet | undefined {
    const hit = this.byKey.get(ChangesStore.key(project, file));
    if (!hit) return undefined;
    if (Date.now() - hit.at > TTL_MS) return undefined;
    return hit;
  }

  clear(project: string): number {
    let n = 0;
    for (const [key, set] of this.byKey) {
      if (set.project === project) {
        this.byKey.delete(key);
        n += 1;
      }
    }
    return n;
  }

  /** 只清一个文件（agent 说「编辑完了，把高亮去掉」时走这里） */
  clearFile(project: string, file: string): boolean {
    return this.byKey.delete(ChangesStore.key(project, file));
  }

  /** 清理过期条目（由调用方按需触发，避免无限增长） */
  prune(): number {
    const now = Date.now();
    let n = 0;
    for (const [key, set] of this.byKey) {
      if (now - set.at > TTL_MS) {
        this.byKey.delete(key);
        n += 1;
      }
    }
    return n;
  }
}

export const CHANGE_TTL_MS = TTL_MS;
