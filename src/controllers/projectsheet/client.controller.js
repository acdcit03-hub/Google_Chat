
import ClientModel from '../../models/projectsheet/client.model.js';
import { broadcastClientUpdate } from '../../config/socket.js';
import { writeAuditLog, pickChangedColumns } from '../../utils/audit.utils.js';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import { AppError, wrapController } from '../../middleware/error.middleware.js';
dotenv.config();

function parseIsActive(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') return true;
        if (normalized === 'false' || normalized === '0') return false;
    }
    return Boolean(value);
}

function formatClientRow(client) {
    if (!client) return client;
    return {
        ...client,
        is_active: parseIsActive(client.is_active) ?? true,
    };
}

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

class ClientController {
    // Optimized: Fetch clients and count in parallel
    static async getAllClients(req, res) {
        const limit = req.query.limit ? parseInt(req.query.limit) : null;
        const offset = parseInt(req.query.offset) || 0;
        const page = parseInt(req.query.page) || 1;
        const actualOffset = offset || (limit ? (page - 1) * limit : 0);
        const isActiveQuery = req.query.is_active;
        const isActiveFilter =
            isActiveQuery !== undefined &&
            isActiveQuery !== null &&
            String(isActiveQuery).trim() !== ''
                ? parseIsActive(isActiveQuery)
                : undefined;

        const listFilters = {
            isActiveFilter,
            company_name: req.query.company_name,
            client_name: req.query.client_name,
            client_code: req.query.client_code,
            mobile: req.query.mobile,
            email: req.query.email ?? req.query.email_id,
            gst: req.query.gst ?? req.query.gst_code,
            location: req.query.location,
            bill_location: req.query.bill_location,
            sheet_map_location: req.query.sheet_map_location,
            created_by: req.query.created_by,
        };

        // Parallel operations: Fetch clients and count simultaneously
        const [clients, totalResult] = await Promise.all([
            ClientModel.findAll(limit, actualOffset, listFilters),
            ClientModel.countAll(listFilters),
        ]);

        const total = totalResult;

        res.json({
            success: true,
            clients: clients.map(formatClientRow),
            pagination: limit ? {
                total,
                limit,
                offset: actualOffset,
                page,
                totalPages: Math.ceil(total / limit)
            } : { total }
        });
    }

    static async getClientStats(req, res) {
        const stats = await ClientModel.getStats();

        res.json({
            success: true,
            stats: {
                total: Number(stats.total) || 0,
                active: Number(stats.active) || 0,
                inactive: Number(stats.inactive) || 0,
            },
        });
    }

    // Optimized: Support both ID and code lookup
    static async getClientById(req, res) {
        const { id } = req.params;
        const client = await ClientModel.findByIdOrCode(id);
        if (!client) {
            throw new AppError('Client not found', 404);
        }
        res.json({
            success: true,
            client: formatClientRow(client)
        });
    }

    // Optimized: Validation and duplicate check in parallel
    static async createClient(req, res) {
        const {
            company_name,
            client_firstname,
            client_middlename,
            client_lastname,
            client_code,
            client_mobile_no,
            contact_number,
            email_id,
            gst_code,
            location,
            bill_location,
            sheet_map_location,
            client_logo,
            sec_name,
            sec_mobile,
            sec_email,
            created_by,
            is_active

        } = req.body;

        // Early validation
        if (!company_name || !company_name.trim()) {
            throw new AppError('Company name is required', 400);
        }

        if (!client_code || !client_code.trim()) {
            throw new AppError('Client code is required', 400);
        }

        // Parallel: Check duplicate code (async operation)
        const existingCode = await ClientModel.findByCode(client_code.trim());

        if (existingCode) {
            throw new AppError('Client code already exists', 409);
        }

        const activeFlag = parseIsActive(is_active);

        // Create client
        let newClient;
        try {
            newClient = await ClientModel.create({
                company_name,
                client_firstname,
                client_middlename,
                client_lastname,
                client_code,
                client_mobile_no,
                contact_number,
                email_id,
                gst_code,
                location,
                bill_location,
                sheet_map_location,
                client_logo,
                sec_name,
                sec_mobile,
                sec_email,
                created_by,
                is_active: activeFlag !== undefined ? activeFlag : true,
            });
        } catch (error) {
            if (error.code === '23505') {
                throw new AppError('Client code already exists', 409);
            }
            throw error;
        }

        broadcastClientUpdate('created', { source: 'client', id: newClient.id });

        res.status(201).json({
            success: true,
            message: 'Client created successfully',
            client: formatClientRow(newClient)
        });
    }

