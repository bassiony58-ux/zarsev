const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    JWT_SECRET: process.env.JWT_SECRET || 'zarsev-platform-jwt-secret-secure-key-2026',
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
    AUTH_COOKIE_NAME: 'zarsev_auth_token',
    ENABLE_DEMO_SEED: process.env.ENABLE_DEMO_SEED === 'true',
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', '..', 'zarsev.db'),
    STORAGE_DIR: path.join(__dirname, '..', '..', 'storage'),
    UPLOADS_DIR: path.join(__dirname, '..', '..', 'storage', 'uploads'),
    EXTRACTED_IMAGES_DIR: path.join(__dirname, '..', '..', 'storage', 'extracted_images'),
    THUMBNAILS_DIR: path.join(__dirname, '..', '..', 'storage', 'thumbnails'),
    
    // AI Engine Configuration
    AI_PROVIDER: process.env.AI_PROVIDER || 'LOCAL_DETERMINISTIC', // 'GEMINI', 'OPENAI', 'LOCAL_DETERMINISTIC'
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,

    // File support specifications
    SUPPORTED_EXTENSIONS: ['.xlsx', '.xls', '.csv', '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.zip'],
    MIME_MAP: {
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.ms-excel': 'xls',
        'text/csv': 'csv',
        'application/csv': 'csv',
        'text/plain': 'csv',
        'application/pdf': 'pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/msword': 'docx',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'application/zip': 'zip',
        'application/x-zip-compressed': 'zip'
    }
};
