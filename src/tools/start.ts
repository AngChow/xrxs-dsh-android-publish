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
      'Start a package-only or production Android release as a background job. Production submission requires a successful preflight and explicit human approval; on refusal nothing starts.',
    parameters: {
      profileId: { type: 'string', required: true, description: 'Release profile id.' },
      stores: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: STORES },
        description: 'Explicit target stores; "all" is never allowed.',
      },
      updateDesc: { type: 'string', required: true, description: 'Release notes (1-300 chars).' },
      onlineTime: { type: 'string', description: 'Optional scheduled publish time, YYYY-MM-DD HH:MM:SS, Asia/Shanghai.' },
      hardenedApkPath: { type: 'string', description: 'Optional absolute path to an already-hardened APK under projectRoot.' },
      mode: { type: 'string', required: true, enum: ['packageOnly', 'submit'], description: 'packageOnly = dry-run; submit = production submission.' },
      acknowledgeSlowOperation: { type: 'boolean', description: 'Advisory acknowledgement of a slow operation; never bypasses approval.' },
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
          intent: isSubmit
            ? { kind: 'approval', approve: approveLabel, reject: REJECT_LABEL }
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
