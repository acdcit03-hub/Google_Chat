import express from 'express';
const router = express.Router();
import AuditLogController from '../../controllers/history/auditLog.controller.js';

router.get('/', AuditLogController.getAll);

export default router;
