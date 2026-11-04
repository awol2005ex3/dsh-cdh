/**
 * 内置 skill：教模型写对 Cloudera Manager 的 tsquery（时序指标查询语言）。
 *
 * 正文放在 skills/cdh-tsquery.md（原生 Markdown，不带模板字符串转义，便于维护/预览）。
 * 宿主半只在装配时读一次；浏览器半不 import 本文件，node:fs 不会进 client bundle。
 *
 * `skills` 服务用 ctx.inject(['skills']) 延迟装配：服务晚挂载/缺席都只降级掉这个增强功能，
 * 核心 cdh 工具照常可用（因此不把 'skills' 写进顶层 inject，避免老宿主加载失败）。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** skill 名（kebab-case，出现在 <available_skills> catalog 里）。 */
export const CDH_TSQUERY_SKILL = 'cdh-tsquery'

/** catalog 里唯一的路由文本，控制在 tool-skill 的 500 字符截断上限内。 */
export const CDH_TSQUERY_SKILL_DESCRIPTION =
  '编写或调试 Cloudera Manager / CDH 时序指标查询（cdh 工具 metrics/query 的 tsquery 参数、' +
  'metrics/list 检索指标名）时加载。涵盖 tsquery 语法、与 events/query 事件查询语法的区别、' +
  'from/to 时间参数、WHERE 谓词与常用属性、metric expression 函数、CDH 7 指标改名、' +
  '可直接套用的 cdh 调用示例，以及 CM 报解析错误时的自查清单。'

/** 相对编译产物 lib/skill.js 解析 skills/cdh-tsquery.md。 */
const SKILL_MD_URL = new URL('../skills/cdh-tsquery.md', import.meta.url)

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
 * 装配全局 runtime skill。
 *
 * `ctx.inject(['skills'], cb)` 是官方「服务就绪才装配」范式：子 fiber 的卸载由宿主管理，
 * HMR/卸载时里面的 ctx.effect 自动反注册；服务缺席时不阻塞插件加载。
 */
export function registerCdhTsquerySkill(ctx: Context): void {
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (c: Context) => void) => unknown
  }).inject
  if (typeof inject !== 'function') return // 测试替身/老宿主没有延迟装配能力，静默降级

  inject.call(ctx, ['skills'], (skillsCtx: Context) => {
    // 子 ctx 已声明 inject(['skills'])，属性访问合法（与 sandbox-local 的官方范式一致）。
    const skills = (skillsCtx as unknown as { skills?: SkillsServiceLike }).skills
    if (!skills || typeof skills.register !== 'function') {
      ctx.logger('cdh').warn('dsh-cdh: skills registry unavailable; built-in tsquery skill not registered')
      return
    }

    // 正文每次装配现读（文件随 npm 包发布、HMR 时若被替换能生效）；读失败不让插件整体失联。
    let content: string
    try {
      content = readFileSync(SKILL_MD_URL, 'utf8')
    } catch (err) {
      ctx.logger('cdh').warn(
        'dsh-cdh: cannot read skills/cdh-tsquery.md, built-in tsquery skill not registered: %s',
        err instanceof Error ? err.message : String(err),
      )
      return
    }

    skillsCtx.effect(() => {
      const dispose = skills.register({
        name: CDH_TSQUERY_SKILL,
        description: CDH_TSQUERY_SKILL_DESCRIPTION,
        source: 'runtime',
        content,
        invocation: { modelInvocable: true, userInvocable: true },
      })
      return dispose
    }, 'cdh: tsquery skill')
  })
}
