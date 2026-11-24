import express from 'express';
const router = express.Router();
import TaskStatusController from '../../controllers/timesheet/taskStatus.controller.js';

router.get('/', TaskStatusController.getAllStatuses);
router.post('/', TaskStatusController.createStatus);
router.put('/reorder', TaskStatusController.reorderStatuses);
router.put('/:id', TaskStatusController.updateStatus);
router.delete('/:id', TaskStatusController.deleteStatus);

export default router;
