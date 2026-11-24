import guideTabModel from '../../models/systemGuide/guideTab.model.js';

export async function list(req, res, next) {
    try {
        const data = await guideTabModel.listByPage(req.params.moduleId || req.query);
        return res.json({ success: true, data });
    } catch (error) { next(error); }
}

export async function get(req, res, next) {
    try {
        const data = await guideTabModel.getById(req.params.id);
        if (!data) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function create(req, res, next) {
    try {
        const data = await guideTabModel.create(req.body, req.user?.id || req.headers['x-user-id'] || null);
        return res.status(201).json({ success:true, data });
    } catch (error) { next(error); }
}

export async function update(req, res, next) {
    try {
        const data = await guideTabModel.update(req.params.id, req.body, req.user?.id || req.headers['x-user-id'] || null);
        if (!data) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function remove(req, res, next) {
    try {
        const deleted = await guideTabModel.remove(req.params.id);
        if (!deleted) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, message:'Deleted successfully' });
    } catch (error) { next(error); }
}

export default { list, get, create, update, remove };
