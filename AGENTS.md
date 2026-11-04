# AGENTS.md — dsh-cdh 开发规范

面向后续在本仓库工作的 AI agent / 开发者。改代码前先读完「不变量」一节，
违反它们通常不会在 `npm run check` 里暴露，但会让插件在真实宿主里失效。

## 项目定位

DeepSeek Harness (dsh) 插件，**只读**诊断 Cloudera Manager / CDH。
任何会改集群状态的能力（重启服务、执行命令、改配置）都不属于本插件，禁止新增。

## 架构不变量（改代码不得破坏）

1. **一个分发器，两条入口**
   浏览器 RPC 与 agent 工具都必须走 `service.ts` 的 `createDispatcher()`。
   校验、错误折叠、配置解析只在这一处实现，禁止在 `rpc.ts` / `tool.ts` 里各写一份。
2. **配置每次现读，绝不缓存快照**
   `Config` 字段是 cosmokit `Volatile<T>` 稳定引用：`apply()` 里只保存 `settings = () => readCdhSettings(config)`，
   每次请求调用它取普通值快照。禁止在 `apply` 时解包一次存起来（设置页改完必须立即生效、无需重启）。
3. **密码永不回显**
   `rpc.ts` 的 `settings` 端点只回 `hasPassword: boolean`；
   工具输出、日志、任何 RPC 回包都不得包含 `password` 字段。
   密码字段**不标** `role('secret')`（secret 字段会被远程读取整体移除，配置页会读到空值）。
4. **插件 RPC 只用 `connection.fetch.register()`**
   harness 0.1.5 起 `connection.rpc.handle` 对插件失效。端点必须挂在 `/api/cdh/<endpoint>`（exact 路由优先于 /api prefix），`RPC_BASE` / `RPC_ENDPOINTS` 在 `rpc.ts` 顶部声明。
5. **RPC 信封完整**
   回包必须是 HTTP 200 + `{ type:'server-response', rpcId, result }`，`result` 为
   `{ ok:true, value }` 或 `{ ok:false, error:{ code, message, details } }`；
   `code`/`details` 不可省略，业务错误一律走 `failure()` 折叠（不用 HTTP 状态码表达业务错误），错误码用闭合集内的 `'bad-request'`。
6. **输出体积有上限**
   工具结果 JSON 超过 `OUTPUT_LIMIT`（tool.ts，256KB）截断；日志/配置文件文本超过 `MAX_TEXT_CHARS`（service.ts，512KB）截断。
   新增大输出能力必须复用或下调这两个上限，禁止无界返回（会挤爆模型上下文）。
7. **子查询失败要降级不拖垮整体**
   单个 tsquery 失败走 `safeTimeseries()` 记入 `ctx.warnings`，继续其余诊断。
8. **只读 + 目标主机锁定**
   `CmClient` 的连接目标只能来自插件配置，不接受运行时传入的 host/URL（防诊断请求被指到配置外的主机）。

## 文件职责

| 文件 | 职责 | 放什么 |
| --- | --- | --- |
| `src/index.ts` | 宿主半插件入口 | `name` / `inject` / `Config` / `apply`，只做注册与 `ctx.effect` 装配 |
| `src/settings.ts` | 配置契约 | zod schema（字段全 `.volatile()` + `.description()`）、`readCdhSettings` |
| `src/service.ts` | 业务层 | `CDH_CATEGORIES` / `CDH_ACTIONS`、各 `*Action()`、`createDispatcher` |
| `src/rpc.ts` | 传输层 | 端点表、信封编解码、`registerRpcRoutes` |
| `src/tool.ts` | agent 工具 | `defineTool` 定义、参数校验、截断与错误折叠 |
| `src/skill.ts` | 内置 skill | `cdh-tsquery` 的注册（`ctx.inject(['skills'])` 延迟装配）与常量 |
| `skills/*.md` | 内置 skill 正文 | 原生 Markdown，随 npm 包发布；`skill.ts` 用 `new URL('../skills/…', import.meta.url)` 读取 |
| `src/cm-client.ts` | HTTP 客户端 | URL 拼装、Basic Auth、超时/取消、`CmError` |
| `src/analysis.ts` | 纯函数 | 健康度归纳、指标提取、事件查询语法规范化（无 IO，便于单测） |
| `src/client.ts` | 浏览器半 | 设置面板 DOM、configForms/RPC 配置通道、插槽挂载降级 |
| `scripts/*.mjs` | 构建与冒烟 | `wrap-client.mjs` 是构建一环，三个 `check-*` 是断言 |

