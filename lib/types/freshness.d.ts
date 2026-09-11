import { spawn, spawnSync } from 'node:child_process';
import type { Config } from './config.ts';
import type { ResolvedProject, GraphFreshnessInfo } from './types.ts';
export declare const INDEX_METADATA_FILENAME = ".dsh-graphify-index.json";
/**
 * Proven core code file extensions supported by Graphify's built-in AST extractors.
 *
 * Verified against Graphify v0.9.57: strictly the conservative intersection of
 * `graphify.detect.CODE_EXTENSIONS` and AST-tier extractors (`_DISPATCH` in `graphify.extract`).
 * Changes strictly confined to these extensions can be safely refreshed via `graphify update`.
 * All other file types (manifests, documentation, config files, optional extras, images, etc.)
 * require a full refresh or rebuild.
 */
export declare const PROVEN_CODE_EXTENSIONS: ReadonlySet<string>;
/**
 * Checks whether a file path has a proven code extension.
 */
export declare function isProvenCodeFile(filePath: string): boolean;
export interface ChangedSource {
    path: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
    oldPath?: string;
}
export interface ChangedSourceInventory {
    files: ChangedSource[];
    complete: boolean;
    reason?: string;
}
/**
 * Checks whether a changed source is safe for incremental AST update.
 * For renames, both old and new paths must be proven code files.
 */
export declare function isSafeChange(change: ChangedSource): boolean;
/**
 * Parses Git `-z` output from `git diff --name-status -z -M`.
 */
export declare function parseNameStatusZ(raw: string): ChangedSource[];
/**
 * Durable metadata recorded by dsh-graphify after a successful graph build or update.
 *
 * V1: Original format without working-tree fingerprint.
 * V2: Adds `workingTreeFingerprint` for whole-tree dirty-state tracking.
 * V3: Adds per-path `indexedPaths` baseline capturing dirty files at index time,
 *     enabling exact delta reconstruction even when indexed dirty files are reverted or modified.
 */
export interface IndexedPathState {
    readonly path: string;
    readonly state: {
        readonly kind: 'modified';
        readonly hash: string;
    } | {
        readonly kind: 'untracked';
        readonly hash: string;
    } | {
        readonly kind: 'deleted';
    };
}
export interface GraphifyIndexMetadataV1 {
    readonly version: 1;
    readonly indexedAt: string;
    readonly graphPath: string;
    readonly graphMtimeMs: number;
    readonly git?: {
        readonly head: string;
        readonly tree: string;
        readonly branch?: string | null;
    };
}
export interface GraphifyIndexMetadataV2 {
    readonly version: 2;
    readonly indexedAt: string;
    readonly graphPath: string;
    readonly graphMtimeMs: number;
    readonly git?: {
        readonly head: string;
        readonly tree: string;
        readonly branch?: string | null;
        /** SHA-256 hash of tracked working tree diffs and untracked file manifest at index time. */
        readonly workingTreeFingerprint?: string;
    };
}
export interface GraphifyIndexMetadataV3 {
    readonly version: 3;
    readonly indexedAt: string;
    readonly graphPath: string;
    readonly graphMtimeMs: number;
    readonly git?: {
        readonly head: string;
        readonly tree: string;
        readonly branch?: string | null;
        /** SHA-256 hash of tracked working tree diffs and untracked file manifest at index time. */
        readonly workingTreeFingerprint?: string;
        /** Per-path dirty baseline states at graph-index time. */
        readonly indexedPaths?: Record<string, {
            kind: 'modified';
            hash: string;
        } | {
            kind: 'untracked';
            hash: string;
        } | {
            kind: 'deleted';
        }>;
        /** True ONLY when all git enumeration and source-state hashing succeeded completely at index time. */
        readonly baselineComplete?: boolean;
    };
}
export type GraphifyIndexMetadata = GraphifyIndexMetadataV1 | GraphifyIndexMetadataV2 | GraphifyIndexMetadataV3;
export interface SourceBaselineCapture {
    readonly complete: boolean;
    readonly indexedPaths: Record<string, {
        kind: 'modified';
        hash: string;
    } | {
        kind: 'untracked';
        hash: string;
    } | {
        kind: 'deleted';
    }>;
    readonly workingTreeFingerprint?: string;
    readonly reason?: string;
}
export interface CaptureBaselineOptions {
    spawnSync?: typeof spawnSync;
    hashFileContent?: (fullPath: string, projectRoot?: string) => string | undefined;
}
export interface UpdateResult {
    readonly success: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: string;
}
/**
 * Computes deterministic SHA-256 content hash of a file or symlink.
 *
 * For symbolic links: Hashes the symlink identity (`SHA256("symlink\0" + readlink(path))`)
 * rather than following target content, preventing false-fresh results when a symlink is retargeted
 * to an alternate file with identical content. Rejects outside-root symlinks by returning `undefined`.
 *
 * For regular files: Bounds memory using 64KB streaming for files exceeding LARGE_FILE_THRESHOLD.
 */
export declare function hashFileContent(fullPath: string, projectRoot?: string): string | undefined;
/**
 * Computes a deterministic fingerprint of the working tree's dirty state.
 *
 * Includes tracked working tree diff against HEAD (with `--binary` for correct
 * binary representation) and hashed content of every relevant untracked file.
 * Git staging state (`--cached`) is intentionally omitted so staging or unstaging
 * identical bytes does not alter the graph's freshness assessment.
 *
 * Fails closed by returning `undefined` if any git command fails or any untracked
 * source file cannot be hashed.
 *
 * @param projectRoot - Repository root directory.
 * @param excludePaths - Relative paths to exclude from fingerprint (e.g. custom
 *   graph output directories and metadata files). Always excludes `graphify-out/`
 *   and `.dsh-graphify-index.json` regardless.
 * @param options - Optional execution overrides for dependency injection in tests.
 */
