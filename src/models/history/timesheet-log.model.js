import { pool } from '../../config/db.js';

class TimesheetLogModel {
    static async create({
        timesheetId,
        action,
        projectCode = null,
        subjectUserId = null,
        subjectUsername = null,
        actorUserId = null,
        actorUsername = null,
        oldValue = null,
        newValue = null,
    }) {
        const safeAction = String(action || '').trim().toUpperCase();
        if (!timesheetId || !safeAction) return null;

        const result = await pool.query(
            `INSERT INTO timesheet_log (
                timesheet_id,
                action,
                project_code,
                subject_user_id,
                subject_username,
                actor_user_id,
                actor_username,
                old_value,
                new_value
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
            RETURNING *`,
            [
                Number(timesheetId),
                safeAction,
                projectCode != null ? String(projectCode).trim() : null,
                subjectUserId != null ? Number(subjectUserId) : null,
                subjectUsername != null ? String(subjectUsername).trim() : null,
                actorUserId != null ? Number(actorUserId) : null,
                actorUsername != null ? String(actorUsername).trim() : null,
                oldValue != null ? JSON.stringify(oldValue) : null,
                newValue != null ? JSON.stringify(newValue) : null,
            ],
        );

        return result.rows[0] || null;
    }

    static async findAll(filters = {}) {
        const {
            timesheetId,
            action,
            projectCode,
            subjectUserId,
            subjectUsername,
            actorUserId,
            actorUsername,
            dateStart,
            dateEnd,
            page,
            limit,
            sortOrder,
        } = filters;

        const params = [];
        const conditions = [];

        if (timesheetId != null && String(timesheetId).trim() !== '') {
            params.push(parseInt(timesheetId, 10));
            conditions.push(`timesheet_id = $${params.length}`);
        }

        if (action) {
            const actionValues = Array.isArray(action)
                ? action
                : String(action)
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean);

            if (actionValues.length > 0) {
                const normalizedActions = actionValues.map((value) => value.toUpperCase());
                const placeholders = normalizedActions.map((_, index) => `$${params.length + index + 1}`).join(', ');
                params.push(...normalizedActions);
                conditions.push(`action IN (${placeholders})`);
            }
        }

        if (projectCode) {
            params.push(String(projectCode).trim());
            conditions.push(`TRIM(UPPER(project_code)) = TRIM(UPPER($${params.length}))`);
        }

        if (subjectUserId != null && String(subjectUserId).trim() !== '') {
            params.push(parseInt(subjectUserId, 10));
            conditions.push(`subject_user_id = $${params.length}`);
        }

        if (subjectUsername) {
            params.push(`%${String(subjectUsername).trim()}%`);
            conditions.push(`subject_username ILIKE $${params.length}`);
        }

        if (actorUserId != null && String(actorUserId).trim() !== '') {
            params.push(parseInt(actorUserId, 10));
            conditions.push(`actor_user_id = $${params.length}`);
        }

        if (actorUsername) {
            params.push(`%${String(actorUsername).trim()}%`);
            conditions.push(`actor_username ILIKE $${params.length}`);
        }

        if (dateStart) {
            params.push(dateStart);
            conditions.push(`created_at >= $${params.length}::date`);
        }

        if (dateEnd) {
            params.push(dateEnd);
            conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
        }

        const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        const direction = sortOrder && sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const countQuery = `SELECT COUNT(*) AS count FROM timesheet_log${whereClause}`;
        let dataQuery = `SELECT * FROM timesheet_log${whereClause} ORDER BY created_at ${direction}, id ${direction}`;

        const countParams = [...params];

        if (page && limit) {
            const limitNum = parseInt(limit, 10);
            const offset = (parseInt(page, 10) - 1) * limitNum;
            params.push(limitNum, offset);
            dataQuery += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
        }

        const [countResult, dataResult] = await Promise.all([
            pool.query(countQuery, countParams),
            pool.query(dataQuery, params),
        ]);

        return {
            rows: dataResult.rows,
            totalCount: parseInt(countResult.rows[0].count, 10),
        };
    }
}

export default TimesheetLogModel;
