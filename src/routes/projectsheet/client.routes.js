import express from 'express';
const router = express.Router();
import ClientController from '../../controllers/projectsheet/client.controller.js';
import upload from '../../config/multer.js';

router.get('/stats', ClientController.getClientStats);
router.get('/', ClientController.getAllClients);
router.get('/:id', ClientController.getClientById);
router.post('/', ClientController.createClient);
router.post('/bulk', ClientController.bulkImport);
router.post('/upload-logo', upload.single('logo'), ClientController.uploadLogo);
router.put('/:id', ClientController.updateClient);
router.delete('/:id', ClientController.deleteClient);

export default router;
