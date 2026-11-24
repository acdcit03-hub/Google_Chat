import { Router } from 'express';

import guideTabController from '../../controllers/systemGuide/guideTab.controller.js';

const router = Router();

router.get('/page/:pageId', guideTabController.list);
router.get('/:id', guideTabController.get);
router.post('/', guideTabController.create);
router.put('/:id', guideTabController.update);
router.delete('/:id', guideTabController.remove);

export default router;
