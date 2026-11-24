import guideRevisionModel from '../../models/systemGuide/guideRevision.model.js';

export async function list(req, res, next) {
    try {
        const data = await guideRevisionModel.listByDocument(
            req.params.documentId
        );
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function create(req, res, next) {
    try {
        const data = await guideRevisionModel.create({
            document_id: req.params.documentId,
            snapshot: req.body.snapshot,
            change_note: req.body.change_note,
            created_by: req.user?.id || req.headers['x-user-id'] || null
        });
        return res.status(201).json({ success:true, data });
    } catch (error) { next(error); }
}

export default { list, create };
