/**
 * dsh-cdh · 浏览器端 bundle 模块体。
 *
 * 构建契约（deepseek-harness packages/client/tsdown.client.ts 的闭包工厂格式）：
 * 本文件经 tsc 编译后，由 scripts/wrap-client.mjs 包上
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 * 成为惰性 CJS bundle。副作用全部在工厂闭包内，待浏览器 shell 物化时运行。
 *
 * 功能：
 * 1. CDH / Cloudera Manager 连接配置（host/port/账号/密码/TLS/API 版本/超时/默认集群），
 *    读写走官方 configForms（volatile 字段落盘 + 宿主热更新）；
 * 2. 「测试连接」按钮，调用宿主 `/api/cdh/diagnose` 的 connection/test；
 * 3. 挂载策略逐级降级：settings.plugins.tab → settings.plugin.item →
 *    settings.section → 设置对话框 DOM 锚点兜底。
 *
 * ⚠ RPC 通道固定 /api：宿主端用 connection.fetch.register() 在 /api/cdh/<ep>
 * 挂精确路由（0.1.5 起 rpc.handle 对插件失效）。
 */

const PLUGIN_ID = 'dsh-cdh'
/** 配置命名空间 = profile 条目 id（cordis.patch.yml 里 `id: dsh-cdh`）。 */
const SETTINGS_NS = 'dsh-cdh'
const RPC_CHANNEL = '/api'
const RPC_PREFIX = 'cdh/'
const SECTION_LABEL = 'CDH 诊断'

/** 构建外壳（scripts/wrap-client.mjs 的 intro）注入的 CJS 语义，仅类型层面使用。 */
declare const module: { exports: unknown }
declare function require(id: string): any

const win = window as unknown as { __dshCdhMounted?: boolean }
const doc = document

/* ── 工具函数 ─────────────────────────────────────────────────────────── */

type ElProps = { style?: string; [key: string]: unknown }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'style') node.setAttribute('style', value as string)
      else (node as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (children) {
    for (const c of children) node.append(typeof c === 'string' ? doc.createTextNode(c) : c)
  }
  return node
}

function service(ctx: any, name: string): any {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/* ── RPC（宿主 /api/cdh/*） ───────────────────────────────────────────── */

interface RpcResponse {
  ok: boolean
  value?: unknown
  error?: { message?: string }
}

async function callRpc(conn: any, endpoint: string, args?: Record<string, unknown>): Promise<unknown> {
  const res = (await conn.rpc.call(RPC_CHANNEL, `${RPC_PREFIX}${endpoint}`, args ? { args } : {})) as RpcResponse
  if (!res || res.ok !== true) {
    throw new Error(res?.error?.message ?? 'rpc error')
  }
  return res.value
}

/** 调用诊断分发器：category + action + args。 */
async function callDiagnose(
  conn: any,
  category: string,
  action: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return callRpc(conn, 'diagnose', { category, action, args })
}

/* ── 配置读写通道（官方 configForms，退路为宿主只读快照） ─────────────── */

/** 面板需要读写的配置字段（与宿主 Config schema 同名）。 */
interface CdhFormValue {
  host: string
  port: number
  username: string
  password: string
  useTls: boolean
  apiVersion: string
  timeoutMs: number
  defaultCluster: string
}

interface SettingsChannel {
  read(): Promise<Partial<CdhFormValue> & { hasPassword?: boolean }>
  write(patch: Record<string, unknown>): Promise<void>
}

function configFormsChannel(ctx: any): SettingsChannel | undefined {
  const forms = service(ctx, 'configForms')
  if (!forms || typeof forms.get !== 'function') return undefined

  /**
   * 探测命名空间是否已进入镜像。
   *
   * 不缓存结果：镜像异步拉取，插件启动时多半还没就绪。首次探测失败即永久
   * 降级会让面板永远失去写能力。
   */
  function ensure(): boolean {
    try {
      const mirror = typeof forms.describe === 'function' ? forms.describe() : undefined
      if (!mirror || typeof mirror.getSnapshot !== 'function') return false
      return mirror.getSnapshot()?.view?.namespaces?.some((row: any) => row?.ns === SETTINGS_NS) === true
    } catch {
      return false
    }
  }

  if (!ensure()) return undefined

  const form = (): any => forms.get(SETTINGS_NS)

  async function waitReady(): Promise<any> {
    const snap = form().getSnapshot()
    if (snap?.status === 'ready') return snap
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        off?.()
        reject(new Error('读取配置超时（宿主配置镜像未就绪）'))
      }, 15000)
      const off = typeof form().subscribe === 'function' ? form().subscribe(check) : undefined
      function check(): void {
        if (done) return
        const s = form().getSnapshot()
        if (s?.status === 'ready') {
          done = true
          clearTimeout(timer)
          off?.()
          resolve(s)
        } else if (s?.status === 'unavailable') {
          done = true
          clearTimeout(timer)
          off?.()
          reject(new Error('配置服务不可用'))
        }
      }
    })
  }

  return {
    read: async () => {
      const snap = await waitReady()
      const value = (snap.value ?? {}) as Record<string, unknown>
      return {
        host: typeof value.host === 'string' ? value.host : undefined,
        port: typeof value.port === 'number' ? value.port : undefined,
        username: typeof value.username === 'string' ? value.username : undefined,
        password: typeof value.password === 'string' ? value.password : undefined,
        useTls: typeof value.useTls === 'boolean' ? value.useTls : undefined,
        apiVersion: typeof value.apiVersion === 'string' ? value.apiVersion : undefined,
        timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined,
        defaultCluster: typeof value.defaultCluster === 'string' ? value.defaultCluster : undefined,
      }
    },
    write: async (patch) => {
      const snap = await waitReady()
      const ops: Array<Record<string, unknown>> = []
      for (const [key, value] of Object.entries(patch)) ops.push({ op: 'set', path: [key], value })
      await form().mutate(ops, snap.revision)
    },
  }
}

