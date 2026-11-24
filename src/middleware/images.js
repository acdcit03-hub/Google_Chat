import multer from "multer";
import path from "path";

/* ================= MEMORY STORAGE ================= */
const storage = multer.memoryStorage();
const fileFilter = ( req, file, cb ) => {
  /* ================= EXTENSION ================= */
  const ext = path
    .extname(file.originalname)
    .toLowerCase();

  return cb(null, true);

  return cb(
    new Error(
      `Only image files allowed. File received: ${file.originalname}`
    )
  );
};

/* ================= EXPORT ================= */
export const uploadImages = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 1024,
    files: 5000
  }
});