import { Router } from 'express';

import guideMediaController from '../../controllers/systemGuide/guideMedia.controller.js';

const router = Router();

router.get('/', guideMediaController.list);
router.get('/:id', guideMediaController.get);
router.post('/', guideMediaController.create);
router.delete('/:id', guideMediaController.remove);

export default router;
