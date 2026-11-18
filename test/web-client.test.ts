import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  graphifyCommandInputDefinition,
  graphifyCommandText,
} from '../src/web-command.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(repositoryRoot, 'lib', 'graphify-client.js')

function loadWebClientBundle(): {
  inject: string[]
  apply: (ctx: any) => void
  graphifyCommandInputDefinition: unknown
  GraphifyCommandInputView: unknown
} {
  let loadedEntry: { id: string; factory: (req: (id: string) => any) => any } | null = null
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(entry: any) {
          loadedEntry = entry
        },
      },
    },
  })
  const code = fs.readFileSync(bundlePath, 'utf8')
  vm.runInContext(code, context)

  if (!loadedEntry) throw new Error('Failed to load bundle into __ModuleLoader__')

  const exports = (loadedEntry as any).factory((id: string) => {
    if (id === 'react') {
      return {
        memo: (fn: any) => fn,
        createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): RenderedElement => (
          { type, props: props ?? {}, children }
        ),
      }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return primitives
    }
    throw new Error(`Unexpected require: ${id}`)
  })
  return exports
}

interface RenderedElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

function ReferenceChip(): null { return null }
function UserTextRun(): null { return null }
const primitives = { ReferenceChip, UserTextRun }

function renderBubbleContent(text: string): unknown {
  const { GraphifyCommandInputView } = loadWebClientBundle()
  const view = GraphifyCommandInputView as (props: unknown) => RenderedElement
  const row = view({ node: { data: { text } }, t: (key: string) => key })
  const stack = row.children[0] as RenderedElement
  const bubble = stack.children[0] as RenderedElement
  return bubble.children[0]
}

/** Bundle values come from the VM realm; JSON copies them into this realm for strict comparison. */
function summarize(element: unknown): unknown {
  if (Array.isArray(element)) return JSON.parse(JSON.stringify(element.map(summarize)))
  const rendered = element as RenderedElement
  const { key: _key, ...props } = rendered.props
  return JSON.parse(JSON.stringify({ type: (rendered.type as { name: string }).name, props }))
}

function commandRun(name: string, args: string): SessionEvent<'command/run'> {
  return {
    seq: 7,
    time: 1_725_000_000_000,
    type: 'command/run',
    data: {
      commandId: 'command-7',
      name,
      args,
    },
  } as SessionEvent<'command/run'>
}

describe('Graphify DSH Web command presentation', () => {
  it('reconstructs the command text from the durable command run', () => {
    assert.equal(graphifyCommandText(commandRun('graphify', ' update .  ')), '/graphify update .')
  })

  it('claims only graphify command runs as visible chat starts', () => {
    assert.deepEqual(graphifyCommandInputDefinition.match(commandRun('graphify', '')), {
      id: 'command-7',
      role: 'start',
    })
    assert.equal(graphifyCommandInputDefinition.match(commandRun('goal', ' test')), null)
  })

  it('declares the required DSH web services in inject', () => {
    const { inject } = loadWebClientBundle()
    assert.deepEqual([...inject], ['slots', 'locale', 'uiConversation'])
    assert.equal(inject.includes('conversationEvents'), false)
  })

  it('renders the command token as a display-only command chip followed by its arguments', () => {
    assert.deepEqual(summarize(renderBubbleContent('/graphify update .')), [
      { type: 'ReferenceChip', props: { appearance: 'command', label: '/graphify', title: '/graphify' } },
      { type: 'UserTextRun', props: { text: ' update .' } },
    ])
    assert.deepEqual(summarize(renderBubbleContent('/graphify')), {
      type: 'ReferenceChip',
      props: { appearance: 'command', label: '/graphify', title: '/graphify' },
    })
  })

  it('renders text without a standalone command token as one plain run', () => {
    assert.deepEqual(summarize(renderBubbleContent('/graphifyx')), {
      type: 'UserTextRun',
      props: { text: '/graphifyx' },
    })
  })

  it('registers command input definition, locale dictionaries, and chat slot renderer in apply', () => {
    const { apply, graphifyCommandInputDefinition: bundleDefinition, GraphifyCommandInputView } = loadWebClientBundle()
    let registeredDefinition: unknown = null
    let registeredLocale: { ns: string; dicts: unknown } | null = null
    let registeredSlot: { name: string; key: string; locale?: string; component: unknown } | null = null

    const mockCtx: any = {
      uiConversation: {
        events: {
          register(def: unknown) {
            registeredDefinition = def
            return () => { registeredDefinition = null }
          },
        },
      },
      locale: {
        register(ns: string, dicts: unknown) {
          registeredLocale = { ns, dicts }
          return () => { registeredLocale = null }
        },
      },
      slots: {
        inject(name: string, callback: () => void) {
          callback()
        },
        register(entry: any, component: any) {
          registeredSlot = { ...entry, component }
          return () => { registeredSlot = null }
        },
      },
      effect(fn: () => (() => void) | void) {
        return fn()
      },
    }

    apply(mockCtx)

    assert.equal(registeredDefinition, bundleDefinition)
    assert.equal(registeredLocale?.ns, 'graphify')
    assert.deepEqual(registeredSlot, {
      name: 'conversation.chat.node',
      key: 'graphify-command-input',
      locale: 'graphify',
      component: GraphifyCommandInputView,
    })
  })
})
