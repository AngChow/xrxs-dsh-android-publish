/**
 * android_publish_plan: deterministic human/machine-readable release plan.
 *
 * @module xrxs-dsh-android-publish/tools/plan
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeRequest, newPlanId, packageOnlySkippedStores, packageNames } from '../request.ts'
import type { PluginRuntime } from '../runtime.ts'

const STORES = ['yyb', 'xiaomi', 'huawei', 'oppo', 'vivo'] as const

export function registerPlanTool(runtime: PluginRuntime) {
  return defineTool({
    name: 'android_publish_plan',
    description:
      'Build a deterministic release plan for Android packaging or production submission. Validates profile policy, stores, paths, and credential configuration. Does not execute anything.',
    parameters: {
      profileId: { type: 'string', required: true, description: 'Release profile id.' },
      stores: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: STORES },
        description: 'Explicit target stores; "all" is never allowed.',
      },
      updateDesc: { type: 'string', required: true, description: 'Release notes (1-300 chars).' },
      onlineTime: { type: 'string', description: 'Optional scheduled publish time, YYYY-MM-DD HH:MM:SS, Asia/Shanghai. Huawei does not support it.' },
      hardenedApkPath: { type: 'string', description: 'Optional absolute path to an already-hardened APK; must be under projectRoot.' },
      mode: { type: 'string', required: true, enum: ['packageOnly', 'submit'], description: 'packageOnly = dry-run packaging; submit = production submission (requires profile policy).' },
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
      title: `生成发布计划 (${String(args.profileId)}, ${String(args.mode)})`,
      kind: 'read' as const,
    }),
    async execute(args) {
      const request = await normalizeRequest(runtime, {
        profileId: args.profileId,
        stores: args.stores as never,
        updateDesc: args.updateDesc,
        onlineTime: args.onlineTime,
        hardenedApkPath: args.hardenedApkPath,
        mode: args.mode as never,
      })

      const warnings: string[] = []
      if (request.onlineTime && request.stores.includes('huawei')) {
        warnings.push('Huawei does not support API scheduled online time; set it manually in AGC console.')
      }
      if (request.mode === 'packageOnly') {
        const skipped = packageOnlySkippedStores(request.stores)
        if (skipped.length) {
          warnings.push(`${skipped.join(', ')} cannot dry-run; they will be skipped in packageOnly mode (only YingYongBao uploads without submitting).`)
        }
      }
      if (request.profile.hardeningMode === 'optional' && request.willHarden) {
        warnings.push('hardeningMode=optional: hardening runs only when JIAGU_* credentials and JIAGU_HOME are configured.')
      }

      // Credential preview: configured state only, never values.
      const { describeCredentialPreview } = await import('../env.ts')
      const preview = await describeCredentialPreview(runtime.ctx, request.profile)

      return {
        ok: true,
        planId: newPlanId(),
        profileId: request.profile.id,
        projectRoot: request.projectRoot,
        mode: request.mode,
        stores: [...request.stores],
        storePackageNames: packageNames(request),
        updateDesc: request.updateDesc,
        onlineTime: request.onlineTime,
        hardenedApkPath: request.hardenedApkPath,
        willBuild: request.willBuild,
        willUploadBugly: request.willUploadBugly,
        willHarden: request.willHarden,
        willGitTag: request.willGitTag,
        warnings,
        credentialPreview: preview,
      }
    },
  })
}
