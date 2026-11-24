import express from 'express';
const router = express.Router();
import UnitController from '../../controllers/settings/unit.controller.js';

router.get('/', UnitController.getAllUnits);
router.post('/', UnitController.createUnit);
router.put('/:id', UnitController.updateUnit);
router.delete('/:id', UnitController.deleteUnit);

export default router;
