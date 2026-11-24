import {
    createCandidateSourceModel,
    getCandidateSourceByIdModel,
    getCandidateSourceModel,
    updateCandidateSourceModel
} from "../../models/Candidate/candidate_source.model.js";

/* =========================================================
   CREATE CANDIDATE SOURCE
========================================================= */
export const createCandidateSource = async (req, res) => {
    try {
        const {
            source_name,
            status = true
        } = req.body;

        const created_by = req.headers["x-username"] || null;

        /* ================= VALIDATION ================= */
        if (
            !source_name ||
            !String(source_name).trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Source name is required"
            });
        }

        if (
            !created_by ||
            !String(created_by).trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "x-username header is required"
            });
        }

        /* ================= CREATE ================= */
        const data = await createCandidateSourceModel({
            source_name: String(source_name).trim(),
            status,
            created_by: String(created_by).trim()
        });

        return res.status(201).json({
            success: true,
            message: "Candidate source created successfully",
            data
        });

    } catch (error) {
        console.error("CREATE CANDIDATE SOURCE ERROR:", error);

        /* ================= DUPLICATE ================= */
        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "Candidate source already exists"
            });
        }

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET ALL CANDIDATE SOURCES
========================================================= */
export const getCandidateSource = async (req, res) => {
    try {

        const {
            source_name,
            status
        } = req.query;

        const data = await getCandidateSourceModel({
            source_name,
            status
        });

        return res.status(200).json({
            success: true,
            message: "Candidate sources fetched successfully",
            count: data.length,
            data
        });

    } catch (error) {
        console.error("GET CANDIDATE SOURCE ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET CANDIDATE SOURCE BY ID
========================================================= */
export const getCandidateSourceById = async (
    req,
    res
) => {
    try {
        const { id } = req.params;

        const data = await getCandidateSourceByIdModel(id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Candidate source not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Candidate source fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET CANDIDATE SOURCE BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   UPDATE CANDIDATE SOURCE
========================================================= */
export const updateCandidateSource = async (
    req,
    res
) => {
    try {
        const { id } = req.params;

        const {
            source_name,
            status
        } = req.body;

        /* ================= VALIDATION ================= */
        if (
            !source_name ||
            !String(source_name).trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Source name is required"
            });
        }

        /* ================= CHECK SOURCE ================= */
        const oldData = await getCandidateSourceByIdModel(id);

        if (!oldData) {
            return res.status(404).json({
                success: false,
                message: "Candidate source not found"
            });
        }

        /* ================= UPDATE ================= */
        const data = await updateCandidateSourceModel(
            id,
            {
                source_name: String(source_name).trim(),
                status
            }
        );

        return res.status(200).json({
            success: true,
            message: "Candidate source updated successfully",
            data
        });

    } catch (error) {
        console.error("UPDATE CANDIDATE SOURCE ERROR:", error);

        /* ================= DUPLICATE ================= */
        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "Candidate source already exists"
            });
        }

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};