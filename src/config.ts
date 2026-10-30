/**
 * Configuration schema, allowlists, and load-time validation.
 *
 * @module xrxs-dsh-android-publish/config
 */

import z from '@deepseek-ai/schemastery'

/** Five supported Android stores. */
export const STORES = ['yyb', 'xiaomi', 'huawei', 'oppo', 'vivo'] as const

export type AndroidStore = (typeof STORES)[number]

export type HardeningMode = 'required' | 'optional' | 'disabled'

/** Credential reference grammar shared with DSH credentials-local. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Environment keys that must be resolved through DSH credential refs. */
export const SECRET_ENV_KEYS = new Set<string>([
  'BUGLY_APP_KEY',
  'BUGLY_APP_ID',
  'YYB_USER_ID',
  'YYB_ACCESS_SECRET',
  'YYB_APP_ID',
  'MI_USER_NAME',
  'MI_PRIVATE_KEY',
  'HW_CLIENT_ID',
  'HW_CLIENT_SECRET',
  'HW_APP_ID',
  'OPPO_CLIENT_ID',
  'OPPO_CLIENT_SECRET',
  'VIVO_ACCESS_KEY',
  'VIVO_ACCESS_SECRET',
  'JIAGU_QID',
  'JIAGU_API_ID',
  'JIAGU_API_KEY',
  'JIAGU_KEYSTORE_PASS',
  'JIAGU_KEY_PASS',
])

/** Non-secret environment keys allowed in `plainEnv`. */
export const PLAIN_ENV_KEYS = new Set<string>([
  'BUGLY_BUNDLE_ID',
  'YYB_PKG_NAME',
  'MI_CERT_PATH',
  'MI_PKG_NAME',
  'MI_APP_NAME',
  'MI_PRIVACY_URL',
  'MI_ICON_PATH',
  'HW_CLIENT_ID',
  'HW_APP_ID',
  'OPPO_CLIENT_ID',
  'OPPO_PKG_NAME',
  'VIVO_PKG_NAME',
  'JIAGU_HOME',
  'JIAGU_FEATURES',
  'JIAGU_CONFIG_NAME',
  'JIAGU_KEYSTORE_PATH',
  'JIAGU_KEY_ALIAS',
  'ANDROID_HOME',
  'ANDROID_BUILD_TOOLS',
  'JAVA_HOME',
])

/** Required credential env keys per store / integration. */
export const REQUIRED_CREDENTIALS: Record<string, string[]> = {
  yyb: ['YYB_USER_ID', 'YYB_ACCESS_SECRET', 'YYB_APP_ID'],
  xiaomi: ['MI_USER_NAME', 'MI_PRIVATE_KEY'],
  huawei: ['HW_CLIENT_ID', 'HW_CLIENT_SECRET', 'HW_APP_ID'],
  oppo: ['OPPO_CLIENT_ID', 'OPPO_CLIENT_SECRET'],
  vivo: ['VIVO_ACCESS_KEY', 'VIVO_ACCESS_SECRET'],
  bugly: ['BUGLY_APP_ID', 'BUGLY_APP_KEY'],
  jiagu: ['JIAGU_QID', 'JIAGU_API_ID', 'JIAGU_API_KEY'],
}

/** Paths referenced from plainEnv that must exist and be canonicalized. */
export const PATH_LIKE_ENV_KEYS = new Set<string>([
  'MI_CERT_PATH',
  'MI_ICON_PATH',
  'JIAGU_HOME',
  'JIAGU_KEYSTORE_PATH',
  'ANDROID_HOME',
  'ANDROID_BUILD_TOOLS',
  'JAVA_HOME',
])

/** Android applicationId shape. */
const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i

/** Deployment-owned release profile. */
export interface ProfileConfig {
  displayName: string
  projectRoot: string
  allowedStores: AndroidStore[]
  packageName: string
  storePackageNames?: Partial<Record<AndroidStore, string>>
  allowProductionSubmit?: boolean
  allowGitTag?: boolean
  allowUnhardenedSubmit?: boolean
  hardeningMode?: HardeningMode
  requireBugly?: boolean
  requireManagedCredentialSource?: boolean
  /** Script env key -> DSH credential reference name (references, never values). */
  credentialRefs?: Record<string, string>
  /** Non-secret environment values. */
  plainEnv?: Record<string, string>
}

/** Plugin-level configuration. */
export interface Config {
  profiles?: Record<string, ProfileConfig>
  pythonExecutable?: string
  runtimeDir?: string
  outputMaxBytes?: number
  processTimeoutMs?: number
  auditEnabled?: boolean
}

/** Resolved defaults for one profile. */
export interface ResolvedProfile {
  readonly id: string
  readonly displayName: string
  readonly projectRoot: string
  readonly allowedStores: readonly AndroidStore[]
  readonly packageName: string
  readonly storePackageNames: Partial<Record<AndroidStore, string>>
  readonly allowProductionSubmit: boolean
  readonly allowGitTag: boolean
  readonly allowUnhardenedSubmit: boolean
  readonly hardeningMode: HardeningMode
  readonly requireBugly: boolean
  readonly requireManagedCredentialSource: boolean
  readonly credentialRefs: Readonly<Record<string, string>>
  readonly plainEnv: Readonly<Record<string, string>>
}

/** Fully resolved plugin configuration. */
export interface ResolvedConfig {
  readonly profiles: Readonly<Record<string, ResolvedProfile>>
  readonly pythonExecutable: string
  readonly runtimeDir?: string
  readonly outputMaxBytes: number
  readonly processTimeoutMs: number
  readonly auditEnabled: boolean
}

