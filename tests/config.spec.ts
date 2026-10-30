import { describe, expect, it } from 'vitest'
import { resolveConfig, getProfile, type Config } from '../src/config.ts'

const validProfile = {
  displayName: 'XRXS Android',
  projectRoot: '/tmp/ap-test-project',
  allowedStores: ['yyb', 'xiaomi'],
  packageName: 'com.xrxs.example',
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return { profiles: { test: { ...validProfile } }, ...overrides }
}

describe('config validation', () => {
  it('accepts a valid minimal profile', () => {
    const config = resolveConfig(baseConfig())
    expect(config.profiles.test?.packageName).toBe('com.xrxs.example')
    expect(config.profiles.test?.allowProductionSubmit).toBe(false)
    expect(config.profiles.test?.hardeningMode).toBe('required')
    expect(config.profiles.test?.requireManagedCredentialSource).toBe(true)
  })

  it('rejects a relative projectRoot', () => {
    expect(() => resolveConfig({
      profiles: { test: { ...validProfile, projectRoot: 'relative/path' } },
    })).toThrow(/absolute/)
  })

  it('rejects an invalid packageName', () => {
    expect(() => resolveConfig({
      profiles: { test: { ...validProfile, packageName: 'not a package' } },
    })).toThrow(/applicationId/)
  })

  it('rejects unknown stores', () => {
    expect(() => resolveConfig({
      profiles: { test: { ...validProfile, allowedStores: ['yyb', 'nope' as never] } },
    })).toThrow(/unknown store/)
  })

  it('rejects duplicate stores', () => {
    expect(() => resolveConfig({
      profiles: { test: { ...validProfile, allowedStores: ['yyb', 'yyb'] } },
    })).toThrow(/duplicates/)
  })

  it('rejects unknown plainEnv keys', () => {
    expect(() => resolveConfig({
      profiles: { test: { ...validProfile, plainEnv: { NOT_ALLOWED: 'x' } } },
    })).toThrow(/allowlist/)
  })

  it('rejects secret-shaped keys in plainEnv', () => {
    expect(() => resolveConfig({
      profiles: { test: { ...validProfile, plainEnv: { YYB_ACCESS_SECRET: 'x' } } },
    })).toThrow(/secret-shaped/)
  })

  it('rejects invalid credential reference grammar', () => {
    expect(() => resolveConfig({
      profiles: {
        test: { ...validProfile, credentialRefs: { YYB_ACCESS_SECRET: 'bad ref with spaces' } },
      },
    })).toThrow(/credential reference/)
  })

  it('rejects unknown credentialRefs keys', () => {
    expect(() => resolveConfig({
      profiles: {
        test: { ...validProfile, credentialRefs: { EVIL_KEY: 'GOOD_REF' } },
      },
    })).toThrow(/allowlist/)
  })

  it('getProfile throws for unknown profileId', () => {
    const config = resolveConfig(baseConfig())
    expect(() => getProfile(config, 'missing')).toThrow(/unknown profileId/)
  })
})
