import express from 'express';
const router = express.Router();
import CategoryController from '../../controllers/timesheet/category.controller.js';

router.get('/', CategoryController.getAllCategories);
router.get('/:id', CategoryController.getCategoryById);
router.post('/', CategoryController.createCategory);
router.put('/:id', CategoryController.updateCategory);
router.patch('/:id/status', CategoryController.setActiveStatus);
router.delete('/:id', CategoryController.deleteCategory);

export default router;
