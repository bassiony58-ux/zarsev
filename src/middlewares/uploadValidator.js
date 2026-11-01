const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

// Ensure base upload directory exists
if (!fs.existsSync(config.UPLOADS_DIR)) {
    fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
}

// Multer storage engine
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Create an import session subfolder if present
        const importSessionId = req.importSessionId || 'temp_' + Date.now();
        const targetDir = path.join(config.UPLOADS_DIR, importSessionId, 'original');
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        cb(null, targetDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomBytes(6).toString('hex');
        const ext = path.extname(file.originalname).toLowerCase();
        const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
        cb(null, `${base}_${uniqueSuffix}${ext}`);
    }
});

// File filter based on extension & MIME type
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    
    // Check if extension is generally supported by the platform
    if (!config.SUPPORTED_EXTENSIONS.includes(ext)) {
        return cb(new Error(`نوع الملف (${ext}) غير مدعوم في منصة زارسيف`), false);
    }

    // Check against subscription allowed formats if available
    if (req.subscription && req.subscription.allowed_formats) {
        const cleanExt = ext.replace('.', '');
        const isImage = ['png', 'jpg', 'jpeg', 'webp'].includes(cleanExt);
        const formatAllowed = req.subscription.allowed_formats.includes(cleanExt) || 
                              (isImage && req.subscription.allowed_formats.includes('images'));
        
        if (!formatAllowed) {
            return cb(new Error(`باقة الاشتراك الحالية لا تسمح باستيراد ملفات من نوع (.${cleanExt})`), false);
        }
    }

    cb(null, true);
};

// Create multer upload instance
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 150 * 1024 * 1024, // 150 MB absolute max
        files: 50 // Max 50 files in a single batch
    }
});

module.exports = {
    upload
};
