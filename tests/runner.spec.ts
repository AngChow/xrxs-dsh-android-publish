import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractResult, runThroughRunner } from '../src/runner.ts'
import { createRedactor } from '../src/redact.ts'
import type { Context } from '@deepseek-ai/cordis'

let workDir: string
let projectDir: string
let logDir: string

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'ap-runner-'))
  projectDir = path.join(workDir, 'proj')
  logDir = path.join(workDir, 'logs')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  // Poisoned project dotenv must have no effect during plugin runs.
  writeFileSync(path.join(projectDir, '.publish_env'), 'YYB_ACCESS_SECRET=poisoned-value-123456\n')
  writeFileSync(path.join(workDir, 'child.py'), [
    'import os, json',
    'print("effective=" + os.environ.get("YYB_ACCESS_SECRET", "<unset>"))',
    'print("dotenv_disabled=" + str(os.environ.get("PUBLISH_DISABLE_PROJECT_ENV")))',
    'print("token=" + os.environ.get("YYB_ACCESS_SECRET", "x"))',
    'print("normal output")',
    'print("@@ANDROID_PUBLISH_PROGRESS@@ " + json.dumps({"step": "build", "message": "Building release APK"}))',
    'print("@@ANDROID_PUBLISH_RESULT@@ " + json.dumps({"exitCode": 0, "mode": "dry-run", "stores": ["yyb"], "success": ["yyb"], "failed": []}))',
  ].join('\n'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const SECRET = 'real-value-987654321'

import { spawnSync } from 'node:child_process'

function fakeCtx(): Context {
  return {
    subprocess: {
      spawn(spec: { argv: string[]; env: Record<string, string> }) {
        const child = spawnSync(spec.argv[0], spec.argv.slice(1), {
          env: { ...process.env, ...spec.env },
          encoding: 'utf8',
        })
        return {
          done: Promise.resolve({ exitCode: child.status ?? -1, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: child.stdout ?? '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: child.stderr ?? '', nextOffset: 0, lossy: false }) },
          },
        }
      },
    },
  } as never as Context
}

describe('plugin_runner integration', () => {
  it('isolates the project dotenv and redacts secrets end to end', async () => {
    const redactor = createRedactor([SECRET])
    const result = await runThroughRunner(
      fakeCtx(),
      {
        childArgv: [path.join(workDir, 'child.py')],
        pythonExecutable: 'python3',
        label: 'test',
        logDir,
        cwd: projectDir,
        env: { YYB_ACCESS_SECRET: SECRET, PUBLISH_DISABLE_PROJECT_ENV: '1' },
        redactKeys: ['YYB_ACCESS_SECRET'],
        maxBytes: 65536,
        timeoutMs: 30_000,
      },
      redactor,
    )

    if (result.exitCode !== 0) console.error('TAIL>>>', result.outputTail)
    expect(result.exitCode).toBe(0)
    expect(result.result).toMatchObject({ parsed: true, mode: 'dry-run', success: ['yyb'] })
    // No secret material anywhere in the visible output.
    expect(result.outputTail).not.toContain(SECRET)
    expect(result.outputTail).not.toContain('poisoned-value-123456')
    expect(result.outputTail).toContain('token=[redacted]')
    expect(result.outputTail).toContain('normal output')
    expect(result.outputTail).toContain('dotenv_disabled=1')
  })

  it('keeps the sanitized log free of secrets', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const logs = readdirSync(logDir).filter(f => f.endsWith('.log'))
    expect(logs.length).toBeGreaterThan(0)
    for (const file of logs) {
      const text = readFileSync(path.join(logDir, file), 'utf8')
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('poisoned-value-123456')
    }
  })
})

describe('extractResult', () => {
  it('parses the structured result marker and strips markers', () => {
    const text = [
      'plain line',
      '@@ANDROID_PUBLISH_RESULT@@ {"exitCode":1,"failed":["yyb"]}',
    ].join('\n')
    const { result, withoutMarkers } = extractResult(text)
    expect(result).toMatchObject({ exitCode: 1, failed: ['yyb'] })
    expect(withoutMarkers).toBe('plain line')
  })

  it('returns null when no marker exists', () => {
    expect(extractResult('nothing here').result).toBeNull()
  })
})
