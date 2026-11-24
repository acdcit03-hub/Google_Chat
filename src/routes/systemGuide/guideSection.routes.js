import { Router } from 'express';

import guideSectionController from '../../controllers/systemGuide/guideSection.controller.js';

const router = Router();

router.get('/page/:pageId', guideSectionController.listByPage);
router.get('/tab/:tabId', guideSectionController.listByTab);
router.get('/:id', guideSectionController.get);
router.post('/', guideSectionController.create);
router.put('/:id', guideSectionController.update);
router.delete('/:id', guideSectionController.remove);

export default router;
