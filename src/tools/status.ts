/**
 * android_publish_status: non-consuming status for a plugin-owned job.
 *
 * @module xrxs-dsh-android-publish/tools/status
 */

import { JobId } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  parseProgressMarker,
  parseResultMarker,
  renderCardText,
  storeName,
  stripMarkers,
  tail,
  type CardState,
  type CardStore,
  type ReleaseCard,
} from '../card.ts'
import { PROGRESS_PREFIX, RESULT_PREFIX } from '../runner.ts'
import { toolError, type PluginRuntime } from '../runtime.ts'

/** Job lifecycle to card tone. */
function cardState(status: string): CardState {
  if (status === 'completed') return 'ok'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'warn'
  return 'running'
}

/** Job lifecycle to a short badge. */
function badgeOf(status: string): string {
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'killed') return '已取消'
  if (status === 'stopping') return '取消中'
  return '运行中'
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** Store outcomes carried by the child's structured result. */
function storeOutcomes(result: Record<string, unknown> | null): CardStore[] {
  if (result === null) return []
  const list = (key: string): string[] =>
    Array.isArray(result[key]) ? (result[key] as unknown[]).map(String) : []
  const outcome = new Map<string, { state: CardStore['state']; detail?: string }>()
  for (const id of list('success')) outcome.set(id, { state: 'success' })
  for (const id of list('failed')) outcome.set(id, { state: 'failed', detail: '提审失败' })
  for (const id of list('skipped')) outcome.set(id, { state: 'skipped', detail: 'dry-run 跳过' })
  return [...outcome.entries()].map(([id, value]) => ({
    id,
    name: storeName(id),
    state: value.state,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  }))
}

export function registerStatusTool(runtime: PluginRuntime) {
  return defineTool({
    name: 'android_publish_status',
    description:
      '读取 Android 发布后台任务的状态与脱敏输出。非消费式读取，可反复调用。',
    parameters: {
      jobId: { type: 'string', required: true, description: 'android_publish_start 返回的任务 id。' },
      fromByte: { type: 'integer', description: '输出流读取偏移量；默认 0。' },
      maxBytes: { type: 'integer', description: '本次最多返回的字节数；受插件 outputMaxBytes 限制。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: renderCardText((value as unknown as { card: ReleaseCard }).card),
      }],
      presentationMeta: (_args, value) => (value as unknown as { card: ReleaseCard }).card,
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: `查询发布任务状态 (${String(args.jobId)})`,
      kind: 'read' as const,
    }),
    async execute(args, exec) {
      const { ctx, config } = runtime
      const sessionId = exec.agent?.id
      const view = ctx.jobs.get(JobId(args.jobId), sessionId)
      if (!view) toolError(`job "${args.jobId}" not found or not visible to this session`)

      const from = args.fromByte ?? 0
      const read = ctx.jobs.readAt(JobId(args.jobId), from, sessionId)
      const redactor = (await import('../redact.ts')).nullRedactor
      const budget = Math.min(args.maxBytes ?? config.outputMaxBytes, config.outputMaxBytes)
      let text = read.chunks.map(chunk => chunk.text).join('')
      if (text.length > budget) text = text.slice(-budget)

      const output = redactor.redact(text)
      const result = parseResultMarker(output, RESULT_PREFIX)
      const progress = parseProgressMarker(output, PROGRESS_PREFIX)
      const stores = storeOutcomes(result)
      const duration = view.finishedAt === undefined ? null : view.finishedAt - view.startedAt

      const facts = [
        { label: '任务 ID', value: view.id },
        { label: '状态', value: view.status },
        ...(progress === null ? [] : [{ label: '当前步骤', value: progress.message || progress.step }]),
        { label: '开始时间', value: formatTime(view.startedAt) },
        ...(duration === null ? [] : [{ label: '耗时', value: `${Math.round(duration / 1000)} 秒` }]),
        { label: '日志字节', value: `${String(read.next)} / ${String(view.output.total)}` },
      ]

      const card: ReleaseCard = {
        v: 1,
        title: 'Android 发布状态',
        subtitle: view.label,
        state: cardState(view.status),
        badge: badgeOf(view.status),
        facts,
        ...(stores.length === 0 ? {} : { stores }),
        outputTail: tail(stripMarkers(output, [RESULT_PREFIX, PROGRESS_PREFIX]), 1500),
        ...(read.lossy ? { notes: ['日志头部已被环形缓冲丢弃；用 fromByte 从更早偏移读取。'] } : {}),
      }

      return {
        jobId: view.id,
        kind: view.kind,
        label: view.label,
        status: view.status,
        progress: view.progress ?? null,
        detail: view.detail ?? null,
        startedAt: view.startedAt,
        finishedAt: view.finishedAt ?? null,
        nextByte: read.next,
        lossy: read.lossy,
        stores,
        output,
        card,
      }
    },
  })
}