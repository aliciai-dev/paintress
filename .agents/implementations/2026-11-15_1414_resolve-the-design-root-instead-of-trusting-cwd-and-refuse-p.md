# 2026-11-15T14:14+08:00 — Resolve the design root instead of trusting cwd, and refuse project roots

MCP server 启动时 `autoRegister()` 用 `process.cwd()` 注册项目，daemon 的 `watch` 又无条件 `ensureProjectScaffold()`，于是 agent 在代码仓库根启动时，仓库根长出空的 `__preset.ptr` / `__components.ptr`，并且侧栏里同一份稿子因父子目录都注册而出现两次。写路径早有 `findProjectRootStrict`（注释里点明「这就是脏数据的来源」），注册路径没有同一份纪律。

## 做法

**新增 `src/web/design-root.ts`（只读，不建任何东西）**

- `resolveDesignRoot(from, explicit?)` 三层依据：显式目录 → `paintress.json` 的 `{"root": "design"}`（向上就近查找，最多 8 层）→ 候选打分。候选 = cwd 自己（只看本层）+ 直接子目录（看两层，跳过 node_modules/.git/dist 等，最多 100 个）。
- 打分：设计稿每个 +1（上限 +4）；有 `__preset.ptr`/`__components.ptr` 且**也**有设计稿 +5，只有空脚手架只 +1（避免把误注册的残留当强证据）；目录名命中 `design|ui|mockups|screens|sketches|…` +3；带项目根标志却没有设计稿的目录**一票否决**（分数归零）。
- 最高分唯一才拍板，并列或全为 0 就 `confident: false` 且把候选交回去。
- `guardProjectRoot(dir)`：命中 `AGENTS.md`/`CLAUDE.md`/`.git`/`package.json`/`pnpm-workspace.yaml`/`pyproject.toml`/`Cargo.toml`/`go.mod`/`pom.xml`/`build.gradle`/`composer.json`/`Gemfile` 之一，且本层没有任何设计稿 → 拒绝；本层就有设计稿则放行（可能就是专门放设计的仓库）。

**接线**

- `ensureViewer`：先解析根再注册；不确信就抛 `DesignRootUnresolvedError`（带候选），不注册。自动注册一律 `scaffold: false`（显式给 `dir` 时保持旧行为）。
- daemon `watch`：`force !== true` 时先过 `guardProjectRoot`，拒绝就回 `{ok:false, error, hint, markers}` 且**不注册、不建文件**；`scaffold !== false` 才建项目文件。所有入口（cli watch / MCP viewer / agent 自动注册）都汇到这里，一处拦截就够。
- `paintress web`：输出 `designRoot{root,reason,confident,candidates}`，当前目录像项目根时给 `hint`（该注册哪个目录）；没把握时也提示建 `design/` 或写 `paintress.json`。
- `paintress_viewer`：新增 `force`；返回 `designRoot`；解析不确定时返回 `{ok:false, designRoot.candidates}` 而不是抛错。
- `skills/paintress/SKILL.md` 第 1 条重写为「在 design root 上启动，不要在仓库根；没把握时不要用 force」，两份 README 在「文件与格式」里补了解析规则与 `--force` 出口。

## 验证

- `pnpm check` 干净；`pnpm test` 33 文件 / **433 用例全绿**，新增 `test/design-root.spec.ts`（解析：显式 / 声明 / 子目录 / 并列 / 空目录 / cwd 自带设计稿；门槛：仓库根拒绝、设计仓库放行、`.git` 计数；daemon：拒绝时不建文件、`force:true` 时建、`scaffold:false` 不建）。
- 真机三场景（隔离 `PAINTRESS_HOME`）：`ptr-test` 仓库根 → 解析到 `design/`（score 9 vs 1，reason `child`）并给出注册指引；在 paintress 仓库根 `paintress watch` → 被拒，`ls __preset.ptr` 不存在；空目录 → `confident:false` + 建目录/写 `paintress.json` 的提示，未建任何文件。

提交：`9bca6f4`（未 push）。