依赖方向固定为：`tool/rpc → service → cm-client/analysis/settings`，不许反向 import。

## 新增一个诊断能力的步骤

1. 在 `service.ts` 的 `CDH_ACTIONS` 对应分类里加 action（这张表是事实来源：工具描述、校验、报错可选项都由它生成）。
2. 在对应 `*Action()` 的 `switch` 里实现；参数缺失用 `requireStr()` 等 helper，抛出的 `Error` 消息要**可读且带纠正提示**（模型据此改参数重试）。
3. 新分类才需要：加进 `CDH_CATEGORIES`、`createDispatcher` 的 `switch`、`tool.ts` 描述里的示例。
4. 时序指标优先走 `safeTimeseries()`；CDH 7 指标改名见 `service.ts` 内注释（如 `under_replicated_blocks`、`yarn_reports_containers_allocated_*`）。
5. 在 `scripts/check-parse.mjs` 补断言（动作表自洽 + 纯逻辑分支），确保 `npm run check` 覆盖。
6. 更新 `README.md` 的分类表与 `tool.ts` 里的常用示例。

## 新增一个 RPC 端点的步骤

1. `rpc.ts` 的 `RPC_ENDPOINTS` 加端点名。
2. `createRpcDispatcher` 的 `switch` 处理，成功 `ok(value)`、失败 `failure(err)`。
3. `scripts/check-plugin.mjs` 的端点列表断言同步更新。
4. 浏览器半如需使用，在 `client.ts` 的 `callRpc(conn, '<endpoint>', args)` 调用。

## 改配置字段的步骤

1. `settings.ts`：schema 加字段（`.default(...)` + `.volatile()` + `.description()`），同步 `DEFAULTS`、`CdhConfig`、`CdhSettings`，并在 `readCdhSettings` 里做兜底/夹取。
2. `client.ts`：`CdhFormValue`、`rpcSettingsChannel.read`、面板输入框与 `collect()` 同步（`rpc.ts` 的 `PublicSettings` 只加**非敏感**字段）。
3. `scripts/check-plugin.mjs` 校验 settings 回包不含敏感值。

## 构建与浏览器 bundle

- `npm run build` = `tsc -p tsconfig.json` → `lib/`，再 `scripts/wrap-client.mjs` 把 `lib/client.js` 包成
  `window.__ModuleLoader__.load({ id:'dsh-cdh', factory: (require) => {...} })` 惰性 CJS 闭包。
- **`lib/` 是产物，不入库**（`.gitignore`）；`wrap-client` 会原地改写 `lib/client.js`，`check:client` 断言它没有 ESM `import`/`export`。
- `src/client.ts` 顶部的 `declare module/require` 是给闭包外壳用的类型占位，不要删；结尾 `module.exports = { name, inject, apply }` 是 loader 契约。
- `package.json` 的 `files` 必须包含 `lib`、`cordis.patch.yml`、`README.md`（发布物）。

## 验证

```bash
npm run typecheck   # 类型
npm run check       # 三个冒烟，全绿才算完（= npm test）
```

冒烟全部离线：假 cordis ctx / 假 DOM / 纯函数断言。需要真实 CM 验证时，
在设置页填连接后先跑 `connection/test`（面板「测试连接」按钮）。

## 约定

- 语言：代码注释、错误消息、面板文案用中文；标识符与文档标题用英文。
- 注释解释**为什么**（契约、坑、降级理由），不复述代码在做什么；已有注释在上下文变化时同步更新。
- 错误消息面向模型：写清缺什么、可选值是什么；不吞异常、不用空 catch（确需忽略时写明理由）。
- 保持外科式改动：只改任务需要的部分，不顺手重构、不加未被要求的抽象/配置项/兼容层。
- 依赖：运行时零第三方（Node 内置 fetch）；`peerDependencies` 是宿主提供的，不要改成 `dependencies`。
- 插件骨架、事件钩子、HTTP 扩展点等 harness 契约以 `.trae/skills/dsh-plugin-dev/SKILL.md` 为准（版本结论以本仓库 `src/` 内注释为准，两者冲突时以实际能通过宿主验证的代码为准）。
