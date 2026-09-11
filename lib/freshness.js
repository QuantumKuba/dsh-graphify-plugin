import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveGraphifyCliCommand, terminateChildProcess } from "./server-process.js";
export const INDEX_METADATA_FILENAME = '.dsh-graphify-index.json';
/**
 * Proven core code file extensions supported by Graphify's built-in AST extractors.
 *
 * Verified against Graphify v0.9.57: strictly the conservative intersection of
 * `graphify.detect.CODE_EXTENSIONS` and AST-tier extractors (`_DISPATCH` in `graphify.extract`).
 * Changes strictly confined to these extensions can be safely refreshed via `graphify update`.
 * All other file types (manifests, documentation, config files, optional extras, images, etc.)
 * require a full refresh or rebuild.
 */
export const PROVEN_CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.mts', '.cts',
    '.js', '.jsx', '.mjs', '.cjs',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
    '.cs',
    '.rb', '.rake',
    '.kt', '.kts',
    '.swift',
    '.php',
    '.lua', '.luau',
    '.zig',
    '.sh', '.bash',
]);
/**
 * Checks whether a file path has a proven code extension.
 */
export function isProvenCodeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return PROVEN_CODE_EXTENSIONS.has(ext);
}
/**
 * Checks whether a changed source is safe for incremental AST update.
 * For renames, both old and new paths must be proven code files.
 */
export function isSafeChange(change) {
    if (change.status === 'renamed') {
        if (!change.oldPath)
            return false;
        return isProvenCodeFile(change.path) && isProvenCodeFile(change.oldPath);
    }
    return isProvenCodeFile(change.path);
}
/**
 * Parses Git `-z` output from `git diff --name-status -z -M`.
 */
export function parseNameStatusZ(raw) {
    const tokens = raw.split('\0');
    if (tokens.length > 0 && tokens[tokens.length - 1] === '') {
        tokens.pop();
    }
    const result = [];
    let i = 0;
    while (i < tokens.length) {
        const statusToken = tokens[i];
        if (!statusToken) {
            i++;
            continue;
        }
        const statusCode = statusToken[0];
        if (statusCode === 'R' || statusCode === 'C') {
            const oldPath = tokens[i + 1];
            const newPath = tokens[i + 2];
            if (oldPath !== undefined && newPath !== undefined) {
                result.push({
                    path: newPath,
                    oldPath,
                    status: statusCode === 'R' ? 'renamed' : 'added',
                });
            }
            i += 3;
        }
        else {
            const filePath = tokens[i + 1];
            if (filePath !== undefined) {
                let status = 'modified';
                if (statusCode === 'A')
                    status = 'added';
                else if (statusCode === 'D')
                    status = 'deleted';
                result.push({
                    path: filePath,
                    status,
                });
            }
            i += 2;
        }
    }
    return result;
}
/** Large-file threshold for streaming hash instead of full read (10 MB). */
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
/**
 * Computes deterministic SHA-256 content hash of a file or symlink.
 *
 * For symbolic links: Hashes the symlink identity (`SHA256("symlink\0" + readlink(path))`)
 * rather than following target content, preventing false-fresh results when a symlink is retargeted
 * to an alternate file with identical content. Rejects outside-root symlinks by returning `undefined`.
 *
 * For regular files: Bounds memory using 64KB streaming for files exceeding LARGE_FILE_THRESHOLD.
 */
export function hashFileContent(fullPath, projectRoot) {
    try {
        const lstat = fs.lstatSync(fullPath);
        if (lstat.isSymbolicLink()) {
            const target = fs.readlinkSync(fullPath);
            if (projectRoot) {
                const resolvedTarget = path.resolve(path.dirname(fullPath), target);
                const rel = path.relative(path.resolve(projectRoot), resolvedTarget);
                if (rel.startsWith('..') || path.isAbsolute(rel)) {
                    return undefined;
                }
            }
            return createHash('sha256').update(`symlink\0${target}`).digest('hex');
        }
        else if (!lstat.isFile()) {
            return undefined;
        }
        const stat = fs.statSync(fullPath);
        const hash = createHash('sha256');
        if (stat.size > LARGE_FILE_THRESHOLD) {
            const fd = fs.openSync(fullPath, 'r');
            try {
                const buf = Buffer.alloc(65536);
                let bytesRead;
                while ((bytesRead = fs.readSync(fd, buf)) > 0) {
                    hash.update(buf.subarray(0, bytesRead));
                }
            }
            finally {
                fs.closeSync(fd);
            }
        }
        else {
            hash.update(fs.readFileSync(fullPath));
        }
        return hash.digest('hex');
    }
    catch {
        return undefined;
    }
}
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
export function computeWorkingTreeFingerprint(projectRoot, excludePaths, options) {
    try {
        const spawnSyncFn = options?.spawnSync ?? spawnSync;
        const hashFn = options?.hashFileContent ?? hashFileContent;
        const hash = createHash('sha256');
        const isExcluded = (relativePath) => {
            if (relativePath.startsWith('graphify-out/') || relativePath === 'graphify-out' ||
                relativePath.includes('/graphify-out/'))
                return true;
            if (path.basename(relativePath) === INDEX_METADATA_FILENAME)
                return true;
            if (excludePaths) {
                for (const exc of excludePaths) {
                    if (relativePath === exc || relativePath.startsWith(exc + '/'))
                        return true;
                }
            }
            return false;
        };
        const pathspecExclusions = [
            ':!graphify-out',
            ':!*/graphify-out',
            ':!*.dsh-graphify-index.json',
            ':!*.dsh-graphify-index.json*',
        ];
        if (excludePaths) {
            for (const exc of excludePaths) {
                pathspecExclusions.push(`:!${exc}`);
            }
        }
        // Tracked working tree changes relative to HEAD (covers effective working tree modifications)
        const diffRes = spawnSyncFn('git', ['diff', '--binary', 'HEAD', '--', '.', ...pathspecExclusions], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 5000,
        });
        if (diffRes.status !== 0 || diffRes.error) {
            return undefined;
        }
        hash.update(diffRes.stdout ?? '');
        // Untracked files: hash relative path + actual file content for each
        const untrackedRes = spawnSyncFn('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 5000,
        });
        if (untrackedRes.status !== 0 || untrackedRes.error) {
            return undefined;
        }
        if (untrackedRes.stdout) {
            const files = untrackedRes.stdout.split('\0')
                .filter(f => f && !isExcluded(f))
                .sort();
            for (const file of files) {
                hash.update(`untracked:${file}\n`);
                const fullPath = path.join(projectRoot, file);
                const fileHash = hashFn(fullPath, projectRoot);
                if (!fileHash) {
                    return undefined;
                }
                hash.update(fileHash);
            }
        }
        return hash.digest('hex');
    }
    catch {
        return undefined;
    }
}
/**
 * Captures per-path dirty baseline states at graph-index time.
 * Allows comparing indexed dirty working tree against current source state.
 *
 * Invariant: Returns `complete: true` ONLY when all git enumeration and source
 * hashing succeed without any errors or omitted paths.
 */
