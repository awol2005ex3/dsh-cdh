# dsh-cdh

DeepSeek Harness (dsh) 插件：**只读**诊断 Cloudera Manager / CDH 集群。

连接信息在插件设置页配置（host / port / 账号 / 密码 / TLS / API 版本 / 超时 / 默认集群），
提供一个 `cdh` agent 工具与一组 `/api/cdh/*` RPC 端点，供模型和设置面板共用同一条诊断链路。

- 只读：仅调用 CM REST API 的查询类接口，不执行任何会改集群状态的命令，**也不能登录主机执行命令**。
- 零第三方运行时依赖：HTTP 走 Node 内置 `fetch`（Node ≥ 22.14.0）。
- 配置热改即生效：全部字段 `volatile`，每个请求现读快照，改完无需重启。
- 内置 7 个排查 skill：模型按故障现象按需加载，每张卡给出「cdh 工具取证序列 + 判读要点 +
  需运维在主机补执行的命令清单」（`skills/*.md`），见下表。

## 功能

一个 `cdh(category, action, args)` 工具收拢 9 个诊断分类（工具面越小，模型选错工具的概率越低）：

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
| `yarn` | `apps` / `app` / `attempts` / `logs` / `diagnose` | Spark/Flink/Hive on YARN 作业失败诊断与容器日志取证 |

`diagnosis/overview` 汇总服务、主机、告警三方面给出 0–100 健康评分与处理建议；
`hdfs` / `yarn` / `impala` 为专项诊断（容量、副本、资源争抢、失败 SQL 聚合等）。

`yarn` 分类面向**作业级**取证（区别于 `diagnosis/yarn` 的服务级健康）：`apps` 走 CM `yarnApplications`
找失败作业（无需额外配置）；`app`/`attempts`/`logs`/`diagnose` 经 ResourceManager REST 取 `diagnostics`
与 AM 容器位置、经 JobHistory Server 取聚合容器日志正文。`yarnRmUrl`/`yarnJhsUrl` 手动配置优先，
留空时自动从 CM 下发的 `yarn-site.xml` 推导（`yarn.resourcemanager.webapp.address` / `yarn.log.server.url`，
处理 `0.0.0.0` 绑定地址与 HA）；仅支持免 Kerberos 的 HTTP 端点。详见 skill `cdh-yarn-jobs`。

### 内置排查 skills

CDH 故障里大量涉及 CPU / 内存 / IO / Linux 内核 / Java 进程 OOM / YARN 作业失败的排查。插件把运维知识拆成
按「故障现象」切分的 runtime skills，模型命中一张卡即可拿到完整取证序列，不必每次重推一遍：

| Skill | 触发现象 | 正文 |
| --- | --- | --- |
| `cdh-tsquery` | 写/调 `metrics/query` 的 tsquery、检索指标名 | [skills/cdh-tsquery.md](skills/cdh-tsquery.md) |
| `cdh-host-cpu` | CPU 高 / load 飙高 / iowait / 单角色吃满 CPU | [skills/cdh-host-cpu.md](skills/cdh-host-cpu.md) |
| `cdh-host-memory` | 内存水位 / swap 换页 / 主机级 OOM 前兆 | [skills/cdh-host-memory.md](skills/cdh-host-memory.md) |
| `cdh-disk-io` | IO 延迟 / 磁盘将满 / DataNode 掉盘 / HDFS 变慢 | [skills/cdh-disk-io.md](skills/cdh-disk-io.md) |
| `cdh-linux-kernel` | 进程无故消失 / 时钟偏移 / fd 耗尽 / 内核参数核对 | [skills/cdh-linux-kernel.md](skills/cdh-linux-kernel.md) |
| `cdh-jvm-oom` | `OutOfMemoryError` / GC 停顿 / 角色僵死或重启 | [skills/cdh-jvm-oom.md](skills/cdh-jvm-oom.md) |
| `cdh-yarn-jobs` | Spark/Flink/Hive on YARN 作业失败 / 取容器或作业日志 | [skills/cdh-yarn-jobs.md](skills/cdh-yarn-jobs.md) |

