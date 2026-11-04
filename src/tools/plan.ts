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
      '为 Android 打包或生产提审生成确定性的发布计划。会校验 profile 策略、渠道、路径与凭据配置，但不执行任何操作。',
    parameters: {
      profileId: { type: 'string', required: true, description: '发布 profile id。' },
      stores: {
        type: 'array',
        required: true,
        items: { type: 'string', enum: STORES },
        description: '显式指定目标商店；不允许使用 "all"。',
      },
      updateDesc: { type: 'string', required: true, description: '更新说明（1-300 字）。' },
      onlineTime: { type: 'string', description: '可选，定时上架时间，格式 YYYY-MM-DD HH:MM:SS，时区 Asia/Shanghai。华为不支持该参数。' },
      hardenedApkPath: { type: 'string', description: '可选，已加固 APK 的绝对路径；必须位于 projectRoot 之下。' },
      mode: { type: 'string', required: true, enum: ['packageOnly', 'submit'], description: 'packageOnly = 仅打包（dry-run）；submit = 生产提审（需 profile 策略允许）。' },
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
        warnings.push('华为不支持通过 API 定时上架；请在 AGC 控制台手动设置上架时间。')
      }
      if (request.mode === 'packageOnly') {
        const skipped = packageOnlySkippedStores(request.stores)
        if (skipped.length) {
          warnings.push(`${skipped.join(', ')} 不支持 dry-run；packageOnly 模式下会跳过（只有应用宝支持只上传不提审）。`)
        }
      }
      if (request.profile.hardeningMode === 'optional' && request.willHarden) {
        warnings.push('hardeningMode=optional：仅当 JIAGU_* 凭据与 JIAGU_HOME 都配置时才执行加固。')
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
