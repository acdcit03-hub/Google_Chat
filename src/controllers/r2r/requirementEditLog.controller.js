import { getRequirementEditLogs } from '../../models/r2r/requirementEditLog.model.js';
import { asyncHandler, AppError } from '../../middleware/error.middleware.js';

function toResponse(serial, result) {
    const total = Number(result.total) || 0;
    const limit = Number(result.limit) || 0;
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    return {
        success: true,
        serial_number: serial || null,
        count: total,
        data: result.data ?? [],
        pagination: {
            page: result.page,
            limit: result.limit,
            total,
            totalPages,
        },
    };
}

/** GET /requirements-edit-log/:serial_number?page=&limit= */
export const getRequirementEditLogsBySerial = asyncHandler(async (req, res) => {
    const serial = String(req.params.serial_number ?? '').trim();
    if (!serial) {
        throw new AppError('serial_number is required', 400);
    }

    const result = await getRequirementEditLogs({
        serial_number: serial,
        page: req.query.page,
        limit: req.query.limit,
    });

    res.json(toResponse(serial, result));
});

/** GET /requirements-edit-log?page=&limit= */
export const getRequirementEditLogList = asyncHandler(async (req, res) => {
    const serial = String(req.query.serial_number ?? '').trim();
    const result = await getRequirementEditLogs({
        serial_number: serial || undefined,
        requirement_id: req.query.requirement_id,
        edited_by: req.query.edited_by,
        field_name: req.query.field_name,
        page: req.query.page,
        limit: req.query.limit,
    });

    res.json(toResponse(serial || null, result));
});
