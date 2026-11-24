import express from 'express';
import ProjectFileManagerController from '../../controllers/filemanager/projectFileManager.controller.js';

const router = express.Router();

/* ================= LIST / MY ACCESS ================= */
router.get('/', ProjectFileManagerController.list);
router.post('/sync-from-disk', ProjectFileManagerController.syncFromDisk);
router.get('/my-access', ProjectFileManagerController.myAccess);

/* ================= BY PROJECT ================= */
router.get(
    '/project/:projectId',
    ProjectFileManagerController.getByProjectId,
);

/* ================= CRUD ================= */
router.post('/', ProjectFileManagerController.create);
/** Create PCB-scoped folders for one PCB under an existing project FM */
router.post('/pcb-folders', ProjectFileManagerController.createPcbFolders);
router.get('/:id', ProjectFileManagerController.getById);
router.put('/:id', ProjectFileManagerController.update);
router.delete('/:id', ProjectFileManagerController.remove);

/* ================= USERS / PERMISSIONS ================= */
router.get('/:id/users', ProjectFileManagerController.listUsers);
router.post('/:id/users', ProjectFileManagerController.assignUsers);
router.put('/:id/users/:userId', ProjectFileManagerController.updateUser);
router.delete('/:id/users/:userId', ProjectFileManagerController.removeUser);
router.get(
    '/:id/access/:userId',
    ProjectFileManagerController.getUserAccess,
);

export default router;
