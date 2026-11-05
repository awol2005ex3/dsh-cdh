/**
 * 内置 skills：模型排查 CDH 故障时按需加载的运维知识卡。
 *
 * 正文放在 skills/*.md（原生 Markdown，不带模板字符串转义，便于维护/预览）。
 * 宿主半只在装配时读一次；浏览器半不 import 本文件，node:fs 不会进 client bundle。
 *
 * `skills` 服务用 ctx.inject(['skills']) 延迟装配：服务晚挂载/缺席都只降级掉这些增强功能，
 * 核心 cdh 工具照常可用（因此不把 'skills' 写进顶层 inject，避免老宿主加载失败）。
 *
 * 新增一个主题只需：在 BUILTIN_SKILLS 加一行 + 在 skills/ 放一个同名 md。
 * 注册逻辑、降级路径、反注册全部复用，不为单个 skill 复制一遍。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** 单个内置 skill 的注册元数据。 */
export interface BuiltinSkillDef {
  /** skill 名（kebab-case，出现在 <available_skills> catalog 里）。 */
  readonly name: string
  /** catalog 里唯一的路由文本，控制在 tool-skill 的 500 字符截断上限内。 */
  readonly description: string
  /** 相对编译产物 lib/skill.js 解析的正文路径。 */
  readonly file: string
}

/** tsquery skill 名（保留单独常量：cdh 工具描述与冒烟脚本按名字引用它）。 */
export const CDH_TSQUERY_SKILL = 'cdh-tsquery'

/** catalog 里唯一的路由文本，控制在 tool-skill 的 500 字符截断上限内。 */
export const CDH_TSQUERY_SKILL_DESCRIPTION =
  '编写或调试 Cloudera Manager / CDH 时序指标查询（cdh 工具 metrics/query 的 tsquery 参数、' +
  'metrics/list 检索指标名）时加载。涵盖 tsquery 语法、与 events/query 事件查询语法的区别、' +
  'from/to 时间参数、WHERE 谓词与常用属性、metric expression 函数、CDH 7 指标改名、' +
  '可直接套用的 cdh 调用示例，以及 CM 报解析错误时的自查清单。'

/**
 * 注册清单 = 事实来源：名称、catalog 描述、正文文件一一对应。
 * 顺序只影响注册次序，不影响 catalog 展示。
 *
 * 主题按「故障现象」切分而非按工具分类：模型看到 CPU 高 / OOME / 磁盘满 时能精准命中一张卡，
 * 每张卡自带边界说明与相邻 skill 的交叉引用，避免重复加载整本手册。
 */
