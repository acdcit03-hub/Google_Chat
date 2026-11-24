import express from 'express';
const router = express.Router();
import R2rImageController from '../../controllers/r2r/r2rImage.controller.js';
import { r2rImageUpload } from '../../middleware/upload.js';

router.post(
    '/r2r/upload',
    ...r2rImageUpload,
    R2rImageController.uploadProductPhoto,
);

export default router;
