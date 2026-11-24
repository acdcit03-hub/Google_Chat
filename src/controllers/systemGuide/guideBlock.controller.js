import guideBlockModel from '../../models/systemGuide/guideBlock.model.js';

export async function list(req, res, next) {
    try {
        const data = await guideBlockModel.listByDocument(
            req.params.documentId
        );

        return res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
}

export async function create(req, res, next) {
    try {
        const data = await guideBlockModel.create({
            ...req.body,
            document_id: req.params.documentId
        });

        return res.status(201).json({ success: true, data });
    } catch (error) {
        next(error);
    }
}

export async function get(req, res, next) {
    try {
        const data = await guideBlockModel.getById(req.params.id);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: 'Guide block not found'
            });
        }

        return res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
}

export async function update(req, res, next) {
    try {
        const data = await guideBlockModel.update(
            req.params.id,
            req.body
        );

        if (!data) {
            return res.status(404).json({
                success: false,
                message: 'Guide block not found'
            });
        }

        return res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
}

export async function reorder(req, res, next) {
    try {
        const data = await guideBlockModel.reorder(
            req.params.documentId,
            req.body.items || []
        );

        return res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
}

export async function remove(req, res, next) {
    try {
        const deleted = await guideBlockModel.remove(req.params.id);

        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: 'Guide block not found'
            });
        }

        return res.json({
            success: true,
            message: 'Guide block deleted successfully'
        });
    } catch (error) {
        next(error);
    }
}

export default { list, create, get, update, reorder, remove };