export function captureIndexedPathStates(projectRoot, excludePaths, options) {
    const spawnSyncFn = options?.spawnSync ?? spawnSync;
    const hashFn = options?.hashFileContent ?? hashFileContent;
    try {
        const indexedPaths = {};
        const isExcluded = (relativePath) => {
            if (relativePath.startsWith('graphify-out/') || relativePath === 'graphify-out' ||
                relativePath.includes('/graphify-out/'))
                return true;
            if (path.basename(relativePath) === INDEX_METADATA_FILENAME)
                return true;
            if (excludePaths) {
                for (const exc of excludePaths) {
                    if (relativePath === exc || relativePath.startsWith(exc + '/'))
                        return true;
                }
            }
            return false;
        };
        const pathspecExclusions = [
            ':!graphify-out',
            ':!*/graphify-out',
            ':!*.dsh-graphify-index.json',
            ':!*.dsh-graphify-index.json*',
        ];
        if (excludePaths) {
            for (const exc of excludePaths) {
                pathspecExclusions.push(`:!${exc}`);
            }
        }
        // 1. Tracked working tree diff against HEAD
        const diffRes = spawnSyncFn('git', ['diff', '--name-status', '-z', '-M', 'HEAD', '--', '.', ...pathspecExclusions], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 5000,
        });
        if (diffRes.status !== 0 || diffRes.error) {
            return {
                complete: false,
                indexedPaths: {},
                reason: `git diff enumeration failed${diffRes.error ? `: ${diffRes.error.message}` : ''}`,
            };
        }
        if (diffRes.stdout) {
            const changed = parseNameStatusZ(diffRes.stdout);
            for (const change of changed) {
                if (isExcluded(change.path))
                    continue;
                if (change.status === 'deleted') {
                    indexedPaths[change.path] = { kind: 'deleted' };
                }
                else {
                    if (change.status === 'renamed' && change.oldPath && !isExcluded(change.oldPath)) {
                        indexedPaths[change.oldPath] = { kind: 'deleted' };
                    }
                    const fullPath = path.join(projectRoot, change.path);
                    const hash = hashFn(fullPath, projectRoot);
                    if (!hash) {
                        return {
                            complete: false,
                            indexedPaths: {},
                            reason: `Failed to hash tracked modified source: ${change.path}`,
                        };
                    }
                    indexedPaths[change.path] = { kind: 'modified', hash };
                }
            }
        }
        // 2. Untracked files
        const untrackedRes = spawnSyncFn('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 5000,
        });
        if (untrackedRes.status !== 0 || untrackedRes.error) {
            return {
                complete: false,
                indexedPaths: {},
                reason: `git ls-files enumeration failed${untrackedRes.error ? `: ${untrackedRes.error.message}` : ''}`,
            };
        }
        if (untrackedRes.stdout) {
            const files = untrackedRes.stdout.split('\0').filter(f => f && !isExcluded(f));
            for (const file of files) {
                const fullPath = path.join(projectRoot, file);
                const hash = hashFn(fullPath, projectRoot);
                if (!hash) {
                    return {
                        complete: false,
                        indexedPaths: {},
                        reason: `Failed to hash untracked source: ${file}`,
                    };
                }
                indexedPaths[file] = { kind: 'untracked', hash };
            }
        }
        const workingTreeFingerprint = computeWorkingTreeFingerprint(projectRoot, excludePaths, options);
        if (workingTreeFingerprint === undefined && Object.keys(indexedPaths).length > 0) {
            return {
                complete: false,
                indexedPaths: {},
                reason: 'Working tree fingerprint calculation failed for dirty state',
            };
        }
        return {
            complete: true,
            indexedPaths,
            workingTreeFingerprint,
        };
    }
    catch (err) {
        return {
            complete: false,
            indexedPaths: {},
            reason: err instanceof Error ? err.message : String(err),
        };
    }
}
/**
 * Builds the set of relative paths that must be excluded from working-tree
 * fingerprinting so that Graphify-generated output does not self-invalidate.
 */
