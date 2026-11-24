import { pool } from '../../config/db.js';
import PCBModel from './pcb.model.js';
import ProjectPcbVersionModel from './projectPcbVersion.model.js';

class ProcessMapModel {

    /** PCB.process_map entry: { project_code, pcb, version, process[] }. */
    static isPcbProjectProcessEntry(node) {
        return (
            !!node &&
            typeof node === 'object' &&
            !Array.isArray(node) &&
            Array.isArray(node.process) &&
            Object.prototype.hasOwnProperty.call(node, 'project_code')
        );
    }

    static isPcbProjectWiseProcessMap(processMap) {
        const mains = processMap?.main_processes;
        return Array.isArray(mains) && mains.some(ProcessMapModel.isPcbProjectProcessEntry);
    }

    /**
     * Process tree for one project assignment on a PCB.
     * Supports legacy flat main_processes (process nodes) and the new
     * project-wise wrapper format.
     */
    static getPcbProcessTreeForProject(pcb, projectCode) {
        const mains = pcb?.process_map?.main_processes;
        if (!Array.isArray(mains) || mains.length === 0) return [];

        if (ProcessMapModel.isPcbProjectWiseProcessMap(pcb.process_map)) {
            const code = String(projectCode ?? pcb?.project_code ?? '')
                .trim()
                .toLowerCase();
            const entry = mains.find(
                (row) =>
                    ProcessMapModel.isPcbProjectProcessEntry(row) &&
                    String(row.project_code ?? '').trim().toLowerCase() === code,
            );
            return Array.isArray(entry?.process) ? entry.process : [];
        }

        return mains;
    }
    
    static wrapWithPcbRoot(processMap, pcbCode) {
        const children = Array.isArray(processMap?.main_processes) ? processMap.main_processes : [];
        const taskCheck = children.length > 0 && children.every((c) => c?.task_check === true);
        return {
            main_processes: [
                {
                    name: String(pcbCode ?? '').trim(),
                    category_type: 'PCB',
                    task_check: taskCheck,
                    children,
                },
            ],
        };
    }

    /** Remove folded CUSTOM nodes so re-merge stays idempotent. */
    static stripCustomProcessNodes(nodes) {
        if (!Array.isArray(nodes)) return [];
        return nodes
            .filter(
                (node) =>
                    node !== null &&
                    typeof node === 'object' &&
                    !Array.isArray(node) &&
                    String(node?.category_type ?? '')
                        .trim()
                        .toUpperCase() !== 'CUSTOM',
            )
            .map((node) => ({
                ...node,
                children: ProcessMapModel.stripCustomProcessNodes(
                    node.children,
                ),
            }));
    }

    /**
     * Fold a PCB's custom_process into the process tree for one project.
     * Returns flat process-node main_processes (PROCESS + CUSTOM with path)
     * ready for display / wrapWithPcbRoot.
     */
    static async mergePcbProcessMapOnly(pcb, projectCode = null) {
        if (!pcb) return pcb;
        const code = projectCode ?? pcb.project_code;
        const baseMainProcesses = ProcessMapModel.stripCustomProcessNodes(
            ProcessMapModel.getPcbProcessTreeForProject(pcb, code),
        );
        const customEntry =
            ProcessMapModel.getCustomProcessEntryForProject(
                pcb.custom_process,
                code,
            ) || pcb.custom_process;

        const topSource = ProcessMapModel.isPcbProjectCustomProcessEntry(customEntry)
            ? Array.isArray(customEntry.process)
                ? customEntry.process
                : []
            : ProcessMapModel.customProcessToDedupedMainProcessNodes(customEntry);

        const customTopLevelNodes = (topSource || [])
            .filter((node) => String(node?.name ?? '').trim())
            .filter((node) => node?.active !== false)
            .map((node) => ProcessMapModel.buildCustomDisplayNode(node));

        const extrasPayload = ProcessMapModel.isPcbProjectCustomProcessEntry(customEntry)
            ? {
                  categoryExtraSubs:
                      customEntry.categoryExtraSubs &&
                      typeof customEntry.categoryExtraSubs === 'object'
                          ? customEntry.categoryExtraSubs
                          : {},
              }
            : customEntry;

        const mergedMainProcesses = await ProcessMapModel.applyCustomProcessExtraSubs(
            [...baseMainProcesses, ...customTopLevelNodes],
            extrasPayload,
        );
        return {
            ...pcb,
            process_map: {
                main_processes: mergedMainProcesses,
            },
        };
    }

