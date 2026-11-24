import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeMaintenanceTable = async () => {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS maintenance (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            end_time TIMESTAMP,
            created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
            updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
        )
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS maintenance_features (
            id SERIAL PRIMARY KEY,
            maintenance_id INT REFERENCES maintenance(id) ON DELETE CASCADE,
            feature VARCHAR(255) NOT NULL
        )
    `);


    console.log("✅ maintenance tables ready");
};

export const saveMaintenanceModel = async ({
    title,
    description,
    endTime,
    features
}) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        const result = await client.query(`
            INSERT INTO maintenance
            (title, description, end_time)
            VALUES($1,$2,$3)
            RETURNING id
        `, [
            title,
            description,
            endTime
        ]);


        const maintenanceId = result.rows[0].id;


        for (const item of features) {

            await client.query(`
                INSERT INTO maintenance_features
                (maintenance_id, feature)
                VALUES($1,$2)
            `, [
                maintenanceId,
                item
            ]);

        }


        await client.query("COMMIT");


        // Fetch saved maintenance data
        const maintenance = await client.query(`
            SELECT 
                id,
                title,
                description,
                end_time
            FROM maintenance
            WHERE id=$1
        `, [
            maintenanceId
        ]);


        const featureData = await client.query(`
            SELECT 
                id,
                feature
            FROM maintenance_features
            WHERE maintenance_id=$1
            ORDER BY id
        `, [
            maintenanceId
        ]);


        return {
            ...maintenance.rows[0],
            features: featureData.rows
        };


    } catch(err) {

        await client.query("ROLLBACK");
        throw err;

    } finally {

        client.release();

    }

};

export const getMaintenanceModel = async () => {

    const settings = await pool.query(`
        SELECT *
        FROM maintenance
        ORDER BY id DESC
        LIMIT 1
    `);


    if (!settings.rows.length) return null;


    const maintenance = settings.rows[0];


    const features = await pool.query(`
        SELECT id, feature
        FROM maintenance_features
        WHERE maintenance_id=$1
        ORDER BY id
    `,[
        maintenance.id
    ]);


    maintenance.features = features.rows;

    return maintenance;
};