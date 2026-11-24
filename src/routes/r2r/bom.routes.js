import express from 'express';
import BomController from '../../controllers/r2r/bom.controller.js';

const router = express.Router();

router.get('/', BomController.list);
router.get('/google-sheet-tabs', BomController.listGoogleSheetTabs);
router.get('/google-sheet-data', BomController.getGoogleSheetTabData);
router.post('/update-google-sheet-tab', BomController.updateGoogleSheetTab);
router.post('/add-google-sheet-tab', BomController.addGoogleSheetTab);
router.post('/sync-google-sheet', BomController.syncGoogleSheet);
router.get('/:id', BomController.getById);

export default router;
