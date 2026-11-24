import express from 'express';
import ProcessMapController from '../../controllers/projectsheet/updateProject.controller.js';

const router = express.Router();

router.get('/:id/main-processes', ProcessMapController.getMainProcesses);
router.get('/:id/checked', ProcessMapController.getCheckedProcessMap);
router.get('/:id', ProcessMapController.getProcessMap);
router.put('/:id', ProcessMapController.updateProcessMap);
router.post('/:id/checked', ProcessMapController.updateChecked);
router.delete('/:id', ProcessMapController.deleteProcessMap);

export default router;