/** 退路：宿主 /api/cdh/settings 只读快照（密码已脱敏，写操作不可用）。 */
function rpcSettingsChannel(conn: any): SettingsChannel | undefined {
  if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') return undefined
  return {
    read: async () => {
      const value = (await callRpc(conn, 'settings', {})) as Record<string, unknown>
      return {
        host: typeof value.host === 'string' ? value.host : undefined,
        port: typeof value.port === 'number' ? value.port : undefined,
        username: typeof value.username === 'string' ? value.username : undefined,
        useTls: typeof value.useTls === 'boolean' ? value.useTls : undefined,
        apiVersion: typeof value.apiVersion === 'string' ? value.apiVersion : undefined,
        timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : undefined,
        defaultCluster: typeof value.defaultCluster === 'string' ? value.defaultCluster : undefined,
        hasPassword: value.hasPassword === true,
      }
    },
    write: async () => {
      throw new Error(
        '当前 dsh 未提供设置表单服务（configForms），配置只能在宿主 profile 的 cordis.patch.yml 里改',
      )
    },
  }
}

/** 运行时择优建通道：每次读写都重新探测 configForms（镜像可能稍后才就绪）。 */
function createChannel(ctx: any, conn: any): SettingsChannel {
  const resolve = (): SettingsChannel | undefined => configFormsChannel(ctx) ?? rpcSettingsChannel(conn)
  const required = (): SettingsChannel => {
    const channel = resolve()
    if (!channel) throw new Error('没有可用的配置读写通道（configForms / RPC 均不可用）')
    return channel
  }
  return {
    read: () => required().read(),
    write: (patch) => required().write(patch),
  }
}

/* ── 面板 ─────────────────────────────────────────────────────────────── */

const PANEL_CSS =
  'color:inherit;font:13px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'display:flex;flex-direction:column;gap:10px;max-width:620px;'
const ROW_CSS = 'display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:center;'
const LABEL_CSS = 'font-weight:600;'
const INPUT_CSS =
  'width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;font-family:inherit;' +
  'border:1px solid rgba(127,127,127,.4);border-radius:6px;background:transparent;color:inherit;'
const HINT_CSS = 'color:rgba(127,127,127,.95);font-size:12px;margin:0;'
const BTN_CSS =
  'padding:6px 14px;font-size:13px;cursor:pointer;border:1px solid rgba(127,127,127,.4);' +
  'background:transparent;color:inherit;border-radius:6px;'
const BTN_PRIMARY_CSS =
  'padding:6px 14px;font-size:13px;cursor:pointer;border:none;background:#1f6feb;color:#fff;border-radius:6px;'
const STATUS_OK = 'color:#1a7f37;font-size:12.5px;white-space:pre-wrap;'
const STATUS_ERR = 'color:#cf222e;font-size:12.5px;white-space:pre-wrap;'
const PRE_CSS =
  'max-height:220px;overflow:auto;margin:0;padding:8px;border-radius:6px;font-size:12px;' +
  'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;' +
  'border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.06);'

interface PanelHandle {
  root: HTMLElement
  refresh(): Promise<void>
}

function makeButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const btn = el('button', { type: 'button', textContent: label, style: primary ? BTN_PRIMARY_CSS : BTN_CSS })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const cells: HTMLElement[] = [el('div', { style: LABEL_CSS, textContent: label })]
  if (hint) {
    cells.push(
      el('div', {}, [input, el('p', { style: HINT_CSS, textContent: hint })]),
    )
  } else {
    cells.push(input)
  }
  return el('div', { style: ROW_CSS }, cells)
}

function buildPanel(ctx: any, conn: any): PanelHandle {
  const channel = createChannel(ctx, conn)

  const hostInput = el('input', { placeholder: 'cm.example.com 或 cm.example.com:7180', style: INPUT_CSS }) as HTMLInputElement
  const portInput = el('input', { type: 'number', placeholder: '7180', style: INPUT_CSS }) as HTMLInputElement
  const userInput = el('input', { placeholder: 'admin', style: INPUT_CSS }) as HTMLInputElement
  const passwordInput = el('input', {
    type: 'password',
    placeholder: '留空表示不修改已保存的密码',
    style: INPUT_CSS,
    autocomplete: 'new-password',
  }) as HTMLInputElement
  const tlsInput = el('input', { type: 'checkbox' }) as HTMLInputElement
  const apiVersionInput = el('input', { placeholder: 'v41', style: INPUT_CSS }) as HTMLInputElement
  const timeoutInput = el('input', { type: 'number', placeholder: '30000', style: INPUT_CSS }) as HTMLInputElement
  const clusterInput = el('input', { placeholder: '留空自动取第一个集群', style: INPUT_CSS }) as HTMLInputElement

  const status = el('div', { style: HINT_CSS })
  const output = el('pre', { style: PRE_CSS })
  output.style.display = 'none'

  let hasPassword = false

  function setStatus(text: string, ok: boolean): void {
    status.textContent = text
    status.setAttribute('style', ok ? STATUS_OK : STATUS_ERR)
  }

  function setOutput(value: unknown): void {
    if (value === undefined || value === null) {
      output.style.display = 'none'
      output.textContent = ''
      return
    }
    output.style.display = 'block'
    output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }

  async function refresh(): Promise<void> {
    setStatus('正在读取配置…', true)
    try {
      const value = await channel.read()
      if (typeof value.host === 'string') hostInput.value = value.host
      if (typeof value.port === 'number') portInput.value = String(value.port)
      if (typeof value.username === 'string') userInput.value = value.username
      if (typeof value.useTls === 'boolean') tlsInput.checked = value.useTls
      if (typeof value.apiVersion === 'string') apiVersionInput.value = value.apiVersion
      if (typeof value.timeoutMs === 'number') timeoutInput.value = String(value.timeoutMs)
      if (typeof value.defaultCluster === 'string') clusterInput.value = value.defaultCluster
      hasPassword = value.hasPassword === true || (typeof value.password === 'string' && value.password.length > 0)
      passwordInput.value = ''
      passwordInput.placeholder = hasPassword
        ? '已保存（留空表示不修改）'
        : '请输入 Cloudera Manager 登录密码'
      setStatus(hasPassword ? '已配置（密码已保存）' : '尚未配置密码', true)
    } catch (err) {
      setStatus(err instanceof Error ? `读取配置失败：${err.message}` : '读取配置失败', false)
    }
  }

  function collect(includePassword: boolean): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    patch.host = hostInput.value.trim()
    const port = Number.parseInt(portInput.value, 10)
    patch.port = Number.isFinite(port) && port > 0 && port <= 65535 ? port : 7180
    patch.username = userInput.value.trim()
    patch.useTls = tlsInput.checked
    patch.apiVersion = apiVersionInput.value.trim() || 'v41'
    const timeout = Number.parseInt(timeoutInput.value, 10)
    patch.timeoutMs = Number.isFinite(timeout) && timeout >= 1000 ? timeout : 30000
    patch.defaultCluster = clusterInput.value.trim()
    // 密码留空 = 不修改，避免每次保存都把已存密码清空。
    if (includePassword && passwordInput.value.length > 0) patch.password = passwordInput.value
    return patch
  }

  const saveBtn = makeButton(
    '保存配置',
    async () => {
      const patch = collect(true)
      if (!patch.host) {
        setStatus('请填写 Cloudera Manager 主机', false)
        return
      }
      saveBtn.disabled = true
      setStatus('正在保存…', true)
      try {
        await channel.write(patch)
        setStatus('已保存，宿主已热更新（无需重启）', true)
        await refresh()
      } catch (err) {
        setStatus(err instanceof Error ? `保存失败：${err.message}` : '保存失败', false)
      } finally {
        saveBtn.disabled = false
      }
    },
    true,
  )

  const testBtn = makeButton('测试连接', async () => {
    testBtn.disabled = true
    setStatus('正在测试连接…', true)
    setOutput(undefined)
    try {
      const value = await callDiagnose(conn, 'connection', 'test')
      const message = (value as { message?: string })?.message
      setStatus(message ? `连接成功：${message}` : '连接成功', true)
      setOutput(value)
    } catch (err) {
      setStatus(err instanceof Error ? `连接失败：${err.message}` : '连接失败', false)
    } finally {
      testBtn.disabled = false
    }
  })

  const clusterBtn = makeButton('列出集群', async () => {
    clusterBtn.disabled = true
    setStatus('正在查询集群列表…', true)
    setOutput(undefined)
    try {
      const value = await callDiagnose(conn, 'cluster', 'list')
      const items = (value as { items?: Array<{ name?: string }> })?.items ?? []
      setStatus(`共 ${items.length} 个集群：${items.map((i) => i.name ?? '?').join(', ') || '（空）'}`, true)
      setOutput(value)
    } catch (err) {
      setStatus(err instanceof Error ? `查询失败：${err.message}` : '查询失败', false)
    } finally {
      clusterBtn.disabled = false
    }
  })

  const overviewBtn = makeButton('集群总览诊断', async () => {
    overviewBtn.disabled = true
    setStatus('正在诊断集群…', true)
    setOutput(undefined)
    try {
      const value = (await callDiagnose(conn, 'diagnosis', 'overview')) as Record<string, unknown>
      const score = typeof value.healthScore === 'number' ? value.healthScore : '?'
      setStatus(`健康评分 ${score} / 100（${String(value.overallHealth ?? '?')}）`, value.overallHealth === 'GOOD')
      setOutput(value)
    } catch (err) {
      setStatus(err instanceof Error ? `诊断失败：${err.message}` : '诊断失败', false)
    } finally {
      overviewBtn.disabled = false
    }
  })

  const root = el('div', { style: PANEL_CSS, id: 'dsh-cdh-panel' }, [
    el('div', { style: 'font-weight:700;font-size:15px;', textContent: '🩺 CDH 诊断 · Cloudera Manager 连接配置' }),
    el('p', {
      style: HINT_CSS,
      textContent:
        '连接信息只用于只读诊断（CM REST API）；账号密码写入本机 profile 配置，工具与 RPC 回包从不回显密码。',
    }),
    field('CM 主机', hostInput, '可带端口，如 cm.example.com:7180；填了端口则以它为准'),
    field('端口', portInput, '默认 7180'),
    field('用户名', userInput, 'CM 登录账号（HTTP Basic Auth）'),
    field('密码', passwordInput, '留空表示沿用已保存的密码'),
    field('使用 HTTPS', tlsInput, '启用后走 https://host:port；自签证书会被 Node fetch 拒绝'),
    field('API 版本', apiVersionInput, '默认 v41（CM 7.1.x / CDH 7.1.7）；CM 6.x 常用 v31/v40'),
    field('超时(ms)', timeoutInput, '单次 CM 请求超时，默认 30000'),
    field('默认集群', clusterInput, '工具省略 cluster_name 时使用；留空取第一个集群'),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [saveBtn, testBtn, clusterBtn, overviewBtn]),
    status,
    output,
  ])

  void refresh()
  return { root, refresh }
}

