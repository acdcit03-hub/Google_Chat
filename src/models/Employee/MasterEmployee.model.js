import { pool } from "../../database.js";
import { generateEmploymentId } from "./EmploymentDetails.model.js";

/* ================= CREATE MASTER EMPLOYEE TABLE ================= */
export const initializeMasterEmployeeTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS master_employee (
            id SERIAL PRIMARY KEY,
            personal_details_id INTEGER,
            username VARCHAR(50),
            status VARCHAR(50) NOT NULL DEFAULT 'pending_approval',
            candidate_status VARCHAR(50),
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata',CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata',CURRENT_TIMESTAMP),

            CONSTRAINT fk_master_employee_personal
            FOREIGN KEY (personal_details_id)
            REFERENCES personal_details(id)
            ON DELETE CASCADE
        );
    `;

    await pool.query(query);

    /* =========================================================
       ADD candidate_status TO EXISTING TABLE
    ========================================================= */
    await pool.query(`
        ALTER TABLE master_employee
        ADD COLUMN IF NOT EXISTS candidate_status VARCHAR(50);
    `);

    await pool.query(`
        ALTER TABLE master_employee
        DROP CONSTRAINT IF EXISTS master_employee_status_check;
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'master_employee_personal_details_id_key'
            ) THEN
                ALTER TABLE master_employee
                ADD CONSTRAINT master_employee_personal_details_id_key
                UNIQUE (personal_details_id);
            END IF;
        END $$;
    `);

    await pool.query(`
        SELECT setval(
            pg_get_serial_sequence('master_employee', 'id'),
            COALESCE((SELECT MAX(id) FROM master_employee), 1),
            true
        );
    `);

    console.log("✅ master_employee table ready");
};

export const addMasterEmployeeModel = async ({
    personal_details_id,
    status = "pending_approval",
    candidate_status = null
}) => {

    const { rows } = await pool.query(
        `
            INSERT INTO master_employee
            (
                personal_details_id,
                username,
                status,
                candidate_status
            )
            SELECT
                pd.id,
                pd.username,
                $2,
                $3
            FROM personal_details pd
            WHERE pd.id = $1
        
            RETURNING *
        `,
        [
            personal_details_id,
            status,
            candidate_status
        ]
    );


    if (rows.length === 0) {
        throw new Error(
            "Personal details not found with id: " + personal_details_id
        );
    }


    return rows[0];
};

export const getMasterEmployeeByPersonalIdModel = async (
    personal_details_id
) => {
    const { rows } = await pool.query(
        `
            SELECT
                me.personal_details_id,
                me.username,
                me.status,
                me.candidate_status
            FROM master_employee me
            WHERE me.personal_details_id = $1
            LIMIT 1
        `,
        [personal_details_id]
    );

    return rows[0] || null;
};

export const updateEmployeeStatusModel = async (
    personal_details_id,
    status,
    candidate_status = null
) => {

    const normalizedStatus =
        String(status).trim();

    const normalizedCandidateStatus =
        candidate_status !== undefined &&
        candidate_status !== null &&
        String(candidate_status).trim() !== ""
            ? String(candidate_status).trim()
            : null;

    /* =========================================================
       INSERT / UPDATE
    ========================================================= */

    const { rows } = await pool.query(
        `
        INSERT INTO master_employee
        (
            personal_details_id,
            username,
            status,
            candidate_status
        )
        SELECT
            pd.id,
            pd.username,
            $2,
            $3
        FROM personal_details pd
        WHERE pd.id = $1

        ON CONFLICT (personal_details_id)
        DO UPDATE
        SET
            username = EXCLUDED.username,
            status = EXCLUDED.status,
            candidate_status = EXCLUDED.candidate_status,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )

        RETURNING
            id,
            personal_details_id,
            username,
            status,
            candidate_status,
            created_at,
            updated_at;
        `,
        [
            personal_details_id,
            normalizedStatus,
            normalizedCandidateStatus
        ]
    );

    if (rows.length === 0) {
        throw new Error(
            `Personal details not found with id: ${personal_details_id}`
        );
    }

    /* =========================================================
       GENERATE EMPLOYMENT ID ONLY FOR ACTIVE
    ========================================================= */

    if (
        normalizedStatus.toLowerCase() === "active"
    ) {

        const {
            rows: employmentRows
        } = await pool.query(
            `
            SELECT
                id,
                employment_id,
                work_location,
                date_of_joining,
                category
            FROM employment_details
            WHERE personal_details_id = $1
            LIMIT 1
            `,
            [personal_details_id]
        );

        if (
            employmentRows.length > 0 &&
            !employmentRows[0].employment_id
        ) {

            const employmentId =
                await generateEmploymentId(
                    employmentRows[0].work_location,
                    employmentRows[0].date_of_joining,
                    employmentRows[0].category
                );

            await pool.query(
                `
                UPDATE employment_details
                SET
                    employment_id = $1,
                    updated_at = TIMEZONE(
                        'Asia/Kolkata',
                        CURRENT_TIMESTAMP
                    )
                WHERE id = $2
                `,
                [
                    employmentId,
                    employmentRows[0].id
                ]
            );
        }
    }

    return rows[0];
};

export const getAllEmployeesModel = async () => {
    const { rows } = await pool.query(
        `
            SELECT
                me.id,
                me.status,
                me.candidate_status,
                me.username,
                pd.first_name,
                pd.last_name,
                pd.mobile_number,
                pd.email_id,
                me.created_at
            FROM master_employee me
            LEFT JOIN personal_details pd
                ON pd.id = me.personal_details_id
            ORDER BY me.id DESC
        `
    );

    return rows;
};
