import express from 'express';
import CategoriesFolderStructureController from '../../controllers/filemanager/categoriesFolderStructure.controller.js';

const router = express.Router();

/* ================= LIST ================= */
router.get('/', CategoriesFolderStructureController.list);
router.get(
    '/category/:categoryId',
    CategoriesFolderStructureController.getByCategoryId,
);

/* ================= CRUD ================= */
router.post('/', CategoriesFolderStructureController.create);
router.get('/:id/children', CategoriesFolderStructureController.getChildren);
router.get('/:id', CategoriesFolderStructureController.getById);
router.put('/:id', CategoriesFolderStructureController.update);
router.delete('/:id', CategoriesFolderStructureController.remove);

export default router;
