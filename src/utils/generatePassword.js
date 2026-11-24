import { pool } from "../config/db.js";

/**
 * Generate random password
 */
const generateRandomPassword = (length = 12) => {
    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const symbols = "@#$!%&*?";

    const allChars = uppercase + lowercase + numbers + symbols;

    let password = "";

    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += symbols[Math.floor(Math.random() * symbols.length)];

    for (let i = password.length; i < length; i++) {
        password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    password = password
        .split("")
        .sort(() => Math.random() - 0.5)
        .join("");

    return password;
};

const generatePassword = async (personalDetailsId) => {
    const query = `
        SELECT
            work_location,
            employment_id
        FROM employment_details
        WHERE personal_details_id = $1
    `;

    const { rows } = await pool.query(query, [personalDetailsId]);

    // Employment details not found
    if (!rows.length) {
        return generateRandomPassword();
    }

    const { work_location, employment_id } = rows[0];

    // Validate values
    if (
        work_location === null ||
        work_location === undefined ||
        employment_id === null ||
        employment_id === undefined ||
        String(work_location).trim() === "" ||
        String(employment_id).trim() === ""
    ) {
        return generateRandomPassword();
    }

    // Convert work_location ID to string
    const formattedLocation = String(work_location)
        .trim()
        .replace(/\s+/g, "");

    const formattedEmploymentId = String(employment_id).trim();

    return `${formattedLocation}@${formattedEmploymentId}`;
};

export default generatePassword;