/* ── 挂载（slots 优先，DOM 兜底） ──────────────────────────────────────── */

const SETTINGS_SLOT_CANDIDATES: Array<[string, Record<string, unknown>]> = [
  ['settings.plugins.tab', { id: SETTINGS_NS, order: 20, label: SECTION_LABEL }],
  ['settings.plugin.item', { key: SETTINGS_NS, label: SECTION_LABEL }],
  ['settings.section', { id: PLUGIN_ID, label: SECTION_LABEL, title: SECTION_LABEL }],
]

function createSettingsComponent(React: any, handle: PanelHandle): any {
  return function CdhSettings() {
    const ref = React.useRef(null)
    React.useEffect(function () {
      const node = ref.current as HTMLElement | null
      if (!node) return
      node.appendChild(handle.root)
      void handle.refresh()
    }, [])
    return React.createElement('div', { ref, 'data-dsh-cdh-settings': 'true' })
  }
}

/** 回退：设置对话框里的可挂载锚点。 */
function findSettingsHost(): HTMLElement | null {
  const selectors = [
    '[data-slot="settings.plugin.item"]',
    '[data-slot="settings.plugins.tab"]',
    '[data-slot="settings.section"]',
    '[data-slot="settings.content"]',
    '[data-slot="settings.body"]',
  ]
  for (const selector of selectors) {
    const node = doc.querySelector(selector)
    if (node instanceof HTMLElement) return node
  }
  return null
}