    /**
     * Full project process map: PROJECT.process_map + PCB roots + custom processes.
     * Shared by GET /process-map/:id, main-processes, and overall_completion.
     */
    static async buildMergedProcessMap(project) {
        if (!project?.id) return { main_processes: [] };

        const row = await ProcessMapModel.findProcessMapByProjectId(project.id);
        const baseMap = row?.process_map && Array.isArray(row.process_map.main_processes)
            ? row.process_map
            : { main_processes: [] };

        const rawPcbsByCode = await PCBModel.findAll({
            project_code: project.project_code,
            all: 'true',
        });

        // Also include PCBs linked to this project via project_pcb_version
        // (same PCB can be assigned to multiple projects).
        const versionRows = await ProjectPcbVersionModel.findByProjectId(
            project.id,
            { activeOnly: true },
        );
        const linkedById = new Map();
        for (const pcb of rawPcbsByCode || []) {
            if (pcb?.id != null) linkedById.set(Number(pcb.id), pcb);
        }
        for (const row of versionRows || []) {
            const pcbId = Number(row?.pcb_id);
            if (!Number.isFinite(pcbId) || pcbId <= 0 || linkedById.has(pcbId)) {
                continue;
            }
            const pcb = await PCBModel.findById(pcbId);
            if (pcb) linkedById.set(pcbId, pcb);
        }
        const rawPcbs = [...linkedById.values()];

        const mergedRawPcbs = await Promise.all(
            (rawPcbs || []).map((pcb) =>
                ProcessMapModel.mergePcbProcessMapOnly(pcb, project.project_code),
            ),
        );

        const pcbsByCode = new Map();
        for (const pcb of mergedRawPcbs) {
            const code = String(pcb?.pcb_code ?? '').trim().toLowerCase();
            if (!code) continue;

            const existing = pcbsByCode.get(code);
            const processCount = Array.isArray(pcb?.process_map?.main_processes)
                ? pcb.process_map.main_processes.length
                : 0;
            const existingProcessCount = existing && Array.isArray(existing?.process_map?.main_processes)
                ? existing.process_map.main_processes.length
                : -1;

            if (!existing || processCount > existingProcessCount) {
                pcbsByCode.set(code, pcb);
            }
        }
        const pcbs = [...pcbsByCode.values()];
        const pcbCodesSet = new Set(pcbsByCode.keys());

        const baseMainProcesses = (baseMap.main_processes || []).filter(
            (node) => !(
                node?.category_type === 'PCB' &&
                pcbCodesSet.has(String(node?.name ?? '').trim().toLowerCase())
            ),
        );

        const pcbNodes = (pcbs || [])
            .filter((pcb) =>
                Array.isArray(pcb?.process_map?.main_processes) &&
                pcb.process_map.main_processes.length > 0,
            )
            .map((pcb) =>
                ProcessMapModel.wrapWithPcbRoot(pcb.process_map, pcb.pcb_code).main_processes[0],
            );

        const customTopLevelNodes = ProcessMapModel.customProcessToDedupedMainProcessNodes(
            project.custom_process,
        );
        const mergedMainProcesses = await ProcessMapModel.applyCustomProcessExtraSubs(
            [...baseMainProcesses, ...pcbNodes, ...customTopLevelNodes],
            project.custom_process,
        );

        return ProcessMapModel.sanitizeCustomCategoryType({
            ...baseMap,
            main_processes: mergedMainProcesses,
        });
    }

