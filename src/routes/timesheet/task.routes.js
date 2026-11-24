import express from 'express';
const router = express.Router();
import TaskController from '../../controllers/timesheet/task.controller.js';


router.get('/', TaskController.getAllTasks);
router.get('/search', TaskController.searchTasks);
router.get('/next-serial', TaskController.getNextSerialNumber);
router.get('/user-photos', TaskController.getUserPhotos);
router.get('/board-preference', TaskController.getBoardPreference);
router.put('/board-preference', TaskController.saveBoardPreference);
router.get('/pending-review-count', TaskController.getPendingReviewCount);
router.get('/by-process', TaskController.getTasksByProcess);
router.get('/status-history', TaskController.getTaskStatusHistory);
router.get('/task-log', TaskController.getTaskLog);
router.get('/:id/status-history', TaskController.getTaskStatusHistoryById);
router.get('/:id/task-log', TaskController.getTaskLogById);
router.get('/:id/time-entries', TaskController.getTaskTimeEntries);
router.get('/:id', TaskController.getTaskById);
router.post('/', TaskController.createTask);
router.put('/:id', TaskController.updateTask);

export default router;