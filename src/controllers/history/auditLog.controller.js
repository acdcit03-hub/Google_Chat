import AuditLogModel from '../../models/history/auditLog.model.js';
class AuditLogController {
  static async getAll(req, res) {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
      const logs = await AuditLogModel.findAll({ limit, offset });
      res.json({ success: true, logs });
    } catch (error) {
      console.error('Error fetching audit logs:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
    }
  }
}

export default AuditLogController;

