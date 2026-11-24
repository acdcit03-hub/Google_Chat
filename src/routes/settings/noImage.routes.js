import express from 'express';
import NoImageController from '../../controllers/settings/noImage.controller.js';
import upload from '../../config/multer.js';

const router = express.Router();

router.get('/', NoImageController.getAll);
router.get('/module/:moduleName', NoImageController.getByModuleName);
router.get('/:id', NoImageController.getById);

router.post(
    '/',
    upload.single('image'),
    NoImageController.create
);
router.put(
    '/:id',
    upload.single('image'),
    NoImageController.update
);
router.delete('/:id', NoImageController.remove);

export default router;
