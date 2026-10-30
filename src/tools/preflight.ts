/**
 * android_publish_preflight: run pre_check.py with resolved credentials.
 *
 * @module xrxs-dsh-android-publish/tools/preflight
 */

import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getProfile } from '../config.ts'
import { resolveEnv, secretEnvKeys } from '../env.ts'
import { createRedactor } from '../redact.ts'
import { runThroughRunner } from '../runner.ts'
import { canonicalize } from '../paths.ts'
import { appendAudit } from '../audit.ts'
import { runtimeDirFor, toolError, type PluginRuntime } from '../runtime.ts'
import { requiredEnvKeys, optionalEnvKeys } from '../request.ts'

const STORES = ['yyb', 'xiaomi', 'huawei', 'oppo', 'vivo'] as const

export function registerPreflightTool(runtime: PluginRuntime) {
  return defineTool({
    name: 'android_publish_preflight',
    description:
      'Run signing/version preflight checks (pre_check.py) for the selected stores with resolved credentials. Never builds or submits. Output is redacted and bounded.',
    parameters: {
      profileId: { type: 'string', required: true, description: 'Release profile id.' },
      stores: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: STORES },
        description: 'Explicit target stores used to select which credentials are required.',
      },
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
      title: `发布预检查 (${String(args.profileId)})`,
      kind: 'read' as const,
    }),
    async execute(args, exec) {
      const profile = getProfile(runtime.config, args.profileId)
      const projectRoot = await canonicalize(profile.projectRoot)
      const required = requiredEnvKeys({ stores: args.stores } as never)
      const optional = optionalEnvKeys({ stores: args.stores } as never)
      const resolution = await resolveEnv(runtime.ctx, profile, [...required, ...optional], {
        enforceManagedSource: false,
      })
      const blocking = resolution.issues.filter(issue => !optional.some(key => issue.startsWith(key)))
      if (blocking.length) toolError(`preflight cannot run: ${blocking.join('; ')}`)

      const redactor = createRedactor(resolution.secretValues)
      const result = await runThroughRunner(runtime.ctx, {
        childArgv: [path.join('pre_check.py'), projectRoot],
        pythonExecutable: runtime.config.pythonExecutable,
        label: 'preflight',
        logDir: path.join(runtimeDirFor(runtime, profile), 'logs'),
        cwd: projectRoot,
        env: resolution.env,
        redactKeys: secretEnvKeys(resolution),
        maxBytes: runtime.config.outputMaxBytes,
        timeoutMs: runtime.config.processTimeoutMs,
        signal: exec.signal,
      }, redactor)

      if (runtime.config.auditEnabled) {
        void appendAudit(runtimeDirFor(runtime, profile), {
          event: 'preflight',
          sessionId: exec.agent?.id,
          callId: exec.callId,
          profileId: profile.id,
          projectRoot,
          mode: 'preflight',
          stores: args.stores,
          exitCode: result.exitCode,
        })
      }

      const ok = result.exitCode === 0
      return {
        ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputTail: result.outputTail,
        issues: ok ? [] : [`preflight exited with code ${result.exitCode}`],
        warnings: resolution.warnings,
      }
    },
  })
}