export declare function computeWorkingTreeFingerprint(projectRoot: string, excludePaths?: Set<string>, options?: CaptureBaselineOptions): string | undefined;
/**
 * Captures per-path dirty baseline states at graph-index time.
 * Allows comparing indexed dirty working tree against current source state.
 *
 * Invariant: Returns `complete: true` ONLY when all git enumeration and source
 * hashing succeed without any errors or omitted paths.
 */
export declare function captureIndexedPathStates(projectRoot: string, excludePaths?: Set<string>, options?: CaptureBaselineOptions): SourceBaselineCapture;
/**
 * Writes a durable v3 index metadata file beside graph.json.
 * Uses atomic file write (temp file -> fsync -> rename) to prevent partial reads.
 */
export declare function writeGraphifyIndexMetadata(projectRoot: string, customGraphPath?: string, options?: CaptureBaselineOptions): GraphifyIndexMetadataV3 | null;
/**
 * Reads durable index metadata from beside the graph.json file.
 * Accepts v1, v2, and v3 metadata formats.
 *
 * @param projectRoot - Project root directory.
 * @param graphJsonPath - Explicit path to graph.json; when provided, metadata is
 *   read from the same directory rather than the hardcoded graphify-out/.
 */
export declare function readGraphifyIndexMetadata(projectRoot: string, graphJsonPath?: string | null): GraphifyIndexMetadata | null;
/**
 * Evaluates the freshness of a project's Graphify knowledge graph relative to
 * repository HEAD state, uncommitted working tree changes, and file modifications.
 */
export declare function checkGraphFreshness(project: ResolvedProject, options?: {
    maxScanFiles?: number;
}): GraphFreshnessInfo;
/** Recursive filesystem fallback: walks source directories excluding build and lock artifacts. */
export declare function checkFilesystemRecursiveFreshness(projectRoot: string, graphMtimeMs: number, maxFiles?: number): Omit<GraphFreshnessInfo, 'lastIndexedTime'>;
/**
 * Collects the inventory of changed source files between the indexed baseline state and the current working tree.
 *
 * For v3 metadata: Compares current source state directly against indexed dirty path states and commit tree.
 * Correctly detects modifications, additions, deletions, renames, and dirty-file reversions without false-fresh.
 *
 * For v1/v2 or missing metadata: Fails safe by returning `complete: false` so callers never assume code-only
 * updates can safely restore freshness.
 */
export declare function getChangedSourceInventory(projectRoot: string, metadata?: GraphifyIndexMetadata | null, graphJsonPath?: string | null): ChangedSourceInventory;
/**
 * Checks whether the project's graph target is the canonical `<projectRoot>/graphify-out/graph.json`.
 *
 * Graphify's `graphify update` CLI exclusively updates the canonical graph. Custom graphPath
 * configurations cannot be incrementally updated by `graphify update`.
 */
export declare function isCanonicalGraphForProject(projectRoot: string, graphJsonPath?: string | null): boolean;
export type AutoUpdateEligibility = {
    kind: 'eligible';
    projectRoot: string;
    graphJsonPath: string;
    changedSources: ChangedSource[];
} | {
    kind: 'requires-full-refresh';
    changedSources: ChangedSource[];
    unsupportedSources: ChangedSource[];
    reason: string;
} | {
    kind: 'unsupported-target';
    reason: string;
} | {
    kind: 'unknown';
    reason: string;
};
/**
 * Evaluates whether a project's graph can be safely auto-updated incrementally.
 *
 * Policy for v0.2.0: All-or-nothing.
 * An incremental update is only eligible if:
 * 1. The target graph is the canonical project graph (`graphify-out/graph.json`).
 * 2. Trustworthy v3 metadata baseline is available.
 * 3. Every detected changed source has a proven code extension supported by Graphify AST extractors.
 * If any non-code, documentation, manifest, or unproven source has changed, auto-update is rejected.
 */
export declare function evaluateAutoUpdateEligibility(project: ResolvedProject): AutoUpdateEligibility;
/**
 * Validates that a graph file represents a valid, coherent Graphify knowledge graph
 * according to Graphify's JSON export contract before writing freshness metadata.
 */
export declare function performPostUpdateValidation(projectRoot: string, graphJsonPath: string): boolean;
/**
 * Coalesces concurrent update requests for the same project root so multiple
 * agent turns never trigger duplicate simultaneous rebuilds.
 *
 * Tracks individual callers with AbortSignals so that one caller aborting
 * never cancels an in-progress update that other concurrent callers are awaiting.
 * Escalates to SIGTERM -> SIGKILL only when all callers have aborted or on timeout.
 */
export declare class ProjectUpdateCoalescer {
    private activeRuns;
    private spawnFn;
    constructor(options?: {
        spawn?: typeof spawn;
    });
    /**
     * Runs or awaits an in-progress incremental update for the given project.
     */
    update(config: Config, projectRoot: string, signal?: AbortSignal, _graphJsonPath?: string | null): Promise<UpdateResult>;
}
