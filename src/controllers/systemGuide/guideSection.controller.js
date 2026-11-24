import guideSectionModel from '../../models/systemGuide/guideSection.model.js';

export async function listByPage(req, res, next) {
    try {
        return res.json({
            success: true,
            data: await guideSectionModel.listByPage(req.params.pageId)
        });
    } catch (error) { next(error); }
}

export async function listByTab(req, res, next) {
    try {
        return res.json({
            success: true,
            data: await guideSectionModel.listByTab(req.params.tabId)
        });
    } catch (error) { next(error); }
}

export async function get(req, res, next) {
    try {
        const data = await guideSectionModel.getById(req.params.id);
        if (!data) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function create(req, res, next) {
    try {
        const data = await guideSectionModel.create(req.body);
        return res.status(201).json({ success:true, data });
    } catch (error) { next(error); }
}

export async function update(req, res, next) {
    try {
        const data = await guideSectionModel.update(req.params.id, req.body);
        if (!data) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, data });
    } catch (error) { next(error); }
}

export async function remove(req, res, next) {
    try {
        const deleted = await guideSectionModel.remove(req.params.id);
        if (!deleted) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, message:'Deleted successfully' });
    } catch (error) { next(error); }
}

export default { listByPage, listByTab, get, create, update, remove };
