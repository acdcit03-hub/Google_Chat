import express from 'express';
import ProjectPcbVersionController from '../../controllers/projectsheet/projectPcbVersion.controller.js';

const router = express.Router();

router.get('/', ProjectPcbVersionController.getAll);
router.get('/project/:projectId', ProjectPcbVersionController.getByProjectId);
router.get('/pcb/:pcbId', ProjectPcbVersionController.getByPcbId);
router.get('/:id', ProjectPcbVersionController.getById);
router.post('/', ProjectPcbVersionController.create);
router.put('/:id', ProjectPcbVersionController.update);
router.patch('/:id/status', ProjectPcbVersionController.setStatus);

export default router;
