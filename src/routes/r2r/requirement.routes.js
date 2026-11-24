import express from 'express';
const router = express.Router();
import RequirementController from '../../controllers/r2r/requirement.controller.js';

router.get('/', RequirementController.getAllRequirements);
router.get('/collection-desk', RequirementController.getCollectionDeskRequirements);
router.get('/stats', RequirementController.getRequirementStats)
router.get('/status', RequirementController.getRequirementStatuses);
router.get('/status/:serial_number', RequirementController.getRequirementStatusBySerial);
router.get('/filter-options/persons', RequirementController.getPersonFilterOptions);
router.get('/next-serial', RequirementController.getNextSerialNumber);
router.post('/bulk-verify', RequirementController.bulkVerifyRequirements);
router.post('/bom-batch-notify', RequirementController.notifyBomBatchCreated);
router.post('/bulk-receive-notify', RequirementController.notifyBulkReceiveDone);
router.post('/bulk-purchase-notify', RequirementController.notifyBulkPurchaseMoved);
router.post('/temp-image', RequirementController.createTempBomImage);
router.put('/temp-image/:id', RequirementController.updateTempBomImage);
router.post('/temp-image/transfer', RequirementController.transferTempBomImage);
router.get('/temp-image/:serial_number', RequirementController.getTempBomImages);
router.post('/temp', RequirementController.createTempRequirement);
router.put('/temp/:id', RequirementController.updateTempRequirement);
router.get('/temp', RequirementController.listTempRequirements);
router.get('/temp/:temp_id', RequirementController.getTempRequirement);
router.delete('/temp/:id', RequirementController.deleteTempRequirement);
router.get('/:id', RequirementController.getRequirementById);
router.post('/bulk', RequirementController.createBulkRequirements);
router.post('/', RequirementController.createRequirement);
router.put('/:id', RequirementController.updateRequirement);
router.delete('/:id', RequirementController.deleteRequirement);
router.post('/:id/issue', RequirementController.reportIssue);
router.post('/:id/terminate', RequirementController.terminateRequirement);
router.put('/:id/confirm-terminate', RequirementController.confirmTerminate);


export default router;
