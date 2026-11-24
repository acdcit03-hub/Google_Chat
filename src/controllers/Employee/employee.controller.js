import generatePassword from "../../utils/generatePassword.js";
import sendCredentialsMail from "../../utils/mailer.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { createUserSessionModel, getClientEnvironment } from "../../models/users/userSession.model.js";

import {
    createEmployeeModel,
    findEmployeeForLoginModel,
    getAllEmployeesModel
} from "../../models/Employee/employee.model.js";

import { getPersonalDetailsByIdModel } from "../../models/Employee/PersonalDetails.model.js";
import { broadcastUserLogin } from "../../config/socket.js";
import { verifyMasterPasswordModel } from "../../models/auth/MasterPassword.model.js";

async function verifyEmployeePassword(input, stored) {
    if (stored == null || stored === "") return false;
    const storedStr = String(stored);
    if (storedStr.startsWith("$2")) {
        return bcrypt.compare(String(input), storedStr);
    }
    return String(input) === storedStr;
}

/* ================= EMPLOYEE LOGIN ================= */
export const loginEmployee = async (req, res) => {
    try {
        let { username, email, password } = req.body;
        username = (username || email)?.trim();

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: "Username and password are required",
            });
        }

        const employee = await findEmployeeForLoginModel(username);

        if (!employee || !employee.password) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials",
            });
        }

        /* =====================================================
          MASTER PASSWORD CHECK
          
          If entered password is master password,
          ANY employee username can login.
       ===================================================== */
        const isMasterPassword = await verifyMasterPasswordModel(password);

        /* =====================================================
           NORMAL EMPLOYEE PASSWORD CHECK
        ===================================================== */
        let passwordMatch = false;

        if (isMasterPassword) {

            // Master password is valid.
            // Ignore employee's own password.
            passwordMatch = true;

        } else {

            // Check employee's normal password
            if (!employee.password) {

                return res.status(401).json({
                    success: false,
                    message: "Invalid credentials"
                });

            }

            passwordMatch = await verifyEmployeePassword(
                password,
                employee.password
            );

        }

        /* ================= PASSWORD FAILED ================= */
        if (!passwordMatch) {

            return res.status(401).json({
                success: false,
                message: "Invalid credentials"
            });

        }

        /* ================= EMPLOYEE STATUS ================= */
        const employeeStatus = String(employee.employee_status || "")
            .trim()
            .toLowerCase();
        if (employeeStatus && employeeStatus !== "active") {
            return res.status(401).json({
                success: false,
                message:
                    employeeStatus === "inactive"
                        ? "Account is inactive"
                        : "Account is not active yet",
            });
        }

        const isAdmin = Number(employee.access) === 1;
        const responseUser = {
            id: employee.id,
            personalDetailsId: employee.personal_details_id,
            username: employee.username || username,
            email: employee.email_id || "",
            firstName: employee.first_name || "",
            lastName: employee.last_name || "",
            department: employee.department || "",
            role: employee.department || "",
            access: employee.access ?? 0,
            permissions: [],
            pagePermissions: {},
            locationPermissions: [],
            avatarColor: null,
            canAddEditDelete: isAdmin,
            canEdit: isAdmin,
            canDelete: isAdmin,
            canHead: isAdmin,
        };

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            return res.status(500).json({
                success: false,
                message: "JWT_SECRET is not configured on server",
            });
        }

        const expiresIn = String(process.env.JWT_EXPIRES_IN || "").trim();
        if (!expiresIn) {
            return res.status(500).json({
                success: false,
                message: "JWT_EXPIRES_IN is not configured on server",
            });
        }

        const session_id = randomUUID();
        const personalDetailsId = Number(responseUser.personalDetailsId);

        if (!Number.isInteger(personalDetailsId) || personalDetailsId <= 0) {
            return res.status(500).json({
                success: false,
                message: "Employee personal details are missing",
            });
        }

        const forwarded = req.headers["x-forwarded-for"];
        const ip_address = String(req.ip || (Array.isArray(forwarded) ? forwarded[0] : forwarded) || "")
            .slice(0, 100) || null;
        const user_agent = req.headers["user-agent"] || null;
        const { operating_system, browser_name } = getClientEnvironment(user_agent);

        await createUserSessionModel({
            user_id: personalDetailsId,
            session_id,
            ip_address,
            user_agent,
            operating_system,
            browser_name,
        });

        const token = jwt.sign(
            {
                sub: String(responseUser.id),
                id: responseUser.id,
                personalDetailsId,
                session_id,
                username: responseUser.username,
                department: responseUser.department,
                access: responseUser.access,
            },
            jwtSecret,
            { expiresIn },
        );

        try {
            broadcastUserLogin(
                responseUser.username,
                responseUser.department,
                responseUser.id,
            );
        } catch (socketErr) {
            console.error('Socket emit error (user-login):', socketErr);
        }

        return res.json({
            success: true,
            user: responseUser,
            token,
            session_id,
            token_type: "Bearer",
            expires_in: expiresIn,
        });
    } catch (error) {
        console.error("Employee login error:", error);
        return res.status(500).json({
            success: false,
            message: "An error occurred during login",
        });
    }
};

/* ================= CREATE EMPLOYEE ================= */
export const createEmployee = async (req, res) => {
    try {
        const {
            personal_details_id,
            department,
            access
        } = req.body;

        const personalData = await getPersonalDetailsByIdModel(personal_details_id);

        if (!personalData) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        const personal = personalData.personal_details;

        const name = [
            personal.first_name,
            personal.middle_name,
            personal.last_name
        ].filter(Boolean).join(" ");

        const username = personal.username;
        const email = req.body.email || personal.email_id;

        const password = await generatePassword(personal_details_id);

        const employee = await createEmployeeModel({
            personal_details_id,
            username,
            password,
            access,
            department
        });

        try {
            const info = await sendCredentialsMail(
                email,
                name,
                username,
                password
            );

            console.log("Email sent:", info);
        } catch (err) {
            console.error("Mail Error:", err);
            return res.status(500).json({
                success: false,
                message: "Failed to send email",
                error: err.message,
            });
        }

        return res.status(201).json({
            success: true,
            message: "Employee account created successfully",
            data: employee
        });

    } catch (err) {
        console.error(err);

        if (err.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "Username already exists"
            });
        }

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};

/* ================= GET ALL ================= */
export const getAllEmployees = async (req, res) => {
    try {
        const data = await getAllEmployeesModel();

        return res.status(200).json({
            success: true,
            data
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
};