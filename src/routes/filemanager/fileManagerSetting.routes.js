import express from 'express';
import FileManagerSettingController from '../../controllers/filemanager/fileManagerSetting.controller.js';

const router = express.Router();

/* ================= LIST ================= */
router.get('/', FileManagerSettingController.list);
router.get('/active', FileManagerSettingController.listActive);

/* ================= BY OWNER ================= */
router.get('/owner/:ownerId', FileManagerSettingController.getByOwnerId);

/* ================= SAVE SINGLE OWNER ================= */
router.post('/', FileManagerSettingController.create);

/* ================= BY ID ================= */
router.get('/:id', FileManagerSettingController.getById);
router.put('/:id', FileManagerSettingController.update);

export default router;
