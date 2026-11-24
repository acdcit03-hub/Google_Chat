import express from "express";

import { createCandidate, getCandidate, getCandidateById, updateCandidate, transferCandidateToEmployee, getCandidateResume, getCandidateStatusStats } from "../../controllers/Candidate/candidate.controller.js";
import { getCandidateBoardPreference, saveCandidateBoardPreference } from "../../controllers/Candidate/candidateBoardPreference.controller.js";
import { upload } from "../../middleware/upload.js";

const candidate = express.Router();

const candidateUploadNames = new Set([
	"image",
	"resume",
	"pan_card_upload",
	"aadhaar_upload",
	"other_document_upload",
	"bank_proof",
	"marksheet_certificate_upload",
	"experience_letter",
	"offer_letter",
    "noc_letter"
]);

const normalizeCandidateFiles = (req, res, next) => {
	const files = {};

	for (const file of req.files || []) {
		const isWorkExperienceLetter =
			/^work_experience\[\d+\]\[experience_letter\]$/.test(
				file.fieldname
			);
			const isEducationCertificate =
				/^education\[\d+\]\[marksheet_certificate_upload\]$/.test(
					file.fieldname
				);

		if (
			!candidateUploadNames.has(file.fieldname) &&
			!isWorkExperienceLetter &&
			!isEducationCertificate
		) {
			return res.status(400).json({
				success: false,
				message: `Unexpected file field: ${file.fieldname}`
			});
		}

		if (!files[file.fieldname]) {
			files[file.fieldname] = [];
		}

		files[file.fieldname].push(file);
	}

	req.files = files;
	next();
};


candidate.post(
	"/add-candidate",
	upload.any(),
	normalizeCandidateFiles,
	createCandidate
);

candidate.post("/transfer-to-employee/:id", transferCandidateToEmployee);

candidate.put("/board-preference", saveCandidateBoardPreference);
candidate.get("/board-preference", getCandidateBoardPreference);

candidate.get("/all-candidate", getCandidate);
candidate.get("/all-candidate/:id", getCandidateById);
candidate.get("/resume/:fileName", getCandidateResume);
candidate.get("/candidate-status-stats", getCandidateStatusStats);

candidate.put(
	"/update-candidate/:id",
	upload.any(),
	normalizeCandidateFiles,
	updateCandidate
);

export default candidate;
