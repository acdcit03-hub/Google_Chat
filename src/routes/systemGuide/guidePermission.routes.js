import { Router } from 'express';

import guidePermissionController from '../../controllers/systemGuide/guidePermission.controller.js';

const router = Router();

router.get('/', guidePermissionController.list);
router.post('/', guidePermissionController.upsert);
router.delete('/:id', guidePermissionController.remove);

export default router;
