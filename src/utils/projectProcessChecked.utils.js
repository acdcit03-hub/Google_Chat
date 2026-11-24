import { pool } from '../config/db.js';
import ProcessMapModel from '../models/projectsheet/updateProject.model.js';

function parseProcessIdsToArray(value) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) {
        return value.map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
                }
            } catch {
                /* fall through */
            }
        }
        return trimmed.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    }
    const n = parseInt(value, 10);
    return isNaN(n) ? [] : [n];
}

/** Scope value for project-level process list (projects_process_checked). */
export const MAIN_PROCESS_SCOPE = 'main';

function removeNodeByPath(nodes, targetPath) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return { nodes: nodes || [], removed: false };
    }

    const idx = nodes.findIndex((n) => String(n?.path ?? '').trim() === targetPath);
    if (idx !== -1) {
        return { nodes: [...nodes.slice(0, idx), ...nodes.slice(idx + 1)], removed: true };
    }

    let removed = false;
    const next = nodes.map((n) => {
        if (removed || !Array.isArray(n?.subProcesses) || n.subProcesses.length === 0) {
            return n;
        }
        const result = removeNodeByPath(n.subProcesses, targetPath);
        if (result.removed) {
            removed = true;
            return { ...n, subProcesses: result.nodes };
        }
        return n;
    });

    return { nodes: next, removed };
}


export function removeCustomProcessEntryByPath(customProcess, path) {
    const targetPath = String(path ?? '').trim();
    if (!targetPath) return { customProcess, removed: false };

    let parsed = customProcess;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return { customProcess, removed: false };
        }
    }

    if (Array.isArray(parsed)) {
        const { nodes, removed } = removeNodeByPath(parsed, targetPath);
        return { customProcess: nodes, removed };
    }

    if (!parsed || typeof parsed !== 'object') {
        return { customProcess: parsed, removed: false };
    }

    const topLevelProcesses = Array.isArray(parsed.topLevelProcesses)
        ? parsed.topLevelProcesses
        : [];
    const topResult = removeNodeByPath(topLevelProcesses, targetPath);

    let removed = topResult.removed;
    const sourceExtraSubs =
        parsed.categoryExtraSubs && typeof parsed.categoryExtraSubs === 'object'
            ? parsed.categoryExtraSubs
            : {};
    const nextExtraSubs = {};

    for (const [categoryId, subs] of Object.entries(sourceExtraSubs)) {
        if (removed) {
            // Already found and removed (from topLevelProcesses, or from an
            // earlier categoryId in this loop) — copy the rest untouched.
            if (Array.isArray(subs) && subs.length > 0) nextExtraSubs[categoryId] = subs;
            continue;
        }
        const result = removeNodeByPath(Array.isArray(subs) ? subs : [], targetPath);
        if (result.removed) removed = true;
        if (result.nodes.length > 0) nextExtraSubs[categoryId] = result.nodes;
    }

    return {
        customProcess: {
            ...parsed,
            topLevelProcesses: topResult.nodes,
            categoryExtraSubs: nextExtraSubs,
        },
        removed,
    };
}

export function resolveProcessCheckedScope(pcbId) {
    if (pcbId == null || pcbId === '') return MAIN_PROCESS_SCOPE;
    return String(pcbId).trim();
}

function normalizeScope(scope) {
    const s = scope == null ? '' : String(scope).trim();
    return s || MAIN_PROCESS_SCOPE;
}

/** Insert with id = MAX(id)+1 so a stale SERIAL sequence cannot collide. */
async function insertProjectsProcessCheckedRow({
    projectId,
    projectCode,
    scope,
    processIdsJson,
    checkedIdsJson,
}) {
    const result = await pool.query(
        `INSERT INTO projects_process_checked
             (id, project_id, project_code, main_or_pcb_id, total_process_id, checked_id)
         VALUES (
             (SELECT COALESCE(MAX(id), 0) + 1 FROM projects_process_checked),
             $1, $2, $3, $4::jsonb, $5::jsonb
         )
         RETURNING *`,
        [
            projectId,
            projectCode,
            scope,
            processIdsJson,
            checkedIdsJson,
        ],
    );
    return result.rows[0] || null;
}

