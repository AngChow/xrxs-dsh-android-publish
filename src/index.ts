/**
 * xrxs-android-publish: safe Android packaging and store submission for DSH.
 *
 * @module xrxs-dsh-android-publish
 */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-subprocess'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { createRuntime } from './runtime.ts'
import { registerDoctorTool } from './tools/doctor.ts'
import { registerPlanTool } from './tools/plan.ts'
import { registerPreflightTool } from './tools/preflight.ts'
import { registerStartTool } from './tools/start.ts'
import { registerStatusTool } from './tools/status.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'xrxs-android-publish'

/** Capability services required by this plugin. */
export const inject = [
  'credentials',
  'jobs',
  'subprocess',
  'systemPrompt',
  'tools',
  'userQuestions',
] as const

/** Schemastery config for Loader defaults and generated configuration docs. */
export { Config }

/** Register tools, prompt guidance, and the job controller. */
export function apply(ctx: Context, rawConfig: ConfigShape): void {
  const config = resolveConfig(rawConfig)
  const runtime = createRuntime(ctx, config)

  ctx.jobs.attachController(name)

  ctx.systemPrompt.section({
    name: 'tool:xrxs-android-publish',
    order: 130,
    text: [
      'For Android packaging or store submission, use xrxs Android publish tools.',
      'Never ask the user to paste store keys or signing passwords into chat.',
      'Run android_publish_doctor or android_publish_preflight before submit.',
      'Production submission always shows a full plan and requires explicit user approval through the plugin.',
    ].join(' '),
  })

  ctx.tools.register(registerDoctorTool(runtime))
  ctx.tools.register(registerPlanTool(runtime))
  ctx.tools.register(registerPreflightTool(runtime))
  ctx.tools.register(registerStartTool(runtime))
  ctx.tools.register(registerStatusTool(runtime))
}
