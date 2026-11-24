import streamifier from "streamifier";
import sharp from "sharp";
import cloudinary from "../config/cloudinary.controller.js";

const toError = (error) =>
    error instanceof Error
        ? error
        : new Error(error?.message || String(error));

/* =====================================================
   FAST IMAGE OPTIMIZATION
===================================================== */

export const convertToWebP = async (buffer) => {

    return await sharp(buffer, {
        sequentialRead: true
    })
        .rotate()

        .resize({
            width: 1600,
            height: 1600,
            fit: "inside",
            withoutEnlargement: true,
            fastShrinkOnLoad: true
        })

        .webp({
            quality: 60,
            effort: 0
        })

        .toBuffer();
};

/* =====================================================
   CLOUDINARY UPLOAD
===================================================== */
export const uploadToCloudinary = async (
    buffer,
    fileName,
    folderPath,
    mimeType
) => {

    let uploadBuffer = buffer;
    let resourceType = "auto";
    let format = null;

    /* =================================================
       IMAGE
    ================================================= */
    if (mimeType?.startsWith("image/")) {

        const originalSize = buffer.length / 1024 / 1024;

        console.time(`${fileName} optimization`);

        uploadBuffer = await convertToWebP(buffer);
        console.timeEnd(`${fileName} optimization`);
        const optimizedSize = uploadBuffer.length / 1024 / 1024;

        console.log(
            `${fileName}:`,
            `${originalSize.toFixed(2)} MB`,
            "->",
            `${optimizedSize.toFixed(2)} MB`
        );

        resourceType = "image";
        format = "webp";
    }

    /* =================================================
       SAFE FILE NAME
    ================================================= */
    const safeFileName = String(fileName || "")
        .trim()
        .replace(/\s+/g, "_")
        .toUpperCase();

    /* =================================================
       SAFE FOLDER
    ================================================= */
    const safeFolder = String(folderPath || "")
        .trim()
        .replace(/\s+/g, "_");

    /* =================================================
       ROOT FOLDER
    ================================================= */
    const rootFolder = process.env.DATABASE_URL
        ? "employee_details"
        : "employee";

    /* =================================================
       CLOUDINARY
    ================================================= */
    return new Promise((resolve, reject) => {
        console.time(`${fileName} Cloudinary upload`);
        const stream = cloudinary.uploader.upload_stream(
                {
                    folder: `${rootFolder}/${safeFolder}`,
                    public_id: safeFileName,
                    overwrite: true,
                    resource_type: resourceType,
                    ...(format && {
                        format
                    })
                },

                (error, result) => {
                    console.timeEnd(`${fileName} Cloudinary upload`);

                    if (error) {
                        reject(toError(error));
                        return;
                    }
                    resolve(result);
                }
            );

        streamifier
            .createReadStream(uploadBuffer)
            .pipe(stream);
    });
};

/* =====================================================
   CATEGORY IMAGE UPLOAD
===================================================== */
export const uploadCategoryImageToCloudinary = async (
    buffer,
    fileName,
    mimeType
) => {

    if (!buffer) {
        throw new Error(
            "Category image buffer is required."
        );
    }

    if (!mimeType?.startsWith("image/")) {
        throw new Error(
            "Only image files are allowed."
        );
    }

    /* ================= OPTIMIZE ================= */
    const uploadBuffer = await convertToWebP(buffer);

    /* ================= FILE NAME ================= */
    const safeFileName =
        String(fileName || "")
            .trim()
            .replace(/\s+/g, "_")
            .replace(
                /[^a-zA-Z0-9_-]/g,
                "_"
            )
            .toUpperCase();

    /* ================= FOLDER ================= */
    const categoryFolder =
        process.env.DATABASE_URL
            ? "category_image"
            : "category_local_image";

    /* ================= UPLOAD ================= */
    return new Promise((resolve, reject) => {
        const stream =
            cloudinary.uploader.upload_stream(
                {
                    folder: categoryFolder,
                    public_id: safeFileName,
                    overwrite: true,
                    resource_type: "image",
                    format: "webp"
                },

                (error, result) => {
                    if (error) {
                        console.error("❌ CATEGORY CLOUDINARY ERROR:", error);
                        reject(toError(error));
                        return;
                    }
                    console.log("✅ CATEGORY IMAGE UPLOADED");
                    resolve(result);
                }
            );

        streamifier
            .createReadStream(uploadBuffer)
            .pipe(stream);
    });
};

/* =====================================================
   LEAVE DOCUMENT UPLOAD
===================================================== */
export const uploadToLeavedocument = async (
    buffer,
    fileName,
    folderPath,
    mimeType
) => {
    let uploadBuffer = buffer;
    let resourceType = "auto";
    let format = null;

    /* =================================================
       IMAGE → WEBP
    ================================================= */
    if (mimeType?.startsWith("image/")) {
        const originalSize = buffer.length / 1024 / 1024;

        console.time(`${fileName} optimization`);

        uploadBuffer = await convertToWebP(buffer);

        console.timeEnd(`${fileName} optimization`);

        const optimizedSize = uploadBuffer.length / 1024 / 1024;

        console.log(
            `${fileName}:`,
            `${originalSize.toFixed(2)} MB`,
            "->",
            `${optimizedSize.toFixed(2)} MB`
        );

        resourceType = "image";
        format = "webp";
    }

    /* =================================================
       SAFE FILE NAME
    ================================================= */
    const safeFileName = String(fileName || "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .toUpperCase();

    /* =================================================
       SAFE FOLDER
    ================================================= */
    const safeFolder = String(folderPath || "")
        .trim()
        .replace(/\s+/g, "_");

    /* =================================================
       ROOT FOLDER
    ================================================= */
    const rootFolder = process.env.DATABASE_URL
        ? "employee_details"
        : "employee";

    /* =================================================
       CLOUDINARY UPLOAD
    ================================================= */
    return new Promise((resolve, reject) => {
        console.time(`${fileName} Cloudinary upload`);

        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `${rootFolder}/${safeFolder}`,
                public_id: safeFileName,
                overwrite: true,
                resource_type: resourceType,
                ...(format && {
                    format
                })
            },

            (error, result) => {
                console.timeEnd(`${fileName} Cloudinary upload`);
                if (error) {
                    reject(toError(error));
                    return;
                }
                resolve(result);
            }
        );

        streamifier
            .createReadStream(uploadBuffer)
            .pipe(stream);
    });
};