export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
  {
    name: CDH_TSQUERY_SKILL,
    description: CDH_TSQUERY_SKILL_DESCRIPTION,
    file: 'cdh-tsquery.md',
  },
  {
    name: 'cdh-host-cpu',
    description:
      '排查 CDH 主机 CPU 高、load 飙高、iowait、上下文切换、单角色吃满 CPU 时加载。给出「现象→层次」判别表、' +
      '用 cdh 工具（host/diagnose、metrics/host、ROLE 级 tsquery、role/diagnose、events/alerts）取证的固定序列、' +
      '因插件只读而需运维在主机执行的 top/vmstat/mpstat/pidstat 命令与判读要点，并区分 iowait 与 GC 颠簸等常见误判。',
    file: 'cdh-host-cpu.md',
  },
  {
    name: 'cdh-host-memory',
    description:
      '排查主机内存水位、swap 换页、cgroup 限额、OOM killer 前兆时加载。区分物理内存不足/内核杀进程/JVM 堆 OOM 三类，' +
      '给出 metrics/host 与 mem/swap tsquery 取证序列、free/vmstat/proc meminfo/dmesg 主机侧命令与判读' +
      '（看 available 而非 free、si/so、角色堆之和要留余量），并指向 cdh-linux-kernel 与 cdh-jvm-oom。',
    file: 'cdh-host-memory.md',
  },
  {
    name: 'cdh-disk-io',
    description:
      '排查磁盘 IO 延迟、设备饱和、磁盘将满、DataNode 掉盘、HDFS 读写变慢时加载。给出 await/util 与容量的判别表、' +
      'metrics/list 核对磁盘指标名、DISK/HOST 级 tsquery、diagnosis/hdfs 容量与副本块、角色 stderr 找掉盘证据，' +
      '以及 iostat/iotop/df -i/dmesg 主机侧命令与判读。',
    file: 'cdh-disk-io.md',
  },
  {
    name: 'cdh-linux-kernel',
    description:
      '进程无故消失、CM 报角色 DOWN 却无应用异常、时钟偏移、too many open files、THP/内核参数核对时加载。' +
      '明确插件只读 CM、不能登录主机：从 host/diagnose、role/diagnose、events、内存曲线找内核级证据，' +
      '给出 dmesg OOM killer、cgroup memory.events、sysctl/ulimit/THP/NTP/conntrack 命令清单与判读，' +
      '并区分内核 OOM killer 与 JVM 堆 OOM。',
    file: 'cdh-linux-kernel.md',
  },
  {
    name: 'cdh-jvm-oom',
    description:
      '角色出现 java.lang.OutOfMemoryError、GC 停顿变长、进程僵死或意外重启时加载。' +
      '按 OOME 类型（heap space / GC overhead / native thread / Metaspace / Direct buffer）分流，' +
      '给出 role/logs(stderr/stdout)、role/config_file、jvm_* 指标、configStale 的 cdh 取证序列，' +
      '以及 jcmd/jstat/jmap/jstack/GC 日志主机侧命令与各角色（NameNode/Impala/HBase 等）着眼点。',
    file: 'cdh-jvm-oom.md',
  },
]

/** `ctx.skills.register()` 的最小鸭子类型（不引入 @deepseek-ai/dsh-skill 运行时依赖）。 */
interface SkillsServiceLike {
  register(skill: {
    readonly name: string
    readonly description: string
    readonly source: string
    readonly content: string
    readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  }): () => void | Promise<void>
}

/**
 * 装配全部内置 runtime skill。
 *
 * `ctx.inject(['skills'], cb)` 是官方「服务就绪才装配」范式：子 fiber 的卸载由宿主管理，
 * HMR/卸载时里面的每个 ctx.effect 自动反注册；服务缺席时不阻塞插件加载。
 * 单个正文读失败只跳过那一个 skill，其余 skill 与核心工具照常可用。
 */
export function registerBuiltinSkills(ctx: Context): void {
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (c: Context) => void) => unknown
  }).inject
  if (typeof inject !== 'function') return // 测试替身/老宿主没有延迟装配能力，静默降级

  inject.call(ctx, ['skills'], (skillsCtx: Context) => {
    // 子 ctx 已声明 inject(['skills'])，属性访问合法（与 sandbox-local 的官方范式一致）。
    const skills = (skillsCtx as unknown as { skills?: SkillsServiceLike }).skills
    if (!skills || typeof skills.register !== 'function') {
      ctx.logger('cdh').warn('dsh-cdh: skills registry unavailable; built-in skills not registered')
      return
    }

    for (const def of BUILTIN_SKILLS) {
      // 正文每次装配现读（文件随 npm 包发布、HMR 时若被替换能生效）。
      let content: string
      try {
        content = readFileSync(new URL(`../skills/${def.file}`, import.meta.url), 'utf8')
      } catch (err) {
        ctx.logger('cdh').warn(
          'dsh-cdh: cannot read skills/%s, skill %s not registered: %s',
          def.file,
          def.name,
          err instanceof Error ? err.message : String(err),
        )
        continue
      }
      if (!content.trim()) {
        ctx.logger('cdh').warn('dsh-cdh: skills/%s is empty, skill %s not registered', def.file, def.name)
        continue
      }

      skillsCtx.effect(() => {
        const dispose = skills.register({
          name: def.name,
          description: def.description,
          source: 'runtime',
          content,
          invocation: { modelInvocable: true, userInvocable: true },
        })
        return dispose
      }, `cdh: skill ${def.name}`)
    }
  })
}
