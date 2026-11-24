import DepartmentModel from '../../models/settings/department.model.js';
import { getUserIdFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';

class DepartmentController {
    // Optimized: Fetch all departments
    static async getAllDepartments(req, res) {
        try {
            const departments = await DepartmentModel.findAll();
            res.json(departments);
        } catch (error) {
            console.error('Error fetching departments:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch departments'
            });
        }
    }

    // Optimized: Parallel duplicate check before creation
    static async createDepartment(req, res) {
        try {
            const { name, description, is_active } = req.body;

            // Validation
            if (!name || !name.trim()) {
                return res.status(400).json({
                    success: false,
                    message: 'Department name is required'
                });
            }

            // Parallel: Check for duplicate name
            const duplicateCheck = await DepartmentModel.findByName(name.trim());

            if (duplicateCheck) {
                return res.status(409).json({
                    success: false,
                    message: 'Department with this name already exists'
                });
            }

            const newDept = await DepartmentModel.create({ 
                name: name.trim(), 
                description: description?.trim() || null, 
                is_active: is_active !== undefined ? is_active : true 
            });
            
            res.status(201).json(newDept);
        } catch (error) {
            console.error('Error creating department:', error);
            
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'Department with this name already exists'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to create department'
            });
        }
    }

    // Optimized: Parallel existence check and duplicate validation
    static async updateDepartment(req, res) {
        try {
            const { id } = req.params;
            const { name, description, is_active } = req.body;
            const userId = getUserIdFromReq(req);

            // Parallel: Check department existence and duplicate name (if name is being changed)
            const [departmentCheck, duplicateCheck] = await Promise.all([
                DepartmentModel.findById(id),
                name ? DepartmentModel.findByName(name.trim(), id) : Promise.resolve(null)
            ]);

            if (!departmentCheck) {
                return res.status(404).json({
                    success: false,
                    message: 'Department not found'
                });
            }

            // Check if name is being changed and if new name already exists
            if (name && name.trim() !== departmentCheck.name && duplicateCheck) {
                return res.status(409).json({
                    success: false,
                    message: 'Department with this name already exists'
                });
            }

            const updatedDept = await DepartmentModel.update(id, {
                name: name ? name.trim() : departmentCheck.name,
                description: description !== undefined ? (description?.trim() || null) : departmentCheck.description,
                is_active: is_active !== undefined ? is_active : departmentCheck.is_active
            });

            if (!updatedDept) {
                return res.status(404).json({
                    success: false,
                    message: 'Department not found'
                });
            }

            // Audit log (best-effort)
            try {
                const patch = pickChangedColumns(departmentCheck, updatedDept, ['name', 'description', 'is_active']);
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'departments',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: patch.columns.join(','),
                    oldValue: patch.oldValue,
                    newValue: patch.newValue,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (department update):', e.message || e);
            }

            res.json(updatedDept);
        } catch (error) {
            console.error('Error updating department:', error);
            
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'Department with this name already exists'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to update department'
            });
        }
    }

    // Optimized: Check existence before deletion
    static async deleteDepartment(req, res) {
        try {
            const { id } = req.params;
            const userId = getUserIdFromReq(req);

            // Check if department exists before deletion
            const departmentCheck = await DepartmentModel.findById(id);

            if (!departmentCheck) {
                return res.status(404).json({
                    success: false,
                    message: 'Department not found'
                });
            }

            const deleted = await DepartmentModel.delete(id);

            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    message: 'Department not found'
                });
            }

            // Audit log (best-effort)
            try {
                await writeAuditLog(req, {
                    action: 'DELETE',
                    tableName: 'departments',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: 'id',
                    oldValue: departmentCheck,
                    newValue: null,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (department delete):', e.message || e);
            }

            res.json({
                success: true,
                message: 'Department deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting department:', error);
            
            // Check for foreign key constraint violation (department has users)
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    message: 'Cannot delete department: it is assigned to users'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to delete department'
            });
        }
    }
}

export default DepartmentController;
