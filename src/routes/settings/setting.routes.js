import express from 'express';
const router = express.Router();
import SettingController from '../../controllers/settings/setting.controller.js';

// GET all settings
router.get('/', SettingController.getAllSettings);

// GET single setting by key (must come before POST to avoid route conflicts)
router.get('/:key', SettingController.getSettingByKey);

// POST - Save multiple settings (map of key→value) or legacy single { key, value }
router.post('/', (req, res) => {
    const body = req.body || {};
    const bodyKeys = Object.keys(body);
    const isLegacySingle =
        bodyKeys.length === 2 &&
        bodyKeys.includes('key') &&
        bodyKeys.includes('value');

    if (isLegacySingle) {
        return SettingController.updateSettingViaPost(req, res);
    }
    return SettingController.saveMultipleSettings(req, res);
});

// PUT - Update single setting by key
router.put('/:key', SettingController.updateSetting);

export default router;
