import express from "express";

import { createCandidateSource, getCandidateSource, getCandidateSourceById, updateCandidateSource } from "../../controllers/Candidate/candidate_source.controller.js";

const candidateSource = express.Router();

/* ================= CREATE ================= */
candidateSource.post("/add-candidate-source", createCandidateSource);

/* ================= GET ALL ================= */
candidateSource.get("/all-candidate-sources", getCandidateSource);

/* ================= GET BY ID ================= */
candidateSource.get("/all-candidate-sources/:id", getCandidateSourceById);

/* ================= UPDATE ================= */
candidateSource.put("/update-candidate-source/:id", updateCandidateSource);

export default candidateSource;
