import fs from 'node:fs';
import path from 'node:path';
import { detectGraph } from "./detector.js";
/**
 * Session-scoped project resolver for DeepSeek Harness.
 *
 * Resolves project roots and graph metadata dynamically per-session so that
 * a single long-running DSH process serving multiple concurrent sessions
 * (Session A -> Project A, Session B -> Project B) never leaks graph metadata
 * across sessions.
 */
export class ProjectResolver {
    cache = new Map();
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Resolves the target project and graph metadata for a tool or command invocation.
     *
     * Resolution precedence:
     * 1. Explicit `explicitPath` (e.g. `project_path` argument)
     * 2. Calling agent session cwd (`toolContext.agent.session.header.cwd` or `agentCwd`)
     * 3. Configured `config.cwd`
     * 4. Process fallback (`process.cwd()`, only if autoDetect is enabled and no session cwd exists)
     */
    resolve(options) {
        const rawTarget = options?.explicitPath?.trim() ||
            options?.toolContext?.agent?.session.header.cwd?.trim() ||
            options?.agentCwd?.trim() ||
            this.config.cwd?.trim() ||
            (this.config.autoDetect ? process.cwd() : '');
        if (!rawTarget) {
            return this.buildEmptyProject(process.cwd());
        }
        const canonicalTarget = path.resolve(rawTarget);
        const cachedEntry = this.cache.get(canonicalTarget);
        if (cachedEntry) {
            if (this.isCacheValid(cachedEntry.project)) {
                return cachedEntry.project;
            }
            this.cache.delete(canonicalTarget);
        }
        const resolved = this.detectForDirectory(canonicalTarget);
        this.cache.set(canonicalTarget, {
            project: resolved,
            cachedAtMs: Date.now(),
        });
        // Also index by canonical project root for fast lookup
        if (resolved.projectRoot !== canonicalTarget) {
            this.cache.set(resolved.projectRoot, {
                project: resolved,
                cachedAtMs: Date.now(),
            });
        }
        return resolved;
    }
    /**
     * Detects the graph for a target directory, respecting autoDetect and explicit graphPath.
     */
    detectForDirectory(targetDir) {
        const detected = this.config.autoDetect
            ? detectGraph(targetDir, this.config.graphPath)
            : this.config.graphPath
                ? detectGraph(targetDir, this.config.graphPath)
                : null;
        if (detected && detected.hasGraph) {
            let mtimeMs;
            try {
                const stat = fs.statSync(detected.graphJsonPath);
                mtimeMs = stat.mtimeMs;
            }
            catch {
                // Ignore stat error
            }
            return {
                projectRoot: detected.projectRoot,
                graphJsonPath: detected.graphJsonPath,
                graphDir: detected.graphDir,
                reportPath: detected.reportPath,
                wikiIndexPath: detected.wikiIndexPath,
                hasGraph: true,
                mtimeMs,
            };
        }
        // Graph missing in target directory
        return this.buildEmptyProject(detected?.projectRoot || targetDir);
    }
    buildEmptyProject(projectRoot) {
        const candidateGraphJson = this.config.graphPath
            ? path.resolve(projectRoot, this.config.graphPath)
            : path.join(projectRoot, 'graphify-out', 'graph.json');
        const candidateGraphDir = path.dirname(candidateGraphJson);
        const hasGraph = fs.existsSync(candidateGraphJson);
        let mtimeMs;
        if (hasGraph) {
            try {
                mtimeMs = fs.statSync(candidateGraphJson).mtimeMs;
            }
            catch {
                // Ignore
            }
        }
        const candidateReport = path.join(candidateGraphDir, 'GRAPH_REPORT.md');
        const candidateWiki = path.join(candidateGraphDir, 'wiki', 'index.md');
        return {
            projectRoot,
            graphJsonPath: hasGraph ? candidateGraphJson : null,
            graphDir: candidateGraphDir,
            reportPath: fs.existsSync(candidateReport) ? candidateReport : undefined,
            wikiIndexPath: fs.existsSync(candidateWiki) ? candidateWiki : undefined,
            hasGraph,
            mtimeMs,
        };
    }
    /**
     * Validates if cached project metadata is still fresh on disk.
     */
    isCacheValid(project) {
        if (!project.graphJsonPath) {
            // Re-verify if graph.json was created since last resolution
            const candidate = path.join(project.graphDir, 'graph.json');
            return !fs.existsSync(candidate);
        }
        try {
            const stat = fs.statSync(project.graphJsonPath);
            if (stat.mtimeMs !== project.mtimeMs)
                return false;
        }
        catch {
            // File deleted or inaccessible
            return false;
        }
        // Verify report/wiki presence has not changed
        const candidateReport = path.join(project.graphDir, 'GRAPH_REPORT.md');
        if (fs.existsSync(candidateReport) !== Boolean(project.reportPath))
            return false;
        const candidateWiki = path.join(project.graphDir, 'wiki', 'index.md');
        if (fs.existsSync(candidateWiki) !== Boolean(project.wikiIndexPath))
            return false;
        return true;
    }
    /**
     * Invalidates cached metadata for a specific directory or clears the entire cache.
     */
    invalidate(targetDir) {
        if (targetDir) {
            const canonical = path.resolve(targetDir);
            for (const [key, entry] of this.cache.entries()) {
                if (key === canonical ||
                    entry.project.projectRoot === canonical ||
                    entry.project.graphDir === canonical) {
                    this.cache.delete(key);
                }
            }
        }
        else {
            this.cache.clear();
        }
    }
}
