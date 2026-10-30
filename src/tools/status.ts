/**
 * android_publish_status: non-consuming status for a plugin-owned job.
 *
 * @module xrxs-dsh-android-publish/tools/status
 */

import { JobId } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolError, type PluginRuntime } from '../runtime.ts'

export function registerStatusTool(runtime: PluginRuntime) {
  return defineTool({
    name: 'android_publish_status',
    description:
      'Read non-consuming status and redacted output for an Android publish background job. Safe to call repeatedly.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'Job id returned by android_publish_start.' },
      fromByte: { type: 'integer', description: 'Output stream offset to resume from; defaults to 0.' },
      maxBytes: { type: 'integer', description: 'Maximum output bytes to return; bounded by plugin outputMaxBytes.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
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
        output: redactor.redact(text),
      }
    },
  })
}
