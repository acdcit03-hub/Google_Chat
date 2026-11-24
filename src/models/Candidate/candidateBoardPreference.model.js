import { pool } from "../../database.js";

/* ================= CREATE TABLE =================
   Aa table ma hammesha fakt ONE j row rehse (id = 1).
   Board preference global chhe, per-user nathi. */
export const initializeCandidateBoardPreferenceTable = async () => {
    /* Juni per-user (username vali) table hoy to tenu
       pehli row nu data sachvi ne navi single-row table ma nakho */
    const oldSchema = await pool.query(`
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'candidate_board_preference'
          AND column_name = 'username'
        LIMIT 1;
    `);

    let oldPreference = null;

    if (oldSchema.rows.length > 0) {
        const oldData = await pool.query(`
            SELECT status_order, card_order, username
            FROM candidate_board_preference
            ORDER BY id ASC
            LIMIT 1;
        `);

        oldPreference = oldData.rows[0] || null;

        await pool.query(`DROP TABLE candidate_board_preference;`);
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS candidate_board_preference (
            id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            status_order JSONB NOT NULL DEFAULT '[]'::JSONB,
            card_order JSONB NOT NULL DEFAULT '{}'::JSONB,
            collapsed_columns JSONB NOT NULL DEFAULT '[]'::JSONB,
            updated_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        );
    `);

    await pool.query(`
        ALTER TABLE candidate_board_preference
        ADD COLUMN IF NOT EXISTS collapsed_columns JSONB NOT NULL DEFAULT '[]'::JSONB;
    `);

    /* By default ek row hammesha hoy j */
    await pool.query(`
        INSERT INTO candidate_board_preference
        (
            id,
            status_order,
            card_order,
            updated_by
        )
        VALUES ($1, $2::JSONB, $3::JSONB, $4)
        ON CONFLICT (id) DO NOTHING;
    `, [
        1,
        JSON.stringify(oldPreference?.status_order ?? []),
        JSON.stringify(oldPreference?.card_order ?? {}),
        oldPreference?.username ?? null
    ]);
};

let tableReadyPromise = null;

const ensureTable = () => {
    if (!tableReadyPromise) {
        tableReadyPromise = initializeCandidateBoardPreferenceTable();
    }

    return tableReadyPromise;
};

/* ================= SAVE BOARD PREFERENCE =================
   Single row (id = 1) ne j UPDATE kare chhe, navi row kyarey nahi bane */
export const saveCandidateBoardPreferenceModel = async ({
    status_order,
    card_order,
    collapsed_columns = [],
    updated_by = null
}) => {
    await ensureTable();

    const result = await pool.query(
        `
        INSERT INTO candidate_board_preference
        (
            id,
            status_order,
            card_order,
            collapsed_columns,
            updated_by
        )
        VALUES (1, $1::JSONB, $2::JSONB, $3::JSONB, $4)
        ON CONFLICT (id)
        DO UPDATE SET
            status_order = EXCLUDED.status_order,
            card_order = EXCLUDED.card_order,
            collapsed_columns = EXCLUDED.collapsed_columns,
            updated_by = EXCLUDED.updated_by,
            updated_at = TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        RETURNING
            status_order,
            card_order,
            collapsed_columns;
        `,
        [
            JSON.stringify(status_order),
            JSON.stringify(card_order),
            JSON.stringify(collapsed_columns),
            updated_by
        ]
    );

    return result.rows[0];
};

/* ================= GET BOARD PREFERENCE ================= */
export const getCandidateBoardPreferenceModel = async () => {
    await ensureTable();

    const result = await pool.query(
        `
        SELECT
            status_order,
            card_order,
            collapsed_columns
        FROM candidate_board_preference
        WHERE id = 1
        LIMIT 1;
        `
    );

    if (!result.rows[0]) {
        return {
            status_order: [],
            card_order: {},
            collapsed_columns: []
        };
    }

    return {
        status_order: Array.isArray(result.rows[0].status_order)
            ? result.rows[0].status_order
            : [],
        card_order:
            result.rows[0].card_order &&
            typeof result.rows[0].card_order === "object" &&
            !Array.isArray(result.rows[0].card_order)
                ? result.rows[0].card_order
                : {},
        collapsed_columns: Array.isArray(result.rows[0].collapsed_columns)
            ? result.rows[0].collapsed_columns
            : []
    };
};
