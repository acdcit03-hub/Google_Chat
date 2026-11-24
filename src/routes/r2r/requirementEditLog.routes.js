import express from 'express';
import {
    getRequirementEditLogList,
    getRequirementEditLogsBySerial,
} from '../../controllers/r2r/requirementEditLog.controller.js';

const router = express.Router();

router.get('/', getRequirementEditLogList);
router.get('/:serial_number', getRequirementEditLogsBySerial);

export default router;
