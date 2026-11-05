# cdh-linux-kernel · 排查 Linux 内核 / 系统级导致的 CDH 异常

适用：角色进程**无故消失**但应用日志没有 Java OOME；CM 报心跳丢失/角色 DOWN 却查不到应用错误；
健康检查报时钟偏移、文件描述符不足；需要核对 THP / swappiness / 内核参数 / conntrack 时加载。

## 0. 核心前提：插件看不到内核，只能找「内核级证据」

`dsh-cdh` 只读 CM REST API，**不能登录主机、不能读 `/proc` / `dmesg` / `sysctl`**。
内核层故障在 CM 里往往只留下**间接痕迹**（进程消失、心跳断、健康检查 BAD、事件告警）。
正确姿势：

1. 用 cdh 把「哪台主机、哪个角色、什么时刻、之前有没有内存/IO 异常」钉死；
2. 把第 5 节命令清单交给运维在该主机执行；
3. 根据回贴的 `dmesg` / cgroup / sysctl 输出继续判读。

**最重要的一条分流**：

| 证据 | 结论 | 去向 |
| --- | --- | --- |
| `dmesg` / `memory.events` 有 `Killed process` / `oom` / `oom_kill`，且应用日志**无** OOME | **内核 OOM killer 杀了整个进程** | 本卡处置 |
| 角色 stderr 有 `java.lang.OutOfMemoryError`，进程**还在** | **JVM 堆/元空间 OOM** | `cdh-jvm-oom` |
| `dmesg` 有 I/O error / `remounted read-only` | 掉盘/只读文件系统 | `cdh-disk-io` |
| 心跳断但主机 `dmesg`/资源都正常 | 网络分区 / CM Agent | 见第 4 节 |

> 常见误判：把「内核 OOM killer 杀进程」当成「Java OOM」去调 `-Xmx`。
> 内核 killer 是整机/cgroup 内存超了，杀的是进程；JVM OOME 是堆不够，进程还在抛异常。

## 1. CM 侧取证序列（把时间线钉死）

1. `{category:"connection",action:"test"}` → `{category:"host",action:"diagnose"}`
   —— 关键看 `HEARTBEAT_STALE`（>60s，Agent 可能离线）、`HOST_STATUS`（DOWN）、健康检查 BAD 项
   （时钟偏移 `CLOCK_OFFSET`、磁盘、交换分区等）、`maintenanceMode`（维护模式会抑制告警）。
2. `{category:"metrics",action:"host",args:{host_id:"<hostId>"}}`
   与 HOST 级内存/CPU 曲线，确认进程消失前是否有内存水位飙升（内核 OOM 的前兆）：
   ```
   {category:"metrics",action:"query",args:{tsquery:'select mem_used, mem_total, cpu_iowait where category = HOST and hostname = "dn01.example.com"',from:"2026-11-05T00:00:00Z",to:"2026-11-05T09:00:00Z"}}
   ```
   指标名先 `metrics/list` 核对（语法见 `cdh-tsquery`）。
3. **确认是「进程消失」而非「CM 误报」**：
   ```
   {category:"service",action:"list"}                                   // service_name
   {category:"role",action:"list",args:{service_name:"hdfs1"}}         // role_name
   {category:"role",action:"diagnose",args:{service_name:"hdfs1"}}     // roleState / entityStatus / configStale
   {category:"role",action:"logs",args:{service_name:"hdfs1",role_name:"hdfs-DATANODE-xxx",log_type:"stderr",lines:300}}
   ```
   stderr **尾部突然中断、没有正常 shutdown 日志、也没有 OOME** → 强提示被信号杀掉（SIGKILL）。
4. **历史事件与告警**（事件查询用 `==`/空格 OR/`;` AND，不是 tsquery）：
   ```
   {category:"events",action:"alerts",args:{hours:24,severities:["CRITICAL","ERROR","WARNING"]}}
   {category:"events",action:"query",args:{query:"category==HOST_HEALTH_EVENT;severity==CRITICAL ERROR",hours:24}}
   {category:"events",action:"build_query",args:{category:"HOST_HEALTH_EVENT",severities:["CRITICAL","ERROR"],hours:24}}
   ```
   `build_query` 只生成查询串与起止时间，不执行，适合先核对语法。
5. **命令历史（若 CM 曾下发过命令）**：
   `{category:"diagnosis",action:"command_status",args:{command_id:123}}` /
   `{category:"diagnosis",action:"command_logs",args:{command_id:123,log_type:"stderr",lines:200}}`
   —— 只读查看，判断角色重启/停止是不是 CM 发起的（排除「被人为/自动操作停掉」）。

## 2. 内核级故障的 CM 侧痕迹对照表

