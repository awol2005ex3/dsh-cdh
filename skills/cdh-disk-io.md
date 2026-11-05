# cdh-disk-io · 排查 CDH 磁盘 IO / 容量 / 掉盘

适用：用户反馈「HDFS 读写变慢」「DataNode 掉盘」「磁盘满了」「iowait 高」「作业卡在读写」，
或 `diagnosis/hdfs` 报容量/副本块异常、`host/diagnose` 报磁盘健康检查 BAD 时加载。

## 0. 四类磁盘问题先分清

| 现象 | 本质 | 主要证据来源 |
| --- | --- | --- |
| IO 延迟高 / 饱和 | 设备忙（`await` 高、`%util` 接近 100） | DISK/HOST 级 tsquery + 主机 `iostat` |
| 容量将满 | `dfs_capacity_used` 逼近 `dfs_capacity` | `diagnosis/hdfs` 容量指标 |
| inode / 小文件耗尽 | `df -h` 有空间但 `df -i` 满 | 主机侧 `df -i` |
| 掉盘 / 只读 / 坏道 | 单盘故障、DataNode 卷失效 | 角色 stderr + `dmesg` + `host/diagnose` |

插件只读 CM（不能 `iostat` / `df` / `ssh`），CM 侧用 cdh 定位到主机/角色/盘，主机侧命令交运维（第 6 节）。

## 1. CM 侧取证序列

1. `{category:"connection",action:"test"}` → `{category:"diagnosis",action:"overview"}`
   —— 判断是全局（HDFS 容量/副本）还是单机（某 DataNode 掉盘）。
2. **HDFS 容量与副本块**（最直接）：
   `{category:"diagnosis",action:"hdfs"}` —— 返回 `capacity.usedPercent`、
   `underReplicatedBlocks`、`missingBlocks`、`serviceHealth`、`roleDiagnosis.findings`。
   阈值：使用率 >70% CONCERNING、>85% BAD；`missingBlocks > 0` 是 BAD（数据可能永久损坏）。
3. **主机健康与磁盘检查项**：
   `{category:"host",action:"diagnose"}` —— 找磁盘类健康检查（DISK / 时钟 / Agent）。
4. **找磁盘指标名**（CM 版本差异大，**必须先 list**）：
   ```
   {category:"metrics",action:"list",args:{filter:"disk",context:"DISK"}}
   {category:"metrics",action:"list",args:{filter:"await",context:"DISK"}}
   {category:"metrics",action:"list",args:{filter:"iowait",context:"HOST"}}
   ```
   常见（以 schema 为准）：`await_time` / `await_read_time` / `await_write_time`、
   `utilization` / `disk_utilization`、`read_bytes_rate` / `write_bytes_rate`、
   `cpu_iowait`（HOST）、`dfs_capacity` / `dfs_capacity_used`（SERVICE）。
5. **看趋势/定位具体盘**（tsquery 语法先加载 `cdh-tsquery`）：
   ```
   {category:"metrics",action:"query",args:{tsquery:'select await_time, await_read_time, await_write_time, 250 where category = DISK and hostname = "dn01.example.com"',from:"2026-11-05T00:00:00Z",to:"2026-11-05T09:00:00Z"}}
   {category:"metrics",action:"query",args:{tsquery:'select cpu_iowait where category = HOST and hostname rlike "dn[0-9]+.*"',from:"2026-11-05T00:00:00Z",to:"2026-11-05T09:00:00Z"}}
   ```
   `250` 是画阈值线的标量常量；`rlike` 用正则缩小到一批 DataNode（值要加引号）。
   `device` / `mountpoint` 是常用 DISK 谓词属性，可用于定位单块盘。
6. **掉盘/卷失效的证据**：
   ```
   {category:"service",action:"list"}                                  // 拿 service_name
   {category:"role",action:"list",args:{service_name:"hdfs1"}}        // 拿 DataNode role_name
   {category:"role",action:"diagnose",args:{service_name:"hdfs1"}}
   {category:"role",action:"logs",args:{service_name:"hdfs1",role_name:"hdfs-DATANODE-xxx",log_type:"stderr",lines:300}}
   ```
   在 stderr 里找 `DataNode` 卷失效、目录不可写、`IOException` / `DiskChecker` / `excluded` 等关键字。