function buildExcludePaths(projectRoot, graphPath) {
    const excludes = new Set();
    const graphDir = path.dirname(graphPath);
    const relGraphDir = path.relative(projectRoot, graphDir);
    if (relGraphDir && !relGraphDir.startsWith('..') && relGraphDir !== '.') {
        excludes.add(relGraphDir);
    }
    const relGraphPath = path.relative(projectRoot, graphPath);
    if (relGraphPath && !relGraphPath.startsWith('..')) {
        excludes.add(relGraphPath);
    }
    return excludes;
}
/**
 * Writes a durable v3 index metadata file beside graph.json.
 * Uses atomic file write (temp file -> fsync -> rename) to prevent partial reads.
 */
export function writeGraphifyIndexMetadata(projectRoot, customGraphPath, options) {
    const graphPath = customGraphPath || path.join(projectRoot, 'graphify-out', 'graph.json');
    if (!fs.existsSync(graphPath))
        return null;
    let graphMtimeMs = Date.now();
    try {
        graphMtimeMs = fs.statSync(graphPath).mtimeMs;
    }
    catch {
        // Fall back to current time
    }
    const excludePaths = buildExcludePaths(projectRoot, graphPath);
    const spawnSyncFn = options?.spawnSync ?? spawnSync;
    let gitInfo;
    try {
        const headRes = spawnSyncFn('git', ['rev-parse', 'HEAD'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 2000,
        });
        if (headRes.status === 0 && headRes.stdout && headRes.stdout.trim()) {
            const head = headRes.stdout.trim();
            const treeRes = spawnSyncFn('git', ['rev-parse', 'HEAD^{tree}'], {
                cwd: projectRoot,
                encoding: 'utf8',
                timeout: 2000,
            });
            const tree = treeRes.status === 0 && treeRes.stdout && treeRes.stdout.trim() ? treeRes.stdout.trim() : head;
            const branchRes = spawnSyncFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
                cwd: projectRoot,
                encoding: 'utf8',
                timeout: 2000,
            });
            const branch = branchRes.status === 0 && branchRes.stdout ? branchRes.stdout.trim() : null;
            const baselineCapture = captureIndexedPathStates(projectRoot, excludePaths, options);
            const workingTreeFingerprint = baselineCapture.workingTreeFingerprint ?? computeWorkingTreeFingerprint(projectRoot, excludePaths, options);
            gitInfo = {
                head,
                tree,
                branch,
                workingTreeFingerprint,
                indexedPaths: baselineCapture.indexedPaths,
                baselineComplete: baselineCapture.complete === true,
            };
        }
    }
    catch {
        // Non-git environment
    }
    const metadata = {
        version: 3,
        indexedAt: new Date(graphMtimeMs).toISOString(),
        graphPath: path.relative(projectRoot, graphPath),
        graphMtimeMs,
        ...(gitInfo ? { git: gitInfo } : {}),
    };
    const metaDir = path.dirname(graphPath);
    if (fs.existsSync(metaDir)) {
        const metaFilePath = path.join(metaDir, INDEX_METADATA_FILENAME);
        const tempFilePath = path.join(metaDir, `${INDEX_METADATA_FILENAME}.${Date.now()}.${process.pid}.tmp`);
        let renamed = false;
        try {
            fs.writeFileSync(tempFilePath, JSON.stringify(metadata, null, 2), 'utf8');
            try {
                const fd = fs.openSync(tempFilePath, 'r');
                fs.fsyncSync(fd);
                fs.closeSync(fd);
            }
            catch {
                // fsync error ignored
            }
            fs.renameSync(tempFilePath, metaFilePath);
            renamed = true;
            return metadata;
        }
        catch {
            // Ignored if unwritable
        }
        finally {
            if (!renamed) {
                try {
                    if (fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath);
                    }
                }
                catch {
                    // Best-effort cleanup
                }
            }
        }
    }
    return null;
}
/**
 * Reads durable index metadata from beside the graph.json file.
 * Accepts v1, v2, and v3 metadata formats.
 *
 * @param projectRoot - Project root directory.
 * @param graphJsonPath - Explicit path to graph.json; when provided, metadata is
 *   read from the same directory rather than the hardcoded graphify-out/.
 */
export function readGraphifyIndexMetadata(projectRoot, graphJsonPath) {
    const metaDir = graphJsonPath
        ? path.dirname(graphJsonPath)
        : path.join(projectRoot, 'graphify-out');
    const metaPath = path.join(metaDir, INDEX_METADATA_FILENAME);
    if (!fs.existsSync(metaPath))
        return null;
    try {
        const raw = fs.readFileSync(metaPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed &&
            (parsed.version === 1 || parsed.version === 2 || parsed.version === 3) &&
            typeof parsed.graphMtimeMs === 'number') {
            return parsed;
        }
    }
    catch {
        // Malformed metadata file ignored
    }
    return null;
}
/**
 * Evaluates the freshness of a project's Graphify knowledge graph relative to
 * repository HEAD state, uncommitted working tree changes, and file modifications.
 */
