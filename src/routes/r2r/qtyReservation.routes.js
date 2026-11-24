import express from 'express';
const router = express.Router();
import QtyReservationController from '../../controllers/r2r/qtyReservation.controller.js';

router.get('/stats', QtyReservationController.getStats);
router.get('/notifications', QtyReservationController.getNotifications);
router.get('/', QtyReservationController.getAll);
router.post(
  '/save-remove-quantity',
  QtyReservationController.bulkRemove,
);
router.post(
  '/accept-reserve-quantity',
  QtyReservationController.bulkAccept,
);
router.post(
  '/tray-prepared',
  QtyReservationController.bulkTrayPrepared,
);
router.post(
  '/cancel-reserve',
  QtyReservationController.bulkCancel,
);
router.post(
  '/receive-used-quantity',
  QtyReservationController.bulkReview,
);
router.post(
  '/bulk-pending-notify',
  QtyReservationController.bulkNotifyPendingReserve,
);
router.get('/:id', QtyReservationController.getById);
router.post('/', QtyReservationController.create);
router.post('/:id/accept-reserve-quantity', QtyReservationController.accept);
router.post('/:id/cancel-reserve', QtyReservationController.cancel);
router.post('/:id/receive-used-quantity', QtyReservationController.review);
router.put('/:id', QtyReservationController.update);
router.delete('/:id', QtyReservationController.delete);

export default router;