7. **关联告警**：
   `{category:"events",action:"alerts",args:{hours:24,severities:["CRITICAL","ERROR"]}}`
   事件查询（非 tsquery）：`{category:"events",action:"query",args:{query:"category==HDFS_EVENT;severity==CRITICAL ERROR",hours:24}}`

## 2. 判读要点

- **iowait 高 ≠ CPU 忙**：CPU 在等磁盘，先看磁盘而非加 CPU（CPU 视角见 `cdh-host-cpu`）。
- `%util` 接近 100 但吞吐不高：可能是随机小 IO / 单盘瓶颈 / RAID 或云盘限速；看 `await` 与 `svctm`。
- `await` 高 + `read_bytes_rate` 突增：可能是大作业/扫描驱动，联动 `diagnosis/impala`、`diagnosis/yarn` 看是否有大查询。
- **HDFS 容量 >85% 会触发副本不足/写入失败**，且 balancer 也会加重 IO；先扩容/清理，再谈性能。
- `under_replicated_blocks` 升高而 `missingBlocks=0`：多为 DataNode 掉线/掉盘导致的暂时副本不足，
  先查 `host/diagnose` 心跳与 DataNode stderr；`missingBlocks>0` 才升级为数据损坏风险。
- 查询返回 `warnings` 字段（指标名失效）时回 `metrics/list` 核对名字，不要直接断言「无数据」。

## 3. 结论要回答

1. 是延迟/饱和、容量、inode 还是掉盘（四类哪一类）；
2. 哪台主机、哪块盘/哪个 DataNode、从何时开始；
3. HDFS 容量使用率与副本块/丢失块数值；
4. cdh 已取到的证据，以及需要运维补的主机命令（第 6 节）。

## 4. 与相邻 skill 的分工

- CPU 侧视角（iowait 归属）→ `cdh-host-cpu`
- 内核/只读挂载/坏道 `dmesg` 证据 → `cdh-linux-kernel`
- 内存换页放大的 IO → `cdh-host-memory`

## 5. cdh 能 / 不能

- 能：HDFS 容量与副本块、主机磁盘健康检查、CM 采集到的 DISK/HOST 指标曲线、角色 stdout/stderr、
  实际下发的配置（`role/config_file`）、历史事件告警。
- 不能：单进程 IO（`iotop`）、设备级 `iostat` 明细、`df -i` inode、SMART/坏道、文件系统只读状态。

## 6. 交给运维在目标主机执行的命令（插件不能执行）

```bash
iostat -x 1 10                # await(ms), %util(接近100=饱和), svctm, r/s w/s, rkB/s wkB/s
iotop -oP                     # 按进程看谁在读写（需权限）
df -hT                        # 挂载点容量
df -i                         # inode 使用率：有空间却写不进去时查这个
lsblk -f / blkid              # 盘与挂载对应关系，核对 DataNode dfs.datanode.data.dir 配的目录
dmesg -T | grep -iE 'i/o error|ext4| xfs|read-only|blk_update_request'  # 坏道/只读/掉盘内核证据 → cdh-linux-kernel
smartctl -a /dev/sdX          # 硬件健康（若可用）
hdfs dfsadmin -report         # HDFS 侧各 DataNode 容量/失效卷，与 CM 指标交叉验证
mount | grep -E 'ro,|,ro'     # 是否被重挂成只读
```

判读：
- `await` 大 + `%util`≈100 → 设备饱和；先看是不是大作业，再考虑分散盘/扩容。
- `df -h` 有空间但 `df -i` 100% → inode 耗尽（小文件场景常见），CM 容量指标看不出来。
- `dmesg` 有 I/O error / remounted read-only → 掉盘硬件故障，去 `cdh-linux-kernel`；
- `dfsadmin -report` 与 CM 容量对不上 → 检查是否有 DataNode 心跳丢失（`host/diagnose`）。
