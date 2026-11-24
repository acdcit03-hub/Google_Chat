import express from 'express';
const router = express.Router();
import ReceiveIssueResponseController from '../../controllers/r2r/receiveIssueResponse.controller.js';

router.get('/', ReceiveIssueResponseController.getForUser);
router.post('/', ReceiveIssueResponseController.create);
router.patch('/:id/read', ReceiveIssueResponseController.markRead);
router.delete('/:id', ReceiveIssueResponseController.deleteById);

export default router;
