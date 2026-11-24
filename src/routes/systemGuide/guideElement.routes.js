import { Router } from 'express';

import guideElementController from '../../controllers/systemGuide/guideElement.controller.js';

const router = Router();

router.get('/page/:pageId', guideElementController.list);
router.get('/:id', guideElementController.get);
router.post('/', guideElementController.create);
router.put('/:id', guideElementController.update);
router.delete('/:id', guideElementController.remove);

export default router;
