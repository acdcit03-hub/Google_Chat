import fs from 'fs';
import path from 'path';

/**
 * SMB / NAS readdir often returns Dirent type "unknown", so isFile() and
 * isDirectory() are both false. Stat the path before skipping it.
 */
export function classifyDiskDirent(parentAbs, entry) {
    if (!entry?.name) return null;
    if (entry.isDirectory()) return 'dir';
    if (entry.isFile()) return 'file';
    try {
        const st = fs.statSync(path.join(parentAbs, entry.name));
        if (st.isDirectory()) return 'dir';
        if (st.isFile()) return 'file';
    } catch {
        return null;
    }
    return null;
}

/** List immediate files/folders on disk under absPath. */
export function listDiskChildren(absPath) {
    if (!absPath || !fs.existsSync(absPath)) {
        return [];
    }
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) return [];

    return fs
        .readdirSync(absPath, { withFileTypes: true })
        .filter((d) => d.name && !d.name.startsWith('.'))
        .map((d) => {
            const kind = classifyDiskDirent(absPath, d);
            if (!kind) return null;
            const childAbs = path.join(absPath, d.name);
            let size = null;
            try {
                if (kind === 'file') size = fs.statSync(childAbs).size;
            } catch {
                size = null;
            }
            return {
                name: d.name,
                item_type: kind === 'dir' ? 'folder' : 'file',
                absolute_path: childAbs,
                size,
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.item_type !== b.item_type) {
                return a.item_type === 'folder' ? -1 : 1;
            }
            return a.name.localeCompare(b.name, undefined, {
                sensitivity: 'base',
            });
        });
}
