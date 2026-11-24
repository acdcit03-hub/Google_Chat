import express from 'express';
const router = express.Router();
import IssueController from '../../controllers/r2r/issue.controller.js';

router.get('/', IssueController.getAllIssues);
router.post('/', IssueController.createIssue);
router.put('/:id/forward', IssueController.forwardIssue);
router.delete('/:id', IssueController.deleteIssue);
router.delete('/requirement/:id', IssueController.deleteIssuesByRequirement);

export default router;
