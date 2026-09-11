import { createElement, memo } from 'react';
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives';
import { graphifyCommandInputDefinition } from "./web-command.js";
export { graphifyCommandInputDefinition, graphifyCommandText } from "./web-command.js";
const zh = {
    'commandInput.aria': '图谱命令输入',
};
const en = {
    'commandInput.aria': 'Graphify command input',
};
const rowStyle = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 6,
};
const stackStyle = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    minWidth: 0,
    maxWidth: 'min(525px, 82%)',
};
const bubbleStyle = {
    overflowWrap: 'anywhere',
    background: 'var(--dsw-specific-bubble)',
    maxWidth: '100%',
    color: 'var(--dsw-alias-label-primary)',
    font: 'var(--dsw-font-markdown-code)',
    whiteSpace: 'pre-wrap',
    borderRadius: 22,
    padding: '10px 16px',
};
/** Right-aligned `/graphify` input bubble without ordinary message actions. */
export const GraphifyCommandInputView = memo(function GraphifyCommandInputView({ node, t, }) {
    return createElement('div', {
        style: rowStyle,
        'data-graphify-command-input': '',
        role: 'group',
        'aria-label': t('commandInput.aria'),
    }, createElement('div', { style: stackStyle }, createElement('div', { style: bubbleStyle }, createElement(MessageText, { text: node.data.text }))));
});
/** Required DSH Web services for the Graphify command projection and renderer. */
export const inject = ['slots', 'locale', 'uiConversation'];
/**
 * Registers Graphify's browser-side DSH command presentation.
 * @param ctx - DSH client Cordis context.
 */
export function apply(ctx) {
    ctx.uiConversation.events.register(graphifyCommandInputDefinition);
    ctx.effect(() => ctx.locale.register('graphify', { zh, en }), 'dsh-graphify: dictionaries');
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'graphify-command-input',
        locale: 'graphify',
    }, GraphifyCommandInputView));
}
