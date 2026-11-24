import { Router } from 'express';

import guideBlockController from '../../controllers/systemGuide/guideBlock.controller.js';

const router = Router();

router.get('/document/:documentId', guideBlockController.list);
router.post('/document/:documentId', guideBlockController.create);
router.patch('/document/:documentId/reorder', guideBlockController.reorder);
router.get('/:id', guideBlockController.get);
router.put('/:id', guideBlockController.update);
router.delete('/:id', guideBlockController.remove);

export default router;
