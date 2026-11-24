import SettingModel from '../../models/settings/setting.model.js';
import { getUserIdFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';

class SettingController {
    // Optimized: Fetch all settings
    static async getAllSettings(req, res) {
        try {
            const settingsRows = await SettingModel.findAll();
            
            // Convert array to object format (parallel processing)
            const settings = {};
            settingsRows.forEach(row => {
                settings[row.key] = row.value;
            });

            res.json({
                success: true,
                settings
            });
        } catch (error) {
            console.error('Error fetching settings:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch settings'
            });
        }
    }

    // Optimized: Get single setting by key
    static async getSettingByKey(req, res) {
        try {
            const { key } = req.params;
            const setting = await SettingModel.findByKey(key);

            if (!setting) {
                return res.status(404).json({
                    success: false,
                    message: 'Setting not found'
                });
            }

            res.json({
                success: true,
                setting: {
                    key: setting.key,
                    value: setting.value
                }
            });
        } catch (error) {
            console.error('Error fetching setting:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch setting'
            });
        }
    }

    // Optimized: Save multiple settings in parallel
    static async saveMultipleSettings(req, res) {
        try {
            const settingsToSave = req.body;
            const userId = getUserIdFromReq(req);

            if (!settingsToSave || typeof settingsToSave !== 'object') {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid settings data'
                });
            }

            // Capture old values for submitted keys
            let oldValue = null;
            try {
                const keys = Object.keys(settingsToSave || {});
                const existingRows = await Promise.all(keys.map((k) => SettingModel.findByKey(k)));
                oldValue = {};
                keys.forEach((k, idx) => {
                    oldValue[k] = existingRows[idx]?.value;
                });
            } catch (e) {
                oldValue = null;
            }

            // Parallel bulk upsert
            const savedSettings = await SettingModel.bulkUpsert(settingsToSave);

            // Audit log (best-effort): store only submitted keys/values
            try {
                const patch = pickChangedColumns(oldValue || {}, settingsToSave || {}, Object.keys(settingsToSave || {}));
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'settings',
                    tableOfId: null,
                    tableOfColumn: patch.columns.join(','),
                    oldValue: patch.oldValue,
                    newValue: patch.newValue,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (settings bulk save):', e.message || e);
            }

            res.json({
                success: true,
                message: 'Settings saved successfully',
                settings: savedSettings
            });
        } catch (error) {
            console.error('Error saving settings:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to save settings'
            });
        }
    }

    // Optimized: Update single setting (upsert)
    static async updateSetting(req, res) {
        try {
            const { key } = req.params;
            const { value } = req.body;
            const userId = getUserIdFromReq(req);

            if (value === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'Setting value is required'
                });
            }

            const before = await SettingModel.findByKey(key);
            const updatedSetting = await SettingModel.upsert(key, value);

            // Audit log (best-effort)
            try {
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'settings',
                    tableOfId: null,
                    tableOfColumn: key,
                    oldValue: before ? { [key]: before.value } : null,
                    newValue: { [key]: updatedSetting?.value ?? value },
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (setting update):', e.message || e);
            }

            res.json({
                success: true,
                message: 'Setting updated successfully',
                setting: updatedSetting
            });
        } catch (error) {
            console.error('Error updating setting:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to update setting'
            });
        }
    }

    // Legacy endpoint: Update setting via POST body (for backward compatibility)
    static async updateSettingViaPost(req, res) {
        try {
            const { key, value } = req.body;
            const userId = getUserIdFromReq(req);

            if (!key) {
                return res.status(400).json({
                    success: false,
                    message: 'Setting key is required'
                });
            }

            if (value === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'Setting value is required'
                });
            }

            const before = await SettingModel.findByKey(key);
            const updatedSetting = await SettingModel.upsert(key, value);

            // Audit log (best-effort)
            try {
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'settings',
                    tableOfId: null,
                    tableOfColumn: key,
                    oldValue: before ? { [key]: before.value } : null,
                    newValue: { [key]: updatedSetting?.value ?? value },
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (setting update via post):', e.message || e);
            }

            res.json({
                success: true,
                setting: updatedSetting
            });
        } catch (error) {
            console.error('Error updating setting:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to update setting'
            });
        }
    }
}

export default SettingController;
