/**
 * Web client half: one release card per publish tool.
 *
 * The bundle registers a keyed view in `tool.call.toolview` for every tool
 * this package owns. The card is driven entirely by the Host's
 * `presentationMeta` (delivered as the result block's `meta`), so the client
 * parses no model-facing text. Results recorded before the meta channel
 * existed fall back to the plain result text.
 *
 * Only `react` is required: the browser module table provides it, and this
 * package must not pull Harness client packages into its bundle.
 *
 * @module xrxs-dsh-android-publish/client
 */

type Fact = { label: string; value: string }
type Step = { label: string; state: string }
type Store = { id: string; name: string; state: string; detail?: string }
type Card = {
  v: 1
  title: string
  subtitle?: string
  state: string
  badge?: string
  facts?: Fact[]
  steps?: Step[]
  stores?: Store[]
  warnings?: string[]
  notes?: string[]
  outputTail?: string
}

type ToolBlock = Record<string, unknown>

type ToolProps = {
  toolName: string
  phase: 'preparing' | 'start' | 'result'
  block: ToolBlock
  useDisclosure?: () => { expanded: boolean; toggle: () => void }
}

type Plugin = {
  inject: string[]
  apply(ctx: {
    slots: {
      inject(name: string, callback: () => unknown): unknown
      register(options: Record<string, unknown>, component: unknown): unknown
    }
  }): unknown
}

const TOOL_KEYS = [
  'android_publish_doctor',
  'android_publish_plan',
  'android_publish_preflight',
  'android_publish_start',
  'android_publish_status',
]

const FALLBACK_TITLES: Record<string, string> = {
  android_publish_doctor: 'Android 发布环境体检',
  android_publish_plan: 'Android 发布计划',
  android_publish_preflight: 'Android 发布预检',
  android_publish_start: 'Android 发布',
  android_publish_status: 'Android 发布状态',
}

const STATE_COLOR: Record<string, string> = {
  running: 'var(--dsw-alias-state-business-primary)',
  ok: 'var(--dsw-alias-state-success-primary)',
  failed: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  info: 'var(--dsw-alias-label-tertiary)',
}

const STEP_GLYPH: Record<string, string> = {
  done: '✓',
  active: '▸',
  pending: '·',
  failed: '✗',
  skipped: '–',
}

const STEP_COLOR: Record<string, string> = {
  done: 'var(--dsw-alias-state-success-primary)',
  active: 'var(--dsw-alias-state-business-primary)',
  pending: 'var(--dsw-alias-label-tertiary)',
  failed: 'var(--dsw-alias-state-error-primary)',
  skipped: 'var(--dsw-alias-label-caption)',
}

const STORE_COLOR: Record<string, string> = {
  success: 'var(--dsw-alias-state-success-primary)',
  failed: 'var(--dsw-alias-state-error-primary)',
  skipped: 'var(--dsw-alias-label-tertiary)',
  pending: 'var(--dsw-alias-label-caption)',
}

