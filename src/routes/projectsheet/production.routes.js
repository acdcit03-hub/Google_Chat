import express from 'express';
const router = express.Router();
import ProductionController from '../../controllers/projectsheet/production.controller.js';
import upload from '../../config/multer.js';

router.get('/stats', ProductionController.getProductionStats);
router.get('/by-project', ProductionController.getProductionsGroupedByPcbCode);
router.get('/', ProductionController.getAllProductions);
router.get('/:id/logs', ProductionController.getProductionLogs);
router.get('/:id', ProductionController.getProductionById);
router.post('/', ProductionController.createProduction);
router.post('/upload-file', upload.single('file'), ProductionController.uploadFile);
router.put('/:id', ProductionController.updateProduction);
router.delete('/:id', ProductionController.deleteProduction);

export default router;
