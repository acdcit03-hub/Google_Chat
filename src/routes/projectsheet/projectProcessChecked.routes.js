import express from 'express';
import ProjectProcessCheckedController from '../../controllers/projectsheet/projectProcessChecked.controller.js';

const router = express.Router();

router.get('/', ProjectProcessCheckedController.list);
router.get('/project/:projectId/scope/:scope', ProjectProcessCheckedController.getByProjectScope);
router.patch('/project/:projectId/scope/:scope/checked', ProjectProcessCheckedController.patchChecked);
router.get('/project/:projectId', ProjectProcessCheckedController.getByProject);
router.get('/:id', ProjectProcessCheckedController.getById);
router.post('/', ProjectProcessCheckedController.upsert);
router.delete('/:id', ProjectProcessCheckedController.remove);

export default router;
