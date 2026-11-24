import { Router } from 'express';

import guideVersionController from '../../controllers/systemGuide/guideVersion.controller.js';

const router = Router();

router.get('/', guideVersionController.list);
router.get('/:id', guideVersionController.get);
router.post('/', guideVersionController.create);
router.put('/:id', guideVersionController.update);
router.delete('/:id', guideVersionController.remove);

export default router;
