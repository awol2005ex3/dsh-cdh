# cdh-host-memory · 排查 CDH 主机内存 / swap / 主机级 OOM 前兆

适用：用户反馈「内存快满了」「swap 一直在涨」「机器开始卡/杀进程」「CM 报内存告警」，
或 `host/diagnose`、`events` 出现内存相关健康检查时加载。

## 0. 先把三类「内存问题」分开（最容易混）

| 类别 | 触发者 | 典型证据 | 去哪张卡 |
| --- | --- | --- | --- |
| **物理内存紧张 / swap** | 整机水位 | `mem_used` 逼近 `mem_total`、si/so 持续非零 | 本卡 |
| **内核 OOM killer 杀进程** | Linux 内核 | `dmesg` 里 `Killed process`/`Out of memory`、角色进程突然消失 | `cdh-linux-kernel` |
| **JVM 堆 OOM / GC 颠簸** | JVM 自身 | 角色 stderr 里 `java.lang.OutOfMemoryError`、GC 停顿变长 | `cdh-jvm-oom` |

三者症状都可能是「角色挂了 / 变慢 / 心跳丢失」，但处置完全不同：
- 内核 killer 杀的是**整个进程**（CM 里表现为角色 DOWN / 无心跳，应用日志往往没有 OOME）；
- JVM 堆 OOM 时**进程还在**，日志有 OOME，可能反复 Full GC；
- 物理内存紧张是前两者的温床（堆 + 堆外 + Page Cache + 其他进程之和超了限额）。

插件只读 CM，不能登录主机执行 `free` / `dmesg`；CM 侧取证用 cdh，主机侧命令交给运维（第 5 节）。

## 1. CM 侧取证序列

1. `{category:"connection",action:"test"}` → `{category:"host",action:"diagnose"}`
   —— 拿到 `hostId`、心跳、健康检查（含 `MEMORY` / `SWAP` 类 BAD/CONCERNING 项）。
2. `{category:"metrics",action:"host",args:{host_id:"<hostId>"}}`
   —— 返回 `mem_used` / `mem_total` / `disk_used` / `disk_total` 的最新值。
   注意：`mem_used/mem_total` 是 CM 口径，与 Linux `free` 的 `available` **不是同一个东西**，见第 3 节。
3. **看趋势**（瞬时值会骗人）：先 `metrics/list` 核对名字，再写 tsquery（语法见 `cdh-tsquery`）：
   ```
   {category:"metrics",action:"list",args:{filter:"mem",context:"HOST"}}
   {category:"metrics",action:"list",args:{filter:"swap",context:"HOST"}}
   {category:"metrics",action:"query",args:{tsquery:'select mem_used, mem_total, swap_used where category = HOST and hostname = "dn01.example.com"',from:"2026-11-05T00:00:00Z",to:"2026-11-05T09:00:00Z"}}
   ```
   指标名以 `/timeseries/schema` 实际返回为准（不同 CM 版本可能是 `mem_used` / `mem_total` /
   `swap_used` / `mem_free` 等），**没有就 `metrics/list` 再查，别凭空写**。
4. **算角色堆之和是否超预算**：
   `{category:"service",action:"list"}` → 逐个
   `{category:"role",action:"list",args:{service_name:"<svc>"}}` →
   `{category:"role",action:"config_file",args:{service_name:"<svc>",role_name:"<role>",file_name:"<env/配置文件>"}}`
   CM 里各角色的 Java 堆大小在角色配置（如 `*_heapsize` / `*_HEAPSIZE`）里，config_file 可核对实际下发值。
   经验：所有角色 `-Xmx` 之和 + 堆外（Direct buffer / Metaspace / JIT code cache / 线程栈）+ OS/Page Cache
   要留出余量，不能把整机内存分光。
5. **关联告警与历史事件**：
   `{category:"events",action:"alerts",args:{hours:24,severities:["CRITICAL","ERROR","WARNING"]}}`
   事件查询语法用 `==`/空格 OR/`;` AND（不是 tsquery）：
   `{category:"events",action:"query",args:{query:"severity==CRITICAL ERROR;category==HOST_HEALTH_EVENT",hours:24}}`

## 2. 关键判读点

- **看 `available`，不是 `free`**：Linux 把空闲内存用于 Page Cache，`free` 小不代表内存不足；
  `MemAvailable` 才是还能给新进程用的估算值。CM 的 `mem_used` 口径更接近「已用」，别和 `free` 直接对。
- **si/so 持续非零比「使用率 95%」更危险**：一旦开始换页，Java 进程的 GC 停顿会被放大，
  进而表现为心跳超时、YARN 容器被杀、Impala 查询超时。`vmstat 1` 的 `si`/`so` 列是金标准。
- **cgroup 限额**：容器化/受管环境里，整机看似有内存，但 cgroup `memory.max` 可能更小，
  触发的是 cgroup OOM（同样由内核杀进程）而非整机 OOM。
- **swappiness / THP**：内核参数不当会提前换页或造成延迟毛刺，去 `cdh-linux-kernel`。
- **进程突然消失、日志无 OOME** → 高度怀疑内核 OOM killer，转 `cdh-linux-kernel`；
  **进程还在、有 OOME** → 转 `cdh-jvm-oom`。

## 3. cdh 能回答 / 不能回答

- 能：哪台主机内存水位高、从何时开始、是否伴随心跳/健康告警、角色配置里堆设了多大、历史事件。
- 不能：Page Cache/Buffer 细分、每个进程的 RSS/PSS、swap 换入换出速率、内核是否发了 OOM killer、
  cgroup 事件计数 —— 这些必须主机侧补。

## 4. 处置方向（写结论时给建议，别只报数）

- 水位高但无换页：确认是否只是 Page Cache；核对角色堆预算是否留余量，评估错峰/迁移角色。
- 已换页：优先降内存压力（限制作业并发、调小/迁移大堆角色、扩容），而不是先调 `swappiness`。
- 反复进程消失：按内核 OOM killer 路径查 `dmesg`，并检查 cgroup 限额。
- 伴随 GC 停顿/超时：与 `cdh-jvm-oom` 联动，区分「内存不够导致 GC」和「堆本身不够」。

## 5. 交给运维在目标主机执行的命令（插件不能执行）

```bash
free -h                         # 看 MemAvailable，不是 free
cat /proc/meminfo                # MemAvailable / SwapTotal / SwapFree / Dirty / HugePages_*
vmstat 1 10                     # si/so 持续>0 = 正在换页；swpd 增长 = 压力
top / ps aux --sort=-rss | head # 按 RSS 排进程，找出吃内存的角色 PID
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current 2>/dev/null   # cgroup v2 限额与用量
cat /sys/fs/cgroup/memory.events 2>/dev/null   # oom / oom_kill 计数（cgroup 内被杀的直接证据）
dmesg -T | grep -iE 'out of memory|killed process|oom-killer'   # 内核 killer 证据 → cdh-linux-kernel
pmap -x <PID> | tail -1         # 单进程 RSS；Java 还要算堆外（Direct/NIO/Metaspace/线程栈）
numastat -m                     # NUMA 内存分布不均
```

判读：
- `MemAvailable` 很低 + `si/so` > 0 → 真内存压力；
- `memory.events` 的 `oom_kill` 增长 → cgroup OOM（内核杀进程，转 `cdh-linux-kernel`）；
- `dmesg` 有 `Killed process` → 整机 OOM killer；
- 以上都没有、但角色仍报错 → 大概率是 JVM 自己的堆 OOM，转 `cdh-jvm-oom`。
