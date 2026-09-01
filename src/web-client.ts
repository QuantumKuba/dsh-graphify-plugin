import { createElement, memo, type CSSProperties } from 'react'
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { graphifyCommandInputDefinition } from './web-command.ts'
export { graphifyCommandInputDefinition, graphifyCommandText } from './web-command.ts'

const zh = {
  'commandInput.aria': '图谱命令输入',
} as const

type GraphifyLocaleKey = keyof typeof zh

const en: Record<GraphifyLocaleKey, string> = {
  'commandInput.aria': 'Graphify command input',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Graphify command presentation copy. */
    graphify: GraphifyLocaleKey
  }
}

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 6,
}

const stackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  minWidth: 0,
  maxWidth: 'min(525px, 82%)',
}

const bubbleStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  background: 'var(--dsw-specific-bubble)',
  maxWidth: '100%',
  color: 'var(--dsw-alias-label-primary)',
  font: 'var(--dsw-font-markdown-code)',
  whiteSpace: 'pre-wrap',
  borderRadius: 22,
  padding: '10px 16px',
}

type GraphifyCommandInputViewProps =
  & PropsRuntime<'conversation.chat.node', 'graphify-command-input'>
  & PropsLocale<'graphify'>

/** Right-aligned `/graphify` input bubble without ordinary message actions. */
export const GraphifyCommandInputView = memo(function GraphifyCommandInputView({
  node,
  t,
}: GraphifyCommandInputViewProps) {
  return createElement(
    'div',
    {
      style: rowStyle,
      'data-graphify-command-input': '',
      role: 'group',
      'aria-label': t('commandInput.aria'),
    },
    createElement(
      'div',
      { style: stackStyle },
      createElement(
        'div',
        { style: bubbleStyle },
        createElement(MessageText, { text: node.data.text }),
      ),
    ),
  )
})

/** Required DSH Web services for the Graphify command projection and renderer. */
export const inject = ['slots', 'locale', 'conversationEvents']

/**
 * Registers Graphify's browser-side DSH command presentation.
 * @param ctx - DSH client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(graphifyCommandInputDefinition)
  ctx.effect(
    () => ctx.locale.register('graphify', { zh, en }),
    'dsh-graphify: dictionaries',
  )
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'graphify-command-input',
    locale: 'graphify',
  }, GraphifyCommandInputView))
}
