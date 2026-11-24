import { pool } from "../../database.js";

/* =========================================================
   CREATE JOB POSITION TABLE
========================================================= */
export const initializeJobPositionTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS job_position (
            id SERIAL PRIMARY KEY,
            job_title VARCHAR(255),
            number_of_positions INTEGER NOT NULL,
            experience VARCHAR(255),
            skills_required JSONB,
            education JSONB,
            job_type VARCHAR(100),
            description TEXT,
            status BOOLEAN DEFAULT TRUE,
            created_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            ),

            updated_at TIMESTAMP DEFAULT TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        );
    `;

    await pool.query(query);

    await pool.query(`
        ALTER TABLE job_position
        ADD COLUMN IF NOT EXISTS job_title VARCHAR(255),
        DROP COLUMN IF EXISTS department,
        DROP COLUMN IF EXISTS sub_department;
    `);

    console.log("✅ job_position table ready");
};

/* =========================================================
   CREATE JOB POSITION
========================================================= */
export const createJobPositionModel = async ({
    job_title,
    number_of_positions,
    experience = null,
    skills_required = null,
    education = null,
    job_type = null,
    description = null,
    status = true,
    created_by = null
}) => {
    /* =====================================================
       CONVERT SKILLS TO JSON
    ===================================================== */
    let skillsJson = null;

    if (
        skills_required !== null &&
        skills_required !== undefined &&
        skills_required !== ""
    ) {
        if (Array.isArray(skills_required)) {

            skillsJson = JSON.stringify(
                skills_required
            );

        } else if (
            typeof skills_required === "string"
        ) {
            try {
                const parsedSkills = JSON.parse(skills_required);
                skillsJson = JSON.stringify(parsedSkills);

            } catch (error) {
                skillsJson =
                    JSON.stringify(
                        skills_required
                            .split(",")
                            .map(skill =>
                                skill.trim()
                            )
                            .filter(Boolean)
                    );
            }

        } else {
            skillsJson =
                JSON.stringify(
                    skills_required
                );
        }
    }

    /* =====================================================
       CONVERT EDUCATION TO JSON ARRAY
    ===================================================== */
    let educationJson = null;

    if (
        education !== null &&
        education !== undefined &&
        education !== ""
    ) {
        if (Array.isArray(education)) {
            educationJson =
                JSON.stringify(
                    education
                        .map(item =>
                            String(item).trim()
                        )
                        .filter(Boolean)
                );

        } else if (
            typeof education === "string"
        ) {
            try {
                const parsedEducation = JSON.parse(education);

                if (
                    Array.isArray(
                        parsedEducation
                    )
                ) {
                    educationJson =
                        JSON.stringify(
                            parsedEducation
                                .map(item =>
                                    String(item).trim()
                                )
                                .filter(Boolean)
                        );

                } else {
                    educationJson =
                        JSON.stringify([
                            String(
                                parsedEducation
                            ).trim()
                        ]);
                }

            } catch (error) {
                educationJson =
                    JSON.stringify(
                        education
                            .split(",")
                            .map(item =>
                                item.trim()
                            )
                            .filter(Boolean)
                    );
            }

        } else {
            educationJson =
                JSON.stringify([
                    String(education).trim()
                ]);
        }
    }

    /* =====================================================
       INSERT
    ===================================================== */
    const query = `
        INSERT INTO job_position (
            job_title,
            number_of_positions,
            experience,
            skills_required,
            education,
            job_type,
            description,
            status,
            created_by
        )
        VALUES (
            $1,
            $2,
            $3,
            $4::jsonb,
            $5::jsonb,
            $6,
            $7,
            $8,
            $9
        )
        RETURNING *;
    `;

    const values = [
        job_title,
        number_of_positions,
        experience,
        skillsJson,
        educationJson,
        job_type,
        description,
        status,
        created_by
    ];

    const result =
        await pool.query(
            query,
            values
        );

    return result.rows[0];
};

/* =========================================================
   GET ALL JOB POSITIONS
========================================================= */
export const getJobPositionModel = async ({
    job_title = null,
    job_type = null,
    status = null
} = {}) => {
    let query = `
        SELECT
            id,
            job_title,
            number_of_positions,
            experience,
            skills_required,
            education,
            job_type,
            description,
            status,
            created_by,
            created_at,
            updated_at
        FROM job_position
        WHERE 1 = 1
    `;

    const values = [];
    let index = 1;

     /* =====================================================
       JOB TITLE FILTER
    ===================================================== */
    if (
        job_title !== null &&
        job_title !== undefined &&
        String(job_title).trim() !== ""
    ) {

        query += `
            AND LOWER(TRIM(job_title))
                LIKE LOWER(TRIM($${index}))
        `;

        values.push(
            `%${String(job_title).trim()}%`
        );

        index++;
    }

    /* =====================================================
       JOB TYPE FILTER
    ===================================================== */
    if (
        job_type !== null &&
        job_type !== undefined &&
        String(job_type).trim() !== ""
    ) {

        query += `
            AND LOWER(TRIM(job_type))
            LIKE LOWER(TRIM($${index}))
        `;

        values.push(
            `%${String(job_type).trim()}%`
        );

        index++;
    }

    /* =====================================================
       STATUS FILTER
    ===================================================== */
    if (
        status !== null &&
        status !== undefined
    ) {

        let statusValue;

        if (
            typeof status === "boolean"
        ) {
            statusValue = status;
        } else if (
            status === "true" ||
            status === "false"
        ) {
            statusValue = status === "true";
        } else {
            throw new Error(
                "Status must be true or false"
            );
        }

        query += `
            AND status = $${index}
        `;

        values.push(statusValue);

        index++;
    }


    query += `
        ORDER BY id DESC
    `;

    const result =
        await pool.query(
            query,
            values
        );

    return result.rows;
};

/* =========================================================
   GET JOB POSITION BY ID
========================================================= */
export const getJobPositionByIdModel = async (
    id
) => {
    const query = `
        SELECT
            id,
            job_title,
            number_of_positions,
            experience,
            skills_required,
            education,
            job_type,
            description,
            status,
            created_by,
            created_at,
            updated_at
        FROM job_position
        WHERE id = $1
    `;

    const result =
        await pool.query(
            query,
            [id]
        );

    return result.rows[0];
};

/* =========================================================
   UPDATE JOB POSITION
========================================================= */
export const updateJobPositionModel = async (
    id,
    {
        job_title,
        number_of_positions,
        experience = null,
        skills_required = null,
        education = null,
        job_type = null,
        description = null,
        status = true
    }
) => {
    /* =====================================================
       CONVERT SKILLS TO JSON
    ===================================================== */
    let skillsJson = null;

    if (
        skills_required !== null &&
        skills_required !== undefined &&
        skills_required !== ""
    ) {
        if (Array.isArray(skills_required)) {
            skillsJson =
                JSON.stringify(
                    skills_required
                );

        } else if (
            typeof skills_required === "string"
        ) {
            try {
                const parsedSkills =
                    JSON.parse(
                        skills_required
                    );

                skillsJson =
                    JSON.stringify(
                        parsedSkills
                    );

            } catch (error) {
                skillsJson =
                    JSON.stringify(
                        skills_required
                            .split(",")
                            .map(skill =>
                                skill.trim()
                            )
                            .filter(Boolean)
                    );
            }

        } else {
            skillsJson =
                JSON.stringify(
                    skills_required
                );
        }
    }

    /* =====================================================
       CONVERT EDUCATION TO JSON ARRAY
    ===================================================== */
    let educationJson = null;

    if (
        education !== null &&
        education !== undefined &&
        education !== ""
    ) {
        if (Array.isArray(education)) {
            educationJson =
                JSON.stringify(
                    education
                        .map(item =>
                            String(item).trim()
                        )
                        .filter(Boolean)
                );

        } else if (
            typeof education === "string"
        ) {
            try {
                const parsedEducation = JSON.parse(education);

                if (
                    Array.isArray(
                        parsedEducation
                    )
                ) {
                    educationJson =
                        JSON.stringify(
                            parsedEducation
                                .map(item =>
                                    String(item).trim()
                                )
                                .filter(Boolean)
                        );

                } else {
                    educationJson =
                        JSON.stringify([
                            String(
                                parsedEducation
                            ).trim()
                        ]);
                }

            } catch (error) {
                educationJson =
                    JSON.stringify(
                        education
                            .split(",")
                            .map(item =>
                                item.trim()
                            )
                            .filter(Boolean)
                    );
            }

        } else {
            educationJson =
                JSON.stringify([
                    String(education).trim()
                ]);
        }
    }

    /* =====================================================
       UPDATE
    ===================================================== */
    const query = `
        UPDATE job_position
        SET
            job_title = $1,
            number_of_positions = $2,
            experience = $3,
            skills_required = $4::jsonb,
            education = $5::jsonb,
            job_type = $6,
            description = $7,
            status = $8,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $9
        RETURNING *;
    `;

    const values = [
        job_title,
        number_of_positions,
        experience,
        skillsJson,
        educationJson,
        job_type,
        description,
        status,
        id
    ];

    const result =
        await pool.query(
            query,
            values
        );

    return result.rows[0];
};

/* =========================================================
   TOGGLE JOB POSITION STATUS
========================================================= */
export const toggleJobPositionStatusModel = async (
    id
) => {
    const query = `
        UPDATE job_position
        SET
            status = NOT status,
            updated_at = TIMEZONE(
                'Asia/Kolkata',
                CURRENT_TIMESTAMP
            )
        WHERE id = $1
        RETURNING *;
    `;

    const result =
        await pool.query(
            query,
            [id]
        );

    return result.rows[0];
};