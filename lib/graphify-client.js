window.__ModuleLoader__.load({
	id: "dsh-graphify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/web-command.ts
		/**
		* Derives the visible command line from its durable structured run.
		* @param event - `/graphify` command run.
		* @returns Command text with trailing parser whitespace removed.
		*/
		function graphifyCommandText(event) {
			return `/${event.data.name}${(event.data.args ?? "").trimEnd()}`;
		}
		/** Graphify-owned command input projection; DSH retains the generic result row. */
		const graphifyCommandInputDefinition = {
			kind: "graphify-command-input",
			target: "chat",
			match: (event) => event.type === "command/run" && event.data.name === "graphify" ? {
				id: String(event.data.commandId),
				role: "start"
			} : null,
			start: (_context, match) => {
				if (match.event.type !== "command/run") throw new Error("graphify-command-input start requires command/run");
				return {
					commandId: match.event.data.commandId,
					seq: match.event.seq,
					time: match.event.time,
					text: graphifyCommandText(match.event)
				};
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				if (context.state === void 0) return null;
				return {
					key: context.key,
					kind: "graphify-command-input",
					id: context.id,
					target: "chat",
					anchorSeq: context.state.seq - .1,
					location: context.start?.location ?? { kind: "unresolved" },
					visibility: "visible",
					data: {
						commandId: context.state.commandId,
						text: context.state.text,
						time: context.state.time
					}
				};
			}
		};
		//#endregion
		//#region src/web-client.ts
		const zh = { "commandInput.aria": "图谱命令输入" };
		const en = { "commandInput.aria": "Graphify command input" };
		const rowStyle = {
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			gap: 6
		};
		const stackStyle = {
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
			minWidth: 0,
			maxWidth: "min(525px, 82%)"
		};
		const bubbleStyle = {
			overflowWrap: "anywhere",
			background: "var(--dsw-specific-bubble)",
			maxWidth: "100%",
			color: "var(--dsw-alias-label-primary)",
			font: "var(--dsw-font-markdown-code)",
			whiteSpace: "pre-wrap",
			borderRadius: 22,
			padding: "10px 16px"
		};
		/** Right-aligned `/graphify` input bubble without ordinary message actions. */
		const GraphifyCommandInputView = (0, react.memo)(function GraphifyCommandInputView({ node, t }) {
			return (0, react.createElement)("div", {
				style: rowStyle,
				"data-graphify-command-input": "",
				role: "group",
				"aria-label": t("commandInput.aria")
			}, (0, react.createElement)("div", { style: stackStyle }, (0, react.createElement)("div", { style: bubbleStyle }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.MessageText, { text: node.data.text }))));
		});
		/** Required DSH Web services for the Graphify command projection and renderer. */
		const inject = [
			"slots",
			"locale",
			"uiConversation"
		];
		/**
		* Registers Graphify's browser-side DSH command presentation.
		* @param ctx - DSH client Cordis context.
		*/
		function apply(ctx) {
			ctx.uiConversation.events.register(graphifyCommandInputDefinition);
			ctx.effect(() => ctx.locale.register("graphify", {
				zh,
				en
			}), "dsh-graphify: dictionaries");
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "graphify-command-input",
				locale: "graphify"
			}, GraphifyCommandInputView));
		}
		//#endregion
		exports.GraphifyCommandInputView = GraphifyCommandInputView;
		exports.apply = apply;
		exports.graphifyCommandInputDefinition = graphifyCommandInputDefinition;
		exports.graphifyCommandText = graphifyCommandText;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=graphify-client.js.map