export function checkGraphFreshness(project, options) {
    if (!project.hasGraph || !project.graphJsonPath) {
        return {
            state: 'unknown',
            reason: 'No graph.json found in project directory or ancestors.',
        };
    }
    let graphMtimeMs;
    try {
        const stat = fs.statSync(project.graphJsonPath);
        graphMtimeMs = stat.mtimeMs;
    }
    catch {
        return {
            state: 'unknown',
            reason: 'Cannot read graph.json modification time.',
        };
    }
    const lastIndexedTime = new Date(graphMtimeMs).toISOString();
    // 1. Check durable index metadata first if available (respects custom graphPath)
    const metadata = readGraphifyIndexMetadata(project.projectRoot, project.graphJsonPath);
    if (metadata && metadata.git) {
        const isCanonical = isCanonicalGraphForProject(project.projectRoot, project.graphJsonPath);
        const metaGitCheck = checkMetadataGitFreshness(project.projectRoot, metadata, project.graphJsonPath);
        if (metaGitCheck) {
            const baselineAvailable = metadata.version === 3 && metadata.git.baselineComplete === true && metadata.git.indexedPaths !== undefined;
            const autoUpdateProps = {};
            if (metaGitCheck.state === 'stale') {
                const eligibility = evaluateAutoUpdateEligibility(project);
                autoUpdateProps.autoUpdateEligible = eligibility.kind === 'eligible';
                if (eligibility.kind !== 'eligible' && eligibility.reason) {
                    autoUpdateProps.autoUpdateBlockReason = eligibility.reason;
                }
            }
            return {
                ...metaGitCheck,
                lastIndexedTime: metadata.indexedAt || lastIndexedTime,
                metadataVersion: metadata.version,
                baselineAvailable,
                isCanonicalTarget: isCanonical,
                ...autoUpdateProps,
            };
        }
    }
    // 2. Fall back to heuristic git inspection if project is a git repository
    try {
        const gitCheck = checkGitHeuristicFreshness(project.projectRoot, graphMtimeMs);
        if (gitCheck) {
            return {
                ...gitCheck,
                lastIndexedTime,
            };
        }
    }
    catch {
        // Fall through to filesystem check
    }
    // 3. Non-git recursive filesystem fallback
    const fileCheck = checkFilesystemRecursiveFreshness(project.projectRoot, graphMtimeMs, options?.maxScanFiles);
    return {
        ...fileCheck,
        lastIndexedTime,
    };
}
/** Checks freshness against durable git metadata (detects branch switches and commit changes). */
function checkMetadataGitFreshness(projectRoot, metadata, graphJsonPath) {
    if (!metadata.git)
        return null;
    try {
        const headRes = spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 2000,
        });
        if (headRes.status !== 0 || !headRes.stdout.trim())
            return null;
        const currentHead = headRes.stdout.trim();
        // Compare HEAD commit SHA
        if (currentHead !== metadata.git.head) {
            return {
                state: 'stale',
                reason: `Git HEAD changed from ${metadata.git.head.slice(0, 7)} to ${currentHead.slice(0, 7)} (branch switch or new commits)`,
                strategy: 'metadata',
            };
        }
        // Compare tree SHA
        const treeRes = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 2000,
        });
        if (treeRes.status === 0 && treeRes.stdout.trim()) {
            const currentTree = treeRes.stdout.trim();
            if (currentTree !== metadata.git.tree) {
                return {
                    state: 'stale',
                    reason: `Git tree changed from ${metadata.git.tree.slice(0, 7)} to ${currentTree.slice(0, 7)}`,
                    strategy: 'metadata',
                };
            }
        }
        // Compare Git branch if recorded
        if (metadata.git.branch) {
            const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
                cwd: projectRoot,
                encoding: 'utf8',
                timeout: 2000,
            });
            if (branchRes.status === 0 && branchRes.stdout.trim()) {
                const currentBranch = branchRes.stdout.trim();
                if (currentBranch !== 'HEAD' && currentBranch !== metadata.git.branch) {
                    return {
                        state: 'stale',
                        reason: `Git branch changed from ${metadata.git.branch} to ${currentBranch}`,
                        strategy: 'metadata',
                    };
                }
            }
        }
        // V3 metadata check: exact per-path baseline comparison
        if (metadata.version === 3) {
            // An incomplete or unverified baseline must NEVER report FRESH
            if (metadata.git?.baselineComplete !== true) {
                return {
                    state: 'stale',
                    reason: 'Freshness metadata has incomplete or untrusted source-state baseline; run a full graph rebuild to establish a trustworthy freshness baseline',
                    strategy: 'metadata',
                };
            }
            if (metadata.git?.workingTreeFingerprint) {
                const excludePaths = graphJsonPath ? buildExcludePaths(projectRoot, graphJsonPath) : undefined;
                const currentFingerprint = computeWorkingTreeFingerprint(projectRoot, excludePaths);
                if (currentFingerprint && currentFingerprint === metadata.git.workingTreeFingerprint && currentHead === metadata.git.head) {
                    return {
                        state: 'fresh',
                        reason: `Graph matches current Git HEAD (${currentHead.slice(0, 7)}) and working tree fingerprint`,
                        changedFilesCount: 0,
                        changedFilesSample: [],
                        strategy: 'metadata',
                    };
                }
            }
            const inventory = getChangedSourceInventory(projectRoot, metadata, graphJsonPath);
            if (inventory.complete && inventory.files.length === 0) {
                return {
                    state: 'fresh',
                    reason: `Graph matches current Git HEAD (${currentHead.slice(0, 7)}) and working tree content baseline`,
                    changedFilesCount: 0,
                    changedFilesSample: [],
                    strategy: 'metadata',
                };
            }
            return {
                state: 'stale',
                reason: inventory.complete
                    ? `Working tree changed since graph was indexed (${inventory.files.length} file(s) modified, added, or deleted)`
                    : (inventory.reason || 'Working tree changed since graph was indexed'),
                ...(inventory.complete
                    ? {
                        changedFilesCount: inventory.files.length,
                        changedFilesSample: inventory.files.slice(0, 5).map((f) => f.path),
                    }
                    : {}),
                strategy: 'metadata',
            };
        }
        // V2 fingerprint comparison: deterministic dirty-state tracking.
        // If the metadata has a workingTreeFingerprint (v2), compare it against
        // the current working tree state. This allows indexing dirty repos without
        // perpetual false-positive staleness.
        if (metadata.version === 2 && metadata.git?.workingTreeFingerprint) {
            const excludePaths = graphJsonPath ? buildExcludePaths(projectRoot, graphJsonPath) : undefined;
            const currentFingerprint = computeWorkingTreeFingerprint(projectRoot, excludePaths);
            if (currentFingerprint && currentFingerprint === metadata.git.workingTreeFingerprint && currentHead === metadata.git.head) {
                return {
                    state: 'fresh',
                    reason: `Graph matches current Git HEAD (${currentHead.slice(0, 7)}) and working tree fingerprint`,
                    changedFilesCount: 0,
                    changedFilesSample: [],
                    strategy: 'metadata',
                };
            }
            const inventory = getChangedSourceInventory(projectRoot, metadata, graphJsonPath);
            return {
                state: 'stale',
                reason: 'Working tree changed since graph was indexed (v2 legacy metadata)',
                ...(inventory.complete
                    ? {
                        changedFilesCount: inventory.files.length,
                        changedFilesSample: inventory.files.slice(0, 5).map((f) => f.path),
                    }
                    : {}),
                strategy: 'metadata',
            };
        }
        // V1 fallback: check uncommitted changes in working tree scoped to projectRoot
        const statusRes = spawnSync('git', ['status', '--porcelain', '--', '.'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 3000,
        });
        const uncommittedFiles = [];
        if (statusRes.status === 0 && statusRes.stdout) {
            for (const line of statusRes.stdout.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                const filePart = trimmed.slice(2).trim();
                if (filePart && !filePart.startsWith('graphify-out') && !filePart.includes('/graphify-out/')) {
                    uncommittedFiles.push(filePart);
                }
            }
        }
        if (uncommittedFiles.length > 0) {
            return {
                state: 'stale',
                reason: `${uncommittedFiles.length} uncommitted file(s) modified since graph was indexed`,
                changedFilesCount: uncommittedFiles.length,
                changedFilesSample: uncommittedFiles.slice(0, 5),
                strategy: 'metadata',
            };
        }
        return {
            state: 'fresh',
            reason: `Graph matches current Git HEAD (${currentHead.slice(0, 7)}) and clean working tree`,
            changedFilesCount: 0,
            changedFilesSample: [],
            strategy: 'metadata',
        };
    }
    catch {
        return null;
    }
}
/** Fallback heuristic for git repos without durable metadata. */
function checkGitHeuristicFreshness(projectRoot, graphMtimeMs) {
    const isGit = fs.existsSync(path.join(projectRoot, '.git')) ||
        spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 2000,
        }).status === 0;
    if (!isGit)
        return null;
    const changedFilesSet = new Set();
    // 1. Check uncommitted changes
    const statusRes = spawnSync('git', ['status', '--porcelain', '--', '.'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 3000,
    });
    if (statusRes.status === 0 && statusRes.stdout) {
        for (const line of statusRes.stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const filePart = trimmed.slice(2).trim();
            if (filePart && !filePart.startsWith('graphify-out') && !filePart.includes('/graphify-out/')) {
                changedFilesSet.add(filePart);
            }
        }
    }
    // 2. Check commits made after graph modification time
    const isoDate = new Date(graphMtimeMs).toISOString();
    const logRes = spawnSync('git', ['log', `--since=${isoDate}`, '--name-only', '--format=', '--', '.'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 3000,
    });
    if (logRes.status === 0 && logRes.stdout) {
        for (const file of logRes.stdout.split('\n')) {
            const trimmed = file.trim();
            if (trimmed && !trimmed.startsWith('graphify-out') && !trimmed.includes('/graphify-out/')) {
                changedFilesSet.add(trimmed);
            }
        }
    }
    const changedFiles = Array.from(changedFilesSet);
    if (changedFiles.length > 0) {
        return {
            state: 'stale',
            reason: `${changedFiles.length} file(s) modified or added since graph was indexed (heuristic fallback, metadata file missing)`,
            changedFilesCount: changedFiles.length,
            changedFilesSample: changedFiles.slice(0, 5),
            strategy: 'git-heuristic',
        };
    }
    return {
        state: 'fresh',
        reason: 'Graph is up to date with repository commits and working tree (heuristic fallback)',
        changedFilesCount: 0,
        changedFilesSample: [],
        strategy: 'git-heuristic',
    };
}
/** Directories skipped during recursive filesystem freshness walks. */
const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.pnpm-store',
    '.next',
    '.cache',
    '.venv',
    '.tox',
    '.mypy_cache',
    '.ruff_cache',
    '.pytest_cache',
    '__pycache__',
    'graphify-out',
    'node_modules',
    'dist',
    'build',
    'coverage',
    'venv',
    'target',
    'vendor',
]);
/** Recursive filesystem fallback: walks source directories excluding build and lock artifacts. */
export function checkFilesystemRecursiveFreshness(projectRoot, graphMtimeMs, maxFiles = 10000) {
    const changedFiles = [];
    let filesScanned = 0;
    const maxDepth = 15;
    function walk(currentDir, depth) {
        if (depth > maxDepth || filesScanned >= maxFiles)
            return;
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (filesScanned >= maxFiles)
                break;
            const name = entry.name;
            if (IGNORED_DIRECTORIES.has(name))
                continue;
            const fullPath = path.join(currentDir, name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                walk(fullPath, depth + 1);
            }
            else if (entry.isFile()) {
                filesScanned++;
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.mtimeMs > graphMtimeMs + 2000) {
                        changedFiles.push(path.relative(projectRoot, fullPath));
                    }
                }
                catch {
                    // Ignore unreadable file
                }
            }
        }
    }
    try {
        walk(projectRoot, 0);
    }
    catch {
        return {
            state: 'unknown',
            reason: 'Could not inspect filesystem entries for freshness',
            strategy: 'filesystem-heuristic',
        };
    }
    if (changedFiles.length > 0) {
        return {
            state: 'stale',
            reason: `${changedFiles.length} nested file(s) modified after graph index`,
            changedFilesCount: changedFiles.length,
            changedFilesSample: changedFiles.slice(0, 5),
            strategy: 'filesystem-heuristic',
        };
    }
    // Honest reporting when scan was truncated: cannot confirm freshness
    if (filesScanned >= maxFiles) {
        return {
            state: 'unknown',
            reason: `Scanned ${maxFiles} files without finding changes, but the project may have more files; freshness is uncertain`,
            strategy: 'filesystem-heuristic',
        };
    }
    return {
        state: 'fresh',
        reason: 'No modified files detected after graph index',
        changedFilesCount: 0,
        changedFilesSample: [],
        strategy: 'filesystem-heuristic',
    };
}
/**
 * Collects the inventory of changed source files between the indexed baseline state and the current working tree.
 *
 * For v3 metadata: Compares current source state directly against indexed dirty path states and commit tree.
 * Correctly detects modifications, additions, deletions, renames, and dirty-file reversions without false-fresh.
 *
 * For v1/v2 or missing metadata: Fails safe by returning `complete: false` so callers never assume code-only
 * updates can safely restore freshness.
 */
