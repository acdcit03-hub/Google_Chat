import { Router } from 'express';

import guidePageController from '../../controllers/systemGuide/guidePage.controller.js';

const router = Router();

router.get('/module/:moduleId', guidePageController.list);
router.get('/:id', guidePageController.get);
router.post('/', guidePageController.create);
router.put('/:id', guidePageController.update);
router.delete('/:id', guidePageController.remove);

export default router;
