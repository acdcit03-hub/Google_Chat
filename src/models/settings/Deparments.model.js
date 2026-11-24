import { pool } from "../../database.js";

/* ================= CREATE TABLE ================= */
export const initializeDepartmentsTable = async () => {
  const query = `
    CREATE TABLE IF NOT EXISTS departments_hrms (
      id SERIAL PRIMARY KEY,
      department_name VARCHAR(255) NOT NULL,
      description TEXT,
      created_by VARCHAR(255),
      status BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP),
      updated_at TIMESTAMP DEFAULT TIMEZONE('Asia/Kolkata', CURRENT_TIMESTAMP)
    );
  `;

  await pool.query(query);
  console.log("✅ departments_hrms table ready");
};

/* ================= ADD ================= */
export const addDepartmentModel = async (data) => {
  const query = `
    INSERT INTO departments_hrms
    (
      department_name,
      description,
      created_by,
      status
    )
    VALUES ($1,$2,$3,$4)
    RETURNING *;
  `;

  const { rows } = await pool.query(query, [
    data.department_name.trim(),
    data.description || null,
    data.created_by || null,
    data.status ?? true
  ]);

  return rows[0];
};

/* ================= GET ALL ================= */
export const getAllDepartmentsModel = async (status = null) => {

  let query = `
    SELECT *
    FROM departments_hrms
    WHERE 1=1
  `;

  const values = [];
  let count = 1;

  if (status !== null) {
    query += ` AND status = $${count}`;
    values.push(status === "true" || status === true);
    count++;
  }

  query += `
    ORDER BY department_name ASC
  `;

  const { rows } = await pool.query(query, values);
  return rows;
};

/* ================= UPDATE ================= */
export const updateDepartmentModel = async (id, data) => {

  const query = `
    UPDATE departments_hrms
    SET
      department_name = $1,
      description = $2,
      created_by = $3,
      status = $4,
      updated_at = TIMEZONE(
        'Asia/Kolkata',
        CURRENT_TIMESTAMP
      )
    WHERE id = $5
    RETURNING *;
  `;

  const { rows } =
    await pool.query(query, [
      data.department_name.trim(),
      data.description || null,
      data.created_by || null,
      data.status ?? true,
      id
    ]);

  return rows[0];
};

/* ================= TOGGLE STATUS ================= */
export const toggleDepartmentStatusModel = async (id) => {
  const { rows } =
    await pool.query(`
        SELECT *
        FROM departments_hrms
        WHERE id = $1
      `,
      [id]
    );

  if (!rows.length) {
    return null;
  }

  const newStatus = !rows[0].status;

  const result =
    await pool.query(`
        UPDATE departments_hrms
        SET
          status = $1,
          updated_at = TIMEZONE(
            'Asia/Kolkata',
            CURRENT_TIMESTAMP
          )
        WHERE id = $2
        RETURNING *;
      `,
      [newStatus, id]
    );

  return result.rows[0];
};