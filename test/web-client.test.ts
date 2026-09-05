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
      return { memo: (fn: any) => fn, createElement: () => ({}) }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { MessageText: () => ({}) }
    }
    throw new Error(`Unexpected require: ${id}`)
  })
  return exports
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
