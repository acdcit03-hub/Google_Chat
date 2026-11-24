import { pool } from '../../config/db.js';
import { ensureFinancialYearFolderByCode } from '../filemanager/financialYearFileManager.model.js';

class FinancialYearModel {
    static buildSearchCode(startYear, endYear) {
        return String(startYear).slice(-2) + String(endYear).slice(-2);
    }

    /** Calendar FY code (Apr–Mar), e.g. 2025-26. */
    static getCalendarCurrentYearCode() {
        const now = new Date();
        const month = now.getMonth() + 1;
        const year = now.getFullYear();

        if (month >= 4) {
            return `${year}-${String(year + 1).slice(-2)}`;
        }
        return `${year - 1}-${String(year).slice(-2)}`;
    }

    static async findAll() {
        const result = await pool.query(
            'SELECT * FROM financial_years ORDER BY start_year DESC, end_year DESC'
        );
        return result.rows;
    }

    static async findById(id) {
        const result = await pool.query('SELECT * FROM financial_years WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async findByYearCode(yearCode) {
        const result = await pool.query(
            'SELECT * FROM financial_years WHERE year_code = $1',
            [yearCode]
        );
        return result.rows[0];
    }

    static async findCurrent() {
        const result = await pool.query(
            'SELECT * FROM financial_years WHERE is_current = TRUE LIMIT 1'
        );
        return result.rows[0];
    }

    static async findByYearRange(startYear, endYear, excludeId = null) {
        let query = 'SELECT * FROM financial_years WHERE start_year = $1 AND end_year = $2';
        const params = [startYear, endYear];

        if (excludeId) {
            query += ' AND id != $3';
            params.push(excludeId);
        }

        const result = await pool.query(query, params);
        return result.rows[0];
    }

    /** Mark exactly one row as current; all others become false. */
    static async setOnlyCurrent(id) {
        await pool.query('UPDATE financial_years SET is_current = FALSE');
        const result = await pool.query(
            'UPDATE financial_years SET is_current = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
            [id]
        );
        return result.rows[0];
    }

    /** Set calendar FY as the only current year. */
    static async syncCalendarCurrentYear() {
        const yearCode = FinancialYearModel.getCalendarCurrentYearCode();
        const row = await FinancialYearModel.findByYearCode(yearCode);
        if (!row) return null;
        return FinancialYearModel.setOnlyCurrent(row.id);
    }

    static async create(fyData) {
        const { year_code, start_year, end_year, is_active, is_current } = fyData;
        const search_code = FinancialYearModel.buildSearchCode(start_year, end_year);
        const calendarCode = FinancialYearModel.getCalendarCurrentYearCode();
        const shouldBeCurrent =
            is_current === true || year_code === calendarCode;

        const result = await pool.query(
            'INSERT INTO financial_years (year_code, start_year, end_year, is_active, search_code, is_current) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [
                year_code,
                start_year,
                end_year,
                is_active !== undefined ? is_active : true,
                search_code,
                shouldBeCurrent,
            ]
        );

        const row = result.rows[0];

        try {
            await ensureFinancialYearFolderByCode(year_code);
        } catch (err) {
            console.warn(
                'FY folder create failed for',
                year_code,
                err?.message || err,
            );
        }

        if (shouldBeCurrent) {
            return FinancialYearModel.setOnlyCurrent(row.id);
        }

        return row;
    }

    static async update(id, fyData) {
        const { year_code, start_year, end_year, is_active, is_current } = fyData;
        const search_code = FinancialYearModel.buildSearchCode(start_year, end_year);

        const result = await pool.query(
            'UPDATE financial_years SET year_code = $1, start_year = $2, end_year = $3, is_active = $4, search_code = $5, is_current = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *',
            [
                year_code,
                start_year,
                end_year,
                is_active,
                search_code,
                is_current === true,
                id,
            ]
        );

        const row = result.rows[0];
        if (row?.year_code) {
            try {
                await ensureFinancialYearFolderByCode(row.year_code);
            } catch (err) {
                console.warn(
                    'FY folder sync failed for',
                    row.year_code,
                    err?.message || err,
                );
            }
        }

        if (is_current === true && row) {
            return FinancialYearModel.setOnlyCurrent(row.id);
        }

        return row;
    }

    static async delete(id) {
        const result = await pool.query('DELETE FROM financial_years WHERE id = $1 RETURNING id', [id]);
        return result.rows[0];
    }
}

export default FinancialYearModel;
