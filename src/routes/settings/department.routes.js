import express from 'express';
const router = express.Router();
import DepartmentController from '../../controllers/settings/department.controller.js';

router.get('/', DepartmentController.getAllDepartments);
router.post('/', DepartmentController.createDepartment);
router.put('/:id', DepartmentController.updateDepartment);
router.delete('/:id', DepartmentController.deleteDepartment);

export default router;
