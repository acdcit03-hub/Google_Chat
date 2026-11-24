import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../../database.js";
import { updatePasswordByPersonalId } from "../../models/Employee/employee.model.js";
import { sendOTPmail } from "../../utils/mailer.js";

const SALT_ROUNDS = 10;

export const generateTestToken = async (req, res) => {
    try {

        const { personalId } = req.query;

        if (!personalId) {
            return res.status(400).json({
                success: false,
                message: "personalId is required."
            });
        }

        const { rows } = await pool.query(
            `
            SELECT
                pd.id,
                pd.username,
                ed.work_email
            FROM personal_details pd
            INNER JOIN employment_details ed
                ON ed.personal_details_id = pd.id
            WHERE pd.id = $1
            `,
            [personalId]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Employee not found."
            });
        }

        const employee = rows[0];

        const token = jwt.sign(
            {
                personalId: employee.id,
                username: employee.username,
                email: employee.work_email,
                purpose: "set-password"
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "7d"
            }
        );

        return res.json({
            success: true,
            employee,
            token
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });

    }
};

export const generateOTPToken = (email, personalId) => {

    const otp = String(
        Math.floor(100000 + Math.random() * 900000)
    );

    const token = jwt.sign(
        {
            email: email.trim().toLowerCase(),
            otp,
            personalId
        },
        process.env.JWT_SECRET,
        {
            expiresIn: "60s"
        }
    );

    return {
        otp,
        token
    };
};

/* ================= SET PASSWORD ================= */
export const setPassword = async (req, res) => {
    try {

        const {
            token,
            new_password
        } = req.body;

        const payload = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        const { rows } = await pool.query(
            `
            SELECT id
            FROM personal_details
            WHERE username = $1
            LIMIT 1
            `,
            [payload.username]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Employee not found."
            });
        }

        const hashedPassword = await bcrypt.hash(
            new_password,
            10
        );

        await updatePasswordByPersonalId(
            rows[0].id,
            hashedPassword
        );

        return res.json({
            success: true,
            message: "Password set successfully."
        });

    } catch (err) {

        return res.status(400).json({
            success: false,
            message: "Invalid or expired link."
        });

    }
};

/* ================= REQUEST OTP ================= */
export const requestPasswordReset = async (req, res) => {
    try {

        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        const personal = (
            await pool.query(
                `
                    SELECT
                        pd.id,
                        pd.first_name,
                        pd.username,
                        ed.work_email
                    FROM employment_details ed
                    INNER JOIN personal_details pd
                        ON pd.id = ed.personal_details_id
                    WHERE LOWER(TRIM(ed.work_email)) = LOWER(TRIM($1))
                    LIMIT 1
                `,
                [email]
            )
        ).rows[0];

        if (!personal) {
            return res.status(404).json({
                success: false,
                message: "Email not found."
            });
        }

        const { otp, token } = generateOTPToken(
            email,
            personal.id
        );

        await sendOTPmail(email, otp, 60);

        return res.json({
            success: true,
            message: "OTP sent successfully.",
            token
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });

    }
};

/* ================= VERIFY OTP ================= */
export const verifyResetOTP = async (req, res) => {
    try {
        const { email, otp, token } = req.body;

        if (!email || !otp || !token) {
            return res.status(400).json({
                success: false,
                message: "Email, OTP and Token are required."
            });
        }

        let payload;

        try {
            payload = jwt.verify(
                token,
                process.env.JWT_SECRET
            );
        } catch {
            return res.status(400).json({
                success: false,
                message: "OTP expired."
            });
        }

        if (
            payload.email !== email.trim().toLowerCase()
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid Email."
            });
        }

        if (payload.otp !== otp) {
            return res.status(400).json({
                success: false,
                message: "Invalid OTP."
            });
        }

        return res.json({
            success: true,
            message: "OTP verified successfully."
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

/* ================= RESEND OTP ================= */
export const resendOTP = async (req, res) => {
    try {

        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        const personal = (
            await pool.query(
                `
                SELECT
                    pd.id,
                    pd.first_name,
                    pd.username,
                    ed.work_email
                FROM employment_details ed
                INNER JOIN personal_details pd
                    ON pd.id = ed.personal_details_id
                WHERE LOWER(TRIM(ed.work_email)) = LOWER(TRIM($1))
                LIMIT 1
                `,
                [email]
            )
        ).rows[0];

        if (!personal) {
            return res.status(404).json({
                success: false,
                message: "Email not found."
            });
        }

        const { otp, token } = generateOTPToken(
            email,
            personal.id
        );

        await sendOTPmail(email, otp, 60);

        return res.json({
            success: true,
            message: "OTP resent successfully.",
            token
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });

    }
};

/* ================= RESET PASSWORD ================= */
export const resetPassword = async (req, res) => {

    try {

        const {
            email,
            new_password
        } = req.body;

        if (!email || !new_password) {
            return res.status(400).json({
                success: false,
                message: "Email and New Password are required."
            });
        }

        const personal = (
            await pool.query(
                `
                SELECT
                    pd.id
                FROM employment_details ed
                INNER JOIN personal_details pd
                    ON pd.id = ed.personal_details_id
                WHERE LOWER(TRIM(ed.work_email)) =
                      LOWER(TRIM($1))
                LIMIT 1
                `,
                [email]
            )
        ).rows[0];

        if (!personal) {
            return res.status(404).json({
                success: false,
                message: "Email not found."
            });
        }

        const hashedPassword = await bcrypt.hash(
            new_password,
            SALT_ROUNDS
        );

        await updatePasswordByPersonalId(
            personal.id,
            hashedPassword
        );

        return res.json({
            success: true,
            message: "Password reset successful."
        });

    } catch (err) {

        return res.status(500).json({
            success: false,
            message: err.message
        });

    }
};