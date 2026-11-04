/**
 * android_publish_start: approval-gated background release execution.
 *
 * @module xrxs-dsh-android-publish/tools/start
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-user-questions'
import { appendAudit } from '../audit.ts'
import { resolveEnv, secretEnvKeys } from '../env.ts'
import { createRedactor } from '../redact.ts'
import { runThroughRunner, startRunnerJob } from '../runner.ts'
import {
  buildChildArgv,
  normalizeRequest,
  optionalEnvKeys,
  renderMarkdownPlan,
  requiredEnvKeys,
  newPlanId,
} from '../request.ts'
import { runtimeDirFor, toolError, type PluginRuntime } from '../runtime.ts'

const STORES = ['yyb', 'xiaomi', 'huawei', 'oppo', 'vivo'] as const
const APPROVE_LABEL = '确认提交生产'
const PROCEED_LABEL = '确认执行'
const REJECT_LABEL = '取消'

export function registerStartTool(runtime: PluginRuntime) {
  return defineTool({
    name: 'android_publish_start',
    description:
      '以后台任务方式启动打包或生产提审。生产提审要求预检通过并获得人工明确批准；若拒绝则不会启动任何操作。',
    parameters: {
      profileId: { type: 'string', required: true, description: '发布 profile id。' },
      stores: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: STORES },
        description: '显式指定目标商店；不允许使用 "all"。',
      },
      updateDesc: { type: 'string', required: true, description: '更新说明（1-300 字）。' },
      onlineTime: { type: 'string', description: '可选，定时上架时间，格式 YYYY-MM-DD HH:MM:SS，时区 Asia/Shanghai。' },
      hardenedApkPath: { type: 'string', description: '可选，已加固 APK 的绝对路径；必须位于 projectRoot 之下。' },
      mode: { type: 'string', required: true, enum: ['packageOnly', 'submit'], description: 'packageOnly = 仅打包（dry-run）；submit = 生产提审。' },
      acknowledgeSlowOperation: { type: 'boolean', description: '对耗时操作的确认项；不会绕过审批。' },
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
      title: `启动发布任务 (${String(args.profileId)}, ${String(args.mode)})`,
      kind: 'other' as const,
    }),
    async execute(args, exec) {
      const { ctx, config } = runtime
      const request = await normalizeRequest(runtime, {
        profileId: args.profileId,
        stores: args.stores as never,
        updateDesc: args.updateDesc,
        onlineTime: args.onlineTime,
        hardenedApkPath: args.hardenedApkPath,
        mode: args.mode as never,
      })
      const profile = request.profile
      const auditDir = runtimeDirFor(runtime, profile)
      const planId = newPlanId()

      // Active-run lock keyed by canonical projectRoot.
      if (runtime.activeRuns.has(request.projectRoot)) {
        toolError(`a release run is already active for ${request.projectRoot} (job ${runtime.activeRuns.get(request.projectRoot)})`)
      }

      // Resolve credentials fresh for this operation.
      const required = requiredEnvKeys(request)
      const optional = optionalEnvKeys(request)
      const resolution = await resolveEnv(ctx, profile, [...required, ...optional], {
        enforceManagedSource: request.mode === 'submit' && profile.requireManagedCredentialSource,
      })
      const blocking = resolution.issues.filter(issue => {
        return !optional.some(key => issue.startsWith(key)) && !/optional credential/.test(issue)
      })
      if (blocking.length) {
        toolError(`cannot start: ${blocking.join('; ')}`)
      }
      if (request.willHarden && profile.hardeningMode === 'required' && !resolution.env.JIAGU_HOME) {
        toolError('hardeningMode=required but JIAGU_HOME is not configured in plainEnv')
      }

      const redactor = createRedactor(resolution.secretValues)
      const warnings = [...resolution.warnings]

      // Preflight always runs before approval.
      const preflight = await runThroughRunner(ctx, {
        childArgv: [path.join('pre_check.py'), request.projectRoot],
        pythonExecutable: config.pythonExecutable,
        label: `preflight-${planId}`,
        logDir: path.join(auditDir, 'logs'),
        cwd: request.projectRoot,
        env: resolution.env,
        redactKeys: secretEnvKeys(resolution),
        maxBytes: config.outputMaxBytes,
        timeoutMs: config.processTimeoutMs,
        signal: exec.signal,
      }, redactor)
      if (runtime.config.auditEnabled) {
        void appendAudit(auditDir, {
          event: 'preflight',
          sessionId: exec.agent?.id,
          callId: exec.callId,
          profileId: profile.id,
          projectRoot: request.projectRoot,
          mode: request.mode,
          stores: [...request.stores],
          exitCode: preflight.exitCode,
        })
      }
      if (preflight.exitCode !== 0) {
        toolError(`preflight failed (exit ${preflight.exitCode}); no approval will be requested`)
      }

      // Human approval.
      const isSubmit = request.mode === 'submit'
      const approveLabel = isSubmit ? APPROVE_LABEL : PROCEED_LABEL
      if (!exec.agent) toolError('no agent context available to ask the user for approval')
      const answer = await ctx.userQuestions.ask({
        agent: exec.agent,
        signal: exec.signal,
        questions: [{
          id: 'production-submit',
          header: isSubmit ? '生产发布确认' : '打包任务确认',
          question: isSubmit
            ? '确认将当前构建提交到生产应用市场吗？'
            : '确认开始打包任务吗？（应用宝 dry-run 会上传但不提审）',
          detail: renderMarkdownPlan(request, warnings),
          options: [{ label: approveLabel }, { label: REJECT_LABEL }],
          // `plan-review` is the only intent kind understood by both 0.2.1-rc.5 and
          // 0.2.2-alpha.2 (`approval` was introduced in 0.2.2). The verdict stays
          // fail-closed either way: only the approve label grants, everything else
          // (including no selection) is treated as a refusal.
          intent: isSubmit
            ? { kind: 'plan-review', approve: approveLabel }
            : undefined,
        }],
      })
      const approved = answer.answers[0]?.selected.includes(approveLabel) === true
      if (!approved) {
        if (config.auditEnabled) {
          void appendAudit(auditDir, {
            event: 'approval_denied',
            sessionId: exec.agent?.id,
            callId: exec.callId,
            profileId: profile.id,
            projectRoot: request.projectRoot,
            mode: request.mode,
            stores: [...request.stores],
            approval: 'denied',
          })
        }
        return {
          ok: true,
          approved: false,
          jobId: null,
          planId,
          profileId: profile.id,
          mode: request.mode,
          stores: [...request.stores],
          status: null,
          reason: 'user_rejected',
          willGitTag: request.willGitTag,
          warnings,
        }
      }

      // Build job spawn options; policy flags are derived, never model-supplied.
      const childArgv = buildChildArgv(request)
      const jobId = startRunnerJob({
        ctx,
        owner: exec.agent?.id,
        label: `Android ${request.mode}: ${profile.id} -> ${request.stores.join(', ')}`,
        redactor,
        spawn: {
          childArgv,
          pythonExecutable: config.pythonExecutable,
          label: planId,
          logDir: path.join(auditDir, 'logs'),
          cwd: request.projectRoot,
          env: resolution.env,
          redactKeys: secretEnvKeys(resolution),
          maxBytes: config.outputMaxBytes,
          timeoutMs: config.processTimeoutMs,
          signal: exec.signal,
        },
        onSettled: outcome => {
          runtime.activeRuns.delete(request.projectRoot)
          if (config.auditEnabled) {
            void appendAudit(auditDir, {
              event: outcome.status === 'completed' ? 'complete' : outcome.status === 'killed' ? 'cancelled' : 'failed',
              sessionId: exec.agent?.id,
              callId: exec.callId,
              profileId: profile.id,
              projectRoot: request.projectRoot,
              mode: request.mode,
              stores: [...request.stores],
              approval: 'granted',
              jobId,
              detail: outcome.detail,
            })
          }
        },
      })
      runtime.activeRuns.set(request.projectRoot, jobId)

      if (config.auditEnabled) {
        void appendAudit(auditDir, {
          event: 'start',
          sessionId: exec.agent?.id,
          callId: exec.callId,
          profileId: profile.id,
          projectRoot: request.projectRoot,
          mode: request.mode,
          stores: [...request.stores],
          approval: 'granted',
          jobId,
        })
      }

      return {
        ok: true,
        approved: true,
        jobId,
        planId,
        profileId: profile.id,
        mode: request.mode,
        stores: [...request.stores],
        status: 'running',
        reason: null,
        willGitTag: request.willGitTag,
        warnings,
      }
    },
  })
}
