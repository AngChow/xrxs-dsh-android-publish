/**
 * Child process execution through the Python plugin runner, and DSH job
 * integration for long-running release work.
 *
 * @module xrxs-dsh-android-publish/runner
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import '@deepseek-ai/dsh-subprocess'

/** Register this plugin's producer kind with the jobs service. */
declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap {
    'android-publish': 'android-publish'
  }
}
import type { Redactor } from './redact.ts'

/** Absolute paths of bundled resources, resolved from the compiled module. */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url))
export const pythonRunnerPath = fileURLToPath(
  new URL('../resources/python/plugin_runner.py', import.meta.url),
)
export const scriptsDir = fileURLToPath(
  new URL('../resources/scripts', import.meta.url),
)

const RESULT_PREFIX = '@@ANDROID_PUBLISH_RESULT@@ '
const PROGRESS_PREFIX = '@@ANDROID_PUBLISH_PROGRESS@@ '

export interface RunnerResult {
  readonly exitCode: number
  readonly outputTail: string
  readonly result: Record<string, unknown> | null
  readonly durationMs: number
}

export interface QuickResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Spawn a short-lived probe command and collect its output. */
export async function runQuick(
  ctx: Context,
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<QuickResult> {
  const maxBytes = 65536
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? {},
    graceMs: 2000,
    stdio: {
      stdin: { data: '' },
      stdout: { maxBytes },
      stderr: { maxBytes },
    },
  })
  const timer = options.timeoutMs
    ? setTimeout(() => handle.terminate(), options.timeoutMs)
    : undefined
  try {
    const done = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
    return { exitCode: done.exitCode ?? -1, stdout, stderr }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface RunnerSpawnOptions {
  /** Full child argv after the runner's own options. */
  childArgv: string[]
  pythonExecutable: string
  label: string
  logDir: string
  cwd: string
  env: Record<string, string>
  /** Env keys whose values must be redacted. */
  redactKeys: readonly string[]
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}

interface RunnerHandle {
  readonly done: Promise<{ exitCode: number | null; signal?: string }>
  terminate(): void
  readonly collected: {
    stdout?: { readFrom(from: number): { text: string; nextOffset: number; lossy: boolean } }
    stderr?: { readFrom(from: number): { text: string; nextOffset: number; lossy: boolean } }
  }
}

/** Build the full runner argv: plugin_runner.py options + `--` + child argv. */
export function buildRunnerArgv(options: {
  pythonExecutable: string
  logDir: string
  label: string
  redactKeys: readonly string[]
  childArgv: readonly string[]
}): string[] {
  return [
    options.pythonExecutable,
    pythonRunnerPath,
    '--python', options.pythonExecutable,
    '--log-dir', options.logDir,
    '--label', options.label,
    '--',
    // plugin_runner executes `cmd` directly, so the child argv must be
    // interpreter-prefixed; callers pass bare [script.py, args...].
    options.pythonExecutable,
    ...options.childArgv,
  ]
}

/** Runner env: child env + redaction key list (names only, never values). */
export function buildRunnerEnv(
  childEnv: Record<string, string>,
  redactKeys: readonly string[],
): Record<string, string> {
  return {
    ...childEnv,
    PLUGIN_REDACT_KEYS: redactKeys.join(','),
    PUBLISH_DISABLE_PROJECT_ENV: '1',
  }
}

/**
 * Run preflight (or any short script) through plugin_runner.py and wait.
 * Output is redacted by the runner itself; we redact again at this boundary.
 */
export async function runThroughRunner(
  ctx: Context,
  options: RunnerSpawnOptions,
  redactor: Redactor,
): Promise<RunnerResult> {
  const handle = ctx.subprocess.spawn({
    argv: buildRunnerArgv(options),
    cwd: options.cwd,
    env: buildRunnerEnv(options.env, options.redactKeys),
    graceMs: 5000,
    signal: options.signal,
    stdio: {
      stdin: { data: '' },
      stdout: { maxBytes: options.maxBytes },
      stderr: { maxBytes: options.maxBytes },
    },
  }) as RunnerHandle

  const started = Date.now()
  const done = await handle.done
  const merged = [
    handle.collected.stdout?.readFrom(0)?.text ?? '',
    handle.collected.stderr?.readFrom(0)?.text ?? '',
  ].join('\n')
  const { result, withoutMarkers } = extractResult(merged)
  return {
    exitCode: done.exitCode ?? -1,
    outputTail: redactor.redact(withoutMarkers.slice(-options.maxBytes)),
    result,
    durationMs: Date.now() - started,
  }
}

/** Split the structured result marker out of merged runner output. */
export function extractResult(text: string): {
  result: Record<string, unknown> | null
  withoutMarkers: string
} {
  const lines = text.split('\n')
  let result: Record<string, unknown> | null = null
  const kept: string[] = []
  for (const line of lines) {
    if (line.startsWith(RESULT_PREFIX)) {
      try {
        result = JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>
      } catch {
        result = null
      }
      continue
    }
    if (line.startsWith(PROGRESS_PREFIX)) continue
    kept.push(line)
  }
  return { result, withoutMarkers: kept.join('\n') }
}

export interface JobRunSpec {
  ctx: Context
  owner?: string
  label: string
  spawn: RunnerSpawnOptions
  redactor: Redactor
  onSettled?: (outcome: JobOutcome, result: Record<string, unknown> | null) => void
}

/** Start a background release job; returns the registry-issued job id. */
export function startRunnerJob(spec: JobRunSpec): string {
  const { ctx } = spec
  return ctx.jobs.start({
    kind: 'android-publish',
    label: spec.label,
    owner: spec.owner as never,
    outputLimitBytes: spec.spawn.maxBytes,
    run(job) {
      const handle = spec.ctx.subprocess.spawn({
        argv: buildRunnerArgv(spec.spawn),
        cwd: spec.spawn.cwd,
        env: buildRunnerEnv(spec.spawn.env, spec.spawn.redactKeys),
        graceMs: 5000,
        stdio: {
          stdin: { data: '' },
          stdout: { maxBytes: spec.spawn.maxBytes },
          stderr: { maxBytes: spec.spawn.maxBytes },
        },
      }) as RunnerHandle

      let settled = false
      let lastOffset = 0
      let lastResult: Record<string, unknown> | null = null

      const pump = setInterval(() => {
        try {
          const read = handle.collected.stdout?.readFrom(lastOffset)
          if (!read || !read.text) return
          lastOffset = read.nextOffset
          const redacted = spec.redactor.redact(read.text)
          const { progress, result } = parseMarkers(redacted)
          if (result) lastResult = result
          if (progress) job.updateProgress(progress)
          job.append(redacted, { channel: 'stdout' })
        } catch {
          // Keep polling; the reader may be mid-write.
        }
      }, 250)

      const finish = (outcome: JobOutcome): JobOutcome => {
        if (settled) return outcome
        settled = true
        clearInterval(pump)
        // Final drain.
        try {
          const read = handle.collected.stdout?.readFrom(lastOffset)
          if (read?.text) {
            lastOffset = read.nextOffset
            const redacted = spec.redactor.redact(read.text)
            const { result } = parseMarkers(redacted)
            if (result) lastResult = result
            job.append(redacted, { channel: 'stdout' })
          }
        } catch {
          // ignore
        }
        const payload = lastResult
          ? JSON.stringify(lastResult)
          : JSON.stringify({ parsed: false, exitCode: outcome.status === 'completed' ? 0 : null })
        spec.onSettled?.(outcome, lastResult)
        return { ...outcome, result: payload }
      }

      const mapOutcome = (done: { exitCode: number | null; signal?: string }): JobOutcome =>
        done.exitCode === 0
          ? { status: 'completed' as const, detail: 'exit code: 0' }
          : {
              status: 'failed' as const,
              detail: `exit code: ${done.exitCode ?? 'signal ' + (done.signal ?? 'unknown')}`,
            }

      return {
        cancel(reason) {
          handle.terminate()
          if (reason) job.append(`\n[cancel requested] ${spec.redactor.redact(reason)}\n`)
        },
        done: handle.done
          .then(mapOutcome)
          .catch(() => ({ status: 'failed' as const, detail: 'runner produced no structured result' }))
          .then(finish),
      }
    },
  })
}

function parseMarkers(text: string): { progress?: string; result?: Record<string, unknown> } {
  let progress: string | undefined
  let result: Record<string, unknown> | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith(PROGRESS_PREFIX)) {
      try {
        const parsed = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as { step?: string; message?: string }
        if (parsed.step) progress = `${parsed.step}: ${parsed.message ?? ''}`.trim()
      } catch {
        // ignore malformed progress
      }
    } else if (line.startsWith(RESULT_PREFIX)) {
      try {
        result = JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>
      } catch {
        // ignore malformed result
      }
    }
  }
  return { progress, result }
}