export function getChangedSourceInventory(projectRoot, metadata, graphJsonPath) {
    const excludePaths = graphJsonPath ? buildExcludePaths(projectRoot, graphJsonPath) : buildExcludePaths(projectRoot, path.join(projectRoot, 'graphify-out', 'graph.json'));
    const isExcluded = (relativePath) => {
        if (relativePath.startsWith('graphify-out/') || relativePath === 'graphify-out' ||
            relativePath.includes('/graphify-out/'))
            return true;
        if (path.basename(relativePath) === INDEX_METADATA_FILENAME)
            return true;
        for (const exc of excludePaths) {
            if (relativePath === exc || relativePath.startsWith(exc + '/'))
                return true;
        }
        return false;
    };
    const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 3000,
    });
    if (isGit.status !== 0) {
        return {
            files: [],
            complete: false,
            reason: 'Project is not a Git repository; unable to inspect changed sources.',
        };
    }
    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 3000,
    });
    if (headRes.status !== 0 || !headRes.stdout.trim()) {
        return {
            files: [],
            complete: false,
            reason: 'Git repository has no HEAD commit.',
        };
    }
    // Legacy (v1, v2), incomplete, or missing metadata: cannot reliably reconstruct changes relative to indexed dirty state.
    // Fail safe by returning complete: false with a diagnostic sample.
    if (!metadata || metadata.version !== 3 || metadata.git?.baselineComplete !== true || !metadata.git?.indexedPaths) {
        const uncommittedDiffRes = spawnSync('git', ['diff', '--name-status', '-z', '-M', 'HEAD', '--', '.'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 5000,
        });
        const bestEffort = [];
        if (uncommittedDiffRes.status === 0 && uncommittedDiffRes.stdout) {
            bestEffort.push(...parseNameStatusZ(uncommittedDiffRes.stdout).filter(f => !isExcluded(f.path)));
        }
        const untrackedRes = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 5000,
        });
        if (untrackedRes.status === 0 && untrackedRes.stdout) {
            for (const t of untrackedRes.stdout.split('\0')) {
                if (t && !isExcluded(t)) {
                    bestEffort.push({ path: t, status: 'added' });
                }
            }
        }
        const reason = metadata
            ? (metadata.version === 3 && metadata.git?.baselineComplete !== true
                ? 'Freshness metadata baseline capture was incomplete; run a full graph rebuild to establish a trustworthy freshness baseline.'
                : `Freshness metadata predates source-state tracking (version ${metadata.version}); run a full graph rebuild to establish a trustworthy freshness baseline.`)
            : 'No freshness metadata found; run a full graph rebuild to establish a trustworthy freshness baseline.';
        return {
            files: bestEffort,
            complete: false,
            reason,
        };
    }
    const indexedHead = metadata.git.head;
    const indexedPaths = metadata.git.indexedPaths;
    // Tracked changes in current working tree relative to indexed commit
    const commitDiffRes = spawnSync('git', ['diff', '--name-status', '-z', '-M', indexedHead, '--', '.'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
    });
    if (commitDiffRes.status !== 0) {
        return {
            files: [],
            complete: false,
            reason: `Could not compare working tree against indexed commit ${indexedHead.slice(0, 7)}.`,
        };
    }
    const diffAgainstIndexedHead = parseNameStatusZ(commitDiffRes.stdout).filter(c => !isExcluded(c.path));
    // Untracked files currently on disk
    const untrackedRes = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
    });
    if (untrackedRes.status !== 0) {
        return {
            files: [],
            complete: false,
            reason: 'Could not inspect untracked files.',
        };
    }
    const untrackedNow = untrackedRes.stdout.split('\0').filter(t => t && !isExcluded(t));
    const untrackedSet = new Set(untrackedNow);
    // Candidate paths map: tracked diffs relative to indexedHead
    const candidateMap = new Map();
    for (const c of diffAgainstIndexedHead) {
        candidateMap.set(c.path, c);
    }
    const allCandidatePaths = new Set([
        ...candidateMap.keys(),
        ...untrackedNow,
        ...Object.keys(indexedPaths),
    ]);
    const effectiveChanges = [];
    for (const relPath of allCandidatePaths) {
        if (isExcluded(relPath))
            continue;
        const idxState = indexedPaths[relPath];
        const fullPath = path.join(projectRoot, relPath);
        const existsNow = fs.existsSync(fullPath);
        if (!existsNow) {
            // File does not exist on disk now
            if (idxState) {
                if (idxState.kind !== 'deleted') {
                    // File existed at index time (modified or untracked), now deleted
                    effectiveChanges.push({ path: relPath, status: 'deleted' });
                }
                // If idxState.kind === 'deleted', it was already deleted at index time -> no change
            }
            else {
                // Was clean in indexedHead. If it was deleted relative to indexedHead, record deletion
                const diffEntry = candidateMap.get(relPath);
                if (diffEntry && diffEntry.status === 'deleted') {
                    effectiveChanges.push({ path: relPath, status: 'deleted' });
                }
            }
        }
        else {
            // File exists on disk now
            const currentHash = hashFileContent(fullPath, projectRoot);
            if (currentHash === undefined) {
                return {
                    files: [],
                    complete: false,
                    reason: `Unreadable file encountered: ${relPath}`,
                };
            }
            if (idxState) {
                if (idxState.kind === 'deleted') {
                    // File was deleted at index time, now exists on disk -> added
                    effectiveChanges.push({ path: relPath, status: 'added' });
                }
                else {
                    // Existed at index time with idxState.hash. Compare hashes:
                    if (currentHash !== idxState.hash) {
                        effectiveChanges.push({ path: relPath, status: 'modified' });
                    }
                    // If currentHash === idxState.hash -> byte-identical to indexed baseline! Unchanged!
                }
            }
            else {
                // Was NOT in indexedPaths, meaning at index time it was clean in indexedHead.
                const diffEntry = candidateMap.get(relPath);
                if (diffEntry) {
                    if (diffEntry.status === 'added') {
                        effectiveChanges.push({ path: relPath, status: 'added' });
                    }
                    else if (diffEntry.status === 'renamed') {
                        effectiveChanges.push({ path: relPath, status: 'renamed', oldPath: diffEntry.oldPath });
                    }
                    else {
                        effectiveChanges.push({ path: relPath, status: 'modified' });
                    }
                }
                else if (untrackedSet.has(relPath)) {
                    // Untracked file that did not exist at index time -> added!
                    effectiveChanges.push({ path: relPath, status: 'added' });
                }
                // If not in diffAgainstIndexedHead and not untracked, it matches indexedHead, which was the indexed baseline! Unchanged!
            }
        }
    }
    // Deduplicate
    const seen = new Set();
    const finalFiles = [];
    for (const change of effectiveChanges) {
        const key = `${change.status}:${change.path}:${change.oldPath ?? ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            finalFiles.push(change);
        }
    }
    return {
        files: finalFiles,
        complete: true,
    };
}
/**
 * Checks whether the project's graph target is the canonical `<projectRoot>/graphify-out/graph.json`.
 *
 * Graphify's `graphify update` CLI exclusively updates the canonical graph. Custom graphPath
 * configurations cannot be incrementally updated by `graphify update`.
 */
export function isCanonicalGraphForProject(projectRoot, graphJsonPath) {
    if (!graphJsonPath)
        return true;
    const canonical = path.resolve(projectRoot, 'graphify-out', 'graph.json');
    const target = path.resolve(graphJsonPath);
    if (canonical === target)
        return true;
    try {
        if (fs.existsSync(canonical) && fs.existsSync(target)) {
            return fs.realpathSync(canonical) === fs.realpathSync(target);
        }
    }
    catch {
        // Ignore realpath error
    }
    return false;
}
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
export function evaluateAutoUpdateEligibility(project) {
    if (!project.hasGraph || !project.graphJsonPath) {
        return {
            kind: 'unknown',
            reason: 'No existing graph found for project.',
        };
    }
    if (!isCanonicalGraphForProject(project.projectRoot, project.graphJsonPath)) {
        return {
            kind: 'unsupported-target',
            reason: `Configured graphPath (${project.graphJsonPath}) is not the canonical project graph (graphify-out/graph.json). Graphify incremental updates only support canonical project graphs. Run a full build or rebuild to update this graph.`,
        };
    }
    const metadata = readGraphifyIndexMetadata(project.projectRoot, project.graphJsonPath);
    if (!metadata || metadata.version !== 3 || metadata.git?.baselineComplete !== true || !metadata.git?.indexedPaths) {
        return {
            kind: 'unknown',
            reason: metadata
                ? (metadata.version === 3 && metadata.git?.baselineComplete !== true
                    ? 'Freshness metadata baseline capture was incomplete; run a full graph rebuild to establish a trustworthy freshness baseline.'
                    : `Freshness metadata predates source-state tracking (version ${metadata.version}); run a full graph rebuild to establish a trustworthy freshness baseline.`)
                : 'No freshness metadata found; run a full graph rebuild to establish a trustworthy freshness baseline.',
        };
    }
    const inventory = getChangedSourceInventory(project.projectRoot, metadata, project.graphJsonPath);
    if (!inventory.complete) {
        return {
            kind: 'unknown',
            reason: inventory.reason ?? 'Unable to determine changed sources in working tree.',
        };
    }
    const unsupportedSources = inventory.files.filter((file) => !isSafeChange(file));
    if (unsupportedSources.length > 0) {
        const sampleNames = unsupportedSources.slice(0, 3).map((f) => f.path).join(', ');
        const countStr = unsupportedSources.length === 1 ? '1 non-code file' : `${unsupportedSources.length} non-code files`;
        return {
            kind: 'requires-full-refresh',
            changedSources: inventory.files,
            unsupportedSources,
            reason: `Changes include ${countStr} (${sampleNames}${unsupportedSources.length > 3 ? ', ...' : ''}) that cannot be incrementally refreshed. A full refresh is required to update the graph.`,
        };
    }
    return {
        kind: 'eligible',
        projectRoot: project.projectRoot,
        graphJsonPath: project.graphJsonPath,
        changedSources: inventory.files,
    };
}
/**
 * Validates that a graph file represents a valid, coherent Graphify knowledge graph
 * according to Graphify's JSON export contract before writing freshness metadata.
 */
export function performPostUpdateValidation(projectRoot, graphJsonPath) {
    try {
        if (!fs.existsSync(graphJsonPath))
            return false;
        const stat = fs.statSync(graphJsonPath);
        if (!stat.isFile() || stat.size === 0)
            return false;
        const raw = fs.readFileSync(graphJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return false;
        // Meaningful Graphify contract verification:
        if (!Array.isArray(parsed.nodes))
            return false;
        if (!Array.isArray(parsed.links) && !Array.isArray(parsed.edges))
            return false;
        if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory())
            return false;
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Coalesces concurrent update requests for the same project root so multiple
 * agent turns never trigger duplicate simultaneous rebuilds.
 *
 * Tracks individual callers with AbortSignals so that one caller aborting
 * never cancels an in-progress update that other concurrent callers are awaiting.
 * Escalates to SIGTERM -> SIGKILL only when all callers have aborted or on timeout.
 */
export class ProjectUpdateCoalescer {
    activeRuns = new Map();
    spawnFn;
    constructor(options) {
        this.spawnFn = options?.spawn ?? spawn;
    }
    /**
     * Runs or awaits an in-progress incremental update for the given project.
     */
    update(config, projectRoot, signal, _graphJsonPath) {
        const canonical = path.resolve(projectRoot);
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve({
                    success: false,
                    stdout: '',
                    stderr: '',
                    error: 'Graphify update cancelled by signal',
                });
                return;
            }
            const caller = { signal, resolve };
            let activeRun = this.activeRuns.get(canonical);
            if (activeRun) {
                if (signal) {
                    const onAbort = () => {
                        signal.removeEventListener('abort', onAbort);
                        activeRun?.callers.delete(caller);
                        resolve({
                            success: false,
                            stdout: '',
                            stderr: '',
                            error: 'Graphify update cancelled by signal',
                        });
                        if (activeRun && activeRun.callers.size === 0) {
                            activeRun.abortChild();
                        }
                    };
                    caller.onAbort = onAbort;
                    signal.addEventListener('abort', onAbort, { once: true });
                }
                activeRun.callers.add(caller);
                return;
            }
            // Start new run
            const callers = new Set([caller]);
            let isExited = false;
            let timer;
            const { command, args } = resolveGraphifyCliCommand(config, {
                operation: 'update',
                projectRoot: canonical,
                flags: [],
            });
            const child = this.spawnFn(command, args, {
                cwd: canonical,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const terminateChild = (_reason) => {
                if (isExited)
                    return;
                terminateChildProcess(child, 1500);
            };
            const abortChild = () => {
                terminateChild('All callers aborted');
            };
            activeRun = { callers, abortChild };
            this.activeRuns.set(canonical, activeRun);
            if (signal) {
                const onAbort = () => {
                    signal.removeEventListener('abort', onAbort);
                    activeRun?.callers.delete(caller);
                    resolve({
                        success: false,
                        stdout: '',
                        stderr: '',
                        error: 'Graphify update cancelled by signal',
                    });
                    if (activeRun && activeRun.callers.size === 0) {
                        activeRun.abortChild();
                    }
                };
                caller.onAbort = onAbort;
                signal.addEventListener('abort', onAbort, { once: true });
            }
            const timeoutMs = config.freshness?.updateTimeoutMs || 120000;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    terminateChild(`Graphify update timed out after ${timeoutMs}ms`);
                }, timeoutMs);
            }
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (chunk) => {
                stdout += chunk.toString('utf8');
                if (stdout.length > 65536)
                    stdout = stdout.slice(-65536);
            });
            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString('utf8');
                if (stderr.length > 65536)
                    stderr = stderr.slice(-65536);
            });
            const finish = (result) => {
                if (timer)
                    clearTimeout(timer);
                this.activeRuns.delete(canonical);
                for (const c of callers) {
                    if (c.onAbort && c.signal) {
                        c.signal.removeEventListener('abort', c.onAbort);
                    }
                    c.resolve(result);
                }
                callers.clear();
            };
            child.once('error', (err) => {
                isExited = true;
                finish({
                    success: false,
                    stdout,
                    stderr,
                    error: err.message,
                });
            });
            child.once('close', (code, childSignal) => {
                isExited = true;
                if (code === 0) {
                    finish({
                        success: true,
                        stdout,
                        stderr,
                    });
                }
                else {
                    const status = childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`;
                    finish({
                        success: false,
                        stdout,
                        stderr,
                        error: stderr || stdout || `Graphify update exited with ${status}`,
                    });
                }
            });
        });
    }
}
