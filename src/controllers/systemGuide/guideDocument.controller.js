import guideDocumentModel from '../../models/systemGuide/guideDocument.model.js';
import guideBlockModel from '../../models/systemGuide/guideBlock.model.js';
import guideRevisionModel from '../../models/systemGuide/guideRevision.model.js';

const actorId = (req) =>
    req.user?.id ||
    req.user?.user_id ||
    req.headers['x-user-id'] ||
    null;

export async function list(req, res, next) {
    try {
        const data = await guideDocumentModel.list(req.query);
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function get(req, res, next) {
    try {
        const data = await guideDocumentModel.getById(req.params.id);
        if (!data) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function getByPath(req, res, next) {
    try {
        const data = await guideDocumentModel.getFullByPath(
            req.params.moduleSlug,
            req.params.pageSlug,
            req.params.documentSlug,
            req.query.version || null
        );

        if (!data) {
            return res.status(404).json({
                success:false,
                message:'Guide document not found'
            });
        }

        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function create(req, res, next) {
    try {
        const data = await guideDocumentModel.create(req.body, actorId(req));

        await guideRevisionModel.create({
            document_id: data.id,
            snapshot: { document:data, blocks:[] },
            change_note: 'Initial creation',
            created_by: actorId(req)
        });

        return res.status(201).json({ success:true, data });
    } catch (error) { next(error); }
}

export async function update(req, res, next) {
    try {
        const old = await guideDocumentModel.getById(req.params.id);

        if (!old) {
            return res.status(404).json({
                success:false,
                message:'Not found'
            });
        }

        const data = await guideDocumentModel.update(
            req.params.id,
            req.body,
            actorId(req)
        );

        const blocks = await guideBlockModel.listByDocument(req.params.id);

        await guideRevisionModel.create({
            document_id: data.id,
            snapshot: { document:data, blocks },
            change_note: req.body.change_note || 'Document updated',
            created_by: actorId(req)
        });

        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function publish(req, res, next) {
    try {
        const data = await guideDocumentModel.publish(
            req.params.id,
            actorId(req)
        );

        if (!data) return res.status(404).json({ success:false, message:'Not found' });

        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function unpublish(req, res, next) {
    try {
        const data = await guideDocumentModel.unpublish(
            req.params.id,
            actorId(req)
        );

        if (!data) return res.status(404).json({ success:false, message:'Not found' });

        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function remove(req, res, next) {
    try {
        const deleted = await guideDocumentModel.remove(req.params.id);

        if (!deleted) return res.status(404).json({
            success:false,
            message:'Not found'
        });

        return res.json({
            success:true,
            message:'Deleted successfully'
        });
    } catch (error) { next(error); }
}

export default {
    list,
    get,
    getByPath,
    create,
    update,
    publish,
    unpublish,
    remove
};