const S = {
  row: {
    display: 'flex',
    alignItems: 'center',
    minHeight: 24,
    gap: 6,
    cursor: 'pointer',
    userSelect: 'none',
  },
  dot: { width: 6, height: 6, borderRadius: 3, flex: 'none' },
  chevron: {
    width: 12,
    flex: 'none',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 10,
    lineHeight: '12px',
    textAlign: 'center',
  },
  title: {
    flex: 'none',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    lineHeight: '24px',
    color: 'var(--dsw-alias-label-primary)',
  },
  sep: { width: 2, height: 2, borderRadius: 1, background: 'var(--dsw-alias-label-caption)', flex: 'none' },
  subtitle: {
    flex: 'auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    lineHeight: '24px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  badge: { flex: 'none', fontSize: 12, lineHeight: '24px', marginLeft: 4 },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    margin: '4px 0 4px 18px',
    padding: '10px 12px',
    border: '0.5px solid var(--dsw-alias-border-l1)',
    borderRadius: 'var(--dsw-radius-lg)',
    background: 'var(--dsw-alias-bg-base)',
  },
  facts: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 12, rowGap: 3 },
  factLabel: { fontSize: 12, color: 'var(--dsw-alias-label-caption)' },
  factValue: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  steps: { display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12 },
  step: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  stores: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  store: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 8px',
    borderRadius: 999,
    border: '0.5px solid var(--dsw-alias-border-l2)',
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
  },
  warning: { fontSize: 12, color: 'var(--dsw-alias-state-warn-label)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  note: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-wrap' },
  pre: {
    margin: 0,
    maxHeight: 240,
    overflow: 'auto',
    padding: '8px 10px',
    borderRadius: 'var(--dsw-radius-sm)',
    background: 'var(--dsw-alias-markdown-code-block)',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'var(--dsw-font-markdown-code-block-small, 12px) monospace',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFact(value: unknown): value is Fact {
  return isRecord(value) && typeof value['label'] === 'string' && typeof value['value'] === 'string'
}

function isStep(value: unknown): value is Step {
  return isRecord(value) && typeof value['label'] === 'string' && typeof value['state'] === 'string'
}

function isStore(value: unknown): value is Store {
  return isRecord(value) && typeof value['name'] === 'string' && typeof value['state'] === 'string'
}

/** Accept only the fields this version knows how to draw; never trust the wire blindly. */
function readCard(block: ToolBlock): Card | null {
  const meta = block['meta']
  if (!isRecord(meta) || meta['v'] !== 1) return null
  if (typeof meta['title'] !== 'string' || typeof meta['state'] !== 'string') return null
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
  const card: Card = { v: 1, title: meta['title'], state: meta['state'] }
  if (typeof meta['subtitle'] === 'string') card.subtitle = meta['subtitle']
  if (typeof meta['badge'] === 'string') card.badge = meta['badge']
  if (Array.isArray(meta['facts'])) card.facts = meta['facts'].filter(isFact)
  if (Array.isArray(meta['steps'])) card.steps = meta['steps'].filter(isStep)
  if (Array.isArray(meta['stores'])) card.stores = meta['stores'].filter(isStore)
  const warnings = strings(meta['warnings'])
  if (warnings !== undefined) card.warnings = warnings
  const notes = strings(meta['notes'])
  if (notes !== undefined) card.notes = notes
  if (typeof meta['outputTail'] === 'string') card.outputTail = meta['outputTail']
  return card
}

function readText(block: ToolBlock): string {
  const content = block['content']
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text'])
    }
    if (parts.length > 0) return parts.join('\n')
  }
  // A failed tool call carries its message on `error`, not in `content`.
  const error = block['error']
  if (isRecord(error) && typeof error['message'] === 'string') return error['message']
  return ''
}