    static async findProjectById(id) {
        const pid = parseInt(id, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const result = await pool.query(
            'SELECT id, project_code, process_map, custom_process FROM "PROJECT" WHERE id = $1 LIMIT 1',
            [pid],
        );
        return result.rows[0] || null;
    }

    /** Shared node shape for a stored custom-process sub (used by both the
     *  main_processes merge and the standalone resolved-tree view below).
     *  Accepts either `category_type` (snake_case, what's actually saved)
     *  or `categoryType` (in case an older payload used the camelCase
     *  frontend-only field name) and falls back to 'PROCESS' when neither
     *  is present or the value isn't one of the two allowed types — mirrors
     *  the `categories.category_type` check constraint (PROCESS/CHECKLIST). */
    static buildCustomSubNode(node, parentPath = '') {
        const rawType = String(node?.category_type ?? node?.categoryType ?? '')
            .trim()
            .toUpperCase();
        let categoryType = 'PROCESS';
        if (rawType === 'CHECKLIST') categoryType = 'CHECKLIST';
        else if (rawType === 'CUSTOM') categoryType = 'CUSTOM';

        const name = String(node?.name ?? '').trim() || 'Custom Process';
        const storedPath = String(node?.path ?? '').trim();

        // Prefer stored path for display (e.g. FIRMWARE/ergg). Nested children
        // still build under the resolved parent path.
        const path = parentPath
            ? `${parentPath}/${name}`
            : storedPath || name;

        const rawChildren = Array.isArray(node?.children)
            ? node.children
            : Array.isArray(node?.subProcesses)
                ? node.subProcesses
                : [];

        return {
            name,
            path,
            category_type: categoryType,
            task_check: node?.task_check === true || node?.taskCheck === true,
            children: rawChildren.map((child) =>
                ProcessMapModel.buildCustomSubNode(child, path),
            ),
        };
    }

    /** Force CUSTOM display nodes while keeping the stored path. */
    static buildCustomDisplayNode(node, parentPath = '') {
        return ProcessMapModel.buildCustomSubNode(
            { ...node, category_type: 'CUSTOM' },
            parentPath,
        );
    }

    /**
     * Normalize a node for custom_process storage/API response:
     * active, path, category_type CUSTOM|CHECKLIST, subProcesses[].
     */
    static buildCustomProcessStorageNode(node, parentPath = '') {
        const rawType = String(node?.category_type ?? node?.categoryType ?? '')
            .trim()
            .toUpperCase();
        const categoryType = rawType === 'CHECKLIST' ? 'CHECKLIST' : 'CUSTOM';

        const name = String(node?.name ?? '').trim() || 'Custom Process';
        const storedPath = String(node?.path ?? '').trim();
        const path = parentPath
            ? `${parentPath}/${name}`
            : storedPath || name;

        const rawChildren = Array.isArray(node?.subProcesses)
            ? node.subProcesses
            : Array.isArray(node?.children)
                ? node.children
                : [];

        return {
            name,
            active: node?.active !== false,
            path,
            category_type: categoryType,
            subProcesses: rawChildren.map((child) =>
                ProcessMapModel.buildCustomProcessStorageNode(child, path),
            ),
        };
    }

    /** PCB.custom_process entry: { project_code, pcb_name, version, process[] }. */
    static isPcbProjectCustomProcessEntry(node) {
        return (
            !!node &&
            typeof node === 'object' &&
            !Array.isArray(node) &&
            Array.isArray(node.process) &&
            Object.prototype.hasOwnProperty.call(node, 'project_code')
        );
    }

    static listPcbCustomProcessEntries(customProcess) {
        if (!customProcess) return [];
        let parsed = customProcess;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch {
                return [];
            }
        }
        if (Array.isArray(parsed) && parsed.some(ProcessMapModel.isPcbProjectCustomProcessEntry)) {
            return parsed.filter(ProcessMapModel.isPcbProjectCustomProcessEntry);
        }
        if (Array.isArray(parsed?.customProcesses)) {
            return parsed.customProcesses.filter(
                ProcessMapModel.isPcbProjectCustomProcessEntry,
            );
        }
        return [];
    }

    static isPcbProjectWiseCustomProcess(customProcess) {
        return ProcessMapModel.listPcbCustomProcessEntries(customProcess).length > 0;
    }

    static customProcessToMainProcessNodes(customProcess) {
        if (!customProcess) return [];

        let parsed = customProcess;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch {
                return [];
            }
        }

        // Project-wise: flatten every project's process[] (legacy merge callers).
        const projectEntries = ProcessMapModel.listPcbCustomProcessEntries(parsed);
        if (projectEntries.length > 0) {
            return projectEntries
                .flatMap((entry) => (Array.isArray(entry.process) ? entry.process : []))
                .filter((node) => String(node?.name ?? '').trim())
                .map((node) => ProcessMapModel.buildCustomSubNode(node));
        }

