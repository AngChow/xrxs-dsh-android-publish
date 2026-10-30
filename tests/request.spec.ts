import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChildArgv, normalizeRequest, type PublishRequestInput } from '../src/request.ts'
import { resolveConfig } from '../src/config.ts'
import { createRuntime } from '../src/runtime.ts'
import { createRedactor } from '../src/redact.ts'

const fixtureRoot = path.join(os.tmpdir(), 'ap-test-project')

beforeAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(path.join(fixtureRoot, 'gradlew'), '#!/bin/sh\n')
  chmodSync(path.join(fixtureRoot, 'gradlew'), 0o755)
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function runtime(overrides: Record<string, unknown> = {}) {
  const config = resolveConfig({
    profiles: {
      test: {
        displayName: 'T',
        projectRoot: fixtureRoot,
        allowedStores: ['yyb', 'xiaomi'],
        packageName: 'com.xrxs.example',
        ...overrides,
      },
    },
  })
  // @ts-expect-error partial fake context is fine for pure helpers
  return createRuntime({}, config)
}

function input(overrides: Partial<PublishRequestInput> = {}): PublishRequestInput {
  return {
    profileId: 'test',
    stores: ['yyb'],
    updateDesc: '修复已知问题',
    mode: 'packageOnly',
    ...overrides,
  }
}

describe('request normalization', () => {
  it('rejects empty store list', async () => {
    await expect(normalizeRequest(runtime(), input({ stores: [] })))
      .rejects.toThrow(/at least one explicit store/)
  })

  it('rejects stores outside allowedStores', async () => {
    await expect(normalizeRequest(runtime(), input({ stores: ['oppo'] as never })))
      .rejects.toThrow(/not in profile/)
  })

  it('blocks submit when allowProductionSubmit is false', async () => {
    await expect(normalizeRequest(runtime(), input({ mode: 'submit' })))
      .rejects.toThrow(/allowProductionSubmit/)
  })

  it('allows submit when profile policy permits', async () => {
    const request = await normalizeRequest(runtime({ allowProductionSubmit: true }), input({ mode: 'submit' }))
    expect(request.mode).toBe('submit')
    expect(request.willGitTag).toBe(false)
  })

  it('rejects empty or oversized updateDesc', async () => {
    await expect(normalizeRequest(runtime(), input({ updateDesc: '   ' }))).rejects.toThrow(/non-empty/)
    await expect(normalizeRequest(runtime(), input({ updateDesc: 'x'.repeat(301) }))).rejects.toThrow(/300/)
  })

  it('rejects invalid onlineTime format', async () => {
    await expect(normalizeRequest(runtime(), input({ onlineTime: '2026/10/29 12:00' })))
      .rejects.toThrow(/YYYY-MM-DD HH:MM:SS/)
  })

  it('rejects relative hardenedApkPath', async () => {
    await expect(normalizeRequest(runtime(), input({ hardenedApkPath: 'relative.apk' })))
      .rejects.toThrow(/absolute/)
  })
})

describe('command construction policy', () => {
  it('packageOnly adds --dry-run and --skip-git', async () => {
    const request = await normalizeRequest(runtime(), input({ mode: 'packageOnly' }))
    const argv = buildChildArgv(request)
    expect(argv).toContain('--dry-run')
    expect(argv).toContain('--skip-git')
    expect(argv).not.toContain('--i-know-this-submits-to-production')
  })

  it('submit adds the production flag and never --dry-run', async () => {
    const request = await normalizeRequest(
      runtime({ allowProductionSubmit: true }),
      input({ mode: 'submit' }),
    )
    const argv = buildChildArgv(request)
    expect(argv).toContain('--i-know-this-submits-to-production')
    expect(argv).not.toContain('--dry-run')
    expect(argv).toContain('--skip-git') // allowGitTag defaults false
  })

  it('allowGitTag omits --skip-git in submit mode', async () => {
    const request = await normalizeRequest(
      runtime({ allowProductionSubmit: true, allowGitTag: true }),
      input({ mode: 'submit' }),
    )
    expect(buildChildArgv(request)).not.toContain('--skip-git')
  })

  it('passes explicit repeated stores', async () => {
    const request = await normalizeRequest(runtime(), input({ stores: ['yyb', 'xiaomi'] }))
    const argv = buildChildArgv(request)
    expect(argv.filter(a => a === '--store')).toHaveLength(2)
    expect(argv).toContain('yyb')
    expect(argv).toContain('xiaomi')
  })

  it('hardening disabled adds --skip-jiagu only when policy allows', async () => {
    const request = await normalizeRequest(
      runtime({ hardeningMode: 'disabled', allowUnhardenedSubmit: true, allowProductionSubmit: true }),
      input({ mode: 'submit' }),
    )
    expect(buildChildArgv(request)).toContain('--skip-jiagu')
  })

  it('passes updateDesc and projectRoot', async () => {
    const request = await normalizeRequest(runtime(), input())
    const argv = buildChildArgv(request)
    expect(argv).toContain('--update-desc')
    expect(argv[argv.length - 1]).toBe(request.projectRoot)
  })
})

describe('redactor', () => {
  it('replaces exact secret substrings', () => {
    const redactor = createRedactor(['super-secret-value', 'short'])
    expect(redactor.redact('token=super-secret-value rest')).toBe('token=[redacted] rest')
    expect(redactor.redact('normal output')).toBe('normal output')
  })

  it('ignores very short values to avoid destructive replacement', () => {
    const redactor = createRedactor(['ab'])
    expect(redactor.redact('ab ab ab')).toBe('ab ab ab')
  })

  it('redacts inside nested JSON values', () => {
    const redactor = createRedactor(['super-secret-value'])
    const out = redactor.redactKnown({ a: ['token=super-secret-value'], b: { c: 'ok' } })
    expect(JSON.stringify(out)).not.toContain('super-secret-value')
  })
})
