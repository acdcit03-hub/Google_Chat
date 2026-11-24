import express from 'express';
import CategoryTypeController from '../../controllers/timesheet/categoryType.controller.js';

const router = express.Router();

router.get('/', CategoryTypeController.getAll);
router.get('/:id', CategoryTypeController.getById);
router.post('/', CategoryTypeController.create);
router.put('/:id', CategoryTypeController.update);
router.delete('/:id', CategoryTypeController.delete);

export default router;
