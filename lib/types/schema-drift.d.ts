import type { ToolDefinition, McpToolInfo } from './types.ts';
export type DriftKind = 'tool_added' | 'tool_removed' | 'argument_added' | 'argument_removed' | 'required_argument_changed' | 'type_changed' | 'enum_changed';
export type DriftSeverity = 'breaking' | 'informational';
export interface SchemaDifference {
    readonly tool: string;
    readonly kind: DriftKind;
    readonly severity: DriftSeverity;
    readonly detail: string;
}
export interface SchemaDriftReport {
    readonly differences: readonly SchemaDifference[];
    readonly breakingCount: number;
    readonly informationalCount: number;
    readonly hasBreakingDrift: boolean;
    readonly summary: string;
}
/**
 * Resolves the canonical Graphify tool name from a potentially prefixed DSH tool name.
 * Returns null if the tool is a plugin-local utility that does not exist upstream.
 *
 * Handles arbitrary prefix lengths by checking whether the tool name, after stripping
 * the prefix, matches a canonical upstream tool name or a plugin-local suffix.
 */
export declare function getCanonicalGraphifyName(toolName: string): string | null;
/**
 * Compares known native Graphify tool schemas against the upstream tools/list result.
 * Distinguishes between informational additions (new optional tools or parameters) and
 * breaking drift affecting native first-class tool contracts.
 *
 * Normalizes tool prefixes before comparing so configured prefixes do not cause false drifts.
 */
export declare function compareToolSchemas(nativeTools: readonly ToolDefinition[], upstreamTools: readonly McpToolInfo[]): SchemaDriftReport;
