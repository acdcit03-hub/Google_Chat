import {
    getGlobalCalendarModel,
    getGlobalCalendarYearlyModel
} from "../../models/Calendar/GlobalCalendar.model.js";

/* =========================================================
   GET GLOBAL CALENDAR - MONTHLY 
========================================================= */
export const getGlobalCalendarMonthly = async (req, res) => {
    try {
        let {
            year,
            month,
            username,
            types,
            type,
            work_location,
            department
        } = req.query;

        /* =============================================
           DEFAULT YEAR
        ============================================= */
        if (!year) {
            year = new Date().getFullYear();
        }

        /* =============================================
           MONTH REQUIRED
        ============================================= */
        if (!month) {
            return res.status(400).json({
                success: false,
                message: "month is required"
            });
        }

        /* =============================================
           USERNAME
        ============================================= */
        if (typeof username === "string") {
            username = username
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);
        }

        if (!Array.isArray(username)) {
            username = [];
        }

        /* =============================================
           TYPES (?types=... or ?type=...)
        ============================================= */
        if (
            (types === undefined || types === null || types === "") &&
            type !== undefined &&
            type !== null &&
            type !== ""
        ) {
            types = type;
        }

        if (typeof types === "string") {
            types = types
                .split(",")
                .map(item =>
                    item.trim().toLowerCase()
                )
                .filter(Boolean);
        }

        if (!Array.isArray(types)) {
            types = [];
        }

        /* =============================================
           WORK LOCATION
        ============================================= */

        if (typeof work_location === "string") {
            work_location = work_location
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);
        }

        if (!Array.isArray(work_location)) {
            work_location = [];
        }

        /* =============================================
           DEPARTMENT
        ============================================= */
        if (typeof department === "string") {
            department = department
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);
        }

        if (!Array.isArray(department)) {
            department = [];
        }

        /* =============================================
           GET MONTHLY CALENDAR
        ============================================= */
        const result = await getGlobalCalendarModel({
            year,
            month,
            username,
            types,
            work_location,
            department
        });

        /* =============================================
           RESPONSE
        ============================================= */
        return res.status(200).json({
            success: true,
            message: "Global calendar fetched successfully",
            data: result
        });

    } catch (error) {
        console.error("Global Calendar Error:", error);
        return res.status(500).json({
            success: false,
            message:
                error.message ||
                "Failed to fetch global calendar"
        });
    }
};

/* =========================================================
   GET GLOBAL CALENDAR - YEARLY
========================================================= */

export const getGlobalCalendarYearly = async (
    req,
    res
) => {

    try {

        let {
            year,
            username,
            types,
            type,
            view,
            work_location,
            department
        } = req.query;

        /* =====================================================
           DEFAULT YEAR
        ===================================================== */

        if (!year) {

            year =
                new Date()
                    .getFullYear();
        }

        /* =====================================================
           DEFAULT VIEW
        ===================================================== */

        if (!view) {

            view =
                "joining_date";
        }

        /* =====================================================
           USERNAME
           
           ?username=AAM

           ?username=AAM,TMM,GPV
        ===================================================== */

        if (
            typeof username === "string"
        ) {

            username =
                username
                    .split(",")
                    .map(
                        item =>
                            item.trim()
                    )
                    .filter(Boolean);
        }

        if (
            !Array.isArray(username)
        ) {

            username = [];
        }

        /* =====================================================
           TYPES

           ?types=attendance

           ?types=attendance,leave

           ?types=attendance,leave,meeting
        ===================================================== */

        if (
            (types === undefined || types === null || types === "") &&
            type !== undefined &&
            type !== null &&
            type !== ""
        ) {
            types = type;
        }

        if (
            typeof types === "string"
        ) {

            types =
                types
                    .split(",")
                    .map(
                        item =>
                            item
                                .trim()
                                .toLowerCase()
                    )
                    .filter(Boolean);
        }

        if (
            !Array.isArray(types)
        ) {

            types = [];
        }

        /* =====================================================
           WORK LOCATION
        ===================================================== */

        if (typeof work_location === "string") {

            work_location =
                work_location
                    .split(",")
                    .map(item => item.trim())
                    .filter(Boolean);
        }

        if (!Array.isArray(work_location)) {
            work_location = [];
        }

        if (typeof department === "string") {
            department = department
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);
        }

        if (!Array.isArray(department)) {
            department = [];
        }

        /* =====================================================
           GET YEARLY CALENDAR
        ===================================================== */

        const result =
            await getGlobalCalendarYearlyModel({
                year,
                username,
                types,
                view,
                work_location,
                department
            });

        /* =====================================================
           RESPONSE
        ===================================================== */

        return res.status(200).json({

            success: true,

            message:
                "Global yearly calendar fetched successfully",

            data:
                result

        });

    } catch (error) {

        console.error(
            "Global Yearly Calendar Error:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                error.message ||
                "Failed to fetch global yearly calendar"

        });
    }
};