export async function createMainProjectProcessChecked({
    projectId,
    projectCode,
    processIds,
}) {
    const pid = parseInt(projectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    const ids = parseProcessIdsToArray(processIds);
    const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
    const code =
        projectCode == null || projectCode === ''
            ? null
            : String(projectCode).trim();

    const existing = await pool.query(
        `SELECT id, total_process_id, checked_id
         FROM projects_process_checked
         WHERE project_id = $1
           AND main_or_pcb_id = $2
         LIMIT 1`,
        [pid, MAIN_PROCESS_SCOPE],
    );

    const totalJson = uniqueIds.length > 0 ? JSON.stringify(uniqueIds) : null;

    if (existing.rows.length === 0) {
        return insertProjectsProcessCheckedRow({
            projectId: pid,
            projectCode: code,
            scope: MAIN_PROCESS_SCOPE,
            processIdsJson: totalJson,
            checkedIdsJson: '[]',
        });
    }

    const prevTotals = [
        ...new Set(parseProcessIdsToArray(existing.rows[0].total_process_id)),
    ].sort((a, b) => a - b);
    const prevChecked = parseProcessIdsToArray(existing.rows[0].checked_id);
    const removedProcessIds = prevTotals.filter((id) => !uniqueIds.includes(id));

    let nextChecked = prevChecked;
    if (removedProcessIds.length > 0 && prevChecked.length > 0) {
        const childrenMap = await loadCategoryChildrenMap(pid);
        nextChecked = dropCheckedForRemovedProcesses(
            prevChecked,
            removedProcessIds,
            childrenMap,
        );
    }
    nextChecked = [...new Set(nextChecked)].sort((a, b) => a - b);

    const result = await pool.query(
        `UPDATE projects_process_checked
         SET total_process_id = $1::jsonb,
             checked_id = $2::jsonb,
             project_code = COALESCE($3, project_code),
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $4
           AND main_or_pcb_id = $5
         RETURNING *`,
        [
            totalJson,
            JSON.stringify(nextChecked),
            code,
            pid,
            MAIN_PROCESS_SCOPE,
        ],
    );
    return result.rows[0] || null;
}

/** Attach main-process total_process_id to project list rows for API consumers. */
export async function enrichProjectsWithMainProcessIds(projects) {
    if (!Array.isArray(projects) || projects.length === 0) return projects;

    const ids = projects
        .map((p) => parseInt(p.id, 10))
        .filter((id) => Number.isFinite(id) && id > 0);

    if (ids.length === 0) return projects;

    const result = await pool.query(
        `SELECT project_id, total_process_id, checked_id
         FROM projects_process_checked
         WHERE main_or_pcb_id = $1
           AND project_id = ANY($2::int[])`,
        [MAIN_PROCESS_SCOPE, ids],
    );

    const byProjectId = new Map(
        result.rows.map((row) => [
            row.project_id,
            {
                process_ids: parseProcessIdsToArray(row.total_process_id),
                checked_ids: parseProcessIdsToArray(row.checked_id),
            },
        ]),
    );

    return Promise.all(projects.map(async (project) => {
        const pid = parseInt(project.id, 10);
        const fromChecked = byProjectId.get(pid);
        const fromProject = parseProcessIdsToArray(project.process_ids);
        const processIds =
            fromChecked?.process_ids?.length > 0
                ? fromChecked.process_ids
                : fromProject;
        const process_mode =
            fromChecked?.process_ids?.length > 0
                ? 'category'
                : fromProject.length > 0
                    ? 'legacy'
                    : 'category';

        return {
            ...project,
            process_ids: processIds,
            process_mode,
            checked_tasks: fromChecked?.checked_ids ?? [],
        };
    }));
}

export async function findProjectProcessCheckedRow(projectId, scope = MAIN_PROCESS_SCOPE) {
    const pid = parseInt(projectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    const result = await pool.query(
        `SELECT *
         FROM projects_process_checked
         WHERE project_id = $1
           AND main_or_pcb_id = $2
         LIMIT 1`,
        [pid, normalizeScope(scope)],
    );
    return result.rows[0] || null;
}

/**
 * Store PCB selected process IDs in projects_process_checked.
 * main_or_pcb_id = PCB id, project_code = project code, total_process_id = selected process ids.
 */
export async function createOrUpdatePcbProjectProcessChecked({
    projectId,
    projectCode,
    pcbId,
    processIds,
    checkedIds,
}) {
    const pid = parseInt(projectId, 10);
    const pcbScope = pcbId == null ? '' : String(pcbId).trim();
    if (!Number.isFinite(pid) || pid <= 0 || !pcbScope) return null;

    const ids = parseProcessIdsToArray(processIds);
    const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
    const code =
        projectCode == null || projectCode === ''
            ? null
            : String(projectCode).trim();
    const hasChecked = checkedIds !== undefined;

    const existing = await pool.query(
        `SELECT id, total_process_id, checked_id
         FROM projects_process_checked
         WHERE project_id = $1
           AND main_or_pcb_id = $2
         LIMIT 1`,
        [pid, pcbScope],
    );

    const prevTotals = existing.rows.length > 0
        ? [...new Set(parseProcessIdsToArray(existing.rows[0].total_process_id))].sort(
              (a, b) => a - b,
          )
        : [];
    const prevChecked = existing.rows.length > 0
        ? parseProcessIdsToArray(existing.rows[0].checked_id)
        : [];
    const removedProcessIds = prevTotals.filter((id) => !uniqueIds.includes(id));

    let nextChecked;
    if (hasChecked) {
        nextChecked = [...new Set(parseProcessIdsToArray(checkedIds))];
    } else {
        nextChecked = prevChecked;
    }

    // Adding a process must not change checks. Removing one process only
    // drops that process tree. Clearing every process keeps checked_id.
    if (
        uniqueIds.length > 0 &&
        removedProcessIds.length > 0 &&
        nextChecked.length > 0
    ) {
        const childrenMap = await loadCategoryChildrenMap(pid);
        nextChecked = pruneCheckedToRemainingProcesses(
            nextChecked,
            uniqueIds,
            childrenMap,
        );
    }
    nextChecked = [...new Set(nextChecked)].sort((a, b) => a - b);

    // No process selected → store NULL, but keep the row (and checked data).
    const totalJson = uniqueIds.length > 0 ? JSON.stringify(uniqueIds) : null;
    const checkedJson = JSON.stringify(nextChecked);

    if (existing.rows.length === 0) {
        return insertProjectsProcessCheckedRow({
            projectId: pid,
            projectCode: code,
            scope: pcbScope,
            processIdsJson: totalJson,
            checkedIdsJson: checkedJson,
        });
    }

    const result = await pool.query(
        `UPDATE projects_process_checked
         SET total_process_id = $1::jsonb,
             checked_id = $2::jsonb,
             project_code = COALESCE($3, project_code),
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $4
           AND main_or_pcb_id = $5
         RETURNING *`,
        [
            totalJson,
            checkedJson,
            code,
            pid,
            pcbScope,
        ],
    );
    return result.rows[0] || null;
}

export async function deletePcbProjectProcessChecked(projectId, pcbId) {
    const pid = parseInt(projectId, 10);
    const pcbScope = pcbId == null ? '' : String(pcbId).trim();
    if (!Number.isFinite(pid) || pid <= 0 || !pcbScope) return;

    await pool.query(
        `DELETE FROM projects_process_checked
         WHERE project_id = $1
           AND main_or_pcb_id = $2`,
        [pid, pcbScope],
    );
}

/** Prefer projects_process_checked.total_process_id per PCB id for API consumers. */
export async function enrichPcbsWithProcessChecked(pcbs) {
    if (!Array.isArray(pcbs) || pcbs.length === 0) return pcbs;

    const pcbScopes = pcbs
        .map((pcb) => (pcb?.id != null ? String(pcb.id).trim() : ''))
        .filter(Boolean);

    let byPcbId = new Map();
    if (pcbScopes.length > 0) {
        const result = await pool.query(
            `SELECT main_or_pcb_id, total_process_id, checked_id, project_code
             FROM projects_process_checked
             WHERE main_or_pcb_id = ANY($1::text[])
               AND COALESCE(main_or_pcb_id, '') <> $2`,
            [pcbScopes, MAIN_PROCESS_SCOPE],
        );

        byPcbId = new Map(
            result.rows.map((row) => [
                String(row.main_or_pcb_id),
                {
                    process_ids: parseProcessIdsToArray(row.total_process_id),
                    checked_tasks: parseProcessIdsToArray(row.checked_id),
                    project_code: row.project_code,
                },
            ]),
        );
    }

    return Promise.all(pcbs.map(async (pcb) => {
        const scopeKey = pcb?.id != null ? String(pcb.id) : '';
        const fromChecked = scopeKey ? byPcbId.get(scopeKey) : null;
        const processIds = fromChecked?.process_ids ?? [];
        const checkedIds = fromChecked?.checked_tasks ?? [];

        return {
            ...pcb,
            process_ids:
                processIds.length > 0 ? processIds.map(String).join(',') : '',
            checked_tasks:
                checkedIds.length > 0 ? checkedIds.map(String).join(',') : '',
        };
    }));
}

function collectDescendantIds(rootId, childrenMap) {
    const out = [];
    const walk = (id) => {
        const kids = childrenMap.get(id) || [];
        for (const childId of kids) {
            out.push(childId);
            walk(childId);
        }
    };
    walk(rootId);
    return out;
}

/** Category parent → children map for a project's letter. */
async function loadCategoryChildrenMap(projectId) {
    const childrenMap = new Map();
    const pid = parseInt(projectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return childrenMap;

    const projectResult = await pool.query(
        `SELECT category FROM "PROJECT" WHERE id = $1 LIMIT 1`,
        [pid],
    );
    const letter = String(projectResult.rows[0]?.category ?? '').trim();
    if (!letter) return childrenMap;

    try {
        const treeResult = await pool.query(
            `WITH RECURSIVE category_tree AS (
                SELECT id, parent_id
                FROM categories
                WHERE UPPER(TRIM(COALESCE(letter, ''))) = UPPER(TRIM($1))
                  AND parent_id IS NULL
                UNION ALL
                SELECT c.id, c.parent_id
                FROM categories c
                INNER JOIN category_tree ct ON c.parent_id = ct.id
            )
            SELECT id, parent_id FROM category_tree`,
            [letter],
        );
        for (const row of treeResult.rows) {
            const parentId = row.parent_id == null ? null : Number(row.parent_id);
            if (parentId == null || !Number.isFinite(parentId)) continue;
            if (!childrenMap.has(parentId)) {
                childrenMap.set(parentId, []);
            }
            childrenMap.get(parentId).push(Number(row.id));
        }
    } catch (err) {
        console.warn('loadCategoryChildrenMap:', err.message);
    }

    return childrenMap;
}

function processTreeIdSet(rootIds, childrenMap) {
    const set = new Set();
    for (const rootId of rootIds) {
        const id = parseInt(rootId, 10);
        if (!Number.isFinite(id)) continue;
        set.add(id);
        for (const descendantId of collectDescendantIds(id, childrenMap)) {
            set.add(descendantId);
        }
    }
    return set;
}


function pruneCheckedToRemainingProcesses(checkedIds, remainingProcessIds, childrenMap) {
    const remaining = parseProcessIdsToArray(remainingProcessIds);
    const checked = parseProcessIdsToArray(checkedIds);
    if (remaining.length === 0) return [];

    // removed process. Keep all checks rather than wiping descendants.
    if (!childrenMap || childrenMap.size === 0) return checked;
    const allowed = processTreeIdSet(remaining, childrenMap);
    return checked.filter((id) => allowed.has(id));
}

/** Drop only the removed process id and its descendant task ids. */
function dropCheckedForRemovedProcesses(checkedIds, removedProcessIds, childrenMap) {
    const checked = parseProcessIdsToArray(checkedIds);
    const removedRoots = parseProcessIdsToArray(removedProcessIds);
    if (checked.length === 0 || removedRoots.length === 0) return checked;

    const removedTree =
        !childrenMap || childrenMap.size === 0
            ? new Set(removedRoots)
            : processTreeIdSet(removedRoots, childrenMap);

    return checked.filter((id) => !removedTree.has(id));
}


export async function recalculateProjectOverallCompletion(projectId) {
    const pid = parseInt(projectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    const project = await ProcessMapModel.findProjectById(pid);
    if (!project) return null;

    // Same hierarchical equal-weight rules as main-process % — applied across
    // the full merged process map (project processes + PCB roots + custom).
    const processMap = await ProcessMapModel.buildMergedProcessMap(project);
    const overall = ProcessMapModel.overallCompletionFromMainProcesses(
        processMap.main_processes,
    );

    await pool.query(
        `UPDATE "PROJECT"
         SET overall_completion = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [overall, pid],
    );

    return overall;
}

