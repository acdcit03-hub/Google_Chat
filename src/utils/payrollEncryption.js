import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({
    path: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../.env"
    )
});

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";

const getEncryptionKey = () => {
    const configuredKey = process.env.PAYROLL_ENCRYPTION_KEY;
    if (!configuredKey || !/^[a-f\d]{64}$/i.test(configuredKey)) {
        throw new Error(
            "PAYROLL_ENCRYPTION_KEY must be configured as 64 hexadecimal characters"
        );
    }

    return Buffer.from(configuredKey, "hex");
};

export const encryptPayrollValue = value => {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const plaintext = String(value);
    if (plaintext.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        return plaintext;
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        getEncryptionKey(),
        iv
    );
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final()
    ]);

    return [
        "enc",
        "v1",
        iv.toString("hex"),
        cipher.getAuthTag().toString("hex"),
        ciphertext.toString("hex")
    ].join(":");
};

export const encryptPayrollAmount = value => {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const amount = Number(value);
    if (!Number.isFinite(amount) || Math.abs(amount) >= 10000000000) {
        throw new Error("Payroll amounts must fit NUMERIC(12,2)");
    }

    return encryptPayrollValue(amount.toFixed(2));
};

export const decryptPayrollValue = value => {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const encryptedValue = String(value);
    if (!encryptedValue.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        return encryptedValue;
    }

    const [, , ivHex, authTagHex, ciphertextHex] = encryptedValue.split(":");
    if (
        !/^[a-f\d]{24}$/i.test(ivHex || "") ||
        !/^[a-f\d]{32}$/i.test(authTagHex || "") ||
        !/^(?:[a-f\d]{2})+$/i.test(ciphertextHex || "")
    ) {
        throw new Error("Stored payroll encryption value is malformed");
    }

    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        getEncryptionKey(),
        Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextHex, "hex")),
        decipher.final()
    ]).toString("utf8");
};

export const encryptPayrollFields = (record, fields) => {
    if (!record) return record;

    return {
        ...record,
        ...Object.fromEntries(
            fields.map(field => [
                field,
                encryptPayrollValue(record[field])
            ])
        )
    };
};

export const decryptPayrollFields = (record, fields) => {
    if (!record) return record;

    return {
        ...record,
        ...Object.fromEntries(
            fields.map(field => {
                const decryptedValue = decryptPayrollValue(record[field]);
                const numericValue = decryptedValue === null
                    ? null
                    : Number(decryptedValue);

                if (
                    decryptedValue !== null &&
                    !Number.isFinite(numericValue)
                ) {
                    throw new Error(
                        `Stored payroll field '${field}' is not a valid number`
                    );
                }

                return [field, numericValue];
            })
        )
    };
};

export const encryptPayrollRows = (rows, fields) =>
    rows.map(row => encryptPayrollFields(row, fields));

export const decryptPayrollRows = (rows, fields) =>
    rows.map(row => decryptPayrollFields(row, fields));

export const migratePayrollEncryptedColumns = async (
    poolOrClient,
    table,
    columns
) => {
    const allowedTables = new Set(["salary_details", "payroll"]);
    const allowedColumns = new Set([
        "current_salary",
        "basic_salary"
    ]);
    if (
        !allowedTables.has(table) ||
        columns.some(column => !allowedColumns.has(column))
    ) {
        throw new Error("Invalid payroll encryption migration target");
    }

    const client = await poolOrClient.connect();
    try {
        await client.query("BEGIN");
        const selected = await client.query(
            `SELECT id, ${columns.join(", ")}
             FROM ${table}
             WHERE ${columns
                .map(column => `${column} IS NOT NULL AND ${column} NOT LIKE 'enc:v1:%'`)
                .join(" OR ")}
             FOR UPDATE;`
        );

        for (const row of selected.rows) {
            for (const column of columns) {
                if (row[column] === null || row[column] === undefined) continue;
                await client.query(
                    `UPDATE ${table} SET ${column} = $1 WHERE id = $2`,
                    [encryptPayrollValue(row[column]), row.id]
                );
            }
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};