/** Schemastery schema consumed by the cordis Loader. */
export const Config: z<Config> = z.object({
  profiles: z.dict(z.object({
    displayName: z.string().required(),
    projectRoot: z.string().required(),
    allowedStores: z.array(z.string()).required(),
    packageName: z.string().required(),
    storePackageNames: z.dict(z.string()),
    allowProductionSubmit: z.boolean(),
    allowGitTag: z.boolean(),
    allowUnhardenedSubmit: z.boolean(),
    hardeningMode: z.string(),
    requireBugly: z.boolean(),
    requireManagedCredentialSource: z.boolean(),
    credentialRefs: z.dict(z.string()),
    plainEnv: z.dict(z.string()),
  })),
  pythonExecutable: z.string().default('python3'),
  runtimeDir: z.string(),
  outputMaxBytes: z.number().step(1).min(16384).max(1048576).default(262144),
  processTimeoutMs: z.number().step(1).min(60000).max(14400000).default(3600000),
  auditEnabled: z.boolean().default(true),
}) as z<Config>

function isAndroidStore(value: string): value is AndroidStore {
  return (STORES as readonly string[]).includes(value)
}

function validateProfile(id: string, raw: ProfileConfig): ResolvedProfile {
  const fail = (message: string): never => {
    throw new Error(`[xrxs-android-publish] profile "${id}": ${message}`)
  }

  if (!raw.displayName?.trim()) fail('displayName is required')
  if (!raw.projectRoot || !raw.projectRoot.startsWith('/')) {
    fail('projectRoot must be an absolute path')
  }
  if (!raw.packageName || !PACKAGE_NAME_PATTERN.test(raw.packageName)) {
    fail(`packageName "${raw.packageName}" does not look like an Android applicationId`)
  }

  const stores = raw.allowedStores
  if (!Array.isArray(stores) || stores.length < 1 || stores.length > STORES.length) {
    fail('allowedStores must contain one to five stores')
  }
  for (const store of stores) {
    if (!isAndroidStore(store)) fail(`unknown store "${store}"`)
  }
  if (new Set(stores).size !== stores.length) fail('allowedStores contains duplicates')

  for (const [store, pkg] of Object.entries(raw.storePackageNames ?? {})) {
    if (!isAndroidStore(store)) fail(`unknown store "${store}" in storePackageNames`)
    if (pkg !== undefined && !PACKAGE_NAME_PATTERN.test(pkg)) {
      fail(`storePackageNames.${store} "${pkg}" does not look like an applicationId`)
    }
  }

  const credentialRefs: Record<string, string> = {}
  for (const [envKey, ref] of Object.entries(raw.credentialRefs ?? {})) {
    if (!SECRET_ENV_KEYS.has(envKey) && !PLAIN_ENV_KEYS.has(envKey)) {
      fail(`credentialRefs key "${envKey}" is not in the environment allowlist`)
    }
    if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      fail(`credentialRefs["${envKey}"] value "${ref}" is not a valid credential reference`)
    }
    credentialRefs[envKey] = ref
  }

  const plainEnv: Record<string, string> = {}
  for (const [envKey, value] of Object.entries(raw.plainEnv ?? {})) {
    if (SECRET_ENV_KEYS.has(envKey)) {
      fail(`plainEnv key "${envKey}" is secret-shaped; use credentialRefs instead`)
    }
    if (!PLAIN_ENV_KEYS.has(envKey)) {
      fail(`plainEnv key "${envKey}" is not in the plain environment allowlist`)
    }
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`plainEnv["${envKey}"] must be a non-empty string`)
    }
    plainEnv[envKey] = value
  }

  const hardeningMode = raw.hardeningMode ?? 'required'
  if (!['required', 'optional', 'disabled'].includes(hardeningMode)) {
    fail(`hardeningMode "${hardeningMode}" must be required|optional|disabled`)
  }

  return {
    id,
    displayName: raw.displayName,
    projectRoot: raw.projectRoot.replace(/\/+$/, '') || '/',
    allowedStores: [...stores],
    packageName: raw.packageName,
    storePackageNames: { ...(raw.storePackageNames ?? {}) },
    allowProductionSubmit: raw.allowProductionSubmit ?? false,
    allowGitTag: raw.allowGitTag ?? false,
    allowUnhardenedSubmit: raw.allowUnhardenedSubmit ?? false,
    hardeningMode,
    requireBugly: raw.requireBugly ?? false,
    requireManagedCredentialSource: raw.requireManagedCredentialSource ?? true,
    credentialRefs,
    plainEnv,
  }
}

/** Validate and freeze configuration at plugin load; throw loudly on any violation. */
export function resolveConfig(raw: Config): ResolvedConfig {
  const profiles: Record<string, ResolvedProfile> = {}
  for (const [id, profile] of Object.entries(raw.profiles ?? {})) {
    profiles[id] = validateProfile(id, profile)
  }
  return {
    profiles,
    pythonExecutable: raw.pythonExecutable?.trim() || 'python3',
    runtimeDir: raw.runtimeDir,
    outputMaxBytes: raw.outputMaxBytes ?? 262144,
    processTimeoutMs: raw.processTimeoutMs ?? 3600000,
    auditEnabled: raw.auditEnabled ?? true,
  }
}

/** Look up one profile or throw a model-facing error. */
export function getProfile(config: ResolvedConfig, profileId: string): ResolvedProfile {
  const profile = config.profiles[profileId]
  if (!profile) {
    const known = Object.keys(config.profiles)
    throw new Error(
      `unknown profileId "${profileId}"` + (known.length ? `; known: ${known.join(', ')}` : '; no profiles configured'),
    )
  }
  return profile
}

/** Effective package name for one store (store override, else profile package name). */
export function storePackageName(profile: ResolvedProfile, store: AndroidStore): string {
  return profile.storePackageNames[store] ?? profile.packageName
}
