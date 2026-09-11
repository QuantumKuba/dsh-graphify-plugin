import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveGraphifyCliRuntime, terminateChildProcess, DEFAULT_GRAPHIFY_VERSION, } from "./server-process.js";
import { INDEX_METADATA_FILENAME, readGraphifyIndexMetadata, writeGraphifyIndexMetadata, performPostUpdateValidation, getChangedSourceInventory, isSafeChange, } from "./freshness.js";
export const ALLOWED_GRAPHIFY_FLAGS = ['--force', '--no-cluster', '--code-only', '--no-viz'];
/**
 * Parses `/graphify [build|update] [path] [--force|--no-cluster|--code-only|--no-viz]` against the
 * receiving Session's project root.
 */
export function parseGraphifyCommand(rawInput, projectRoot) {
    const tokens = tokenize(rawInput);
    const operation = tokens[0] === 'update' ? 'update' : 'build';
    const rest = operation === 'update' || tokens[0] === 'build' ? tokens.slice(1) : tokens;
    const flags = rest.filter((token) => token.startsWith('-'));
    const paths = rest.filter((token) => !token.startsWith('-'));
    if (paths.length > 1) {
        throw new Error('Use one project path. Queries belong in Graphify tools, not `/graphify`.');
    }
    if (flags.some((flag) => !ALLOWED_GRAPHIFY_FLAGS.includes(flag))) {
        throw new Error('Only --force, --no-cluster, --code-only, and --no-viz are accepted by `/graphify`.');
    }
    return {
        operation,
        projectRoot: paths[0] ? path.resolve(projectRoot, paths[0]) : projectRoot,
        flags,
    };
}
/** Splits the small command grammar while retaining quoted project paths. */
function tokenize(input) {
    const tokens = [];
    let token = '';
    let quote;
    let escaping = false;
    for (const character of input.trim()) {
        if (escaping) {
            token += character;
            escaping = false;
            continue;
        }
        if (character === '\\') {
            escaping = true;
            continue;
        }
        if (quote) {
            if (character === quote)
                quote = undefined;
            else
                token += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (/\s/.test(character)) {
            if (token)
                tokens.push(token);
            token = '';
            continue;
        }
        token += character;
    }
    if (quote || escaping)
        throw new Error('The command has an unfinished quote or escape sequence.');
    if (token)
        tokens.push(token);
    return tokens;
}
/** Registers the `/graphify` build and incremental-update command. */
export function registerGraphifyCommand(ctx, config, defaultProjectRoot) {
    const def = {
        name: 'graphify',
        description: 'Build or incrementally update this project’s Graphify knowledge graph.',
        input: { hint: '[build|update] [path] [--force|--no-cluster|--code-only|--no-viz]' },
        async handler(invocation) {
            try {
                const projectRoot = invocation.agent.session.header.cwd || defaultProjectRoot;
                const request = parseGraphifyCommand(invocation.rawInput, projectRoot);
                const cliResolution = resolveGraphifyCliRuntime(config, request);
                if (!cliResolution.available) {
                    return {
                        kind: 'error',
                        text: `Graphify is not installed.\n\nInstall it with:\n  uv tool install 'graphifyy[mcp]==${DEFAULT_GRAPHIFY_VERSION}'\n\nor configure \`cliCommand\` in cordis.yml.`,
                    };
                }
                const { command, args } = cliResolution;
                const canonicalGraphJson = path.join(request.projectRoot, 'graphify-out', 'graph.json');
                if (request.operation === 'build') {
                    const isCodeOnly = request.flags.includes('--code-only');
                    const text = await runGraphify(command, args, request.projectRoot, invocation.signal);
                    if (isCodeOnly) {
                        // --code-only builds skip semantic/document sources; do not establish full-corpus baseline.
                        // Best-effort unlink preexisting index metadata so old baseline is not falsely assumed for new graph.
                        try {
                            const metaPath = path.join(path.dirname(canonicalGraphJson), INDEX_METADATA_FILENAME);
                            if (fs.existsSync(metaPath)) {
                                fs.unlinkSync(metaPath);
                            }
                        }
                        catch {
                            // Ignore unlink error
                        }
                        return {
                            kind: 'success',
                            text: `${text}\n\nNote: Graphify code-only build completed. Because --code-only skips semantic/document sources, this build does not establish a full-corpus freshness baseline.`,
                        };
                    }
                    if (performPostUpdateValidation(request.projectRoot, canonicalGraphJson)) {
                        let meta = null;
                        try {
                            meta = writeGraphifyIndexMetadata(request.projectRoot, canonicalGraphJson);
                        }
                        catch {
                            // Metadata recording failure ignored
                        }
                        if (meta?.git?.baselineComplete === true) {
                            return { kind: 'success', text };
                        }
                        else {
                            return {
                                kind: 'success',
                                text: `${text}\n\nWarning: Graphify build completed, but dsh-graphify could not capture a complete source-state baseline. Freshness remains unverified.`,
                            };
                        }
                    }
                    else {
                        return {
                            kind: 'success',
                            text: `${text}\n\nWarning: Post-build validation failed for graph.json. Freshness metadata was not recorded.`,
                        };
                    }
                }
                // Incremental update (/graphify update)
                const priorMeta = readGraphifyIndexMetadata(request.projectRoot, canonicalGraphJson);
                let eligibleForCheckpoint = false;
                let checkpointBlockReason = '';
                const isTrustworthyV3 = priorMeta !== null &&
                    priorMeta.version === 3 &&
                    priorMeta.git !== undefined &&
                    priorMeta.git.baselineComplete === true &&
                    priorMeta.git.indexedPaths !== undefined;
                if (!isTrustworthyV3) {
                    eligibleForCheckpoint = false;
                    checkpointBlockReason =
                        'Freshness metadata predates source-state tracking or has incomplete baseline. Freshness checkpoint was not advanced. Run a full Graphify build (/graphify build) to establish a trustworthy freshness baseline.';
                }
                else {
                    const inventory = getChangedSourceInventory(request.projectRoot, priorMeta, canonicalGraphJson);
                    if (!inventory.complete) {
                        eligibleForCheckpoint = false;
                        checkpointBlockReason =
                            inventory.reason ||
                                'Source state relative to indexed graph baseline could not be safely verified. Freshness checkpoint was not advanced. Run a full Graphify build (/graphify build) to make the graph fully current.';
                    }
                    else {
                        const unsupportedSources = inventory.files.filter((f) => !isSafeChange(f));
                        if (unsupportedSources.length > 0) {
                            eligibleForCheckpoint = false;
                            checkpointBlockReason =
                                'Semantic or unsupported source changes were detected. Freshness checkpoint was not advanced. Run a full Graphify build (/graphify build) to make the graph fully current.';
                        }
                        else {
                            eligibleForCheckpoint = true;
                        }
                    }
                }
                const text = await runGraphify(command, args, request.projectRoot, invocation.signal);
                if (eligibleForCheckpoint) {
                    if (performPostUpdateValidation(request.projectRoot, canonicalGraphJson)) {
                        // Re-verify that no unsupported sources were introduced concurrently during the update
                        const postInventory = getChangedSourceInventory(request.projectRoot, priorMeta, canonicalGraphJson);
                        const postUnsupported = postInventory.complete ? postInventory.files.filter((f) => !isSafeChange(f)) : [];
                        if (postInventory.complete && postUnsupported.length === 0) {
                            let updatedMeta = null;
                            try {
                                updatedMeta = writeGraphifyIndexMetadata(request.projectRoot, canonicalGraphJson);
                            }
                            catch {
                                // Ignore metadata recording failure
                            }
                            if (updatedMeta?.git?.baselineComplete === true) {
                                return { kind: 'success', text };
                            }
                            else {
                                return {
                                    kind: 'success',
                                    text: `${text}\n\nWarning: Graphify incremental update completed, but dsh-graphify could not capture a complete source-state baseline. Freshness remains unverified.`,
                                };
                            }
                        }
                        else {
                            return {
                                kind: 'success',
                                text: `${text}\n\nNote: Graphify incremental update completed, but source state changed during update. Freshness checkpoint was not advanced. Run a full Graphify build (/graphify build) to make the graph fully current.`,
                            };
                        }
                    }
                    else {
                        return {
                            kind: 'success',
                            text: `${text}\n\nWarning: Post-update validation failed for graph.json. Freshness metadata was not recorded.`,
                        };
                    }
                }
                else {
                    return {
                        kind: 'success',
                        text: `${text}\n\nNote: Graphify incremental update completed, but ${checkpointBlockReason}`,
                    };
                }
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                return { kind: 'error', text: `Graphify failed: ${text}` };
            }
        },
    };
    return ctx.commands.register(def);
}
/** Runs Graphify while preserving a bounded, useful result for the command UI. */
function runGraphify(command, args, cwd, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const onAbort = () => {
            terminateChildProcess(child).finally(() => {
                settle(() => reject(new Error('Graphify command cancelled')));
            });
        };
        const settle = (action) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            action();
        };
        const append = (current, chunk) => {
            const combined = current + chunk.toString('utf8');
            return combined.length > 65_536 ? combined.slice(-65_536) : combined;
        };
        child.stdout?.on('data', (chunk) => {
            stdout = append(stdout, chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr = append(stderr, chunk);
        });
        signal.addEventListener('abort', onAbort, { once: true });
        child.once('error', (error) => settle(() => reject(error)));
        child.once('close', (code, childSignal) => {
            if (signal.aborted) {
                settle(() => reject(new Error('Graphify command cancelled')));
                return;
            }
            if (code === 0) {
                settle(() => resolve(stdout || 'Graphify completed successfully.'));
                return;
            }
            const status = childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`;
            settle(() => reject(new Error(stderr || stdout || `Graphify exited with ${status}`)));
        });
    });
}