    // Optimized: Existence check and duplicate check in parallel
    static async updateClient(req, res) {
        const { id } = req.params;
        const {
            company_name,
            client_firstname,
            client_middlename,
            client_lastname,
            client_code,
            client_mobile_no,
            contact_number,
            email_id,
            gst_code,
            location,
            bill_location,
            sheet_map_location,
            client_logo,
            is_active
        } = req.body;

        // Parallel: Check if client exists and if code is duplicate (if provided)
        const [existingClient, duplicateCheck] = await Promise.all([
            ClientModel.findById(id),
            client_code ? ClientModel.findByCode(client_code, id) : Promise.resolve(null)
        ]);

        if (!existingClient) {
            throw new AppError('Client not found', 404);
        }

        if (duplicateCheck) {
            throw new AppError('Client code already exists for another client', 409);
        }

        const activeFlag = parseIsActive(is_active);

        // Update client
        let updatedClient;
        try {
            updatedClient = await ClientModel.update(id, {
                company_name,
                client_firstname,
                client_middlename,
                client_lastname,
                client_code,
                client_mobile_no,
                contact_number,
                email_id,
                gst_code,
                location,
                bill_location,
                sheet_map_location,
                client_logo,
                ...(activeFlag !== undefined ? { is_active: activeFlag } : {}),
            });
        } catch (error) {
            if (error.code === '23505') {
                throw new AppError('Client code already exists', 409);
            }
            throw error;
        }

        if (!updatedClient) {
            throw new AppError('Client not found', 404);
        }

        broadcastClientUpdate('updated', { source: 'client', id: updatedClient.id });

        // Audit log (best-effort)
        try {
            const candidate = Object.keys({
                company_name,
                client_firstname,
                client_middlename,
                client_lastname,
                client_code,
                client_mobile_no,
                contact_number,
                email_id,
                gst_code,
                location,
                bill_location,
                sheet_map_location,
                client_logo,
                is_active
                
            }).filter((k) => req.body[k] !== undefined);
            const patch = pickChangedColumns(existingClient, updatedClient, candidate);
            await writeAuditLog(req, {
                action: 'UPDATE',
                tableName: 'CLIENT',
                tableOfId: updatedClient.id,
                tableOfColumn: patch.columns.join(','),
                oldValue: patch.oldValue,
                newValue: patch.newValue,
            });
        } catch (e) {
            console.error('Audit log write failed (client update):', e.message || e);
        }

        res.json({
            success: true,
            message: 'Client updated successfully',
            client: formatClientRow(updatedClient)
        });
    }

    static async deleteClient(req, res) {
        const { id } = req.params;
        const existingClient = await ClientModel.findById(id);
        if (!existingClient) {
            throw new AppError('Client not found', 404);
        }
        const deleted = await ClientModel.delete(id);
        if (!deleted) {
            throw new AppError('Client not found', 404);
        }
        broadcastClientUpdate('deleted', { source: 'client', id: parseInt(id, 10) });

        // Audit log (best-effort)
        try {
            await writeAuditLog(req, {
                action: 'DELETE',
                tableName: 'CLIENT',
                tableOfId: parseInt(id, 10),
                tableOfColumn: 'id',
                oldValue: existingClient,
                newValue: null,
            });
        } catch (e) {
            console.error('Audit log write failed (client delete):', e.message || e);
        }
        res.json({
            success: true,
            message: 'Client deleted successfully'
        });
    }

    // Optimized: Bulk import with transaction
    static async bulkImport(req, res) {
        const { clients } = req.body;
        if (!clients || !Array.isArray(clients)) {
            throw new AppError('Invalid clients data', 400);
        }

        const result = await ClientModel.bulkCreate(clients);
        broadcastClientUpdate('updated', { source: 'client', bulk: true, count: result.length });
        res.json({
            success: true,
            message: `${result.length} clients imported successfully`
        });
    }

    // Optimized: Upload logo to Cloudinary (async, non-blocking)
    static async uploadLogo(req, res) {
        if (!req.file) {
            throw new AppError('No logo file provided', 400);
        }

        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(req.file.mimetype)) {
            throw new AppError('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.', 400);
        }

        // Generate a structured filename for client logo
        const timestamp = Date.now();
        const originalName = req.file.originalname || 'client-logo';
        const fileExtension = req.file.mimetype.split('/')[1] || 'jpg';
        const cleanName = originalName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const publicId = `clients/logos/client_${timestamp}_${cleanName}`;

        // Convert buffer to base64 for Cloudinary (async operation)
        const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        // Upload to Cloudinary (async, non-blocking)
        const uploadResult = await cloudinary.uploader.upload(base64Image, {
            public_id: publicId,
            folder: 'clients/logos',
            resource_type: 'image',
            transformation: [
                { width: 500, height: 500, crop: 'limit' }, // Resize logo to max 500x500
                { quality: 'auto' } // Auto optimize quality
            ]
        });

        res.json({
            success: true,
            imageUrl: uploadResult.secure_url,
            publicId: uploadResult.public_id
        });
    }
}

wrapController(ClientController, [
    'getAllClients',
    'getClientStats',
    'getClientById',
    'createClient',
    'updateClient',
    'deleteClient',
    'bulkImport',
    'uploadLogo',
]);

export default ClientController;
