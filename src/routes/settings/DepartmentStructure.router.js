import express from "express";
import { 
    addDepartmentStructure,
    toggleDepartmentStructureStatus,
    getAllDepartmentStructure,
    getDepartmentStructureById,
    updateDepartmentStructure,
    getSubDepartments,
    deleteDepartmentStructure,
    getActiveUsersWorkEmail
} from "../../controllers/settings/DepartmentStructure.controller.js";
import {
    createGoogleChatSpace,
    openEmployeeGoogleChat
} from "../../GoogleChat/createGoogleChatSpace.controller.js";

const departmentStructure = express.Router();

departmentStructure.post("/add-department-structure", addDepartmentStructure);

departmentStructure.get("/active-work-emails", getActiveUsersWorkEmail);
departmentStructure.post("/open-employee-google-chat", openEmployeeGoogleChat);
departmentStructure.post("/create-google-chat-space", createGoogleChatSpace);
departmentStructure.get("/all-department-structure", getAllDepartmentStructure);
departmentStructure.get("/all-department-structure/:id", getDepartmentStructureById);
departmentStructure.get("/sub-departments", getSubDepartments);

departmentStructure.put("/update-department-structure/:id", updateDepartmentStructure);

departmentStructure.patch("/toggle/:id", toggleDepartmentStructureStatus);

departmentStructure.delete("/delete-department-structure/:id", deleteDepartmentStructure);

export default departmentStructure;