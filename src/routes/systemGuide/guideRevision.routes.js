import { Router } from 'express';

import guideRevisionController from '../../controllers/systemGuide/guideRevision.controller.js';

const router = Router();

router.get('/document/:documentId', guideRevisionController.list);
router.post('/document/:documentId', guideRevisionController.create);

export default router;