function mountPanelInSettings(panel: HTMLElement, refresh: () => void): void {
  const host = findSettingsHost()
  if (!host) {
    if (panel.parentElement) panel.remove()
    return
  }
  if (panel.parentElement !== host) {
    host.append(panel)
    refresh()
  }
}

/** 注册设置页插槽；成功返回 true（调用方据此决定是否启用 DOM 兜底）。 */
function tryRegisterSettingsSlot(ctx: any, handle: PanelHandle, onSlotted: () => void): boolean {
  let wired = false
  let mounted = false

  const register = (slots: any): void => {
    if (wired || !slots || typeof slots.inject !== 'function') return
    let React: any
    try {
      React = require('react')
    } catch {
      return
    }
    if (!React || typeof React.createElement !== 'function') return
    wired = true

    const Comp = createSettingsComponent(React, handle)
    const priority = new Map(SETTINGS_SLOT_CANDIDATES.map(([name], index) => [name, index]))
    const mountedAt = new Set<string>()
    const declared = (name: string): boolean => {
      if (typeof slots.specDynamic !== 'function') return false
      try {
        return Boolean(slots.specDynamic(name))
      } catch {
        return false
      }
    }

    for (const [name, opts] of SETTINGS_SLOT_CANDIDATES) {
      try {
        slots.inject(name, () => {
          // 高优先级插槽已声明时不再重复挂载
          for (const [other] of SETTINGS_SLOT_CANDIDATES) {
            if (priority.get(other)! < priority.get(name)! && declared(other)) return
          }
          if (mountedAt.size > 0 && !mountedAt.has(name)) return
          const dispose = slots.register({ name, ...opts }, Comp)
          mountedAt.add(name)
          mounted = true
          onSlotted()
          return () => {
            mountedAt.delete(name)
            if (typeof dispose === 'function') dispose()
          }
        })
      } catch {
        // 单个插槽注入失败不影响其余候选
      }
    }
  }

  try {
    if (typeof ctx?.inject === 'function') ctx.inject(['slots'], (scope: any) => register(scope?.slots))
    register(service(ctx, 'slots'))
  } catch {
    // 回退到 DOM 挂载
  }
  return mounted
}

/* ── 客户端插件契约（浏览器半 fiber；inject 声明 connection） ───────────── */

function apply(ctx: any): void {
  const conn = service(ctx, 'connection') ?? ctx?.connection
  if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
    // 无 connection 时静默退出：宿主端工具仍可用。
    return
  }
  if (win.__dshCdhMounted === true) return
  win.__dshCdhMounted = true

  const handle = buildPanel(ctx, conn)
  // 插槽注册在 inject 回调里异步生效；注册成功前先用 DOM 兜底。
  // ⚠ 两者必须互斥：`[data-slot="settings.section"]` 是所有设置分区**共享**的
  // 单一容器（宿主按 only:active 渲染当前分区），面板一旦被兜底搬进去，
  // 每个配置 tab 都会出现 CDH 配置项。onSlotted 里必须断开 observer。
  let slotted = false
  let observer: MutationObserver | undefined

  function stopFallback(): void {
    slotted = true
    observer?.disconnect()
    observer = undefined
    const anchor = doc.querySelector('[data-dsh-cdh-settings]')
    if (anchor) {
      if (handle.root.parentElement !== anchor) anchor.appendChild(handle.root)
    } else if (handle.root.parentElement) {
      // 插槽组件还没挂载（对话框未开 / 未切到本 tab）：先摘除，
      // 组件挂载时它的 effect 会把面板 append 回来。
      handle.root.remove()
    }
  }

  slotted = tryRegisterSettingsSlot(ctx, handle, stopFallback)
  if (!slotted) {
    observer = new MutationObserver(() => {
      if (!slotted) mountPanelInSettings(handle.root, handle.refresh)
    })
    observer.observe(doc.documentElement, { childList: true, subtree: true })
  }
}

// 工厂返回值即插件模块表：loader 从中读取 name / inject / apply 组装 fiber。
module.exports = { name: PLUGIN_ID, inject: ['connection'], apply }
