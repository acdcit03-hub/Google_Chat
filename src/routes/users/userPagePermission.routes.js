import express from 'express';
import {
    getUserPermissionsByUsername,
    createUserPermissionsByUsername,
    updateUserPermissionsByUsername
} from '../../controllers/users/userPagePermission.controller.js';

const router = express.Router();



router.get('/:username/permissions', getUserPermissionsByUsername);
router.post('/:username/permissions', createUserPermissionsByUsername);
router.put('/:username/permissions', updateUserPermissionsByUsername);

export default router;