        const topLevelProcesses = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.topLevelProcesses)
                ? parsed.topLevelProcesses
                : [];

        return topLevelProcesses
            .filter((node) => String(node?.name ?? '').trim())
            .map((node) => ProcessMapModel.buildCustomSubNode(node));
    }

    /** Names (normalized, lowercase-trimmed) of every node stashed under
     *  categoryExtraSubs, at any depth (a node's own name plus all of its
     *  subProcesses' names, recursively).
     *
     *  A custom process/checklist added via the "+" on an existing category
     *  (e.g. "SAMPLE SOLDRING") is stored under categoryExtraSubs and gets
     *  merged in as a *child* of that category by applyCustomProcessExtraSubs.
     *  If the same entry is also present in topLevelProcesses (e.g. because
     *  the write path saves it in both places, or old/stale data), it would
     *  ALSO render as its own top-level main process — the "DCVFGG shows up
     *  twice" bug. Filtering topLevelProcesses against this set before
     *  combining prevents that duplicate render, regardless of how it got
     *  into both buckets. */
    static customProcessExtraSubNames(customProcess) {
        const extrasByCategoryId = ProcessMapModel.customProcessExtraSubsByCategoryId(customProcess);
        const names = new Set();
        const collect = (nodes) => {
            for (const n of nodes || []) {
                const name = String(n?.name ?? '').trim().toLowerCase();
                if (name) names.add(name);
                collect(n?.subProcesses);
            }
        };
        Object.values(extrasByCategoryId).forEach(collect);
        return names;
    }

    /** Top-level custom-process nodes, with anything that's ALSO stashed
     *  under categoryExtraSubs (i.e. belongs nested under some category)
     *  filtered out so it doesn't render twice. Use this instead of calling
     *  customProcessToMainProcessNodes directly whenever the result will be
     *  combined with applyCustomProcessExtraSubs output for the same
     *  customProcess value. */
    static customProcessToDedupedMainProcessNodes(customProcess) {
        const extraSubNames = ProcessMapModel.customProcessExtraSubNames(customProcess);
        return ProcessMapModel.customProcessToMainProcessNodes(customProcess).filter(
            (n) => !extraSubNames.has(String(n?.name ?? '').trim().toLowerCase()),
        );
    }


    static normalizeCustomProcessExtras(extras) {
        if (!extras || typeof extras !== 'object') return {};
        const out = {};
        for (const [categoryId, subs] of Object.entries(extras)) {
            if (!Array.isArray(subs) || subs.length === 0) continue;
            out[categoryId] = subs
                .filter((node) => String(node?.name ?? '').trim())
                .map((node) =>
                    ProcessMapModel.buildCustomProcessStorageNode(node),
                );
        }
        return out;
    }

    /**
     * Normalize PROJECT/PCB custom_process for storage + API response.
     * Nodes: { active, category_type: CUSTOM|CHECKLIST, name, path, subProcesses }.
     */
    static normalizeCustomProcessForStorage(customProcess) {
        if (customProcess == null) return [];

        let parsed = customProcess;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch {
                return [];
            }
        }

        const projectEntries =
            ProcessMapModel.listPcbCustomProcessEntries(parsed);
        if (projectEntries.length > 0) {
            return {
                customProcesses: projectEntries.map((entry) => {
                    const extras =
                        entry.categoryExtraSubs &&
                        typeof entry.categoryExtraSubs === 'object'
                            ? ProcessMapModel.normalizeCustomProcessExtras(
                                  entry.categoryExtraSubs,
                              )
                            : {};
                    return {
                        project_code: String(entry.project_code ?? '').trim(),
                        pcb_name: String(
                            entry.pcb_name ?? entry.pcb ?? '',
                        ).trim(),
                        version: String(entry.version ?? '').trim(),
                        process: (Array.isArray(entry.process)
                            ? entry.process
                            : []
                        )
                            .filter((node) => String(node?.name ?? '').trim())
                            .map((node) =>
                                ProcessMapModel.buildCustomProcessStorageNode(
                                    node,
                                ),
                            ),
                        ...(Object.keys(extras).length > 0
                            ? { categoryExtraSubs: extras }
                            : {}),
                    };
                }),
            };
        }

        const topLevelSource = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.topLevelProcesses)
              ? parsed.topLevelProcesses
              : [];
        const topLevelProcesses = topLevelSource
            .filter((node) => String(node?.name ?? '').trim())
            .map((node) =>
                ProcessMapModel.buildCustomProcessStorageNode(node),
            );

        const extrasRaw =
            !Array.isArray(parsed) &&
            parsed &&
            typeof parsed === 'object' &&
            parsed.categoryExtraSubs &&
            typeof parsed.categoryExtraSubs === 'object'
                ? parsed.categoryExtraSubs
                : {};

        return {
            topLevelProcesses,
            categoryExtraSubs:
                ProcessMapModel.normalizeCustomProcessExtras(extrasRaw),
        };
    }

    /**
     * Resolves a project's (or PCB's) raw `custom_process` JSON into the
     * `{ customProcesses }` or `{ topLevelProcesses, categoryExtraSubs }`
     * shape with CUSTOM storage nodes for API display.
     */
    static async customProcessToResolvedTree(customProcess) {
        const normalized =
            ProcessMapModel.normalizeCustomProcessForStorage(customProcess);

        if (
            normalized &&
            typeof normalized === 'object' &&
            Array.isArray(normalized.customProcesses)
        ) {
            return normalized;
        }

        const topLevelProcesses = Array.isArray(normalized?.topLevelProcesses)
            ? normalized.topLevelProcesses
            : [];
        const extrasByCategoryId =
            normalized?.categoryExtraSubs &&
            typeof normalized.categoryExtraSubs === 'object'
                ? normalized.categoryExtraSubs
                : {};

        const categoryIds = Object.keys(extrasByCategoryId)
            .map((id) => parseInt(id, 10))
            .filter((id) => Number.isFinite(id));

        if (categoryIds.length === 0) {
            return { topLevelProcesses, categoryExtraSubs: {} };
        }

        const result = await pool.query(
            'SELECT id FROM categories WHERE id = ANY($1::int[])',
            [categoryIds],
        );
        const existingIds = new Set(result.rows.map((row) => row.id));

        const categoryExtraSubs = {};
        for (const categoryId of categoryIds) {
            const subs = extrasByCategoryId[String(categoryId)];
            if (
                !existingIds.has(categoryId) ||
                !Array.isArray(subs) ||
                subs.length === 0
            ) {
                continue;
            }
            categoryExtraSubs[categoryId] = subs;
        }

        return { topLevelProcesses, categoryExtraSubs };
    }

    /** categoryExtraSubs keyed by category id -> array of custom sub nodes. */
    static customProcessExtraSubsByCategoryId(customProcess) {
        if (!customProcess) return {};

        let parsed = customProcess;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch {
                return {};
            }
        }

        if (!parsed || typeof parsed !== 'object') return {};

        // Project-wise: merge categoryExtraSubs from every customProcesses entry
        const projectEntries = ProcessMapModel.listPcbCustomProcessEntries(parsed);
        if (projectEntries.length > 0) {
            const merged = {};
            for (const entry of projectEntries) {
                const extras = entry?.categoryExtraSubs;
                if (!extras || typeof extras !== 'object') continue;
                for (const [key, value] of Object.entries(extras)) {
                    if (!Array.isArray(value) || value.length === 0) continue;
                    merged[key] = [...(merged[key] || []), ...value];
                }
            }
            return merged;
        }

        if (Array.isArray(parsed)) return {};
        const extras = parsed.categoryExtraSubs;
        return extras && typeof extras === 'object' ? extras : {};
    }

    static getCustomProcessEntryForProject(customProcess, projectCode) {
        const code = String(projectCode ?? '')
            .trim()
            .toLowerCase();
        if (!code) return null;
        return (
            ProcessMapModel.listPcbCustomProcessEntries(customProcess).find(
                (entry) =>
                    String(entry.project_code ?? '')
                        .trim()
                        .toLowerCase() === code,
            ) || null
        );
    }

    /**
     * Attaches categoryExtraSubs to the matching category node (by name)
     * anywhere in main_processes. Any categoryExtraSubs entry whose category
     * can't be found in main_processes (e.g. a stale/unused category id) is
     * simply dropped — it's dead data with nowhere valid to attach to.
     */
    static async applyCustomProcessExtraSubs(mainProcesses, customProcess) {
        const extrasByCategoryId = ProcessMapModel.customProcessExtraSubsByCategoryId(customProcess);
        const categoryIds = Object.keys(extrasByCategoryId)
            .map((id) => parseInt(id, 10))
            .filter((id) => Number.isFinite(id));
        if (categoryIds.length === 0) return mainProcesses;

        const result = await pool.query(
            'SELECT id, name FROM categories WHERE id = ANY($1::int[])',
            [categoryIds],
        );
        const nameById = new Map(result.rows.map((row) => [row.id, String(row.name ?? '').trim()]));

        const normalize = (name) => String(name ?? '').trim().toLowerCase();
        const findByName = (nodes, targetName) => {
            for (const node of nodes || []) {
                if (normalize(node?.name) === targetName) return node;
                const found = findByName(node?.children, targetName);
                if (found) return found;
            }
            return null;
        };


        const mergeSubInto = (children, sub) => {
            const existing = children.find(
                (child) => normalize(child?.name) === normalize(sub.name),
            );
            if (!existing) {
                children.push(sub);
                return;
            }
            existing.children = existing.children || [];
            for (const grandchild of sub.children || []) {
                mergeSubInto(existing.children, grandchild);
            }
        };

        for (const categoryId of categoryIds) {
            const subs = extrasByCategoryId[String(categoryId)];
            if (!Array.isArray(subs) || subs.length === 0) continue;
            const categoryName = nameById.get(categoryId);
            const target = categoryName ? findByName(mainProcesses, normalize(categoryName)) : null;
            if (!target) continue;
            target.children = target.children || [];
            for (const sub of subs.map((s) =>
                ProcessMapModel.buildCustomDisplayNode(s),
            )) {
                // Prefer attaching by stored path parent (e.g. FIRMWARE/ergg)
                const pathParts = String(sub?.path ?? '')
                    .split('/')
                    .map((p) => p.trim())
                    .filter(Boolean);
                if (pathParts.length >= 2) {
                    const parentName = pathParts[pathParts.length - 2];
                    const parent =
                        findByName(mainProcesses, normalize(parentName)) ||
                        target;
                    parent.children = parent.children || [];
                    mergeSubInto(parent.children, sub);
                    continue;
                }
                mergeSubInto(target.children, sub);
            }
        }

        return mainProcesses;
    }

    static async findProcessMapByProjectId(projectId) {
        const pid = parseInt(projectId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const result = await pool.query(
            `SELECT id, id AS project_id, project_code, process_map
             FROM "PROJECT"
             WHERE id = $1
             LIMIT 1`,
            [pid],
        );
        return result.rows[0] || null;
    }

  
    static async loadCategorySubtree(rootIds) {
        const ids = (rootIds || [])
            .map((n) => parseInt(n, 10))
            .filter((n) => Number.isFinite(n));
        if (ids.length === 0) return [];

        const result = await pool.query(
            `WITH RECURSIVE category_tree AS (
                SELECT id, parent_id, name, category_type
                FROM categories
                WHERE id = ANY($1::int[])

                UNION ALL

                SELECT c.id, c.parent_id, c.name, c.category_type
                FROM categories c
                INNER JOIN category_tree ct ON c.parent_id = ct.id
            )
            SELECT id, parent_id, name, category_type FROM category_tree`,
            [ids],
        );
        return result.rows;
    }

    static async findRootCategoryIdsByNames(names, categoryLetter = '') {
        const cleanNames = [
            ...new Set(
                (names || [])
                    .map((n) => (typeof n === 'string' ? n.trim() : ''))
                    .filter((n) => n.length > 0),
            ),
        ];
        if (cleanNames.length === 0) return new Map();

        const letter = String(categoryLetter ?? '').trim();

        const result = await pool.query(
            `SELECT c.id, c.name
             FROM categories c
             JOIN categories root ON root.id = c.parent_id
             WHERE root.parent_id IS NULL
               AND TRIM(c.name) = ANY($1::text[])
               AND ($2 = '' OR UPPER(TRIM(root.letter)) = UPPER(TRIM($2)))`,
            [cleanNames, letter],
        );

        const byName = new Map();
        for (const row of result.rows) {
            const key = row.name.trim();
            // Keep the first match if a name is duplicated within scope.
            if (!byName.has(key)) byName.set(key, Number(row.id));
        }
        return byName;
    }

    
     
    static collectTaskCheckOverridesByName(nodes, overrides = new Map()) {
        for (const n of nodes || []) {
            if (n && typeof n === 'object' && typeof n.name === 'string') {
                const key = n.name.trim();
                if (key && typeof n.task_check === 'boolean') {
                    overrides.set(key, n.task_check);
                }
            }
            if (n && Array.isArray(n.children) && n.children.length > 0) {
                ProcessMapModel.collectTaskCheckOverridesByName(
                    n.children,
                    overrides,
                );
            }
        }
        return overrides;
    }

    static async buildProcessMapFromCategoryIds(
        projectId,
        mainProcessCategoryIds,
        taskCheckOverridesByName = new Map(),
        subProcessCategoryIds = [],
    ) {
        const rootIds = [
            ...new Set(
                (mainProcessCategoryIds || [])
                    .map((n) => parseInt(n, 10))
                    .filter((n) => Number.isFinite(n)),
            ),
        ];

        if (rootIds.length === 0) return { main_processes: [] };

        const rawRows = await ProcessMapModel.loadCategorySubtree(rootIds);

        const byId = new Map();
        for (const row of rawRows) {
            byId.set(Number(row.id), row);
        }

      
        const childrenByParent = new Map();
        for (const row of byId.values()) {
            const parentId = row.parent_id == null ? null : Number(row.parent_id);
            if (parentId == null) continue;
            if (!childrenByParent.has(parentId)) {
                childrenByParent.set(parentId, new Set());
            }
            childrenByParent.get(parentId).add(Number(row.id));
        }

        const requestedSubIds = new Set(
            (subProcessCategoryIds || [])
                .map((n) => parseInt(n, 10))
                .filter((n) => Number.isFinite(n)),
        );
        const restrictedChildrenByParent = new Map();
        if (requestedSubIds.size > 0) {
            for (const parentId of byId.keys()) {
                const directChildren = [...(childrenByParent.get(parentId) || [])];
                const allowed = directChildren.filter((childId) =>
                    requestedSubIds.has(childId),
                );
                if (allowed.length > 0) {
                    restrictedChildrenByParent.set(parentId, new Set(allowed));
                }
            }
        }

        const visited = new Set();

        const build = (id) => {
            visited.add(id);
            const row = byId.get(id);
            const allowedChildren = restrictedChildrenByParent.get(id);
            const childIds = [
                ...(allowedChildren ?? childrenByParent.get(id) ?? []),
            ];

            const children = childIds
                .filter((childId) => !visited.has(childId))
                .map((childId) => build(childId));

            const nameKey = row?.name ? row.name.trim() : '';
            const taskCheck =
                children.length > 0
                    ? children.every((c) => c.task_check === true)
                    : taskCheckOverridesByName.has(nameKey)
                        ? taskCheckOverridesByName.get(nameKey)
                        : false;

            return {
                name: row?.name?.trim() ?? '',
                category_type: row?.category_type ?? 'PROCESS',
                task_check: taskCheck,
                children,
            };
        };

        const main_processes = [];
        for (const id of rootIds) {
            if (!byId.has(id) || visited.has(id)) continue;
            main_processes.push(build(id));
        }

        return { main_processes };
    }

    static applyCheckedTasks(processMap, checkedNames, taskScopeNames) {
        const normalizeNames = (names) =>
            new Set(
                (names || [])
                    .filter((name) => typeof name === 'string')
                    .map((name) => name.trim().toLowerCase())
                    .filter(Boolean),
            );
        const checked = normalizeNames(checkedNames);
        const scope = normalizeNames(taskScopeNames);

        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (node.children?.length) {
                node.children.forEach(visit);
                node.task_check = node.children.every((child) => child.task_check === true);
            } else {
                const name = String(node.name ?? '').trim().toLowerCase();
                if (scope.size === 0 || scope.has(name)) {
                    node.task_check = checked.has(name);
                }
            }
        };

        const mains = processMap.main_processes || [];
        if (ProcessMapModel.isPcbProjectWiseProcessMap(processMap)) {
            for (const entry of mains) {
                if (Array.isArray(entry?.process)) entry.process.forEach(visit);
            }
        } else {
            mains.forEach(visit);
        }
        return processMap;
    }

    static filterProcessMapByTaskScope(processMap, taskScopeNames, processName = '') {
        const requestedProcess = String(processName ?? '').trim().toLowerCase();

        if (requestedProcess) {
            const findProcess = (nodes) => {
                for (const node of nodes || []) {
                    const nodeName = String(node?.name ?? '').trim().toLowerCase();
                    if (nodeName === requestedProcess) return node;
                    const found = findProcess(node?.children);
                    if (found) return found;
                }
                return null;
            };

            const selectedProcess = findProcess(processMap?.main_processes);
            if (selectedProcess) return { main_processes: [selectedProcess] };
        }

        const scope = new Set(
            (taskScopeNames || [])
                .filter((name) => typeof name === 'string')
                .map((name) => name.trim().toLowerCase())
                .filter(Boolean),
        );

        if (scope.size === 0) return processMap;

        const filterNode = (node) => {
            const children = Array.isArray(node?.children)
                ? node.children.map(filterNode).filter(Boolean)
                : [];
            const nodeName = String(node?.name ?? '').trim().toLowerCase();

            if (!scope.has(nodeName) && children.length === 0) return null;

            return {
                ...node,
                children,
            };
        };

        const filteredMap = {
            ...processMap,
            main_processes: (processMap?.main_processes || [])
                .map(filterNode)
                .filter(Boolean),
        };

        return filteredMap.main_processes.length > 0 ? filteredMap : processMap;
    }

   // Inside ProcessMapModel in updateProject.model.js

