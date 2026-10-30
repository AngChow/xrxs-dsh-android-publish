/**
 * Shared plugin runtime: validated config, service handles, active-run lock.
 *
 * @module xrxs-dsh-android-publish/runtime
 */

import path from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig, ResolvedProfile } from './config.ts'

export interface PluginRuntime {
  readonly ctx: Context
  readonly config: ResolvedConfig
  /** Canonical projectRoot -> jobId; prevents concurrent runs on one project. */
  readonly activeRuns: Map<string, string>
  /** Default runtime directory (overridden by config.runtimeDir). */
  readonly defaultRuntimeDir: string
}

export function createRuntime(ctx: Context, config: ResolvedConfig): PluginRuntime {
  return {
    ctx,
    config,
    activeRuns: new Map(),
    defaultRuntimeDir: path.join(homedir(), '.dsh', 'android-publish'),
  }
}

/** Effective runtime directory for one profile. */
export function runtimeDirFor(runtime: PluginRuntime, profile: ResolvedProfile): string {
  return runtime.config.runtimeDir
    ?? path.join(runtime.defaultRuntimeDir, profile.id)
}

/** Abort the current tool call with a model-facing error message. */
export function toolError(message: string): never {
  throw new Error(`[android-publish] ${message}`)
}
