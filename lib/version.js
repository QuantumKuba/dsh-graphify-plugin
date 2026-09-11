import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let cachedVersion;
/**
 * Returns the package version of dsh-graphify.
 * Resolves package.json dynamically so client reporting never goes stale.
 */
export function getPackageVersion() {
    if (cachedVersion)
        return cachedVersion;
    try {
        let current = path.dirname(fileURLToPath(import.meta.url));
        for (let i = 0; i < 5; i++) {
            const candidate = path.join(current, 'package.json');
            if (fs.existsSync(candidate)) {
                const content = fs.readFileSync(candidate, 'utf8');
                const parsed = JSON.parse(content);
                if (parsed.name === 'dsh-graphify' && parsed.version) {
                    cachedVersion = parsed.version;
                    return cachedVersion;
                }
            }
            const parent = path.dirname(current);
            if (parent === current)
                break;
            current = parent;
        }
    }
    catch {
        // Fall back safely if filesystem read fails
    }
    cachedVersion = 'unknown';
    return cachedVersion;
}