| 内核/系统原因 | CM 里能看到什么 | 主机侧确认命令 |
| --- | --- | --- |
| 整机 OOM killer | 角色进程消失、心跳断、无 OOME、内存曲线先冲顶 | `dmesg -T \| grep -i oom` |
| cgroup OOM | 同上，但整机内存看着还够 | `cat /sys/fs/cgroup/memory.events` |
| 文件系统只读 / 掉盘 | DataNode 卷失效、写失败、健康检查 BAD | `dmesg`、`mount`、`iostat`（见 `cdh-disk-io`） |
| 时钟偏移 NTP | `CLOCK_OFFSET` 健康检查 BAD、Kerberos/认证失败 | `timedatectl`、`chronyc sources`、`ntpq -p` |
| fd / nproc 耗尽 | 角色报 too many open files、连接失败、健康检查异常 | `ulimit -n`、`cat /proc/<PID>/limits`、`lsof` |
| THP / swappiness | 延迟毛刺、换页、GC 停顿放大 | `cat /sys/kernel/mm/transparent_hugepage/enabled`、`sysctl vm.swappiness` |
| conntrack 满 / 网络分区 | 心跳断、RPC 超时但主机资源正常 | `dmesg` 看 `nf_conntrack: table full`、`ss -s` |
| 内核 panic / 重启 | 所有角色同时心跳断 | `last -x \| head`、`journalctl -b -1` |

## 3. 判读要点

- **先定时刻**：把角色日志中断时间、事件告警时间、内存曲线拐点对齐到同一时间轴，再让运维查该时刻的 `dmesg`。
- 内核 OOM killer 的 `dmesg` 会列出被杀进程名、pid、`total-vm`/`anon-rss`、以及 `oom_score_adj`；
  据此判断「是谁把内存吃光的」，而不是直接给被杀角色加内存。
- `entityStatus=DOWN` / `roleState=STOPPED` 但 `host/diagnose` 心跳正常 → 进程级问题（内核 kill / JVM 退出），
  不是主机掉线；心跳也断 → 主机/网络/Agent 层。
- 维护模式（`maintenanceMode`）会抑制告警，别把「无告警」当成「无故障」。
- 健康检查名（如 `CLOCK_OFFSET`、`HOST_SCM_HEALTH`、`HOST_AGENT_CERTIFICATE_EXPIRY`）本身就是线索，
  原样保留在结论里，便于运维对照 CM 文档。

## 4. 处置方向（建议，非执行）

- 内核 OOM killer：找内存占用大头（堆预算、堆外、Page Cache、其他进程），错峰/迁移/扩容/设 cgroup 限额；
  关键服务可评估 `oom_score_adj`（由运维决定，插件不执行）。
- 时钟偏移：修 NTP/chrony，Kerberos 环境对时钟尤其敏感。
- fd / nproc：核对 systemd `LimitNOFILE` 与 `ulimit`，CM 角色配置里也有对应项（`role/config_file`）。
- THP：CDH/HBase/Impala 通常建议 `never`/`madvise`，并核对 `vm.swappiness`（多为 1 或 10）。
- 掉盘/只读：转 `cdh-disk-io`；GC/堆问题：转 `cdh-jvm-oom`；纯 CPU/iowait：转 `cdh-host-cpu`。

## 5. 交给运维在目标主机执行的命令（插件不能执行）

```bash
# OOM / 内核日志（最优先）
dmesg -T | grep -iE 'out of memory|oom-killer|killed process|oom_reaper'
journalctl -k --since "2026-11-05 00:00:00" | grep -i oom
cat /sys/fs/cgroup/memory.events 2>/dev/null      # oom / oom_kill / max 计数（cgroup OOM 直接证据）
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current 2>/dev/null

# 是否发生过重启 / panic
last -x | head -20
journalctl -b -1 -k | tail -50                    # 上一次启动的内核日志
uptime

# 时钟
timedatectl
chronyc sources -v || ntpq -p

# 资源限制
ulimit -a
cat /proc/<PID>/limits                            # 进程实际生效的 nofile/nproc
ls /proc/<PID>/fd | wc -l                         # 已用 fd；lsof -p <PID> | wc -l
cat /proc/sys/fs/file-nr                          # 系统级 fd 用量

# 内核参数 / THP / 网络
sysctl -a | grep -E 'vm.swappiness|vm.overcommit|vm.dirty_ratio|net.netfilter.nf_conntrack_max|net.ipv4.tcp'
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /proc/sys/net/netfilter/nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null
ss -s
dmesg -T | grep -iE 'conntrack|table full|link is down|reset|read-only|i/o error'
```

判读：
- `oom_kill` 计数增长或 `dmesg` 有 `Killed process` → 内核 OOM killer（本卡主线）；
- `memory.current` 贴近 `memory.max` → cgroup 限额太小；
- `CLOCK_OFFSET` BAD + `chronyc` 不同步 → 时钟问题；
- `nf_conntrack_count` 贴近 max / `dmesg` `table full` → 网络丢包导致心跳断；
- 全部正常但角色仍消失 → 回到 `cdh-jvm-oom`（JVM 自身 / hs_err_pid 文件 / 被外部 kill）。
