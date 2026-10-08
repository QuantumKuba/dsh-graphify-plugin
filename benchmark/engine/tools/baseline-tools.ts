import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export interface BaselineTools {
  list_dir: (args: { dirPath?: string }) => { text: string; error?: string }
  find_files: (args: { pattern: string }) => { text: string; error?: string }
  grep_search: (args: { query: string; path?: string; caseSensitive?: boolean }) => { text: string; error?: string }
  read_file: (args: { filePath: string; startLine?: number; endLine?: number }) => { text: string; error?: string }
}

/**
 * Creates the standard filesystem and code search tools available in baseline DeepSeek Harness.
 */
export function createBaselineTools(targetRepoDir: string): BaselineTools {
  const resolveTarget = (relOrAbs: string) => {
    const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(targetRepoDir, relOrAbs)
    // Guard containment
    const rel = path.relative(targetRepoDir, p)
    if (rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error(`Path ${relOrAbs} escapes target repository directory.`)
    }
    return p
  }

  return {
    list_dir: ({ dirPath = '.' }) => {
      try {
        const fullPath = resolveTarget(dirPath)
        if (!fs.existsSync(fullPath)) {
          return { text: `Directory not found: ${dirPath}`, error: 'NOT_FOUND' }
        }
        const entries = fs.readdirSync(fullPath, { withFileTypes: true })
        const lines = entries.map((e) => {
          const type = e.isDirectory() ? '[DIR]' : '[FILE]'
          return `${type} ${e.name}`
        })
        return { text: lines.join('\n') }
      } catch (err) {
        return { text: `list_dir error: ${String(err)}`, error: 'FS_ERROR' }
      }
    },

    find_files: ({ pattern }) => {
      try {
        const res = spawnSync('find', ['.', '-name', pattern, '-not', '-path', '*/.*'], {
          cwd: targetRepoDir,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        })
        if (res.status !== 0) {
          return { text: `find error: ${res.stderr || 'unknown error'}`, error: 'CMD_ERROR' }
        }
        const cleaned = res.stdout
          .split('\n')
          .filter(Boolean)
          .map((p) => p.replace(/^\.\//, ''))
          .slice(0, 100)
          .join('\n')
        return { text: cleaned || 'No files found matching pattern.' }
      } catch (err) {
        return { text: `find_files error: ${String(err)}`, error: 'EXEC_ERROR' }
      }
    },

    grep_search: ({ query, path: searchSubpath = '.', caseSensitive = false }) => {
      try {
        const targetSearch = resolveTarget(searchSubpath)
        const args = ['-rnI']
        if (!caseSensitive) args.push('-i')
        // Exclude node_modules, git, and graphify-out from search
        args.push('--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=graphify-out')
        args.push(query, targetSearch)

        const res = spawnSync('grep', args, {
          cwd: targetRepoDir,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        })

        if (!res.stdout || res.stdout.trim() === '') {
          return { text: `No matches found for query: "${query}"` }
        }

        const lines = res.stdout.split('\n').filter(Boolean)
        const totalMatches = lines.length
        // Standard agent output truncation to avoid overflowing buffer
        const preview = lines
          .slice(0, 50)
          .map((line) => {
            const rel = line.replace(targetRepoDir + '/', '')
            return rel
          })
          .join('\n')

        const suffix =
          totalMatches > 50
            ? `\n\n[Showing 50 of ${totalMatches} matches. Narrow your query with specific paths.]`
            : ''
        return { text: `${preview}${suffix}` }
      } catch (err) {
        return { text: `grep_search error: ${String(err)}`, error: 'EXEC_ERROR' }
      }
    },

    read_file: ({ filePath, startLine, endLine }) => {
      try {
        const fullPath = resolveTarget(filePath)
        if (!fs.existsSync(fullPath)) {
          return { text: `File not found: ${filePath}`, error: 'NOT_FOUND' }
        }
        const content = fs.readFileSync(fullPath, 'utf8')
        const lines = content.split('\n')
        const start = Math.max(1, startLine || 1)
        const end = Math.min(lines.length, endLine || lines.length)

        const sliced = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`)
        return { text: sliced.join('\n') }
      } catch (err) {
        return { text: `read_file error: ${String(err)}`, error: 'FS_ERROR' }
      }
    },
  }
}
