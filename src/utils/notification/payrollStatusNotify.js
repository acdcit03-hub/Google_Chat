// import { emitDesktopNotification } from "./r2rDesktopNotify.js";
// import { pool } from "../../config/db.js";

export const PAYROLL_CONFIG_EXPIRED_NOTIFICATION = "payroll-config-expired";
export const SALARY_INCREMENT_UPCOMING_NOTIFICATION = "salary-increment-upcoming";

/* =========================================================
   PAYROLL NOTIFICATIONS DISABLED
========================================================= */

export async function createPayrollExpiryNotifications(client, configs) {
    return [];
    /*
    const notifications = [];

    for (const config of configs) {
        const title = "Payroll configuration expired";
        
        const message =
            `${config.username} payroll configuration ` +
            `(${config.serial_number}) ` +
            `expired on ${config.payroll_end_date}. Please contact HR to renew it.`;

        const meta = {
            payroll_config_id: config.id,
            serial_number: config.serial_number,
            payroll_end_date: config.payroll_end_date
        };

        const result = await client.query(
            `
            INSERT INTO "READ_NOTIFICATION" (
                notification_type,
                sender_username,
                receive_username,
                page_name,
                href,
                title,
                message,
                meta,
                is_read
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
            RETURNING *;
            `,
            [
                PAYROLL_CONFIG_EXPIRED_NOTIFICATION,
                "System",
                config.username,
                "Payroll",
                "/payroll",
                title,
                message,
                JSON.stringify(meta)
            ]
        );

        notifications.push(result.rows[0]);
    }

    return notifications;
    */
}

export function emitPayrollExpiryNotifications(notifications) {
    return;
    /*
    for (const notification of notifications) {
        emitDesktopNotification({
            username: notification.receive_username,
            type: PAYROLL_CONFIG_EXPIRED_NOTIFICATION,
            title: notification.title,
            message: notification.message,
            href: notification.href,
            notification
        });
    }
    */
}

export async function createUpcomingSalaryIncrementNotifications() {
    return [];
    /*
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext('salary_increment_notifications'));"
        );

        const salaries = await client.query(`
            WITH latest_salary AS (
                SELECT DISTINCT ON (personal_details_id)
                    id,
                    personal_details_id,
                    next_increment_date
                FROM salary_details
                ORDER BY personal_details_id, id DESC
            )
            SELECT
                ls.id AS salary_detail_id,
                pd.username,
                TO_CHAR(ls.next_increment_date, 'YYYY-MM-DD')
                    AS next_increment_date
            FROM latest_salary ls
            INNER JOIN personal_details pd
                ON pd.id = ls.personal_details_id
            WHERE ls.next_increment_date =
                (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE + 2;
        `);

        const notifications = [];
        for (const salary of salaries.rows) {
            const title = "Salary increment approaching";

            const message =
                `${salary.username} next increment date is ` +
                `${salary.next_increment_date}.`;

            const meta = {
                salary_detail_id: salary.salary_detail_id,
                next_increment_date: salary.next_increment_date
            };
            const result = await client.query(
                `
                INSERT INTO "READ_NOTIFICATION" (
                    notification_type,
                    sender_username,
                    receive_username,
                    page_name,
                    href,
                    title,
                    message,
                    meta,
                    is_read
                )
                SELECT
                    $1::VARCHAR(100),
                    $2,
                    $3::VARCHAR(255),
                    $4,
                    $5,
                    $6,
                    $7,
                    $8::JSONB,
                    FALSE
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM "READ_NOTIFICATION"
                    WHERE notification_type = $1::VARCHAR(100)
                      AND LOWER(TRIM(receive_username)) =
                          LOWER(TRIM($3::VARCHAR(255)))
                      AND meta->>'salary_detail_id' = $9
                      AND meta->>'next_increment_date' = $10
                )
                RETURNING *;
                `,
                [
                    SALARY_INCREMENT_UPCOMING_NOTIFICATION,
                    "System",
                    salary.username,
                    "Payroll",
                    "/payroll",
                    title,
                    message,
                    JSON.stringify(meta),
                    String(salary.salary_detail_id),
                    salary.next_increment_date
                ]
            );

            if (result.rows[0]) {
                notifications.push(result.rows[0]);
            }
        }

        await client.query("COMMIT");
        return notifications;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
    */
}

export function emitUpcomingSalaryIncrementNotifications(notifications) {
    return;
    /*
    for (const notification of notifications) {
        emitDesktopNotification({
            username: notification.receive_username,
            type: SALARY_INCREMENT_UPCOMING_NOTIFICATION,
            title: notification.title,
            message: notification.message,
            href: notification.href,
            notification
        });
    }
    */
}
