import UnitModel from '../../models/settings/unit.model.js';
import { getUserIdFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';

class UnitController {
    // Optimized: Fetch all units
    static async getAllUnits(req, res) {
        try {
            const units = await UnitModel.findAll();
            res.json(units);
        } catch (error) {
            console.error('Error fetching units:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch units'
            });
        }
    }

    // Optimized: Parallel duplicate check before creation
    static async createUnit(req, res) {
        try {
            const { unitname, is_active } = req.body;

            // Validation
            if (!unitname || !unitname.trim()) {
                return res.status(400).json({
                    success: false,
                    message: 'Unit name is required'
                });
            }

            // Check for duplicate name
            const duplicateCheck = await UnitModel.findByName(unitname.trim());

            if (duplicateCheck) {
                return res.status(409).json({
                    success: false,
                    message: 'Unit with this name already exists'
                });
            }

            const newUnit = await UnitModel.create({ 
                unitname: unitname.trim(), 
                is_active: is_active !== undefined ? is_active : true 
            });
            
            res.status(201).json(newUnit);
        } catch (error) {
            console.error('Error creating unit:', error);
            
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'Unit with this name already exists'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to create unit'
            });
        }
    }

    // Optimized: Parallel existence check and duplicate validation
    static async updateUnit(req, res) {
        try {
            const { id } = req.params;
            const { unitname, is_active } = req.body;
            const userId = getUserIdFromReq(req);

            // Validation
            if (unitname !== undefined && (!unitname || !unitname.trim())) {
                return res.status(400).json({
                    success: false,
                    message: 'Unit name is required'
                });
            }

            // Parallel: Check unit existence and duplicate name (if name is being changed)
            const [unitCheck, duplicateCheck] = await Promise.all([
                UnitModel.findById(id),
                unitname ? UnitModel.findByName(unitname.trim(), id) : Promise.resolve(null)
            ]);

            if (!unitCheck) {
                return res.status(404).json({
                    success: false,
                    message: 'Unit not found'
                });
            }

            // Check if name is being changed and if new name already exists
            if (unitname && unitname.trim() !== unitCheck.unitname && duplicateCheck) {
                return res.status(409).json({
                    success: false,
                    message: 'Unit with this name already exists'
                });
            }

            const updatedUnit = await UnitModel.update(id, {
                unitname: unitname ? unitname.trim() : unitCheck.unitname,
                is_active: is_active !== undefined ? is_active : unitCheck.is_active
            });

            if (!updatedUnit) {
                return res.status(404).json({
                    success: false,
                    message: 'Unit not found'
                });
            }

            // Audit log (best-effort)
            try {
                const patch = pickChangedColumns(unitCheck, updatedUnit, ['unitname', 'is_active']);
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'UNITS',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: patch.columns.join(','),
                    oldValue: patch.oldValue,
                    newValue: patch.newValue,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (unit update):', e.message || e);
            }

            res.json(updatedUnit);
        } catch (error) {
            console.error('Error updating unit:', error);
            
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'Unit with this name already exists'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to update unit'
            });
        }
    }

    // Optimized: Check existence before deletion
    static async deleteUnit(req, res) {
        try {
            const { id } = req.params;
            const userId = getUserIdFromReq(req);

            // Check if unit exists before deletion
            const unitCheck = await UnitModel.findById(id);

            if (!unitCheck) {
                return res.status(404).json({
                    success: false,
                    message: 'Unit not found'
                });
            }

            const deleted = await UnitModel.delete(id);

            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    message: 'Unit not found'
                });
            }

            // Audit log (best-effort)
            try {
                await writeAuditLog(req, {
                    action: 'DELETE',
                    tableName: 'UNITS',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: 'id',
                    oldValue: unitCheck,
                    newValue: null,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (unit delete):', e.message || e);
            }

            res.json({
                success: true,
                message: 'Unit deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting unit:', error);
            
            // Check for foreign key constraint violation (unit is being used)
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    message: 'Cannot delete unit: it is being used by other records'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to delete unit'
            });
        }
    }
}

export default UnitController;
