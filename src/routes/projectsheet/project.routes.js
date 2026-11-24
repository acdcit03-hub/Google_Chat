import express from 'express';
const router = express.Router();
import ProjectController from '../../controllers/projectsheet/project.controller.js';
import CustomProcessController from '../../controllers/projectsheet/customProcess.controller.js';
import upload from '../../config/multer.js';

router.get('/', ProjectController.getAllProjects);
router.get('/stats', ProjectController.getProjectStats);
router.get('/next-serial', ProjectController.getNextSerial);
router.get('/next-version', ProjectController.getNextVersion);
router.get('/code/:code', ProjectController.getProjectByCode);
router.get('/:id/logs', ProjectController.getProjectLogs);
router.get('/:id', ProjectController.getProjectById);
router.post('/', ProjectController.createProject);
router.post('/upload-photo', upload.single('photo'), ProjectController.uploadPhoto);
router.put('/:id', ProjectController.updateProject);
router.delete('/:id', ProjectController.deleteProject);

// Project-only "custom_process" tree — isolated from process_map/categories.
router.get('/:id/custom-process', CustomProcessController.getCustomProcess);
router.put('/:id/custom-process', CustomProcessController.updateCustomProcess);
router.delete('/:id/custom-process', CustomProcessController.clearCustomProcess);
router.delete('/:id/custom-process/item', CustomProcessController.removeCustomProcessItem);

export default router;
