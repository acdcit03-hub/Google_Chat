import FinancialYearModel from '../../models/settings/financial-year.model.js';
import { getUserIdFromReq, writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { ensureFinancialYearFolders } from '../../models/filemanager/financialYearFileManager.model.js';

class FinancialYearController {
    static getCurrentFinancialYear() {
        const now = new Date();
        const month = now.getMonth() + 1; // 1-12
        const year = now.getFullYear();

        let startYear, endYear, yearCode;

        if (month >= 4) {
            startYear = year;
            endYear = year + 1;
            yearCode = `${startYear}-${endYear.toString().slice(-2)}`;
        } else {
            startYear = year - 1;
            endYear = year;
            yearCode = `${startYear}-${endYear.toString().slice(-2)}`;
        }

        return { yearCode, startYear, endYear };
    }

    // Optimized: Parallel check and fetch
    static async getAllFinancialYears(req, res) {
        try {
            const currentFY = FinancialYearController.getCurrentFinancialYear();
            
            // Parallel: Check if current FY exists and fetch all financial years
            const [existing, allFinancialYears] = await Promise.all([
                FinancialYearModel.findByYearCode(currentFY.yearCode),
                FinancialYearModel.findAll()
            ]);

            // Auto-add current financial year if it doesn't exist
            if (!existing) {
                await FinancialYearModel.create({
                    year_code: currentFY.yearCode,
                    start_year: currentFY.startYear,
                    end_year: currentFY.endYear,
                    is_active: true,
                    is_current: true,
                });
                console.log(`✅ Auto-added current financial year: ${currentFY.yearCode}`);
            } else {
                await FinancialYearModel.syncCalendarCurrentYear();
            }

            // Sync physical FY folders under PROJECT_FILE_MANAGER_PATH
            try {
                await ensureFinancialYearFolders();
            } catch (err) {
                console.warn(
                    'ensureFinancialYearFolders failed:',
                    err?.message || err,
                );
            }

            const updatedFinancialYears = await FinancialYearModel.findAll();
            return res.json({
                success: true,
                financialYears: updatedFinancialYears,
            });
        } catch (error) {
            console.error('Error fetching financial years:', error);
            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to fetch financial years'
            });
        }
    }

    // Optimized: Parallel duplicate checks
    static async createFinancialYear(req, res) {
        try {
            const { year_code, start_year, end_year, is_active, is_current } = req.body;

            // Validation
            if (!year_code || !start_year || !end_year) {
                return res.status(400).json({
                    success: false,
                    message: 'year_code, start_year, and end_year are required'
                });
            }

            if (!/^\d{4}-\d{2}$/.test(year_code)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid year_code format. Expected format: YYYY-YY (e.g., 2024-25)'
                });
            }

            // Parallel: Check for duplicate year_code and year range
            const [duplicateCode, duplicateRange] = await Promise.all([
                FinancialYearModel.findByYearCode(year_code),
                FinancialYearModel.findByYearRange(start_year, end_year)
            ]);

            if (duplicateCode) {
                return res.status(409).json({
                    success: false,
                    message: 'Financial year with this year_code already exists'
                });
            }

            if (duplicateRange) {
                return res.status(409).json({
                    success: false,
                    message: 'Financial year with this start_year and end_year already exists'
                });
            }

            const newFY = await FinancialYearModel.create({
                year_code,
                start_year,
                end_year,
                is_active,
                is_current,
            });

            res.status(201).json({
                success: true,
                financialYear: newFY
            });
        } catch (error) {
            console.error('Error creating financial year:', error);
            
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'Financial year already exists'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to create financial year'
            });
        }
    }

    // Optimized: Parallel existence check and duplicate validation
    static async updateFinancialYear(req, res) {
        try {
            const { id } = req.params;
            const { year_code, start_year, end_year, is_active, is_current } = req.body;
            const userId = getUserIdFromReq(req);

            // Validation
            if (year_code && !/^\d{4}-\d{2}$/.test(year_code)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid year_code format. Expected format: YYYY-YY (e.g., 2024-25)'
                });
            }

            // First check if financial year exists
            const financialYearCheck = await FinancialYearModel.findById(id);

            if (!financialYearCheck) {
                return res.status(404).json({
                    success: false,
                    message: 'Financial year not found'
                });
            }

            // Parallel: Check for duplicates if values are being changed
            const [duplicateCodeCheck, duplicateRangeCheck] = await Promise.all([
                year_code && year_code !== financialYearCheck.year_code 
                    ? FinancialYearModel.findByYearCode(year_code) 
                    : Promise.resolve(null),
                start_year && end_year && (start_year !== financialYearCheck.start_year || end_year !== financialYearCheck.end_year)
                    ? FinancialYearModel.findByYearRange(start_year, end_year, id)
                    : Promise.resolve(null)
            ]);

            // Check for duplicates if values are being changed
            if (duplicateCodeCheck) {
                return res.status(409).json({
                    success: false,
                    message: 'Financial year with this year_code already exists'
                });
            }

            if (duplicateRangeCheck) {
                return res.status(409).json({
                    success: false,
                    message: 'Financial year with this start_year and end_year already exists'
                });
            }

            const updatedFY = await FinancialYearModel.update(id, {
                year_code: year_code || financialYearCheck.year_code,
                start_year: start_year || financialYearCheck.start_year,
                end_year: end_year || financialYearCheck.end_year,
                is_active: is_active !== undefined ? is_active : financialYearCheck.is_active,
                is_current:
                    is_current !== undefined
                        ? is_current
                        : financialYearCheck.is_current,
            });

            if (!updatedFY) {
                return res.status(404).json({
                    success: false,
                    message: 'Financial year not found'
                });
            }

            // Audit log (best-effort)
            try {
                const patch = pickChangedColumns(financialYearCheck, updatedFY, ['year_code', 'start_year', 'end_year', 'is_active', 'is_current']);
                await writeAuditLog(req, {
                    action: 'UPDATE',
                    tableName: 'financial_years',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: patch.columns.join(','),
                    oldValue: patch.oldValue,
                    newValue: patch.newValue,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (financial year update):', e.message || e);
            }

            res.json({
                success: true,
                financialYear: updatedFY
            });
        } catch (error) {
            console.error('Error updating financial year:', error);
            
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'Financial year with this year_code or year range already exists'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to update financial year'
            });
        }
    }

    // Optimized: Check existence before deletion
    static async deleteFinancialYear(req, res) {
        try {
            const { id } = req.params;
            const userId = getUserIdFromReq(req);

            // Check if financial year exists before deletion
            const financialYearCheck = await FinancialYearModel.findById(id);

            if (!financialYearCheck) {
                return res.status(404).json({
                    success: false,
                    message: 'Financial year not found'
                });
            }

            const deleted = await FinancialYearModel.delete(id);

            if (!deleted) {
                return res.status(404).json({
                    success: false,
                    message: 'Financial year not found'
                });
            }

            // Audit log (best-effort)
            try {
                await writeAuditLog(req, {
                    action: 'DELETE',
                    tableName: 'financial_years',
                    tableOfId: parseInt(id, 10),
                    tableOfColumn: 'id',
                    oldValue: financialYearCheck,
                    newValue: null,
                    userId
                });
            } catch (e) {
                console.error('Audit log write failed (financial year delete):', e.message || e);
            }

            res.json({
                success: true,
                message: 'Financial year deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting financial year:', error);
            
            // Check for foreign key constraint violation
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    message: 'Cannot delete financial year: it is being used by other records'
                });
            }

            res.status(500).json({
                success: false,
                message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to delete financial year'
            });
        }
    }
}

export default FinancialYearController;
