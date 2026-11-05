# cdh-jvm-oom · 排查 Java 角色 OOM / GC 停顿 / 进程退出

适用：角色 stderr 出现 `java.lang.OutOfMemoryError`、GC 停顿变长、进程僵死/被重启、
NameNode / ResourceManager / Impala / HBase / Hive / Solr / Kafka 等 JVM 角色内存异常时加载。

## 0. 先分流：JVM OOM 还是内核 OOM killer

| 证据 | 结论 |
| --- | --- |
| 角色 stderr 有 `java.lang.OutOfMemoryError: ...`，**进程还在**（可能反复 Full GC / 僵死） | JVM OOM → 本卡 |
| 进程突然消失、日志无 OOME、`dmesg` 有 `Killed process` / cgroup `oom_kill` | **内核 OOM killer** → `cdh-linux-kernel` |
| 整机 swap 换页、内存水位冲顶 | 主机内存压力 → `cdh-host-memory`（可能是前两者的根因） |

> 插件只读 CM，不能执行 `jcmd` / `jmap` / `jstack` / 读 GC 日志目录。
> CM 侧用 `role/logs`、`role/config_file`、jvm 指标取证据；进程内诊断命令交运维（第 5 节）。

## 1. 按 OOME 类型分流（第一步永远是读完整错误行）

`role/logs` 拿到的第一行 `java.lang.OutOfMemoryError: <reason>` 决定方向，别一律加 `-Xmx`：

| `<reason>` | 真正含义 | 方向 |
| --- | --- | --- |
| `Java heap space` | 堆不够 / 对象存活过多（或泄漏） | 堆转储分析、核对 `-Xmx`、看对象分布 |
| `GC overhead limit exceeded` | 堆将满且 GC 回收极少（通常也是堆问题/泄漏） | 同上，常伴 CPU 打满（GC 线程） |
| `unable to create new native thread` | 线程数到 `nproc`/内存上限，不是堆 | `ulimit -u`、`-Xss`、线程数、`cdh-linux-kernel` |
| `Metaspace` / `PermGen space` | 类元数据区不够（类加载器泄漏/动态类） | `-XX:MaxMetaspaceSize`、类加载器 |
| `Direct buffer memory` / `Requested array size exceeds VM limit` | 堆外内存（NIO/堆外缓存） | `-XX:MaxDirectMemorySize`、Impala/HBase 堆外预算 |
| `Map failed` / `OutOfMemoryError: ... (native)` | mmap/本地内存（JVM 进程 RSS 超限） | 内核/cgroup OOM 方向 → `cdh-linux-kernel` |
| 无 OOME 但有 `hs_err_pid*.log` / 进程消失 | JVM crash（非 OOM） | 查 crash 日志、native 库、内核 killer |

## 2. CM 侧取证序列

1. `{category:"connection",action:"test"}` → `{category:"diagnosis",action:"overview"}`
   —— 看是否伴随主机心跳/健康检查异常（区分 JVM 与主机/内核层）。
2. **定位服务与角色名**（后续所有调用都要真实名字）：
   ```
   {category:"service",action:"list"}
   {category:"service",action:"diagnose"}                       // 找 BAD / CONFIG_STALE 服务
   {category:"role",action:"list",args:{service_name:"hdfs1"}}
   {category:"role",action:"diagnose",args:{service_name:"hdfs1"}}
   ```
   关注 `healthSummary`、`roleState`、`configStale`（**配置过期说明改过的堆参数还没下发/重启，容易误判**）。
3. **读角色 stderr / stdout 尾部**（最关键证据）：
   ```
   {category:"role",action:"logs",args:{service_name:"hdfs1",role_name:"hdfs-NAMENODE-xxx",log_type:"stderr",lines:300}}
   {category:"role",action:"logs",args:{service_name:"hdfs1",role_name:"hdfs-NAMENODE-xxx",log_type:"stdout",lines:200}}
   ```
   `lines` 最大 5000；找：`OutOfMemoryError`、`Full GC`、`GC overhead`、`hs_err_pid`、
   `Killed`、`shutdown` 前后是否有正常退出日志。GC 日志通常在 stdout（取决于 CM 配置）。
4. **核对实际下发的 JVM 参数**（别只信「应该配了多大」）：
   ```
   {category:"role",action:"config_file",args:{service_name:"hdfs1",role_name:"hdfs-NAMENODE-xxx",file_name:"hdfs-env.sh"}}
   ```
   常见文件名：`hdfs-env.sh` / `yarn-env.sh` / `impala-env.sh` / `hbase-env.sh` / `hive-env.sh` /
   `core-site.xml` / `hdfs-site.xml` / `yarn-site.xml`。看 `*_HEAPSIZE` / `-Xmx` / `-Xms` /
   `-XX:MaxMetaspaceSize` / `-XX:MaxDirectMemorySize` / GC 相关 `-XX:+UseG1GC` 等。
5. **jvm 指标趋势**（指标名先 list 核对，tsquery 语法见 `cdh-tsquery`）：
   ```
   {category:"metrics",action:"list",args:{filter:"jvm",context:"ROLE"}}
   {category:"metrics",action:"query",args:{tsquery:'select jvm_heap_used_mb, jvm_max_heap_mb, jvm_gc_time_ms where category = ROLE and roleType = NAMENODE',from:"2026-11-05T00:00:00Z",to:"2026-11-05T09:00:00Z"}}
   ```
   常见（以 `/timeseries/schema` 为准）：`jvm_heap_used_mb` / `jvm_heap_committed_mb` /
   `jvm_max_heap_mb`、`jvm_gc_count` / `jvm_gc_time_ms` / `jvm_gc_rate`、
   `jvm_threads` / `jvm_blocked_threads`、`jvm_non_heap_used_mb`。
   判读：堆用满 + GC 时间飙升 + CPU 高 = 典型 GC 颠簸；堆不满却报 OOME → 查堆外/元空间/线程。
