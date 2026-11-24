import express from 'express';
const router = express.Router();
import PCBController from '../../controllers/projectsheet/pcb.controller.js';
import PcbCustomProcessController from '../../controllers/projectsheet/pcbCustomProcess.controller.js';
import upload from '../../config/multer.js';

router.get('/', PCBController.getAllPCBs);
router.get('/stats', PCBController.getPCBStats);
router.get('/last-serial', PCBController.getLastSerial);
router.get('/project/:projectId', PCBController.getPCBsByProjectId);
router.get(
    '/:id/projects-process-map',
    PCBController.getPcbProjectsProcessMap,
);
router.get('/:id/logs', PCBController.getPcbLogs);
router.get('/:id', PCBController.getPCBById);
router.post('/', PCBController.createPCB);
router.post('/upload-photo', upload.single('photo'), PCBController.uploadPhoto);
router.put('/:id', PCBController.updatePCB);
router.delete('/:id', PCBController.deletePCB);

// PCB-only "custom_process" tree — mirrors PROJECT's, isolated from process_map/categories.
router.get('/:id/custom-process', PcbCustomProcessController.getCustomProcess);
router.put('/:id/custom-process', PcbCustomProcessController.updateCustomProcess);
router.delete('/:id/custom-process', PcbCustomProcessController.clearCustomProcess);
router.delete('/:id/custom-process/item', PcbCustomProcessController.removeCustomProcessItem);

export default router;
