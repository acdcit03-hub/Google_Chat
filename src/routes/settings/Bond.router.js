import express from "express";
import { addBondOption, getAllBondOptions, getBondOptionById, toggleBondOptionStatus, updateBondOption } from "../../controllers/settings/Bond.controller.js";

const bond = express.Router();

bond.post("/add-bond", addBondOption);

bond.get("/all-bond", getAllBondOptions);
bond.get("/:id", getBondOptionById);

bond.put("/update-bond/:id", updateBondOption);

bond.patch("/toggle/:id", toggleBondOptionStatus);

export default bond;
