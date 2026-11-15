# 2026-11-15T16:12+08:00 — Ask the user before creating a design directory

`paintress web` / `paintress_viewer` 在没指定目录时给出的提示，只说了「把稿子放进 design/ 或显式传 dir」——等于默许 agent 自己把目录建出来，也从没要求它先征求用户同意。

## 改动

- `src/mcp/tools.ts`：`paintress_viewer` 解析失败时的返回值新增 `next` 字段：先问用户设计稿放哪儿（建议项目根下新建 `design/`），得到同意后再建、再把这个目录作为 `dir` 传进来；明确禁止自行建目录、也禁止直接改用 `force`。工具描述同步说明「无设计根时返回 ok:false + candidates + next」。
- `src/web/autoregister.ts`：`DesignRootUnresolvedError` 的文案改成 ask-then-create 的顺序（原来是无条件建议建目录）。
- `src/web/design-root.ts`：`guardProjectRoot` 的 hint 补上「仓库里还没有设计目录时先问用户」；`none` 分支文案从「需要显式指定」改为「需要用户指定位置，或先问用户要不要新建」。
- `skills/paintress/SKILL.md` 规则 1：把「挑一个候选传 dir」改成「有 candidates 就问用户选哪个；没有候选就问用户要不要新建 design/，同意后建好再传 dir；不要自行建目录、不要自行 force」。

## 顺带（同一文件的健壮性）

- `childDirs` 的 `readdirSync(...).sort()` 加显式比较器。
- `describe()` 的 switch 加 `default` 兜底：将来新增 `RootReason` 忘补文案时，`message` 不会变成 `undefined`。

## 测试

- `test/design-root.spec.ts`：空目录的解析文案断言改为包含「问用户」；新增一条工具级用例——mock cwd 到空目录，调 `paintress_viewer`，断言 `ok:false`、`next` 含 `Ask the user` / `design/` / `do not create a directory` / `force`，且**断言没有任何目录或项目文件被创建**。
- `test/daemon-log.spec.ts`：`afterAll` 现在等待子进程真正 `exit`（有上限），修掉「文件级失败但用例全过」的假红。

## 验证

- `pnpm check` 干净。
- `pnpm test`：34 文件 / **441 用例全绿**；`daemon-log` 连跑 3 次稳定。
- 早前一次全量跑出现过「Test Files 1 failed / Tests 441 passed」，定位为测试收尾竞态（已修），复跑与连跑均无复现。
