import type { DetectedGraph } from './types.ts';
/**
 * Probes for an existing Graphify knowledge graph starting at searchDir
 * and traversing upward to ancestor directories.
 *
 * @param searchDir - Starting directory (defaults to process.cwd()).
 * @param customGraphPath - Optional explicit graph.json or graphify-out directory path.
 * @returns DetectedGraph information or null if no graph is found.
 */
export declare function detectGraph(searchDir?: string, customGraphPath?: string): DetectedGraph | null;
/** Reads Graphify's optional authoritative scan-root marker. */
export declare function readValidGraphifyRoot(graphDir: string): string | undefined;
