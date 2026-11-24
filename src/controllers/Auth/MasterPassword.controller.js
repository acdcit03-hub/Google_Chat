import { pool } from "../../database.js";
import { createMasterPasswordModel, getMasterPasswordModel, matchSecretKeyModel, resetMasterPasswordModel, resetSecretKeyModel } from "../../models/auth/MasterPassword.model.js";
import { sendOTPmail } from "../../utils/mailer.js";
import { generateOTPToken } from "./reset.controller.js";
import crypto from "crypto";

/* ================= CREATE MASTER PASSWORD ================= */
export const createMasterPassword = async (req, res) => {
    try {
        const { password } = req.body;

        /* ================= GET CREATED BY FROM HEADER ================= */
        const created_by = req.headers["x-hrms-username"] || null;

        /* ================= VALIDATION ================= */
        if (!password) {
            return res.status(400).json({
                success: false,
                message: "Master password is required"
            });
        }

        if (String(password).length < 6) {
            return res.status(400).json({
                success: false,
                message:
                    "Master password must be at least 6 characters"
            });
        }

        /* ================= CREATE ================= */
        const data = await createMasterPasswordModel({
            password,
            created_by
        });

        return res.status(201).json({
            success: true,
            message: "Master password created successfully",
            data
        });

    } catch (error) {
        console.error("CREATE MASTER PASSWORD ERROR:", error);
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= SEND PASSWORD OTP ================= */

export const sendPasswordSetupMail = async (req, res) => {

    try {

        const { username, email } = req.body;

        /* ================= VALIDATION ================= */

        if (!username || !email) {
            return res.status(400).json({
                success: false,
                message: "Username and email are required"
            });
        }

        /* ================= GET ADMIN EMPLOYEE ================= */

        const { rows } = await pool.query(
            `
                SELECT
                    pd.id,
                    pd.first_name,
                    pd.middle_name,
                    pd.last_name,
                    pd.username,
                    ed.work_email,
                    ed.access

                FROM employment_details ed

                INNER JOIN personal_details pd
                    ON pd.id = ed.personal_details_id

                WHERE LOWER(TRIM(ed.username))
                    = LOWER(TRIM($1))

                AND ed.access = 1

                LIMIT 1
            `,
            [username]
        );

        /* ================= CHECK ADMIN ================= */

        if (!rows.length) {
            return res.status(401).json({
                success: false,
                message: "Only authorized admin users can set the master password"
            });
        }

        const employee = rows[0];

        /* ================= MATCH USERNAME ================= */

        const payloadUsername = String(username)
            .trim()
            .toLowerCase();

        const employeeUsername = String(employee.username || "")
            .trim()
            .toLowerCase();

        if (
            !employeeUsername ||
            payloadUsername !== employeeUsername
        ) {
            return res.status(401).json({
                success: false,
                message: "Username and email do not match"
            });
        }

        /* ================= MATCH WORK EMAIL ================= */

        const payloadEmail = String(email)
            .trim()
            .toLowerCase();

        const employeeWorkEmail = String(employee.work_email || "")
            .trim()
            .toLowerCase();

        if (
            !employeeWorkEmail ||
            payloadEmail !== employeeWorkEmail
        ) {
            return res.status(401).json({
                success: false,
                message: "Username and email do not match"
            });
        }

        /* ================= GENERATE OTP TOKEN ================= */

        const {
            otp,
            token
        } = generateOTPToken(
            employeeWorkEmail,
            employee.id
        );

        /* ================= SEND OTP ================= */

        await sendOTPmail(
            employeeWorkEmail,
            otp,
            60
        );

        /* ================= RESPONSE ================= */

        return res.status(200).json({
            success: true,
            message: "OTP sent successfully.",
            data: {
                username: employee.username,
                email: employeeWorkEmail,
                access: employee.access,
                expires_in: 60
            },
            token
        });

    } catch (error) {

        console.error(
            "SEND PASSWORD OTP ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                error.message ||
                "Failed to send OTP"
        });
    }
};

/* ================= GET MASTER PASSWORD ================= */
export const getMasterPassword = async (req, res) => {
    try {
        const data = await getMasterPasswordModel();

        return res.status(200).json({
            success: true,
            message: data.is_configured
                ? "Master password details fetched successfully"
                : "Master password not configured",
            data
        });

    } catch (error) {
        console.error("GET MASTER PASSWORD ERROR:", error);
        return res.status(500).json({
            success: false,
            message:
                error.message ||
                "Failed to fetch master password"
        });
    }
};

/* ================= MATCH SECRET KEY ================= */
export const matchSecretKey = async (req, res) => {
    try {
        const { secret_key } = req.body;

        /* ================= VALIDATION ================= */
        if (!secret_key) {
            return res.status(400).json({
                success: false,
                message: "Secret key is required"
            });
        }

        /* ================= MATCH SECRET KEY ================= */
        const data = await matchSecretKeyModel(
            secret_key
        );

        if (!data) {
            return res.status(401).json({
                success: false,
                message: "Invalid secret key"
            });
        }

        /* ================= SUCCESS ================= */
        return res.status(200).json({
            success: true,
            message: "Secret key matched successfully",
            data
        });

    } catch (error) {
        console.error("MATCH SECRET KEY ERROR:", error);
        return res.status(500).json({
            success: false,
            message:
                error.message ||
                "Failed to match secret key"

        });
    }
};

/* ================= RESET MASTER PASSWORD ================= */
export const resetMasterPassword = async (req, res) => {
    try {
        const {
            secret_key,
            new_password
        } = req.body;

        /* ================= VALIDATION ================= */
        if (!secret_key) {
            return res.status(400).json({
                success: false,
                message: "Secret key is required"
            });
        }

        if (!new_password) {
            return res.status(400).json({
                success: false,
                message: "New master password is required"
            });
        }

        if (String(new_password).length < 6) {
            return res.status(400).json({
                success: false,
                message:
                    "Master password must be at least 6 characters"
            });
        }

        /* ================= GET UPDATED BY ================= */
        const updated_by = req.headers["x-hrms-username"] || null;

        /* ================= RESET ================= */
        const data = await resetMasterPasswordModel({
            secret_key,
            new_password,
            updated_by
        });

        /* ================= RESPONSE ================= */
        return res.status(200).json({
            success: true,
            message: "Master password reset successfully",
            data
        });

    } catch (error) {
        console.error("RESET MASTER PASSWORD ERROR:", error);

        if (
            error.message === "Master password is not configured"
        ) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        if (
            error.message === "Invalid secret key"
        ) {
            return res.status(401).json({
                success: false,
                message: error.message
            });
        }

        return res.status(500).json({
            success: false,
            message:
                error.message ||
                "Failed to reset master password"
        });
    }
};

/* ================= RESET SECRET KEY ================= */
export const resetSecretKey = async (req, res) => {
    try {
        /* ================= GET UPDATED BY ================= */
        const updated_by = req.headers["x-hrms-username"] || null;

        /* ================= RESET SECRET KEY ================= */
        const data = await resetSecretKeyModel({
            updated_by
        });

        /* ================= GENERATE TOKEN ================= */
        const token = crypto.randomBytes(32).toString("hex");

        /* ================= SUCCESS ================= */
        return res.status(200).json({
            success: true,
            message: "Secret key reset successfully",
            data: {
                ...data,
                token
            }
        });

    } catch (error) {
        console.error("RESET SECRET KEY ERROR:", error);

        /* ================= MASTER PASSWORD NOT CONFIGURED ================= */
        if (
            error.message ===
            "Master password is not configured"
        ) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        /* ================= 60 SECOND LIMIT ================= */
        if (
            error.message.includes(
                "Secret key can be reset again after"
            )
        ) {
            return res.status(429).json({
                success: false,
                message: error.message
            });
        }

        /* ================= OTHER ERROR ================= */
        return res.status(500).json({
            success: false,
            message:
                error.message ||
                "Failed to reset secret key"
        });
    }
};