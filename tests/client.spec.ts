import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * The client half only runs inside the Harness browser module table. This spec
 * loads the built bundle against a stub `window.__ModuleLoader__` and a stub
 * `react`, then checks the registration surface and the card rendering paths.
 */

type Registration = {
  id: string
  factory: (require: (id: string) => unknown) => unknown
}

type VNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

const react = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]): VNode => ({
    type,
    props: (props ?? {}) as Record<string, unknown>,
    children: children.flat(),
  }),
}

const TOOL_KEYS = [
  'android_publish_doctor',
  'android_publish_plan',
  'android_publish_preflight',
  'android_publish_start',
  'android_publish_status',
]

function loadBundle(): Registration[] {
  let source: string
  try {
    source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  } catch {
    throw new Error('lib/client.js is missing; run `pnpm build` before `pnpm test`')
  }
  const registrations: Registration[] = []
  const context = {
    window: {
      __ModuleLoader__: {
        load: (registration: Registration) => {
          registrations.push(registration)
        },
      },
    },
    console,
  }
  vm.runInNewContext(source, context, { filename: 'lib/client.js' })
  return registrations
}

function materialize(): {
  id: string
  inject: string[]
  apply: (ctx: unknown) => unknown
} {
  const registrations = loadBundle()
  expect(registrations).toHaveLength(1)
  const register = registrations[0]!
  const exported = register.factory(id => {
    if (id === 'react') return react
    throw new Error(`unexpected module request: ${id}`)
  }) as { inject: string[]; apply: (ctx: unknown) => unknown } | undefined
  expect(exported).toBeDefined()
  expect(exported!.inject).toEqual(['slots'])
  expect(typeof exported!.apply).toBe('function')
  return { id: register.id, inject: exported!.inject, apply: exported!.apply }
}

/** Run `apply` against a recording slot registry. */
function registrations(key?: string): { key: string; component: (props: unknown) => VNode }[] {
  const { apply } = materialize()
  const recorded: { key: string; component: (props: unknown) => VNode }[] = []
  const ctx = {
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: { key: string }, component: (props: unknown) => VNode) => {
        recorded.push({ key: options.key, component })
        return () => undefined
      },
    },
  }
  apply(ctx)
  return key === undefined ? recorded : recorded.filter(entry => entry.key === key)
}

/** Every string rendered inside a tree. */
function text(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const child of node) text(child, out)
  else if (node !== null && typeof node === 'object' && 'children' in node) {
    for (const child of (node as VNode).children) text(child, out)
  }
  return out
}

function renderCard(card: Record<string, unknown>, extra: Record<string, unknown> = {}): string[] {
  const entry = registrations('android_publish_start')[0]!
  const props = {
    toolName: 'android_publish_start',
    phase: 'result',
    block: { kind: 'result', meta: card, content: [{ type: 'text', text: 'raw result' }] },
    useDisclosure: () => ({ expanded: true, toggle: () => undefined }),
    ...extra,
  }
  return text(entry.component(props))
}

describe('client bundle', () => {
  it('registers under the package name the manifest declares', () => {
    expect(materialize().id).toBe('xrxs-dsh-android-publish')
  })

  it('registers one tool view per publish tool', () => {
    expect(registrations().map(entry => entry.key)).toEqual(TOOL_KEYS)
  })

  it('renders a start card from presentation metadata', () => {
    const rendered = renderCard({
      v: 1,
      title: 'Android 生产提审',
      subtitle: '薪人薪事 · 应用宝 / 小米',
      state: 'running',
      badge: '已启动',
      facts: [{ label: '任务 ID', value: 'job-42' }],
      steps: [{ label: '打包', state: 'active' }],
      stores: [
        { id: 'yyb', name: '应用宝', state: 'pending' },
        { id: 'xiaomi', name: '小米', state: 'pending' },
      ],
      warnings: ['注意 dry-run'],
    }).join('\n')
    expect(rendered).toContain('Android 生产提审')
    expect(rendered).toContain('已启动')
    expect(rendered).toContain('job-42')
    expect(rendered).toContain('应用宝')
    expect(rendered).toContain('小米')
    expect(rendered).toContain('注意 dry-run')
  })

  it('falls back to the result text when no card was recorded', () => {
    const entry = registrations('android_publish_status')[0]!
    const rendered = text(entry.component({
      toolName: 'android_publish_status',
      phase: 'result',
      block: { kind: 'result', content: [{ type: 'text', text: 'legacy text output' }] },
      useDisclosure: () => ({ expanded: true, toggle: () => undefined }),
    })).join('\n')
    expect(rendered).toContain('legacy text output')
  })

  it('shows a failed call\'s error message instead of an empty card', () => {
    const entry = registrations('android_publish_status')[0]!
    const rendered = text(entry.component({
      toolName: 'android_publish_status',
      phase: 'result',
      block: { kind: 'result', isError: true, error: { message: 'job not found' }, content: [] },
      useDisclosure: () => ({ expanded: true, toggle: () => undefined }),
    })).join('\n')
    expect(rendered).toContain('job not found')
  })

  it('ignores an unknown card version instead of rendering garbage', () => {
    const rendered = renderCard({ v: 2, title: 'future card' }).join('\n')
    expect(rendered).not.toContain('future card')
    expect(rendered).toContain('raw result')
  })

  it('summarizes args while the call is still starting', () => {
    const entry = registrations('android_publish_start')[0]!
    const rendered = text(entry.component({
      toolName: 'android_publish_start',
      phase: 'start',
      block: { phase: 'start', args: { profileId: 'xrxs', mode: 'submit', stores: ['yyb'] } },
      useDisclosure: () => ({ expanded: false, toggle: () => undefined }),
    })).join('\n')
    expect(rendered).toContain('xrxs')
    expect(rendered).toContain('运行中')
  })
})