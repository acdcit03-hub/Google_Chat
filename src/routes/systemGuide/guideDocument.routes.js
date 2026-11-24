import { Router } from 'express';

import guideDocumentController from '../../controllers/systemGuide/guideDocument.controller.js';

const router = Router();

router.get('/', guideDocumentController.list);
router.get('/path/:moduleSlug/:pageSlug/:documentSlug', guideDocumentController.getByPath);
router.get('/:id', guideDocumentController.get);
router.post('/', guideDocumentController.create);
router.put('/:id', guideDocumentController.update);
router.post('/:id/publish', guideDocumentController.publish);
router.post('/:id/unpublish', guideDocumentController.unpublish);
router.delete('/:id', guideDocumentController.remove);

export default router;