设计要点：

- **只读边界**：插件只能读 CM REST API。每张卡都明确区分「CM 侧用 cdh 取证」与
  「需运维在目标主机补执行的命令（top/vmstat/iostat/dmesg/jcmd 等）」，不假装能登录主机。
- **交叉分流**：卡内互相引用，避免把内核 OOM killer 误判成 JVM 堆 OOM、把 iowait 误判成 CPU 瓶颈、
  把 `events/query` 语法误用进 tsquery。
- **触发**：`cdh` 工具描述逐一点名；任务命中现象时模型 `skill("<name>")` 加载正文。
- **正文**：`skills/*.md`（原生 Markdown，随 npm 包发布）。tsquery 结论以 Cloudera 官方
  [tsquery Language](https://docs-archive.cloudera.com/documentation/enterprise/6/6.3/topics/cm_dg_tsquery.html) 为准；
  指标名一律以 `/timeseries/schema` 实际返回为准（先 `metrics/list` 再写查询）。
- **装配**：`src/skill.ts` 的 `BUILTIN_SKILLS` 是事实来源（名称 / catalog 描述 / 正文文件一一对应），
  用 `ctx.inject(['skills'])` 延迟注册，每个 skill 一个 `ctx.effect` 保证 HMR/卸载反注册；
  服务缺席/晚挂载只降级掉这些增强功能，不影响 RPC 路由和 `cdh` 工具（故不写进顶层 `inject`）。
  新增一个主题：清单加一行 + `skills/` 放同名 md + 同步两个冒烟脚本的断言即可。

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
| `yarnRmUrl` | 空 | ResourceManager Web 基址（`http://rm:8088`）：取作业 diagnostics 与 AM 容器位置；留空自动从 CM `yarn-site.xml` 推导，推导失败才退回 CM 元数据 |
| `yarnJhsUrl` | 空 | JobHistory Server 基址（`http://jhs:19888`，可粘贴 `yarn.log.server.url`）：取聚合容器日志正文；留空自动从 CM `yarn-site.xml` 推导 |

## 开发

```bash
npm install
npm run build        # tsc → lib/ + 包装浏览器 bundle
npm run typecheck    # 只做类型检查
npm run check        # 全部冒烟（= npm test）
```

三个冒烟脚本都不联网、不依赖真实 CM：

- `check:plugin` — 假 cordis ctx 驱动真实插件：路由注册/信封、工具注册、内置 skill 注册与降级、错误分支、disposer 清空、settings 不回传密码。
- `check:parse` — 分析层纯逻辑：健康度归纳、事件查询语法规范化、分类/动作表自洽、skill 正文关键点断言。
- `check:client` — 浏览器 bundle 契约：无 ESM 语法、`window.__ModuleLoader__.load` 工厂可执行并导出 `{ name, inject, apply }`。

### 目录

```
src/
  index.ts      宿主半插件入口（路由 + 工具注册）
  settings.ts   Config schema（volatile 配置）与现读快照
  service.ts    诊断业务层与分发器（9 分类动作表）
  rpc.ts        /api/cdh/* 精确路由与 RPC 信封
  tool.ts       cdh agent 工具定义
  cm-client.ts  Cloudera Manager REST 客户端
  yarn-client.ts  YARN Web 只读客户端（ResourceManager REST + JobHistory 聚合日志）
  analysis.ts   健康度/指标/事件查询/YARN 日志提取等公共逻辑
  skill.ts      内置 skills 的注册清单（BUILTIN_SKILLS）与装配
  client.ts     浏览器半设置面板（bundle 模块体）
skills/         内置 skill 正文（7 个 *.md，随发布物打包）
scripts/        构建包装与三个冒烟脚本
```

新增能力的改动清单见 [AGENTS.md](AGENTS.md)。

## License

Apache-2.0
