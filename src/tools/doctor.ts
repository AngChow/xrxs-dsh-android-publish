/**
 * android_publish_doctor: diagnose runtime and credential configuration.
 *
 * @module xrxs-dsh-android-publish/tools/doctor
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { getProfile, PATH_LIKE_ENV_KEYS } from '../config.ts'
import { profileCredentialKeys } from '../env.ts'
import { runQuick } from '../runner.ts'
import { canonicalize } from '../paths.ts'
import { toolError, type PluginRuntime } from '../runtime.ts'

const STORES = ['yyb', 'xiaomi', 'huawei', 'oppo', 'vivo'] as const

export function registerDoctorTool(runtime: PluginRuntime) {
  return defineTool({
    name: 'android_publish_doctor',
    description:
      'Check Python, Python dependencies, Java, Gradle wrapper, Android build tools, and configured credential references for an Android publish profile. Returns configuration state only; never credential values.',
    parameters: {
      profileId: { type: 'string', required: true, description: 'Release profile id.' },
      stores: {
        type: 'array',
        items: { type: 'string', enum: STORES },
        description: 'Optional store subset to report credentials for; defaults to all configured stores.',
      },
      networkProbe: {
        type: 'boolean',
        description: 'Run pre_check.py against store APIs. Defaults to false; consumes store API quota.',
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
      title: `检查 Android 发布环境 (${String(args.profileId)})`,
      kind: 'read' as const,
    }),
    async execute(args, exec) {
      const profile = getProfile(runtime.config, args.profileId)
      if (!existsSync(profile.projectRoot)) {
        toolError(`projectRoot "${profile.projectRoot}" does not exist`)
      }
      const projectRoot = await canonicalize(profile.projectRoot)
      const issues: string[] = []
      const warnings: string[] = []
      const { ctx } = runtime
      const spawnOpts = { timeoutMs: 30_000, env: {} as Record<string, string> }

      // Gradle wrapper.
      const gradleOk = existsSync(path.join(projectRoot, 'gradlew'))
      if (!gradleOk) issues.push(`gradlew not found under ${projectRoot}`)

      // Python.
      const py = await runQuick(ctx, [runtime.config.pythonExecutable, '--version'], spawnOpts)
      const pythonVersion = py.stdout.trim() || py.stderr.trim()
      const deps = await runQuick(ctx, [runtime.config.pythonExecutable, '-c',
        'import requests, Crypto, cryptography; print("python-deps-ok")'], spawnOpts)
      const depsOk = deps.exitCode === 0 && deps.stdout.includes('python-deps-ok')
      if (py.exitCode !== 0) issues.push(`python3 not runnable: ${pythonVersion}`)
      if (!depsOk) issues.push('python deps missing: requests / pycryptodome / cryptography (see resources/requirements.txt)')

      // Java.
      const java = await runQuick(ctx, ['java', '-version'], spawnOpts)
      const javaOk = java.exitCode === 0
      if (!javaOk) warnings.push('java not found on PATH; Gradle builds will fail unless JAVA_HOME is configured')

      // Android build tools.
      let buildToolsOk = false
      const btDir = profile.plainEnv.ANDROID_BUILD_TOOLS
      if (btDir) {
        buildToolsOk = ['aapt', 'zipalign', 'apksigner'].every(bin =>
          existsSync(path.join(btDir, bin)) || existsSync(path.join(btDir, `${bin}.exe`)))
        if (!buildToolsOk) warnings.push(`ANDROID_BUILD_TOOLS (${btDir}) is missing aapt/zipalign/apksigner`)
      } else {
        warnings.push('ANDROID_BUILD_TOOLS not configured in plainEnv; zipalign/apksigner steps may fail')
      }

      // Credential state (describe only; never resolve for doctor).
      const stores = args.stores?.length
        ? args.stores.filter(s => profile.allowedStores.includes(s as never))
        : [...profile.allowedStores]
      const requiredKeys = new Set<string>()
      const storeReq: Record<string, string[]> = {
        yyb: ['YYB_USER_ID', 'YYB_ACCESS_SECRET', 'YYB_APP_ID'],
        xiaomi: ['MI_USER_NAME', 'MI_PRIVATE_KEY'],
        huawei: ['HW_CLIENT_ID', 'HW_CLIENT_SECRET', 'HW_APP_ID'],
        oppo: ['OPPO_CLIENT_ID', 'OPPO_CLIENT_SECRET'],
        vivo: ['VIVO_ACCESS_KEY', 'VIVO_ACCESS_SECRET'],
      }
      for (const store of stores) {
        for (const key of storeReq[store] ?? []) requiredKeys.add(key)
      }
      const credentials = []
      for (const envKey of profileCredentialKeys(profile)) {
        const refName = profile.credentialRefs[envKey] ?? ''
        const info = await ctx.credentials.describe(credentialRef(refName))
        credentials.push({
          envKey,
          credentialRef: refName ?? '',
          configured: info.configured,
          source: info.source ?? null,
          writable: info.writable,
          requiredForSelection: requiredKeys.has(envKey),
        })
        if (requiredKeys.has(envKey) && !info.configured) {
          issues.push(`required credential ${envKey} (ref ${refName ?? '?'}) is not configured`)
        }
      }

      // Path checks for path-like plainEnv values.
      for (const [key, value] of Object.entries(profile.plainEnv)) {
        if (!PATH_LIKE_ENV_KEYS.has(key)) continue
        if (!existsSync(value)) warnings.push(`${key} path does not exist: ${value}`)
      }

      // Optional network probe: real pre_check.py through the runner.
      let preflight: Record<string, string | number | boolean | null> | null = null
      if (args.networkProbe) {
        const { runThroughRunner } = await import('../runner.ts')
        const { resolveEnv, secretEnvKeys } = await import('../env.ts')
        const { createRedactor } = await import('../redact.ts')
        const required = [...requiredKeys]
        const resolution = await resolveEnv(ctx, profile, required, { enforceManagedSource: false })
        issues.push(...resolution.issues)
        warnings.push(...resolution.warnings)
        const redactor = createRedactor(resolution.secretValues)
        const result = await runThroughRunner(runtime.ctx, {
          childArgv: [path.join('pre_check.py'), projectRoot],
          pythonExecutable: runtime.config.pythonExecutable,
          label: 'doctor-precheck',
          logDir: path.join(runtime.defaultRuntimeDir, profile.id, 'logs'),
          cwd: projectRoot,
          env: resolution.env,
          redactKeys: secretEnvKeys(resolution),
          maxBytes: runtime.config.outputMaxBytes,
          timeoutMs: 120_000,
          signal: exec.signal,
        }, redactor)
        preflight = { exitCode: result.exitCode, parsed: result.result ? 'yes' : 'no' }
        if (result.exitCode !== 0) warnings.push('network preflight reported problems; see its output')
      }

      const ok = issues.length === 0
      return {
        ok,
        profileId: profile.id,
        platform: process.platform,
        python: { ok: py.exitCode === 0, version: pythonVersion, dependencies: depsOk },
        java: { ok: javaOk },
        gradle: { ok: gradleOk },
        androidBuildTools: { ok: buildToolsOk },
        credentials,
        preflight,
        issues,
        warnings,
      }
    },
  })
}
