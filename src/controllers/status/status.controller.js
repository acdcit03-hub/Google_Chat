import { addSettingEditLogModel } from "../../models/history/setting_edit_log.model.js";
import { createStatusModel, getStatusByIdModel, getStatusModel, toggleStatusModel, updateStatusModel } from "../../models/status/status.model.js";

/* ================= CREATE STATUS ================= */
export const createStatus = async (req, res) => {
    try {

        const {
            status_name,
            move_to_employee = false,
            status = true
        } = req.body;

        const created_by = req.headers["x-username"] || null;

        if (!status_name || !String(status_name).trim()) {
            return res.status(400).json({
                success: false,
                message: "Status name is required"
            });
        }

        const data = await createStatusModel({
            status_name: String(status_name).trim(),
            move_to_employee,
            status,
            created_by: String(created_by).trim()
        });

        return res.status(201).json({
            success: true,
            message: "Status created successfully",
            data
        });

    } catch (error) {
        console.error("CREATE STATUS ERROR:", error);
        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "Status name already exists"
            });
        }

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET ALL STATUS ================= */
export const getStatus = async (req, res) => {
    try {
        const {
            status_name,
            status
        } = req.query;

        const data = await getStatusModel({
            status_name,
            status
        });

        return res.status(200).json({
            success: true,
            message: "Status fetched successfully",
            count: data.length,
            data
        });

    } catch (error) {
        console.error("GET STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= GET STATUS BY ID ================= */
export const getStatusById = async (req, res) => {
    try {
        const { id } = req.params;

        const data = await getStatusByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Status not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Status fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET STATUS BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= UPDATE STATUS ================= */
export const updateStatus = async (req, res) => {
    try {

        const { id } = req.params;

        const {
            status_name,
            move_to_employee
        } = req.body;

        const edited_by =
            req.headers["x-username"] || null;

        if (!status_name || !String(status_name).trim()) {
            return res.status(400).json({
                success: false,
                message: "Status name is required"
            });
        }

        /* ================= GET OLD DATA ================= */

        const oldData =
            await getStatusByIdModel(id);

        if (!oldData) {
            return res.status(404).json({
                success: false,
                message: "Status not found"
            });
        }

        /* ================= UPDATE ================= */

        const data =
            await updateStatusModel(
                id,
                {
                    status_name:
                        String(status_name).trim(),

                    move_to_employee
                }
            );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Status not found"
            });
        }

        /* ================= SETTING EDIT LOG ================= */

        const fields = [
            "status_name",
            "move_to_employee"
        ];

        for (const field of fields) {

            const oldValue =
                oldData[field];

            const newValue =
                data[field];

            if (
                String(oldValue) !==
                String(newValue)
            ) {

                await addSettingEditLogModel({
                    table_name: "status",
                    record_id: Number(id),

                    username:
                        data.created_by || null,

                    edited_by:
                        String(edited_by || "").trim(),

                    field_name: field,

                    old_value:
                        oldValue === null ||
                            oldValue === undefined
                            ? null
                            : String(oldValue),

                    new_value:
                        newValue === null ||
                            newValue === undefined
                            ? null
                            : String(newValue)
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: "Status updated successfully",
            data
        });

    } catch (error) {

        console.error(
            "UPDATE STATUS ERROR:",
            error
        );

        if (error.code === "STATUS_IN_USE") {
            return res.status(409).json({
                success: false,
                message: "This status is already used by candidate(s) and cannot be updated."
            });
        }

        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message:
                    "Status name already exists"
            });
        }

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* ================= TOGGLE STATUS ================= */
export const toggleStatus = async (req, res) => {
    try {
        const { id } = req.params;

        const edited_by = req.headers["x-username"] || null;

        /* ================= VALIDATE ID ================= */
        if (!id || isNaN(Number(id))) {
            return res.status(400).json({
                success: false,
                message: "Valid status ID is required"
            });
        }

        /* ================= VALIDATE EDITED BY ================= */
        if (!edited_by || String(edited_by).trim() === "") {
            return res.status(400).json({
                success: false,
                message: "x-username header is required"
            });
        }

        /* ================= GET OLD DATA ================= */
        const oldData = await getStatusByIdModel(Number(id));

        if (!oldData) {
            return res.status(404).json({
                success: false,
                message: "Status not found"
            });
        }

        /* ================= TOGGLE STATUS ================= */
        const data = await toggleStatusModel(Number(id));

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Status not found"
            });
        }

        /* ================= SETTING EDIT LOG ================= */
        await addSettingEditLogModel({
            table_name: "status",
            record_id: Number(id),
            username: oldData.created_by || null,
            edited_by: String(edited_by).trim(),
            field_name: "status",

            old_value:
                oldData.status === null ||
                    oldData.status === undefined
                    ? null
                    : String(oldData.status),

            new_value:
                data.status === null ||
                    data.status === undefined
                    ? null
                    : String(data.status)
        });

        return res.status(200).json({
            success: true,
            message: "Status toggled successfully",
            data
        });

    } catch (error) {
        console.error("TOGGLE STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
