import { Router } from 'express';

import guideModuleRouter from './guideModule.routes.js';
import guidePageRouter from './guidePage.routes.js';
import guideTabRouter from './guideTab.routes.js';
import guideSectionRouter from './guideSection.routes.js';
import guideElementRouter from './guideElement.routes.js';
import guideVersionRouter from './guideVersion.routes.js';
import guideDocumentRouter from './guideDocument.routes.js';
import guideBlockRouter from './guideBlock.routes.js';
import guideMediaRouter from './guideMedia.routes.js';
import guideRevisionRouter from './guideRevision.routes.js';
import guidePermissionRouter from './guidePermission.routes.js';

const router = Router();

router.use('/modules', guideModuleRouter);
router.use('/pages', guidePageRouter);
router.use('/tabs', guideTabRouter);
router.use('/sections', guideSectionRouter);
router.use('/elements', guideElementRouter);
router.use('/versions', guideVersionRouter);
router.use('/documents', guideDocumentRouter);
router.use('/blocks', guideBlockRouter);
router.use('/media', guideMediaRouter);
router.use('/revisions', guideRevisionRouter);
router.use('/permissions', guidePermissionRouter);

export default router;
