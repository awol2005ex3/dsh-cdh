# dsh-cdh

DeepSeek Harness (dsh) 插件：**只读**诊断 Cloudera Manager / CDH 集群。

连接信息在插件设置页配置（host / port / 账号 / 密码 / TLS / API 版本 / 超时 / 默认集群），
提供一个 `cdh` agent 工具与一组 `/api/cdh/*` RPC 端点，供模型和设置面板共用同一条诊断链路。

- 只读：仅调用 CM REST API 的查询类接口，不执行任何会改集群状态的命令。
- 零第三方运行时依赖：HTTP 走 Node 内置 `fetch`（Node ≥ 22.14.0）。
- 配置热改即生效：全部字段 `volatile`，每个请求现读快照，改完无需重启。

## 功能

一个 `cdh(category, action, args)` 工具收拢 8 个诊断分类（工具面越小，模型选错工具的概率越低）：

| 分类 | action | 说明 |
| --- | --- | --- |
| `connection` | `test` / `version` | 连通性、认证、API 版本比对 |
| `cluster` | `list` / `get` / `diagnose` / `hosts` | 集群列表、服务健康汇总 |
| `service` | `list` / `get` / `diagnose` | 服务状态、健康检查、配置过期 |
| `host` | `list` / `get` / `diagnose` | 主机心跳、状态、维护模式 |
| `role` | `list` / `diagnose` / `logs` / `config_file` | 角色诊断、日志尾部、配置文件 |
| `events` | `query` / `alerts` / `build_query` | 事件查询语法、近 N 小时告警 |
| `metrics` | `query` / `list` / `service` / `host` | 时序指标检索与查询 |
| `diagnosis` | `overview` / `hdfs` / `yarn` / `impala` / `command_status` / `command_logs` | 集群评分与专项诊断 |

`diagnosis/overview` 汇总服务、主机、告警三方面给出 0–100 健康评分与处理建议；
`hdfs` / `yarn` / `impala` 为专项诊断（容量、副本、资源争抢、失败 SQL 聚合等）。

## 架构

```
┌─ 浏览器半（设置面板） ─┐        ┌─ 宿主半（Node / Cordis 插件） ─┐
│  src/client.ts          │  RPC   │  src/index.ts                  │
│  连接配置 + 测试连接按钮 │ ─────► │  connection.fetch.register()    │
└─────────────────────────┘ /api   │  /api/cdh/{diagnose,settings,ping}
                                   │        │                       │
                                   │        ▼                       │
                     agent 工具 ──►  src/service.ts · createDispatcher()
                                   │        │                       │
                                   │        ▼                       │
                                   │  src/cm-client.ts → CM REST API │
                                   └────────────────────────────────┘
```

- **一个分发器，两条入口**：浏览器 RPC 与 agent 工具共用 `createDispatcher()`，校验、错误折叠、配置解析只实现一次（[src/service.ts](src/service.ts)）。
- **宿主半**（[src/index.ts](src/index.ts)）：注册 `/api/cdh/*` 精确路由与 `cdh` 工具；harness 0.1.5 起 `connection.rpc.handle` 对插件失效，`connection.fetch.register()` 是插件 RPC 的唯一正解。
- **浏览器半**（[src/client.ts](src/client.ts)）：经 `scripts/wrap-client.mjs` 包成惰性 CJS bundle，挂载设置面板（配置读写优先走官方 `configForms`，退路为 RPC 只读快照）。

## 配置

设置 → 插件 → CDH 诊断（也可直接改 profile 的 `cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `localhost` | CM 主机名/IP，可带端口（`cm.example.com:7180`） |
| `port` | `7180` | host 未自带端口时使用 |
| `username` / `password` | `admin` / 空 | HTTP Basic Auth；密码只写本机 profile，工具与 RPC 回包从不回显 |
| `useTls` | `false` | HTTPS；自签证书会被 Node fetch 拒绝 |
| `apiVersion` | `v41` | CM REST API 版本（CM 7.1.x / CDH 7.1.7；CM 6.x 常用 `v31`/`v40`） |
| `timeoutMs` | `30000` | 单次 CM 请求超时 |
| `defaultCluster` | 空 | 工具省略 `cluster_name` 时使用；留空自动取第一个集群 |

## 开发

```bash
npm install
npm run build        # tsc → lib/ + 包装浏览器 bundle
npm run typecheck    # 只做类型检查
npm run check        # 全部冒烟（= npm test）
```

三个冒烟脚本都不联网、不依赖真实 CM：

- `check:plugin` — 假 cordis ctx 驱动真实插件：路由注册/信封、工具注册、错误分支、disposer 清空、settings 不回传密码。
- `check:parse` — 分析层纯逻辑：健康度归纳、事件查询语法规范化、分类/动作表自洽。
- `check:client` — 浏览器 bundle 契约：无 ESM 语法、`window.__ModuleLoader__.load` 工厂可执行并导出 `{ name, inject, apply }`。

### 目录

```
src/
  index.ts      宿主半插件入口（路由 + 工具注册）
  settings.ts   Config schema（volatile 配置）与现读快照
  service.ts    诊断业务层与分发器（8 分类动作表）
  rpc.ts        /api/cdh/* 精确路由与 RPC 信封
  tool.ts       cdh agent 工具定义
  cm-client.ts  Cloudera Manager REST 客户端
  analysis.ts   健康度/指标/事件查询等公共逻辑
  client.ts     浏览器半设置面板（bundle 模块体）
scripts/        构建包装与三个冒烟脚本
```

新增能力的改动清单见 [AGENTS.md](AGENTS.md)。

## License

Apache-2.0
