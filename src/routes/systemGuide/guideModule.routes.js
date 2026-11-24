import { Router } from 'express';

import guideModuleController from '../../controllers/systemGuide/guideModule.controller.js';

const router = Router();

router.get('/', guideModuleController.list);
router.get('/:id', guideModuleController.get);
router.post('/', guideModuleController.create);
router.put('/:id', guideModuleController.update);
router.delete('/:id', guideModuleController.remove);

export default router;
