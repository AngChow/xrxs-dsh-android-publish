import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  parseProgressMarker,
  parseResultMarker,
  renderCardText,
  tail,
  type ReleaseCard,
} from '../src/card.ts'
import { resolveConfig } from '../src/config.ts'
import { createRuntime } from '../src/runtime.ts'
import { registerPlanTool } from '../src/tools/plan.ts'
import { registerDoctorTool } from '../src/tools/doctor.ts'

const fixtureRoot = path.join(os.tmpdir(), 'ap-card-test-project')

beforeAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(path.join(fixtureRoot, 'gradlew'), '#!/bin/sh\n')
  chmodSync(path.join(fixtureRoot, 'gradlew'), 0o755)
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function runtime() {
  const config = resolveConfig({
    profiles: {
      test: {
        displayName: '测试应用',
        projectRoot: fixtureRoot,
        allowedStores: ['yyb', 'xiaomi'],
        packageName: 'com.xrxs.example',
      },
    },
  })
  const ctx = {
    credentials: {
      describe: async () => ({ configured: true, source: 'env', writable: false }),
    },
  }
  // @ts-expect-error the plan tool only touches credentials.describe here
  return createRuntime(ctx, config)
}

describe('card text', () => {
  const card: ReleaseCard = {
    v: 1,
    title: 'Android 生产提审',
    subtitle: '测试应用 · 应用宝 / 小米',
    state: 'ok',
    badge: '已完成',
    facts: [{ label: '任务 ID', value: 'job-1' }],
    steps: [
      { label: '打包', state: 'done' },
      { label: '提审', state: 'failed' },
    ],
    stores: [{ id: 'yyb', name: '应用宝', state: 'success' }],
    warnings: ['注意 dry-run'],
    notes: ['用 status 读结果'],
    outputTail: 'tail line',
  }

  it('keeps every section in the model-facing text', () => {
    const text = renderCardText(card)
    expect(text).toContain('【已完成】Android 生产提审 — 测试应用 · 应用宝 / 小米')
    expect(text).toContain('任务 ID: job-1')
    expect(text).toContain('流程: ✓打包 → ✗提审')
    expect(text).toContain('渠道: 应用宝 成功')
    expect(text).toContain('- 注意 dry-run')
    expect(text).toContain('用 status 读结果')
    expect(text).toContain('tail line')
  })
})

describe('job output markers', () => {
  it('takes the last well-formed result payload', () => {
    const output = [
      '@@ANDROID_PUBLISH_RESULT@@ {"success":["yyb"]}',
      'plain log line',
      '@@ANDROID_PUBLISH_RESULT@@ {"success":["yyb"],"failed":["xiaomi"]}',
      '@@ANDROID_PUBLISH_RESULT@@ {broken',
    ].join('\n')
    expect(parseResultMarker(output, '@@ANDROID_PUBLISH_RESULT@@ ')).toEqual({
      success: ['yyb'],
      failed: ['xiaomi'],
    })
  })

  it('reads the running step from the progress marker', () => {
    const output = [
      '@@ANDROID_PUBLISH_PROGRESS@@ {"step":"build","message":"[2/5] 打包"}',
      '@@ANDROID_PUBLISH_PROGRESS@@ {"step":"submit","message":"[3/5] 提审"}',
    ].join('\n')
    expect(parseProgressMarker(output, '@@ANDROID_PUBLISH_PROGRESS@@ ')).toEqual({
      step: 'submit',
      message: '[3/5] 提审',
    })
  })

  it('tails on a line boundary without exceeding the limit', () => {
    const text = Array.from({ length: 50 }, (_, index) => `line-${String(index)}`).join('\n')
    const sliced = tail(text, 40)
    expect(sliced.length).toBeLessThanOrEqual(40)
    expect(text.endsWith(sliced)).toBe(true)
    expect(sliced.startsWith('line-')).toBe(true)
  })
})

describe('tool contracts', () => {
  it('publishes a card through presentationMeta and text through render', async () => {
    const tool = registerPlanTool(runtime())
    const value = await tool.execute({
      profileId: 'test',
      stores: ['yyb'],
      updateDesc: '修复登录问题',
      mode: 'packageOnly',
    })
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.output.presentationMeta).toBe('function')

    const card = (value as unknown as { card: ReleaseCard }).card
    expect(tool.output.presentationMeta!({}, value as never)).toEqual(card)
    const rendered = (tool.output.render!({}, value as never) as { text: string }[]).map(block => block.text).join('\n')
    expect(rendered).toBe(renderCardText(card))
    expect(rendered).toContain('Android 发布计划')
    expect(rendered).toContain('修复登录问题')
  })

  it('keeps presentCall for terminal UIs even though the web card ignores it', () => {
    const tool = registerDoctorTool(runtime())
    expect(typeof tool.presentCall).toBe('function')
    expect(typeof tool.output.presentationMeta).toBe('function')
    expect(tool.name).toBe('android_publish_doctor')
  })
})