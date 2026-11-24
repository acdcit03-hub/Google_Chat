import express from 'express';
const router = express.Router();
import TaskListHistoryController from '../../controllers/history/task-list-history.controller.js';

router.get('/', TaskListHistoryController.list);
router.post('/', TaskListHistoryController.log);



export default router;
