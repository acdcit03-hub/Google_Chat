import guideMediaModel from '../../models/systemGuide/guideMedia.model.js';

export async function list(req, res, next) {
    try {
        return res.json({
            success: true,
            data: await guideMediaModel.list(req.query)
        });
    } catch (error) { next(error); }
}

export async function get(req, res, next) {
    try {
        const data = await guideMediaModel.getById(req.params.id);
        if (!data) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function create(req, res, next) {
    try {
        const data = await guideMediaModel.create(
            req.body,
            req.user?.id || req.headers['x-user-id'] || null
        );
        return res.status(201).json({ success:true, data });
    } catch (error) { next(error); }
}

export async function remove(req, res, next) {
    try {
        const deleted = await guideMediaModel.remove(req.params.id);
        if (!deleted) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, message:'Deleted successfully' });
    } catch (error) { next(error); }
}

export default { list, get, create, remove };
