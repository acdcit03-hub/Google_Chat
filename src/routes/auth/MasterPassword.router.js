import express from "express";
import { createMasterPassword, getMasterPassword, matchSecretKey, resetMasterPassword, resetSecretKey, sendPasswordSetupMail } from "../../controllers/Auth/MasterPassword.controller.js";

const MasterPassword = express.Router();

MasterPassword.post("/initialize-master-password", createMasterPassword);
MasterPassword.post("/send-mail", sendPasswordSetupMail);
MasterPassword.post("/match-secret-key", matchSecretKey);
MasterPassword.post("/reset-master-password", resetMasterPassword);
MasterPassword.post("/reset-secret-key", resetSecretKey);

MasterPassword.get("/", getMasterPassword);

export default MasterPassword;