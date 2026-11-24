import {
    createJobPositionModel,
    getJobPositionByIdModel,
    getJobPositionModel,
    toggleJobPositionStatusModel,
    updateJobPositionModel
} from "../../models/JobPosition/jobPosition.models.js";
import { getIO } from "../../config/socket.js";

/* =========================================================
   CREATE JOB POSITION
========================================================= */
export const createJobPosition = async (req, res) => {
    try {
        const {
            job_title,

            number_of_positions,
            experience,
            skills_required,
            education,
            job_type,
            description,
            status
        } = req.body;

        const created_by = req.headers["x-username"] || null;

        /* =====================================================
           VALIDATE JOB TITLE
        ===================================================== */
        if (
            !job_title ||
            String(job_title).trim() === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "Job title is required"
            });
        }

        /* =====================================================
           NUMBER OF POSITIONS
        ===================================================== */
        const numberOfPositions = Number(number_of_positions);

        if (
            !Number.isInteger(numberOfPositions) ||
            numberOfPositions <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Number of positions must be a positive integer"
            });
        }

        /* =====================================================
           STATUS
        ===================================================== */
        let jobStatus = true;

        if (
            status !== undefined &&
            status !== null
        ) {
            if (
                typeof status === "boolean"
            ) {
                jobStatus = status;
            } else if (
                status === "true" ||
                status === "false"
            ) {
                jobStatus = status === "true";
            } else {
                return res.status(400).json({
                    success: false,
                    message: "Status must be true or false"
                });
            }
        }

        /* =====================================================
           SKILLS
        ===================================================== */
        let skills = null;

        if (
            skills_required !== undefined &&
            skills_required !== null &&
            skills_required !== ""
        ) {
            if (
                Array.isArray(
                    skills_required
                )
            ) {
                skills =
                    skills_required
                        .map(skill =>
                            String(skill).trim()
                        )
                        .filter(Boolean);

            } else if (
                typeof skills_required === "string"
            ) {
                try {
                    const parsedSkills =
                        JSON.parse(
                            skills_required
                        );

                    if (
                        Array.isArray(
                            parsedSkills
                        )
                    ) {
                        skills =
                            parsedSkills
                                .map(skill =>
                                    String(skill).trim()
                                )
                                .filter(Boolean);
                    } else {
                        skills = [
                            String(
                                parsedSkills
                            ).trim()
                        ];
                    }

                } catch (error) {
                    skills =
                        skills_required
                            .split(",")
                            .map(skill =>
                                skill.trim()
                            )
                            .filter(Boolean);
                }

            } else {
                skills = [
                    String(
                        skills_required
                    ).trim()
                ];
            }
        }

        /* =====================================================
           EDUCATION
        ===================================================== */
        let educationData = null;

        if (
            education !== undefined &&
            education !== null &&
            education !== ""
        ) {
            if (
                Array.isArray(
                    education
                )
            ) {
                educationData =
                    education
                        .map(item =>
                            String(item).trim()
                        )
                        .filter(Boolean);

            } else if (
                typeof education === "string"
            ) {
                try {
                    const parsedEducation =
                        JSON.parse(
                            education
                        );

                    if (
                        Array.isArray(
                            parsedEducation
                        )
                    ) {
                        educationData =
                            parsedEducation
                                .map(item =>
                                    String(item).trim()
                                )
                                .filter(Boolean);
                    } else {
                        educationData = [
                            String(
                                parsedEducation
                            ).trim()
                        ];
                    }

                } catch (error) {
                    educationData =
                        education
                            .split(",")
                            .map(item =>
                                item.trim()
                            )
                            .filter(Boolean);
                }

            } else {
                educationData = [
                    String(
                        education
                    ).trim()
                ];
            }
        }

        /* =====================================================
           CREATE
        ===================================================== */
        const data = await createJobPositionModel({
            job_title: String(job_title).trim(),
            number_of_positions: numberOfPositions,

            experience:
                experience
                    ? String(
                        experience
                    ).trim()
                    : null,

            skills_required: skills,
            education: educationData,

            job_type:
                job_type
                    ? String(
                        job_type
                    ).trim()
                    : null,

            description:
                description
                    ? String(
                        description
                    ).trim()
                    : null,

            status: jobStatus,

            created_by:
                created_by
                    ? String(
                        created_by
                    ).trim()
                    : null
        });

        const io = getIO();
        if (io) {
            io.emit("job-position:created", {
                success: true,
                message: "Job position created successfully",
                data
            });
        }

        return res.status(201).json({
            success: true,
            message: "Job position created successfully",
            data
        });

    } catch (error) {
        console.error("CREATE JOB POSITION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET ALL JOB POSITIONS
========================================================= */
export const getJobPosition = async (req, res) => {
    try {
        const {
            job_title,
            job_type,
            status
        } = req.query;

        const data = await getJobPositionModel({
            job_title,
            job_type,
            status
        });

        return res.status(200).json({
            success: true,
            message: "Job positions fetched successfully",
            count: data.length,
            data
        });

    } catch (error) {
        console.error("GET JOB POSITION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   GET JOB POSITION BY ID
========================================================= */
export const getJobPositionById = async (
    req,
    res
) => {
    try {
        const {
            id
        } = req.params;

        if (
            !id ||
            !Number.isInteger(
                Number(id)
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid job position ID is required"
            });
        }

        const data = await getJobPositionByIdModel(
            Number(id)
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Job position not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Job position fetched successfully",
            data
        });

    } catch (error) {
        console.error("GET JOB POSITION BY ID ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   UPDATE JOB POSITION
========================================================= */
export const updateJobPosition = async (
    req,
    res
) => {
    try {
        const { id } = req.params;

        const {
            job_title,
            number_of_positions,
            experience,
            skills_required,
            education,
            job_type,
            description,
            status
        } = req.body;

        /* =====================================================
           VALIDATE ID
        ===================================================== */
        if (
            !id ||
            !Number.isInteger(
                Number(id)
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid job position ID is required"
            });
        }

        /* =====================================================
           GET EXISTING DATA
        ===================================================== */
        const oldData =
            await getJobPositionByIdModel(
                Number(id)
            );

        if (!oldData) {
            return res.status(404).json({
                success: false,
                message: "Job position not found"
            });
        }

        /* =====================================================
           NUMBER OF POSITIONS
        ===================================================== */
        const numberOfPositions = Number(number_of_positions);

        if (
            !Number.isInteger(
                numberOfPositions
            ) ||
            numberOfPositions <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Number of positions must be a positive integer"
            });
        }

        /* =====================================================
           STATUS
        ===================================================== */
        let jobStatus;

        if (
            status === undefined ||
            status === null
        ) {
            jobStatus = oldData.status;

        } else if (
            typeof status === "boolean"
        ) {
            jobStatus = status;

        } else if (
            status === "true" ||
            status === "false"
        ) {
            jobStatus =
                status === "true";

        } else {
            return res.status(400).json({
                success: false,
                message: "Status must be true or false"
            });
        }

        /* =====================================================
           SKILLS
        ===================================================== */
        let skills = null;

        if (
            skills_required !== undefined &&
            skills_required !== null
        ) {
            if (
                Array.isArray(
                    skills_required
                )
            ) {
                skills =
                    skills_required
                        .map(skill =>
                            String(skill).trim()
                        )
                        .filter(Boolean);

            } else if (
                typeof skills_required === "string"
            ) {
                try {
                    const parsedSkills =
                        JSON.parse(
                            skills_required
                        );

                    if (
                        Array.isArray(
                            parsedSkills
                        )
                    ) {
                        skills =
                            parsedSkills
                                .map(skill =>
                                    String(skill).trim()
                                )
                                .filter(Boolean);
                    } else {
                        skills = [
                            String(
                                parsedSkills
                            ).trim()
                        ];
                    }

                } catch (error) {
                    skills =
                        skills_required
                            .split(",")
                            .map(skill =>
                                skill.trim()
                            )
                            .filter(Boolean);
                }

            } else {
                skills = [
                    String(
                        skills_required
                    ).trim()
                ];
            }

        } else {
            skills = oldData.skills_required;
        }

        /* =====================================================
           EDUCATION
        ===================================================== */
        let educationData;

        if (
            education === undefined ||
            education === null
        ) {
            educationData = oldData.education;
        } else if (
            Array.isArray(
                education
            )
        ) {
            educationData =
                education
                    .map(item =>
                        String(item).trim()
                    )
                    .filter(Boolean);

        } else if (
            typeof education === "string"
        ) {
            try {
                const parsedEducation =
                    JSON.parse(
                        education
                    );

                if (
                    Array.isArray(
                        parsedEducation
                    )
                ) {
                    educationData =
                        parsedEducation
                            .map(item =>
                                String(item).trim()
                            )
                            .filter(Boolean);
                } else {
                    educationData = [
                        String(
                            parsedEducation
                        ).trim()
                    ];
                }

            } catch (error) {
                educationData =
                    education
                        .split(",")
                        .map(item =>
                            item.trim()
                        )
                        .filter(Boolean);
            }

        } else {
            educationData = [
                String(
                    education
                ).trim()
            ];
        }

        /* =====================================================
           UPDATE
        ===================================================== */
        const data =
            await updateJobPositionModel(
                Number(id),
                {
                    job_title: String(job_title).trim(),
                    number_of_positions: numberOfPositions,

                    experience:
                        experience
                            ? String(
                                experience
                            ).trim()
                            : null,

                    skills_required: skills,
                    education: educationData,

                    job_type:
                        job_type
                            ? String(
                                job_type
                            ).trim()
                            : null,

                    description:
                        description
                            ? String(
                                description
                            ).trim()
                            : null,

                    status: jobStatus
                }
            );

        const io = getIO();
        if (io) {
            io.emit("job-position:updated", {
                success: true,
                message: "Job position updated successfully",
                data
            });
        }

        return res.status(200).json({
            success: true,
            message: "Job position updated successfully",
            data
        });

    } catch (error) {
        console.error("UPDATE JOB POSITION ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   TOGGLE JOB POSITION STATUS
========================================================= */
export const toggleJobPositionStatus = async (
    req,
    res
) => {
    try {
        const {
            id
        } = req.params;

        /* =====================================================
           VALIDATE ID
        ===================================================== */
        if (
            !id ||
            !Number.isInteger(
                Number(id)
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid job position ID is required"
            });
        }

        /* =====================================================
           CHECK EXISTING JOB POSITION
        ===================================================== */
        const existingJobPosition =
            await getJobPositionByIdModel(
                Number(id)
            );

        if (!existingJobPosition) {
            return res.status(404).json({
                success: false,
                message: "Job position not found"
            });
        }

        /* =====================================================
           TOGGLE STATUS
        ===================================================== */
        const data = await toggleJobPositionStatusModel(
            Number(id)
        );

        const io = getIO();
        if (io) {
            io.emit("job-position:status-updated", {
                success: true,
                message: `Job position status changed to ${data.status ? "active" : "inactive"} successfully`,
                data
            });
        }

        return res.status(200).json({
            success: true,
            message:
                `Job position status changed to ${data.status
                    ? "active"
                    : "inactive"
                } successfully`,
            data
        });

    } catch (error) {
        console.error("TOGGLE JOB POSITION STATUS ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};