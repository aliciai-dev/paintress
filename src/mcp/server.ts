import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../shared/version.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.js';
import { autoRegister, closeViewerHandles, ensureViewer } from '../web/autoregister.js';

const SERVER_NAME = 'paintress';
const SERVER_VERSION = VERSION;

/**
 * 连接时交给客户端模型的使用说明（MCP initialize 的 instructions）。
 * 头号规则是「作画前把查看器拉起来」——人看不到进程状态，agent 不等提醒就该做。
 *
 * 写法纪律（operator 2026-11-14）：**只说「跑 `paintress web`」就结章**。
 * 不开窗、不指 URL、不让人去打开浏览器 —— 窗口是程序的事（openBrowser），
 * 提示词里多一句「你自己去开浏览器」就必然会在 WSL 里开到错的那一个。
 */
const INSTRUCTIONS = `paintress is a design tool for AI agents: design files are JSON, edited through tools and rendered by a local viewer.

VIEWER — the human only sees your work in the viewer:
- Run \`paintress web\` before the first write of a drawing session (creating, editing or showing a design) — do not wait to be asked. It ensures the viewer is running and returns immediately.
- The window is the command's job, not yours: never launch a browser or start a process for it.
- It is idempotent: if the viewer is already up it prints the existing pid/port/URL and exits; calling it again is safe and never starts a second process.
- MCP equivalent: \`paintress_viewer\` returns the same URL. Append \`?file=<relative path>\` to deep-link one document.

WORKFLOW: \`paintress_new\` → \`paintress_query\`/\`paintress_get\` for real node ids (never invent them) → \`paintress_update\`/\`insert\`/\`move\`/\`delete\` or \`paintress_batch\` → \`paintress_validate\` → \`paintress_screenshot\` to check the result with your own eyes.
\`#1\` in the conversation is a click marker from the viewer: resolve it with \`paintress_marks\`.

DESIGN SYSTEM — one source of truth; do not paste values:
- Before the first shape call \`paintress_preset list\`; if it is empty use \`paintress_preset seed\` (dry-run, then apply) or set tokens, and reference them as \`$key\`.
- Before building a button, card or input call \`paintress_component list\`; insert one that fits. Use \`paintress_component add\` once the same shape is needed a second time.
- \`paintress_font list\` shows the font registry; register families with a source and a preview. Text without a fontFamily uses the default and is reported on every read — close that gap.
- After a batch run \`paintress_validate\`; it reports design-system drift, wrong token kinds and font gaps.`;

/** 写操作前补一次查看器：这是「光画不开 web」的兜底网，不靠 agent 自觉 */
const WRITE_TOOLS = new Set([
  'paintress_new',
  'paintress_update',
  'paintress_insert',
  'paintress_delete',
  'paintress_move',
  'paintress_batch',
]);

export interface McpServerOptions {
  /**
   * 写工具执行前确保查看器在跑（幂等）。只在 stdio 入口开启：
   * 测试 / 嵌入场景不希望一次写操作就拉起后台进程。
   */
  ensureViewerBeforeWrite?: boolean;
}

/** 构建 MCP server：把共享工具注册到 stdio 协议上 */
export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  for (const [name, def] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.inputSchema },
      async (args) => {
        try {
          if (opts.ensureViewerBeforeWrite === true && WRITE_TOOLS.has(name)) await ensureViewerQuiet();
          const payload = await def.run(args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
        } catch (cause) {
          return {
            content: [{ type: 'text' as const, text: cause instanceof Error ? cause.message : String(cause) }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

/**
 * 父进程看门狗：stdio MCP server 必须随宿主死亡而退出，否则变成孤儿进程
 * （MCP 生态的已知问题）。两道保险：ppid 变化 + stdin EOF。
 */
function installParentWatchdog(): void {
  const parentPid = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) {
      exitClean(0);
    }
    try {
      process.kill(parentPid, 0);
    } catch {
      exitClean(0);
    }
  }, 5000);
  timer.unref();
  // stdin 关闭通常也意味着宿主已退出；不消费数据，只监听结束
  process.stdin.on('end', () => exitClean(0));
  process.stdin.on('close', () => exitClean(0));
}

/**
 * attach 连接引用：由 autoregister 持有（ensureViewer 每次调用都会复用/刷新）。
 * 退出时显式关闭——比等 OS 回收更快让 daemon 看到 we're gone。
 */
function exitClean(code = 0): never {
  closeViewerHandles();
  process.exit(code);
}

/** 写之前补一次查看器：best-effort，失败不阻断写入（人看不到图，但文件还是要改） */
async function ensureViewerQuiet(): Promise<void> {
  try {
    await ensureViewer();
  } catch (cause) {
    process.stderr.write(
      `paintress: 写操作前自动拉起查看器失败（${cause instanceof Error ? cause.message : String(cause)}）\n`,
    );
  }
}

/** 自动注册自身（best-effort，失败不阻断 MCP） */
async function registerSelf(): Promise<void> {
  const res = await autoRegister();
  if (res) {
    process.stderr.write(`paintress: 已注册项目 "${res.project}"（${res.url}）\n`);
  }
}

/** CLI `paintress mcp` 入口：stdio transport + 自动注册 */
export async function runStdioServer(): Promise<void> {
  const server = createMcpServer({ ensureViewerBeforeWrite: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installParentWatchdog();
  void registerSelf();
}