function readArgs(block: ToolBlock): Record<string, unknown> | null {
  const args = block['args']
  if (isRecord(args)) return args
  const raw = block['argsRaw']
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function fallbackFacts(args: Record<string, unknown> | null): Fact[] {
  if (args === null) return []
  const facts: Fact[] = []
  const profile = args['profileId']
  if (typeof profile === 'string') facts.push({ label: 'Profile', value: profile })
  const mode = args['mode']
  if (typeof mode === 'string') facts.push({ label: '模式', value: mode })
  const stores = args['stores']
  if (Array.isArray(stores)) facts.push({ label: '目标渠道', value: stores.map(String).join(' / ') })
  return facts
}

function FactRow(fact: Fact, key: number) {
  return h('div', { key: `f${String(key)}`, style: { display: 'contents' } },
    h('span', { style: S.factLabel }, fact.label),
    h('span', { style: S.factValue }, fact.value))
}

function StepChip(step: Step, key: number) {
  const color = STEP_COLOR[step.state] ?? STEP_COLOR['pending']
  return h('span', { key: `s${String(key)}`, style: S.step },
    h('span', { style: { color } }, STEP_GLYPH[step.state] ?? '·'),
    h('span', { style: { color: step.state === 'pending' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)' } }, step.label))
}

function StoreChip(store: Store, key: number) {
  const color = STORE_COLOR[store.state] ?? STORE_COLOR['pending']
  return h('span', { key: `c${String(key)}`, style: S.store },
    h('span', { style: { ...S.dot, background: color } }),
    h('span', null, `${store.name}${store.detail ? ` · ${store.detail}` : ''}`))
}

function Body(card: Card, raw: string) {
  const children: unknown[] = []
  if (card.facts && card.facts.length > 0) {
    children.push(h('div', { key: 'facts', style: S.facts }, ...card.facts.map((fact, index) => FactRow(fact, index))))
  }
  if (card.steps && card.steps.length > 0) {
    children.push(h('div', { key: 'steps', style: S.steps }, ...card.steps.map((step, index) => StepChip(step, index))))
  }
  if (card.stores && card.stores.length > 0) {
    children.push(h('div', { key: 'stores', style: S.stores }, ...card.stores.map((store, index) => StoreChip(store, index))))
  }
  for (const warning of card.warnings ?? []) {
    children.push(h('div', { key: `w${warning}`, style: S.warning }, `! ${warning}`))
  }
  for (const note of card.notes ?? []) {
    children.push(h('div', { key: `n${note}`, style: S.note }, note))
  }
  if (card.outputTail && card.outputTail.trim() !== '') {
    children.push(h('pre', { key: 'tail', style: S.pre }, card.outputTail))
  }
  if (children.length === 0) {
    children.push(h('div', { key: 'empty', style: S.note }, raw.trim() === '' ? '没有更多细节。' : raw))
  }
  return h('div', { style: S.body }, ...children)
}

function ReleaseRow(props: ToolProps) {
  const host = props.useDisclosure
  const disclosure = host === undefined ? { expanded: false, toggle: () => undefined } : host()
  const card = props.phase === 'result' ? readCard(props.block) : null
  const raw = props.phase === 'result' ? readText(props.block) : ''
  const args = props.phase === 'preparing' ? null : readArgs(props.block)
  const title = card?.title ?? FALLBACK_TITLES[props.toolName] ?? props.toolName
  const subtitle = card?.subtitle
    ?? (props.phase === 'result' ? firstLine(raw) : describeArgs(props.toolName, args))
  const state = card?.state ?? (props.phase === 'result' ? (isError(props.block) ? 'failed' : 'info') : 'running')
  const badge = card?.badge ?? (props.phase === 'result' ? '' : '运行中')
  const color = STATE_COLOR[state] ?? STATE_COLOR['info']
  const expandable = card !== null || raw.trim() !== '' || args !== null

  return h('div', null,
    h('div', {
      role: 'button',
      tabIndex: 0,
      'aria-expanded': expandable ? disclosure.expanded : undefined,
      style: S.row,
      onClick: () => {
        if (expandable) disclosure.toggle()
      },
      onKeyDown: (event: { key: string; preventDefault: () => void }) => {
        if (!expandable) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          disclosure.toggle()
        }
      },
    },
    h('span', { style: S.chevron }, expandable ? (disclosure.expanded ? '▾' : '▸') : ''),
    h('span', { style: { ...S.dot, background: color } }),
    h('span', { style: S.title }, title),
    subtitle === '' ? null : h('span', { style: S.sep }),
    subtitle === '' ? null : h('span', { style: S.subtitle }, subtitle),
    badge === '' ? null : h('span', { style: { ...S.badge, color } }, badge)),
    disclosure.expanded
      ? (card !== null ? Body(card, raw) : Body(fallbackCard(props, args, raw), raw))
      : null)
}

function isError(block: ToolBlock): boolean {
  return block['isError'] === true
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.slice(0, 120) ?? ''
}

function describeArgs(toolName: string, args: Record<string, unknown> | null): string {
  if (args === null) return ''
  const profile = typeof args['profileId'] === 'string' ? args['profileId'] : ''
  const mode = typeof args['mode'] === 'string' ? args['mode'] : ''
  const stores = Array.isArray(args['stores']) ? args['stores'].map(String).join(' / ') : ''
  const parts = [profile, mode, stores].filter(part => part !== '')
  if (toolName === 'android_publish_status' && typeof args['jobId'] === 'string') return args['jobId']
  return parts.join(' · ')
}

function fallbackCard(props: ToolProps, args: Record<string, unknown> | null, raw: string): Card {
  return {
    v: 1,
    title: FALLBACK_TITLES[props.toolName] ?? props.toolName,
    state: props.phase === 'result' && isError(props.block) ? 'failed' : 'info',
    facts: fallbackFacts(args),
    ...(raw.trim() === '' ? {} : { outputTail: raw.length > 4000 ? raw.slice(raw.length - 4000) : raw }),
  }
}

// `react` is a browser module-table baseline module; the factory receives it.
const React = require('react')
const h = React.createElement as (...args: unknown[]) => unknown

const plugin: Plugin = {
  inject: ['slots'],
  apply(ctx) {
    // `slots.inject` accepts one disposer or an iterable of them.
    ctx.slots.inject('tool.call.toolview', () =>
      TOOL_KEYS.map(key => ctx.slots.register({ name: 'tool.call.toolview', key }, ReleaseRow)))
  },
}

export const inject = plugin.inject
export const apply = plugin.apply