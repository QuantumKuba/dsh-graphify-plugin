import type { Config } from './config.ts';
import type { ResolvedProject, GraphifyStatusResult } from './types.ts';
import type { GraphifyMcpClient } from './client.ts';
export interface CollectStatusOptions {
    /** If true, proactively probes the MCP connection if disconnected (default false). */
    readonly probe?: boolean;
}
/**
 * Collects a comprehensive status report for Graphify in the given project/session.
 * Non-destructive and fault-tolerant: failure of any individual metric does not fail
 * the entire diagnostic response.
 */
export declare function collectGraphifyStatus(project: ResolvedProject, client: GraphifyMcpClient, config: Config, options?: CollectStatusOptions): Promise<GraphifyStatusResult>;
/**
 * Formats a GraphifyStatusResult into a clear, scannable text summary for models and humans.
 */
export declare function formatGraphifyStatus(status: GraphifyStatusResult): string;
