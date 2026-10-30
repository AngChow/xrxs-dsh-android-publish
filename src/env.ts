/**
 * Per-operation credential resolution and child environment construction.
 *
 * Secrets exist only here, in the child env, and in the redactor state.
 *
 * @module xrxs-dsh-android-publish/env
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import {
  PLAIN_ENV_KEYS,
  type AndroidStore,
  type ResolvedProfile,
} from './config.ts'
import { REQUIRED_CREDENTIALS } from './config.ts'

/** Credential configured-state entry (never contains values). */
export type CredentialStatus = {
  envKey: string
  credentialRef: string
  configured: boolean
  source?: string
  writable?: boolean
  issue?: 'missing' | 'unmanaged-source'
}

export interface EnvResolution {
  /** Environment entries safe to hand to the child process. */
  readonly env: Record<string, string>
  /** Resolved secret values (for the redactor only; never returned to the model). */
  readonly secretValues: string[]
  /** Blocking issues. */
  readonly issues: string[]
  /** Non-blocking warnings. */
  readonly warnings: string[]
  /** Configured-state preview (no values, no secret material). */
  readonly credentialPreview: CredentialStatus[]
}

/**
 * Non-secret env keys derived from the profile package name. Injected unless a
 * store-specific override already exists in `plainEnv`.
 */
function derivedPackageEnv(profile: ResolvedProfile): Record<string, string> {
  const overrides = profile.storePackageNames
  return {
    YYB_PKG_NAME: overrides.yyb ?? profile.packageName,
    MI_PKG_NAME: overrides.xiaomi ?? profile.packageName,
    OPPO_PKG_NAME: overrides.oppo ?? profile.packageName,
    VIVO_PKG_NAME: overrides.vivo ?? profile.packageName,
    BUGLY_BUNDLE_ID: overrides.yyb ?? profile.packageName,
  }
}

/** All credential env keys referenced by this profile. */
export function profileCredentialKeys(profile: ResolvedProfile): string[] {
  return Object.keys(profile.credentialRefs).sort()
}

/** Required env keys for a set of stores plus integrations. */
export function requiredKeysFor(
  stores: readonly AndroidStore[],
  options: { needBugly: boolean; needJiagu: boolean },
): string[] {
  const keys = new Set<string>()
  for (const store of stores) {
    for (const key of REQUIRED_CREDENTIALS[store] ?? []) keys.add(key)
  }
  if (options.needBugly) for (const key of REQUIRED_CREDENTIALS.bugly ?? []) keys.add(key)
  if (options.needJiagu) for (const key of REQUIRED_CREDENTIALS.jiagu ?? []) keys.add(key)
  return [...keys]
}

/** Env keys in `resolution.env` whose values are resolved secrets. */
export function secretEnvKeys(resolution: EnvResolution): string[] {
  const byValue = new Map(resolution.secretValues.map(v => [v, true]))
  return Object.entries(resolution.env)
    .filter(([, value]) => byValue.has(value))
    .map(([key]) => key)
}

/** Configured-state credential preview without resolving values. */
export async function describeCredentialPreview(
  ctx: Context,
  profile: ResolvedProfile,
): Promise<CredentialStatus[]> {
  const preview: CredentialStatus[] = []
  for (const [envKey, refName] of Object.entries(profile.credentialRefs)) {
    const info = await ctx.credentials.describe(credentialRef(refName))
    preview.push({
      envKey,
      credentialRef: refName,
      configured: info.configured,
      source: info.source,
      writable: info.writable,
      issue: info.configured ? undefined : 'missing',
    })
  }
  return preview
}

/**
 * Resolve every credential ref fresh for this operation and build the child
 * environment. Never caches; missing required refs are blocking issues.
 */
export async function resolveEnv(
  ctx: Context,
  profile: ResolvedProfile,
  requiredEnvKeys: readonly string[],
  options: { enforceManagedSource: boolean },
): Promise<EnvResolution> {
  const env: Record<string, string> = {}
  const secretValues: string[] = []
  const issues: string[] = []
  const warnings: string[] = []
  const credentialPreview: CredentialStatus[] = []

  for (const [envKey, refName] of Object.entries(profile.credentialRefs)) {
    const info = await ctx.credentials.describe(credentialRef(refName))
    const status: CredentialStatus = {
      envKey,
      credentialRef: refName,
      configured: info.configured,
      source: info.source,
      writable: info.writable,
    }
    if (!info.configured) {
      status.issue = 'missing'
      if (requiredEnvKeys.includes(envKey)) {
        issues.push(`missing required credential ${envKey} (ref ${refName})`)
      } else {
        warnings.push(`optional credential ${envKey} is not configured; related feature will be skipped`)
      }
      credentialPreview.push(status)
      continue
    }
    const resolved = await ctx.credentials.resolve(credentialRef(refName))
    if (!resolved || resolved.value.trim() === '') {
      status.issue = 'missing'
      if (requiredEnvKeys.includes(envKey)) {
        issues.push(`credential ${envKey} resolved to an empty value`)
      } else {
        warnings.push(`optional credential ${envKey} is empty; related feature will be skipped`)
      }
      credentialPreview.push(status)
      continue
    }
    if (options.enforceManagedSource && resolved.source !== 'file') {
      status.issue = 'unmanaged-source'
      issues.push(
        `credential ${envKey} came from source "${resolved.source}"; policy requires the managed credential store ("file")`,
      )
      credentialPreview.push(status)
      continue
    }
    env[envKey] = resolved.value
    secretValues.push(resolved.value)
    credentialPreview.push(status)
  }

  // Derived + plain non-secret values.
  const derived = derivedPackageEnv(profile)
  for (const [key, value] of Object.entries(derived)) {
    if (profile.plainEnv[key] === undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(profile.plainEnv)) {
    if (!PLAIN_ENV_KEYS.has(key)) continue
    env[key] = value
  }

  return { env, secretValues, issues, warnings, credentialPreview }
}
