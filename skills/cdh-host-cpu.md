# cdh-host-cpu · 排查 CDH 主机 CPU / load 异常

适用：用户反馈「CPU 高」「机器很卡」「load 飙到几十」「iowait 高」「某个角色把 CPU 吃满了」，
或 `events/alerts`、`host/diagnose` 出现 CPU / load 相关告警时加载。

## 0. 先记住插件的边界（最重要）

`dsh-cdh` 是**只读**诊断插件：它只能通过 Cloudera Manager REST API 取数据，
**不能在主机上执行 `top` / `vmstat` / `ssh` 等任何命令**（见 AGENTS.md 第 2 条架构不变量）。

因此排查分两段：
- **CM 侧取证**：用 `cdh` 工具把「哪台主机、哪个角色、从什么时候开始、指标曲线长什么样」定位清楚。
- **主机侧深挖**：CM 给不出进程级数据时，把下面第 5 节的命令清单交给运维在**目标主机**上执行；
  插件负责根据返回结果继续判读，不要假装自己执行过。

不要向用户承诺「我登录主机查了 top」。

## 1. 「现象 → 层次」判别表（决定下一步查什么）

| 现象 | 最可能层次 | 先做的 cdh 调用 |
| --- | --- | --- |
| 单台主机 `cpu_percent` 高，其余正常 | 主机/进程 | `metrics/host` + `host/diagnose` |
| 所有 DataNode 同时 CPU 高 | HDFS 负载/作业 | `diagnosis/hdfs` + `diagnosis/yarn` |
| `iowait` 高但 `us`/`sy` 不高 | 磁盘 IO 或网络存储 | 转 `cdh-disk-io` |
| load 远大于 CPU 核数但 CPU 不满 | IO/锁/不可中断睡眠 D 状态 | 主机侧 `vmstat` 的 `r`/`b`、`ps` 看 D 状态 |
| CPU 周期性打满、伴随 GC 日志 | JVM GC 颠簸 | 转 `cdh-jvm-oom` |
| CM agent 心跳超时、CPU 读数缺失 | 主机已失联 | `host/diagnose` 看 HEARTBEAT_STALE |

> CPU 高只是症状。先区分「CPU 真忙」还是「在等 IO / 等锁」，否则容易把 IO 问题当 CPU 问题调。

## 2. 固定取证序列（按此顺序，逐步收窄）

1. **连通性**（任何排查第一步）：
   `{category:"connection",action:"test"}`
2. **全局概览**：
   `{category:"diagnosis",action:"overview"}` —— 看是单点还是全局、是否伴随告警。
3. **锁定问题主机**：
   `{category:"host",action:"diagnose"}` —— 找 `hostId` / `hostname`、心跳、健康检查。
4. **主机指标曲线**：
   `{category:"metrics",action:"host",args:{host_id:"<hostId>"}}` —— 返回
   `cpu_percent / mem_used / mem_total / disk_used / disk_total` 的最新值与 `flags`（>90% 会标 BAD）。
5. **看趋势与时间点**（别只看瞬时值）：
   写 tsquery 前**先加载 `cdh-tsquery`** 并 `metrics/list` 核对指标名。示例：
   ```
   {category:"metrics",action:"list",args:{filter:"cpu",context:"HOST"}}
   {category:"metrics",action:"query",args:{tsquery:'select cpu_percent where category = HOST and hostname = "dn01.example.com"',from:"2026-11-05T00:00:00Z",to:"2026-11-05T09:00:00Z"}}
   ```
   常用指标名以 `/timeseries/schema` 为准，常见：`cpu_percent`、`cpu_user`、`cpu_system`、
   `cpu_iowait`、`load_1min` / `load_5min` / `load_15min`（名字可能随版本变化，**先 list 再写**）。
   算每核 CPU 可用 `dt0(total_cpu_user)/getHostFact(numCores,1)*100`（见 tsquery skill）。
6. **下钻到角色**：ROLE 级曲线找出是哪一个 JVM 在吃 CPU：
   ```
   {category:"metrics",action:"query",args:{tsquery:'select total_cpu_user, total_cpu_system where category = ROLE and hostname = "dn01.example.com" and serviceType = HDFS'}}
   {category:"service",action:"list"}                         // 拿真实 service_name
   {category:"role",action:"list",args:{service_name:"hdfs1"}}
   {category:"role",action:"diagnose",args:{service_name:"hdfs1"}}
   ```
   注意 `serviceType` 的值大小写敏感（`HDFS` / `YARN` / `IMPALA`），实体名用 `metrics/list` / `role/list` 核对。