static normalizeMap(map) {
    const normalizeNode = (node) => {
        if (!node || typeof node !== 'object') return null;

        const categoryType = String(node.category_type ?? 'PROCESS').trim().toUpperCase();

        return {
            name: String(node.name ?? '').trim(),
            children: Array.isArray(node.children)
                ? node.children.map(normalizeNode).filter(Boolean)
                : [],
            task_check: node.task_check === true,

            category_type: categoryType || 'PROCESS',
        };
    };

    return {
        main_processes: Array.isArray(map?.main_processes)
            ? map.main_processes.map(normalizeNode).filter(Boolean)
            : [],
    };
}


static sanitizeCustomCategoryType(map) {
    if (!map || typeof map !== 'object') return map;

    const fixNode = (node) => {
        if (!node || typeof node !== 'object') return node;

        const categoryType = String(node.category_type ?? '').trim().toUpperCase();

        return {
            ...node,
            category_type: categoryType === 'CUSTOM' ? 'PROCESS' : node.category_type,
            children: Array.isArray(node.children)
                ? node.children.map(fixNode)
                : node.children,
        };
    };

    return {
        ...map,
        main_processes: Array.isArray(map.main_processes)
            ? map.main_processes.map(fixNode)
            : map.main_processes,
    };
}

    /**
     * Hierarchical equal-weight completion.
     *
     * Example — main process has 2 sub-processes → each owns 100/2 = 50:
     *   - sub A has 5 leaves → each leaf = 50/5 = 10; 4 checked → 40
     *   - sub B has 10 leaves → each leaf = 50/10 = 5; 5 checked → 25
     *   → main total = 65
     *
     * At every level, siblings split their parent's weight equally.
     * A leaf contributes its full weight only when `task_check` is true.
     */
    static weightedCompletion(node, weight = 100) {
        if (!node || typeof node !== 'object' || !(weight > 0)) return 0;

        const children = Array.isArray(node.children)
            ? node.children.filter((c) => c && typeof c === 'object')
            : [];

        if (children.length === 0) {
            return node.task_check === true ? weight : 0;
        }

        const share = weight / children.length;
        return children.reduce(
            (sum, child) => sum + ProcessMapModel.weightedCompletion(child, share),
            0,
        );
    }

    /** 0–100 completion for one main-process / PCB root node (2 decimal places). */
    static completionPercentageForNode(node) {
        const raw = ProcessMapModel.weightedCompletion(node, 100);
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        if (raw >= 100) return 100;
        return Math.round(raw * 100) / 100;
    }

    /**
     * Project overall completion: every top-level main process (PROCESS + PCB)
     * is a sibling under a virtual root, so N mains each own 100/N, then the
     * same hierarchical equal-weight rules apply underneath.
     */
    static overallCompletionFromMainProcesses(mainProcesses) {
        const mains = (Array.isArray(mainProcesses) ? mainProcesses : []).filter(
            (n) => n && typeof n === 'object' && String(n.name ?? '').trim() !== '',
        );
        if (mains.length === 0) return 0;
        return ProcessMapModel.completionPercentageForNode({
            name: '__project_root__',
            category_type: 'PROCESS',
            children: mains,
        });
    }

    /**
     * Slim main_processes list for list/header UIs:
     * `{ name, category_type, completion_percentage }` only.
     */
    static toMainProcessSummaries(mainProcesses) {
        return (Array.isArray(mainProcesses) ? mainProcesses : [])
            .map((node) => {
                if (!node || typeof node !== 'object') return null;
                const name = String(node.name ?? '').trim();
                if (!name) return null;

                const rawType = String(node.category_type ?? 'PROCESS').trim().toUpperCase();
                const category_type =
                    rawType === 'PCB'
                        ? 'PCB'
                        : rawType === 'CHECKLIST'
                            ? 'CHECKLIST'
                            : 'PROCESS';

                return {
                    name,
                    category_type,
                    completion_percentage: ProcessMapModel.completionPercentageForNode(node),
                };
            })
            .filter(Boolean);
    }

    static async upsertProcessMap({ projectId, projectCode, map }) {
        const pid = parseInt(projectId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const code =
            projectCode == null || projectCode === ''
                ? null
                : String(projectCode).trim();

        const cleanMap = ProcessMapModel.normalizeMap(map);
        const mapJson = JSON.stringify(cleanMap);

        const result = await pool.query(
            `UPDATE "PROJECT"
             SET process_map = $1::jsonb,
                 project_code = COALESCE($2, project_code),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING id, id AS project_id, project_code, process_map`,
            [mapJson, code, pid],
        );
        return result.rows[0] || null;
    }

    static async deleteProcessMapByProjectId(projectId) {
        const pid = parseInt(projectId, 10);
        if (!Number.isFinite(pid) || pid <= 0) return null;

        const result = await pool.query(
            `UPDATE "PROJECT"
             SET process_map = '{}'::jsonb,
                 process_ids = '[]'::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id`,
            [pid],
        );
        return result.rows[0] || null;
    }
}

export default ProcessMapModel;