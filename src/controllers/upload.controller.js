import { v2 as cloudinary } from 'cloudinary';

class UploadController {
    // Generic image upload endpoint
    static async uploadImage(req, res) {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'No image file provided'
                });
            }

            // Validate file type
            if (!req.file.mimetype.startsWith('image/')) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid file type. Only images are allowed.'
                });
            }

            // Generate a predictable filename based on timestamp and original filename
            const timestamp = Date.now();
            const originalName = req.file.originalname || 'pasted-image';
            const fileExtension = req.file.mimetype.split('/')[1] || 'jpg';
            const cleanName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
            const publicId = `uploads/img_${timestamp}_${cleanName}`;

            // Convert buffer to base64 for Cloudinary
            const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

            // Upload to Cloudinary with structured filename
            const uploadResult = await cloudinary.uploader.upload(base64Image, {
                public_id: publicId,
                folder: 'uploads', // Organize images in a folder
                resource_type: 'image',
                transformation: [
                    { width: 1200, height: 1200, crop: 'limit' }, // Resize if needed
                    { quality: 'auto' } // Auto optimize quality
                ]
            });

            res.json({
                success: true,
                imageUrl: uploadResult.secure_url, // Use secure_url for HTTPS
                url: uploadResult.secure_url, // Also include 'url' for backward compatibility
                publicId: uploadResult.public_id
            });
        } catch (error) {
            console.error('Cloudinary upload error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to upload image: ' + (error.message || 'Unknown error')
            });
        }
    }
}

export default UploadController;
