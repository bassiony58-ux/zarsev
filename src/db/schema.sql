-- ZARSEV Global Trade Platform - Database Schema (SQLite)

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN', 'LOGISTICS_OFFICER', 'MANUFACTURER')),
    manufacturer_id TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    allowed_formats TEXT NOT NULL, -- JSON array
    max_products_per_import INTEGER NOT NULL,
    max_monthly_imports INTEGER NOT NULL,
    max_file_size_mb INTEGER NOT NULL,
    ai_extraction_enabled INTEGER NOT NULL DEFAULT 1, -- 0 or 1
    bulk_import_enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manufacturers (
    id TEXT PRIMARY KEY,
    name_ar TEXT NOT NULL,
    name_en TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    business_model TEXT NOT NULL CHECK(business_model IN ('DIRECT_CONTRACT', 'MARKETING_SUBSCRIPTION')),
    subscription_id TEXT NULL,
    country TEXT NOT NULL DEFAULT 'مصر',
    city TEXT NOT NULL,
    contact_email TEXT NULL,
    contact_phone TEXT NULL,
    is_verified INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    parent_id TEXT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    icon TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(parent_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    manufacturer_id TEXT NOT NULL,
    category_id TEXT NULL,
    subcategory_id TEXT NULL,
    sku TEXT NULL,
    name_ar TEXT NOT NULL,
    name_en TEXT NULL,
    description_ar TEXT NULL,
    description_en TEXT NULL,
    specifications TEXT NULL, -- JSON object
    packaging_info TEXT NULL,
    country_of_origin TEXT NOT NULL DEFAULT 'مصر',
    price REAL NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    price_unit TEXT NOT NULL DEFAULT 'MT',
    moq TEXT NULL,
    available_quantity TEXT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED')),
    rejection_reason TEXT NULL,
    source_import_id TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id),
    FOREIGN KEY(category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    url TEXT NOT NULL,
    thumbnail_url TEXT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    dhash TEXT NULL,
    file_size INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    manufacturer_id TEXT NULL,
    source_files TEXT NOT NULL, -- JSON array of file metadata
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PARSING', 'EXTRACTING', 'REVIEW_READY', 'SAVED_DRAFT', 'SUBMITTED', 'FAILED')),
    total_detected INTEGER NOT NULL DEFAULT 0,
    total_valid INTEGER NOT NULL DEFAULT 0,
    total_failed INTEGER NOT NULL DEFAULT 0,
    progress_percent INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(manufacturer_id) REFERENCES manufacturers(id)
);

CREATE TABLE IF NOT EXISTS import_items (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL,
    suggested_manufacturer_id TEXT NULL,
    suggested_category_id TEXT NULL,
    raw_data TEXT NULL, -- JSON
    extracted_data TEXT NOT NULL, -- JSON product fields
    confidence_score REAL NOT NULL DEFAULT 1.0,
    validation_warnings TEXT NULL, -- JSON array of warnings
    is_duplicate INTEGER NOT NULL DEFAULT 0,
    duplicate_matched_id TEXT NULL,
    duplicate_reason TEXT NULL,
    assigned_images TEXT NULL, -- JSON array: [{url, is_primary, thumbnail}]
    status TEXT NOT NULL DEFAULT 'AWAITING_REVIEW' CHECK(status IN ('AWAITING_REVIEW', 'READY', 'SKIPPED', 'SAVED', 'FAILED')),
    error_message TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_logs (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL,
    step TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'INFO' CHECK(severity IN ('INFO', 'WARNING', 'ERROR')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE
);
