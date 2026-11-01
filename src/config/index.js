const path = require('path');

const KNOWN_INSECURE_SECRETS = [
    'zarsev-platform-jwt-secret-secure-key-2026',
    'zarsev-dev-secret-do-not-use-in-production-f89a2b',
    'secret',
    'default',
    'changeme',
    'password',
    'admin',
    '12345678',
    '12345678901234567890123456789012'
];

/**
 * Validates JWT_SECRET against production security requirements.
 * Rejects missing, default, known fallback, or weak (< 32 bytes) secrets in production.
 */
function validateJwtSecret(env, secret) {
    const isProduction = env === 'production';

    if (isProduction) {
        if (!secret || typeof secret !== 'string' || !secret.trim()) {
            throw new Error('[FATAL SECURITY CONFIG] JWT_SECRET is mandatory in production (NODE_ENV=production). Server startup aborted.');
        }

        const normalized = secret.trim().toLowerCase();
        if (KNOWN_INSECURE_SECRETS.includes(normalized)) {
            throw new Error('[FATAL SECURITY CONFIG] Insecure JWT_SECRET: The configured secret matches a known default or insecure fallback. Production requires a unique cryptographically random secret.');
        }

        const byteLength = Buffer.byteLength(secret.trim(), 'utf8');
        if (byteLength < 32) {
            throw new Error(`[FATAL SECURITY CONFIG] Weak JWT_SECRET: Production requires a secret of at least 32 bytes (256 bits). Current secret is only ${byteLength} bytes.`);
        }

        return secret.trim();
    }

    // Development or test mode
    if (secret && typeof secret === 'string' && secret.trim()) {
        return secret.trim();
    }

    return 'zarsev-dev-secret-do-not-use-in-production-f89a2b';
}

const currentEnv = process.env.NODE_ENV || 'development';
const rawJwtSecret = process.env.JWT_SECRET;
const resolvedJwtSecret = validateJwtSecret(currentEnv, rawJwtSecret);

const config = {
    PORT: process.env.PORT || 3000,
    NODE_ENV: currentEnv,
    JWT_SECRET: resolvedJwtSecret,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
    AUTH_COOKIE_NAME: 'zarsev_auth_token',
    CSRF_COOKIE_NAME: 'zarsev_csrf_token',
    CSRF_HEADER_NAME: 'x-csrf-token',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().toLowerCase())
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    ENABLE_DEMO_SEED: process.env.ENABLE_DEMO_SEED === 'true',
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', '..', 'zarsev.db'),
    STORAGE_DIR: path.join(__dirname, '..', '..', 'storage'),
    UPLOADS_DIR: path.join(__dirname, '..', '..', 'storage', 'uploads'),
    EXTRACTED_IMAGES_DIR: path.join(__dirname, '..', '..', 'storage', 'extracted_images'),
    THUMBNAILS_DIR: path.join(__dirname, '..', '..', 'storage', 'thumbnails'),

    // AI Engine Configuration
    AI_PROVIDER: process.env.AI_PROVIDER || 'LOCAL_DETERMINISTIC',
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
    },

    // Helpers
    validateJwtSecret,
    validateStartupSettings: function() {
        validateJwtSecret(process.env.NODE_ENV || 'development', process.env.JWT_SECRET);
    }
};

module.exports = config;