6. **关联事件与命令历史**：
   ```
   {category:"events",action:"alerts",args:{hours:24,severities:["CRITICAL","ERROR"]}}
   {category:"diagnosis",action:"command_status",args:{command_id:123}}
   {category:"diagnosis",action:"command_logs",args:{command_id:123,log_type:"stderr",lines:200}}
   ```
   事件查询用 `==`/空格 OR/`;` AND（**不是 tsquery**），例如
   `query:"category==ROLE_EVENT;severity==CRITICAL ERROR"`。

## 3. 各角色着眼点（同样一句 OOME，含义不同）

- **NameNode / JournalNode**：堆主要装元数据（inode/block），文件数暴涨会让堆线性增长；
  关注 `jvm_max_heap_mb` 与 HDFS 文件/块数，别单纯加堆而不看数据量。
- **DataNode**：堆通常不大；若 OOME 多伴随掉盘/线程数，去 `cdh-disk-io` / `cdh-linux-kernel`。
- **ResourceManager / NodeManager**：容器/应用上下文数量、NM 本地缓存；`unable to create new native thread` 常见。
- **Impala / impalad**：大量内存是**堆外**（`-Xmx` 只是其中一部分），`MemLimit`/admission control
  与并发查询更相关；`Direct buffer memory` 要算堆外预算，别只调 `-Xmx`。
- **HBase RegionServer**：堆外 bucket cache / MSLAB / 读缓存；GC 停顿影响 RegionServer 心跳（ZK 超时）。
- **HiveServer2 / Metastore / Solr / Kafka**：会话/查询并发、缓存、结果集大小； correlate with 并发量。

## 4. 结论与建议

- 先给「OOME 完整错误行 + 角色 + 时刻 + 当时堆/GC 曲线 + 实际 `-Xmx`」五要素，再给结论。
- `configStale=true` 时明确提示：**配置未下发，改堆参数后需重新部署客户端配置/重启才生效**（只读诊断，不代执行）。
- 建议方向按类型给：堆 → 堆转储找存活对象/泄漏 vs 调堆；元空间/堆外/线程 → 对应参数与限制；
  内核 killer → 转 `cdh-linux-kernel`；IO/掉盘 → 转 `cdh-disk-io`；CPU 高伴 GC → `cdh-host-cpu`。
- 不要建议「无脑加大 -Xmx」：堆过大延长 GC 停顿、挤占 Page Cache，甚至更快触发内核 OOM killer。

## 5. 交给运维在目标主机执行的命令（插件不能执行）

```bash
# 进程与堆概况
jps -lv | grep -iE 'namenode|resourcemanager|impalad|hbase|hiveserver2|datanode'
jcmd <PID> VM.flags                      # 实际生效的 -Xmx/-Xms/GC 参数（比配置文件可靠）
jcmd <PID> VM.native_memory summary      # 需 -XX:NativeMemoryTracking=summary，看堆外各区
jstat -gcutil <PID> 1000 10             # O/YGC/FGC 次数与耗时、各区占比；FGC 频繁+GCT 大 = GC 颠簸

# 堆内对象分布（在线、开销小，优先）
jcmd <PID> GC.class_histogram | head -40          # 或 jmap -histo:live <PID>（live 会触发 Full GC，谨慎）
# 必要时堆转储（大堆会暂停应用，生产慎用）：
jcmd <PID> GC.heap_dump /tmp/heap_$(date +%s).hprof   # 或 jmap -dump:format=b,file=...
# 用 MAT / jhat 分析 dominator tree 找泄漏对象

# 线程（native thread OOM / 卡死）
jcmd <PID> Thread.print | less           # 数线程数；查 "java.lang.Thread.State" 与 "OutOfMemoryError: unable to create..."
jcmd <PID> VM.uptime                     # 确认进程是否刚被重启（区分「反复重启」和「一直没起来」）

# GC 日志 / crash 日志（路径看 role/config_file 或 CM 角色日志目录）
ls -lt /var/log/*/ | head                # 找 gc.log / hs_err_pid*.log
grep -iE 'OutOfMemoryError|Full GC|concurrent mode failure' <gc.log 或 role stdout 文件>
grep -iE 'Killed process|oom' /var/log/messages /var/log/syslog 2>/dev/null   # 排除内核 killer → cdh-linux-kernel
ulimit -u                                # nproc，配合 native thread OOM
```

判读：
- `GC.class_histogram` 某类实例数/占用异常集中 → 泄漏/大结果集，回到业务侧；
- `jstat` 老年代长期 ~100%、FGC 频繁、`GCT` 占比高 → 堆不足或泄漏；
- 堆/GC 都正常却报 OOME → 查 `MaxDirectMemorySize` / Metaspace / 线程数 / `NativeMemoryTracking`；
- 进程被重启过（`VM.uptime` 很小）或无 OOME 就消失 → 回到 `cdh-linux-kernel` 查 `dmesg` 与 hs_err_pid。
