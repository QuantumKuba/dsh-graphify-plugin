import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
export { graphifyCommandInputDefinition, graphifyCommandText } from './web-command.ts';
declare const zh: {
    readonly 'commandInput.aria': "图谱命令输入";
};
type GraphifyLocaleKey = keyof typeof zh;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** Graphify command presentation copy. */
        graphify: GraphifyLocaleKey;
    }
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Target-neutral Conversation registries and per-Session assembly. */
        uiConversation: {
            readonly events: {
                register(definition: unknown): () => void;
            };
        };
    }
}
type GraphifyCommandInputViewProps = PropsRuntime<'conversation.chat.node', 'graphify-command-input'> & PropsLocale<'graphify'>;
/** Right-aligned `/graphify` input bubble without ordinary message actions. */
export declare const GraphifyCommandInputView: import("react").NamedExoticComponent<GraphifyCommandInputViewProps>;
/** Required DSH Web services for the Graphify command projection and renderer. */
export declare const inject: string[];
/**
 * Registers Graphify's browser-side DSH command presentation.
 * @param ctx - DSH client Cordis context.
 */
export declare function apply(ctx: ClientContext): void;
