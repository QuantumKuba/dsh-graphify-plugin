import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  graphifyCommandInputDefinition,
  graphifyCommandText,
} from '../src/web-command.ts'

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
})
