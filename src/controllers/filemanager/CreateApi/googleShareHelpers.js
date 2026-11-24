import { pool } from '../../../config/db.js';
import ProjectModel from '../../../models/projectsheet/project.model.js';

/**
 * Resolve employment work_email for a username (personal email as fallback).
 */
export async function getWorkEmailByUsername(username) {
    const name = String(username || '').trim();
    if (!name) return null;

    const result = await pool.query(
        `
        SELECT
            NULLIF(TRIM(ed.work_email), '') AS work_email,
            NULLIF(TRIM(pd.email_id), '') AS personal_email
        FROM personal_details pd
        LEFT JOIN employment_details ed
            ON ed.personal_details_id = pd.id
            OR (
                ed.username IS NOT NULL
                AND LOWER(TRIM(ed.username)) = LOWER(TRIM(pd.username))
            )
        WHERE LOWER(TRIM(pd.username)) = LOWER(TRIM($1))
           OR (
                ed.username IS NOT NULL
                AND LOWER(TRIM(ed.username)) = LOWER(TRIM($1))
           )
        ORDER BY
            CASE WHEN NULLIF(TRIM(ed.work_email), '') IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1
        `,
        [name],
    );

    const row = result.rows[0];
    if (!row) return null;
    return row.work_email || row.personal_email || null;
}

/**
 * Collect unique work emails for usernames (creator / folder owner).
 */
export async function collectWorkEmailsForUsernames(usernames = []) {
    const names = [
        ...new Set(
            (Array.isArray(usernames) ? usernames : [])
                .map((u) => String(u || '').trim())
                .filter(Boolean),
        ),
    ];
    const emails = [];
    for (const username of names) {
        const email = await getWorkEmailByUsername(username);
        if (email && email.includes('@')) emails.push(email.toLowerCase());
    }
    return [...new Set(emails)];
}

function splitAssignedUsernames(raw) {
    return String(raw || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

async function projectCodeFromFolder(folder) {
    const direct = String(folder?.project_code || '').trim();
    if (direct) return direct;
    const rootId = Number(folder?.scope_root_id);
    if (!Number.isFinite(rootId) || rootId <= 0) return '';
    const result = await pool.query(
        `SELECT project_code FROM file_manager_items WHERE id = $1`,
        [rootId],
    );
    return String(result.rows[0]?.project_code || '').trim();
}

/**
 * Work emails for a project's assigned users and created_by,
 * plus any extra usernames (folder owner / actor).
 * Used to grant Google Sheet and Doc editor access.
 */
export async function collectProjectGoogleEditorEmails({
    projectCode = null,
    folder = null,
    extraUsernames = [],
} = {}) {
    const names = [...extraUsernames];
    const code =
        String(projectCode || '').trim() ||
        (await projectCodeFromFolder(folder));

    if (code) {
        const project = await ProjectModel.findByCode(code);
        if (project) {
            if (project.created_by) names.push(project.created_by);
            names.push(...splitAssignedUsernames(project.assigned_users_display));
        }
    }

    return collectWorkEmailsForUsernames(names);
}
