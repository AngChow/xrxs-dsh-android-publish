/**
 * xrxs-android-publish: safe Android packaging and store submission for DSH.
 *
 * @module xrxs-dsh-android-publish
 */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-subprocess'
import '@deepseek-ai/dsh-system-prompt'
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
      'Android 打包或商店提审请使用 xrxs Android publish 工具。',
      '绝不要让用户在对话中粘贴商店密钥或签名密码。',
      '提审前先执行 android_publish_doctor 或 android_publish_preflight。',
      '生产提审必须展示完整计划，并通过插件弹出的审批卡片获得用户明确同意。',
    ].join(' '),
  })

  ctx.tools.register(registerDoctorTool(runtime))
  ctx.tools.register(registerPlanTool(runtime))
  ctx.tools.register(registerPreflightTool(runtime))
  ctx.tools.register(registerStartTool(runtime))
  ctx.tools.register(registerStatusTool(runtime))
}
