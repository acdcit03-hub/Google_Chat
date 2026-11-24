import guidePermissionModel from '../../models/systemGuide/guidePermission.model.js';

export async function list(req, res, next) {
    try {
        return res.json({
            success:true,
            data: await guidePermissionModel.list(req.query)
        });
    } catch (error) { next(error); }
}

export async function upsert(req, res, next) {
    try {
        const data = await guidePermissionModel.upsert(req.body);
        return res.status(201).json({ success:true, data });
    } catch (error) { next(error); }
}

export async function remove(req, res, next) {
    try {
        const deleted = await guidePermissionModel.remove(req.params.id);
        if (!deleted) return res.status(404).json({ success:false, message:'Not found' });
        return res.json({ success:true, message:'Deleted successfully' });
    } catch (error) { next(error); }
}

export default { list, upsert, remove };
