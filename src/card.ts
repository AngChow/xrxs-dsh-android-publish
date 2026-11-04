/**
 * Release card model shared by the Host tools and the Web client view.
 *
 * Tools project this value through `output.presentationMeta`, which the Host
 * persists on the `tool/result` event and the Web client receives as the
 * result block's `meta`. The client never parses model-facing text to draw a
 * card; it renders this shape, and falls back to the raw result when absent.
 *
 * @module xrxs-dsh-android-publish/card
 */

/** Card tone; the client maps it to a theme token. */
export type CardState = 'running' | 'ok' | 'failed' | 'warn' | 'info'

/** One pipeline step's lifecycle. */
export type CardStepState = 'done' | 'active' | 'pending' | 'failed' | 'skipped'

/** One target store's outcome. */
export type CardStoreState = 'success' | 'failed' | 'skipped' | 'pending'

/** One target store, with the reason its outcome is what it is. */
export type CardStore = { id: string; name: string; state: CardStoreState; detail?: string }

/**
 * The whole card. A plain object type (not an interface) so it satisfies the
 * `JsonValue` index signature `presentationMeta` returns.
 */
export type ReleaseCard = {
  /** Wire format version; the client refuses unknown versions. */
  v: 1
  title: string
  subtitle?: string
  state: CardState
  badge?: string
  facts?: { label: string; value: string }[]
  steps?: { label: string; state: CardStepState }[]
  stores?: CardStore[]
  warnings?: string[]
  notes?: string[]
  /** Bounded, already-redacted tail of the child process output. */
  outputTail?: string
}

/** Human names for the five supported stores. */
export const STORE_NAMES: Record<string, string> = {
  yyb: '应用宝',
  xiaomi: '小米',
  huawei: '华为',
  oppo: 'OPPO',
  vivo: 'vivo',
}

/** Display name for one store id. */
export function storeName(id: string): string {
  return STORE_NAMES[id] ?? id
}

/** Human label for a publish mode. */
export function modeLabel(mode: string): string {
  return mode === 'submit' ? '生产提审' : '仅打包 (dry-run)'
}

/** Slash-joined display names, order preserved. */
export function storeNames(ids: readonly string[]): string {
  return ids.map(storeName).join(' / ')
}

const STEP_GLYPH: Record<CardStepState, string> = {
  done: '✓',
  active: '▸',
  pending: '·',
  failed: '✗',
  skipped: '–',
}

const STORE_LABEL: Record<CardStoreState, string> = {
  success: '成功',
  failed: '失败',
  skipped: '跳过',
  pending: '待定',
}

/** Model-facing text for one card; also the client's fallback body. */
export function renderCardText(card: ReleaseCard): string {
  const lines: string[] = []
  lines.push(`${card.badge ? `【${card.badge}】` : ''}${card.title}${card.subtitle ? ` — ${card.subtitle}` : ''}`)
  for (const fact of card.facts ?? []) lines.push(`${fact.label}: ${fact.value}`)
  if (card.steps?.length) {
    lines.push(`流程: ${card.steps.map(step => `${STEP_GLYPH[step.state]}${step.label}`).join(' → ')}`)
  }
  if (card.stores?.length) {
    lines.push(`渠道: ${card.stores
      .map(store => `${store.name} ${STORE_LABEL[store.state]}${store.detail ? `（${store.detail}）` : ''}`)
      .join(' · ')}`)
  }
  if (card.warnings?.length) {
    lines.push('警告:')
    for (const warning of card.warnings) lines.push(`- ${warning}`)
  }
  for (const note of card.notes ?? []) lines.push(note)
  if (card.outputTail?.trim()) {
    lines.push('', '输出尾部:')
    lines.push(card.outputTail.trimEnd())
  }
  return lines.join('\n')
}

/** Marker lines are meta-channel traffic; keep them out of card text. */
export function stripMarkers(text: string, prefixes: readonly string[]): string {
  return text
    .split('\n')
    .filter(line => !prefixes.some(prefix => line.startsWith(prefix)))
    .join('\n')
}

/** Last `limit` characters of a text, on a line boundary when possible. */
export function tail(text: string, limit = 2000): string {
  const trimmed = text.trimEnd()
  if (trimmed.length <= limit) return trimmed
  const sliced = trimmed.slice(trimmed.length - limit)
  const newline = sliced.indexOf('\n')
  return newline === -1 ? sliced : sliced.slice(newline + 1)
}

/** Parse the most recent `@@...RESULT@@` payload in a job output tail. */
export function parseResultMarker(
  text: string,
  prefix: string,
): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue
    try {
      const parsed = JSON.parse(line.slice(prefix.length).trim()) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        found = parsed as Record<string, unknown>
      }
    } catch {
      // Ignore a malformed or truncated marker line.
    }
  }
  return found
}

/** Parse the most recent `@@...PROGRESS@@` payload in a job output tail. */
export function parseProgressMarker(
  text: string,
  prefix: string,
): { step: string; message: string } | null {
  let found: { step: string; message: string } | null = null
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue
    try {
      const parsed = JSON.parse(line.slice(prefix.length).trim()) as {
        step?: unknown
        message?: unknown
      }
      if (typeof parsed.step === 'string' && parsed.step !== '') {
        found = { step: parsed.step, message: typeof parsed.message === 'string' ? parsed.message : '' }
      }
    } catch {
      // Ignore a malformed or truncated marker line.
    }
  }
  return found
}

/** Build the planned pipeline steps for one request. */
export function planSteps(request: {
  willBuild: boolean
  willUploadBugly: boolean
  willHarden: boolean
  willGitTag: boolean
}): { label: string; state: CardStepState }[] {
  return [
    { label: '预检', state: 'pending' },
    { label: '打包', state: request.willBuild ? 'pending' : 'skipped' },
    { label: 'Bugly 符号表', state: request.willUploadBugly ? 'pending' : 'skipped' },
    { label: '360 加固', state: request.willHarden ? 'pending' : 'skipped' },
    { label: '提审', state: 'pending' },
    { label: 'Git tag', state: request.willGitTag ? 'pending' : 'skipped' },
  ]
}