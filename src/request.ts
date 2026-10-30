/**
 * Shared request normalization and validation for plan / start.
 *
 * @module xrxs-dsh-android-publish/request
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  getProfile,
  storePackageName,
  type AndroidStore,
  type ResolvedProfile,
} from './config.ts'
import { canonicalize, isInside, requireAbsolute } from './paths.ts'
import { requiredKeysFor } from './env.ts'
import { toolError, type PluginRuntime } from './runtime.ts'

export type PublishMode = 'packageOnly' | 'submit'

export interface PublishRequest {
  readonly profile: ResolvedProfile
  readonly projectRoot: string
  readonly mode: PublishMode
  readonly stores: readonly AndroidStore[]
  readonly updateDesc: string
  readonly onlineTime: string | null
  readonly hardenedApkPath: string | null
  readonly willBuild: boolean
  readonly willUploadBugly: boolean
  readonly willHarden: boolean
  readonly willGitTag: boolean
  readonly needBuglyCredentials: boolean
  readonly needJiaguCredentials: boolean
}

export interface PublishRequestInput {
  profileId: string
  stores: AndroidStore[]
  updateDesc: string
  onlineTime?: string
  hardenedApkPath?: string
  mode: PublishMode
  acknowledgeSlowOperation?: boolean
}

const ONLINE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** Create a readable plan id: ap-YYYYMMDD-HHmm-<6 hex>. */
export function newPlanId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `ap-${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * Validate and normalize a publish request against profile policy.
 * Throws model-facing errors; performs path canonicalization.
 */
export async function normalizeRequest(
  runtime: PluginRuntime,
  input: PublishRequestInput,
): Promise<PublishRequest> {
  const profile = getProfile(runtime.config, input.profileId)

  // Stores: explicit only, never `all`.
  const stores = [...new Set(input.stores ?? [])]
  if (stores.length === 0) toolError('stores must list at least one explicit store; "all" is not allowed')
  for (const store of stores) {
    if (!profile.allowedStores.includes(store)) {
      toolError(`store "${store}" is not in profile "${profile.id}" allowedStores [${profile.allowedStores.join(', ')}]`)
    }
  }

  // Mode policy.
  const mode = input.mode
  if (mode === 'submit' && !profile.allowProductionSubmit) {
    toolError(`profile "${profile.id}" does not allow production submission (allowProductionSubmit is false)`)
  }
  if (mode === 'submit' && process.platform !== 'darwin') {
    toolError('Production Android submission is currently supported only on macOS')
  }

  // updateDesc.
  const updateDesc = (input.updateDesc ?? '').trim()
  if (!updateDesc) toolError('updateDesc must be a non-empty string')
  if (updateDesc.length > 300) toolError(`updateDesc must be at most 300 characters; got ${updateDesc.length}`)

  // onlineTime.
  let onlineTime: string | null = null
  if (input.onlineTime !== undefined && input.onlineTime !== null) {
    if (!ONLINE_TIME_PATTERN.test(input.onlineTime)) {
      toolError('onlineTime must match YYYY-MM-DD HH:MM:SS (Asia/Shanghai)')
    }
    onlineTime = input.onlineTime
  }

  // hardenedApkPath: absolute, canonical, under projectRoot.
  let hardenedApkPath: string | null = null
  if (input.hardenedApkPath) {
    requireAbsolute(input.hardenedApkPath, 'hardenedApkPath')
    hardenedApkPath = await canonicalize(input.hardenedApkPath)
  }

  // projectRoot: must exist, be a directory, and match the canonical profile root.
  if (!existsSync(profile.projectRoot) || !statSync(profile.projectRoot).isDirectory()) {
    toolError(`projectRoot "${profile.projectRoot}" does not exist or is not a directory`)
  }
  const projectRoot = await canonicalize(profile.projectRoot)
  if (hardenedApkPath && !isInside(projectRoot, hardenedApkPath)) {
    toolError(`hardenedApkPath must reside under projectRoot (${projectRoot})`)
  }
  if (!existsSync(path.join(projectRoot, 'gradlew'))) {
    toolError(`gradlew not found under ${projectRoot}`)
  }

  // Hardening policy.
  const hardeningMode = profile.hardeningMode
  if (hardeningMode === 'disabled' && mode === 'submit' && !profile.allowUnhardenedSubmit) {
    toolError('hardeningMode is disabled but allowUnhardenedSubmit is false; unhardened submission is not allowed')
  }
  const willHarden = hardeningMode !== 'disabled' && hardenedApkPath === null
  const needJiaguCredentials = willHarden && hardeningMode === 'required'

  // Bugly policy.
  const requireBugly = profile.requireBugly
  const willUploadBugly = requireBugly
  const needBuglyCredentials = requireBugly

  const willGitTag = profile.allowGitTag && mode === 'submit'

  return {
    profile,
    projectRoot,
    mode,
    stores,
    updateDesc,
    onlineTime,
    hardenedApkPath,
    willBuild: hardenedApkPath === null,
    willUploadBugly,
    willHarden,
    willGitTag,
    needBuglyCredentials,
    needJiaguCredentials,
  }
}

/** Required credential env keys for one normalized request. */
export function requiredEnvKeys(request: PublishRequest): string[] {
  return requiredKeysFor(request.stores, {
    needBugly: request.needBuglyCredentials,
    needJiagu: request.needJiaguCredentials,
  })
}

/** Optional (warn-only) credential keys for one normalized request. */
export function optionalEnvKeys(request: PublishRequest): string[] {
  return requiredKeysFor(request.stores, {
    needBugly: !request.needBuglyCredentials,
    needJiagu: false,
  })
}

/** Store ids skipped in packageOnly mode because they cannot dry-run. */
export function packageOnlySkippedStores(stores: readonly AndroidStore[]): AndroidStore[] {
  return stores.filter(s => s !== 'yyb')
}

/**
 * Build the build_and_submit.py child argv from policy. The model never
 * passes arbitrary skip flags; everything here is policy-derived.
 */
export function buildChildArgv(request: PublishRequest): string[] {
  const argv: string[] = [path.join('build_and_submit.py')]
  for (const store of request.stores) argv.push('--store', store)

  if (request.mode === 'packageOnly') {
    argv.push('--dry-run')
    argv.push('--skip-git')
  } else {
    argv.push('--i-know-this-submits-to-production')
    if (!request.profile.allowGitTag) argv.push('--skip-git')
  }

  argv.push('--update-desc', request.updateDesc)
  if (request.onlineTime) argv.push('--online-time', request.onlineTime)
  if (request.hardenedApkPath) argv.push('--hardened-apk', request.hardenedApkPath)
  if (request.profile.hardeningMode === 'disabled') argv.push('--skip-jiagu')
  if (!request.needBuglyCredentials) argv.push('--skip-bugly')
  argv.push(request.projectRoot)
  return argv
}

/** Markdown rendering for the production approval card. */
export function renderMarkdownPlan(request: PublishRequest, warnings: readonly string[]): string {
  const lines = [
    `**方案 ID**: ${newPlanId()}`,
    `**Profile**: ${request.profile.displayName} (${request.profile.id})`,
    `**项目根目录**: ${request.projectRoot}`,
    `**模式**: ${request.mode === 'submit' ? '生产提审' : '仅打包 (dry-run)'}`,
    `**目标渠道**: ${request.stores.join(', ')}`,
    `**更新文案**: ${request.updateDesc}`,
    `**定时上架**: ${request.onlineTime ?? '无'}`,
    `**外部加固包**: ${request.hardenedApkPath ?? '无'}`,
    '',
    `- 打包 Release APK: ${request.willBuild ? '是' : '否'}`,
    `- Bugly 符号表上传: ${request.willUploadBugly ? '是（requireBugly）' : '可选/跳过'}`,
    `- 360 加固: ${request.willHarden ? '是' : `否（hardeningMode=${request.profile.hardeningMode}）`}`,
    `- Git 打 tag: ${request.willGitTag ? '**是（提审成功后自动打 tag）**' : '否'}`,
  ]
  if (request.mode === 'packageOnly') {
    const skipped = packageOnlySkippedStores(request.stores)
    if (skipped.length) {
      lines.push('', `注意: ${skipped.join(', ')} 不支持仅上传不提审，将在 dry-run 中跳过；应用宝支持 dry-run。`)
    }
  }
  if (warnings.length) {
    lines.push('', '**警告**:', ...warnings.map(w => `- ${w}`))
  }
  return lines.join('\n')
}

/** Effective package name used per store (exposed for preflight diagnostics). */
export function packageNames(request: PublishRequest): Record<string, string> {
  const out: Record<string, string> = {}
  for (const store of request.stores) out[store] = storePackageName(request.profile, store)
  return out
}