7. **关联告警**：
   `{category:"events",action:"alerts",args:{hours:24,severities:["CRITICAL","ERROR"]}}`
   或 `{category:"events",action:"query",args:{query:"category==HOST_HEALTH_EVENT;severity==CRITICAL ERROR",hours:24}}`
   （事件查询用 `==`、空格 OR、分号 AND，**和 tsquery 不同**，混淆会报错——见 `cdh-tsquery`）。

## 3. 判读要点

- `cpu_percent` 是整机口径；角色级 `total_cpu_user` 才是进程口径，二者单位/核数不同，别直接比大小。
- `load_1min` 要和 `numCores` 比（用 `getHostFact(numCores, 1)` 或 `host/get` 看核数）。
  load 高但 CPU 不满，几乎总是 IO/锁，不是算力不足。
- **iowait 高 ≠ CPU 瓶颈**：说明 CPU 在等磁盘，去 `cdh-disk-io`；把 iowait 算进「CPU 使用率」是常见误判。
- 周期性尖峰 + GC 停顿 → `cdh-jvm-oom`；突发且持续 + 心跳超时 → 可能是主机已经卡死（`host/diagnose` 的 HEARTBEAT_STALE）。
- 所有主机同时升高，先看是不是作业/大查询驱动：`diagnosis/yarn`（apps_running/pending）、
  `diagnosis/impala`（失败/长查询），而不是先怀疑硬件。

## 4. 结论要回答的四件事

1. 哪台/哪些主机、哪个角色，从何时开始；
2. 是「CPU 真忙」还是「等 IO / 等锁 / GC」；
3. 是否伴随心跳丢失、健康检查 BAD、告警；
4. 已用 cdh 拿到什么证据，还缺什么（明确列出需要运维在主机上补的命令）。

## 5. 交给运维在目标主机执行的命令（插件不能执行）

把命令按「先无损、后深入」给出，并说明每条看什么：

```bash
# 1) 总体：us 高=用户态(应用), sy 高=内核, wa 高=等 IO, id 高=其实不忙
top -H                       # 再看线程级：按 1 展开每核，按 P 按 CPU 排序；记下高 CPU 的 PID/TID
vmstat 1 10                  # r=运行队列(持续>核数=饱和), b=不可中断(等IO), cs=上下文切换, in=中断
mpstat -P ALL 1              # 逐核；单核 100% 可能是单线程瓶颈/中断绑核
pidstat -u -t -p <PID> 1     # 定位到具体线程；TID 转 16 进制后可在 jstack 里对上 nid

# 2) 用户态为主时：抓 Java 线程栈（连续 3 次间隔 5s，看同一线程是否一直在跑）
jcmd <PID> Thread.print > /tmp/jstack.$(date +%s).txt   # 或 jstack -l <PID>
# TID(十进制) -> printf '%x\n' <TID>，在 jstack 里搜 nid=0x<hex>，定位到具体方法

# 3) 内核态(sy)高时
perf top -p <PID>            # 需权限；看热点在内核路径还是系统调用
strace -c -p <PID> -f        # 短时采样，看系统调用频次/错误（谨慎用于生产）

# 4) 关联 cgroup / NUMA
cat /sys/fs/cgroup/cpu.max 2>/dev/null        # cgroup v2 的 CPU 限额，配额打满也会表现为「卡」
numactl -H                                    # 跨 NUMA 访问导致的不均衡
```

判读：
- `us` 高 → 应用/GC/热点方法，回到 `cdh-jvm-oom` 或具体计算引擎诊断。
- `sy` 高 → 系统调用/锁/网络中断，结合 `strace -c`。
- `wa` 高 → **不是 CPU 问题**，去 `cdh-disk-io`。
- `r` 长期 > 核数且 `%idle` 低 → 真 CPU 饱和，考虑扩容/限流/调度。
- `cs`/`in` 异常高 → 线程过多或中断风暴，配合 `pidstat -w`。

> 插件只读：以上命令必须在目标主机由有权限的人执行；把输出贴回会话，插件继续据此判读。
