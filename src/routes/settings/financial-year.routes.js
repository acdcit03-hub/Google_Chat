import express from 'express';
const router = express.Router();
import FinancialYearController from '../../controllers/settings/financial-year.controller.js';

router.get('/', FinancialYearController.getAllFinancialYears);
router.post('/', FinancialYearController.createFinancialYear);
router.put('/:id', FinancialYearController.updateFinancialYear);
router.delete('/:id', FinancialYearController.deleteFinancialYear);

export default router;
