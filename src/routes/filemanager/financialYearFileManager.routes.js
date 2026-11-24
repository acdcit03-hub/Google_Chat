import express from 'express';
import FinancialYearFileManagerController from '../../controllers/filemanager/financialYearFileManager.controller.js';

const router = express.Router();

/* ================= LIST / SYNC ================= */
router.get('/', FinancialYearFileManagerController.list);
router.post('/sync', FinancialYearFileManagerController.sync);

/* ================= BY YEAR CODE ================= */
router.get(
    '/year/:yearCode',
    FinancialYearFileManagerController.getByYearCode,
);
router.post(
    '/year/:yearCode',
    FinancialYearFileManagerController.ensureByYearCode,
);

/* ================= BY FINANCIAL YEAR ID ================= */
router.get(
    '/financial-year/:financialYearId',
    FinancialYearFileManagerController.getByFinancialYearId,
);

/* ================= USERS / PERMISSIONS (before :id) ================= */
router.get('/:id/users', FinancialYearFileManagerController.listUsers);
router.post('/:id/users', FinancialYearFileManagerController.assignUsers);
router.put('/:id/users/:userId', FinancialYearFileManagerController.updateUser);
router.delete(
    '/:id/users/:userId',
    FinancialYearFileManagerController.removeUser,
);
router.get(
    '/:id/access/:userId',
    FinancialYearFileManagerController.getUserAccess,
);

/* ================= BY ROW ID / FOLDER STRUCTURE ================= */
router.get('/:id/children', FinancialYearFileManagerController.listChildren);
router.get('/:id', FinancialYearFileManagerController.getById);

export default router;
