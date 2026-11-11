-- 001_initial_schema.sql
-- ZARSEV Global Trade Platform - PostgreSQL Foundation Schema

-- 1. Subscriptions Table
CREATE TABLE IF NOT EXISTS subscriptions (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    allowed_formats JSONB NOT NULL,
    max_products_per_import INTEGER NOT NULL,
    max_monthly_imports INTEGER NOT NULL,
    max_file_size_mb INTEGER NOT NULL,
    ai_extraction_enabled BOOLEAN NOT NULL DEFAULT true,
    bulk_import_enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Categories Table (Hierarchical Self-Referencing)
CREATE TABLE IF NOT EXISTS categories (
    id VARCHAR(64) PRIMARY KEY,
    parent_id VARCHAR(64) NULL REFERENCES categories(id) ON DELETE SET NULL,
    name_ar VARCHAR(255) NOT NULL,
    name_en VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    icon VARCHAR(255) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Manufacturers Table
CREATE TABLE IF NOT EXISTS manufacturers (
    id VARCHAR(64) PRIMARY KEY,
    name_ar VARCHAR(255) NOT NULL,
    name_en VARCHAR(255) NOT NULL,
    code VARCHAR(100) UNIQUE NOT NULL,
    business_model VARCHAR(50) NOT NULL CHECK(business_model IN ('DIRECT_CONTRACT', 'MARKETING_SUBSCRIPTION')),
    subscription_id VARCHAR(64) NULL REFERENCES subscriptions(id) ON DELETE SET NULL,
    country VARCHAR(100) NOT NULL DEFAULT 'مصر',
    city VARCHAR(100) NOT NULL,
    contact_email VARCHAR(255) NULL,
    contact_phone VARCHAR(50) NULL,
    is_verified BOOLEAN NOT NULL DEFAULT true,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Users Table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NULL,
    role VARCHAR(50) NOT NULL CHECK(role IN ('SUPER_ADMIN', 'LOGISTICS_OFFICER', 'MANUFACTURER')),
    manufacturer_id VARCHAR(64) NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Products Table
CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(64) PRIMARY KEY,
    manufacturer_id VARCHAR(64) NOT NULL REFERENCES manufacturers(id) ON DELETE RESTRICT,
    category_id VARCHAR(64) NULL REFERENCES categories(id) ON DELETE SET NULL,
    subcategory_id VARCHAR(64) NULL,
    sku VARCHAR(100) NULL,
    name_ar VARCHAR(255) NOT NULL,
    name_en VARCHAR(255) NULL,
    description_ar TEXT NULL,
    description_en TEXT NULL,
    specifications JSONB NULL,
    packaging_info TEXT NULL,
    country_of_origin VARCHAR(100) NOT NULL DEFAULT 'مصر',
    price NUMERIC(12, 2) NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    price_unit VARCHAR(50) NOT NULL DEFAULT 'MT',
    moq VARCHAR(100) NULL,
    available_quantity VARCHAR(100) NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED')),
    rejection_reason TEXT NULL,
    source_import_id VARCHAR(64) NULL,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Product Images Table
CREATE TABLE IF NOT EXISTS product_images (
    id VARCHAR(64) PRIMARY KEY,
    product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    thumbnail_url TEXT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    display_order INTEGER NOT NULL DEFAULT 0,
    dhash VARCHAR(64) NULL,
    file_size INTEGER NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Imports Table
CREATE TABLE IF NOT EXISTS imports (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    manufacturer_id VARCHAR(64) NULL REFERENCES manufacturers(id) ON DELETE SET NULL,
    source_files JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PARSING', 'EXTRACTING', 'REVIEW_READY', 'SAVED_DRAFT', 'SUBMITTED', 'FAILED')),
    total_detected INTEGER NOT NULL DEFAULT 0,
    total_valid INTEGER NOT NULL DEFAULT 0,
    total_failed INTEGER NOT NULL DEFAULT 0,
    progress_percent INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT NULL,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Import Items Table
CREATE TABLE IF NOT EXISTS import_items (
    id VARCHAR(64) PRIMARY KEY,
    import_id VARCHAR(64) NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    suggested_manufacturer_id VARCHAR(64) NULL,
    suggested_category_id VARCHAR(64) NULL,
    raw_data JSONB NULL,
    extracted_data JSONB NOT NULL,
    confidence_score NUMERIC(5, 4) NOT NULL DEFAULT 1.0000,
    validation_warnings JSONB NULL,
    is_duplicate BOOLEAN NOT NULL DEFAULT false,
    duplicate_matched_id VARCHAR(64) NULL,
    duplicate_reason TEXT NULL,
    assigned_images JSONB NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'AWAITING_REVIEW' CHECK(status IN ('AWAITING_REVIEW', 'READY', 'SKIPPED', 'SAVED', 'FAILED')),
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Import Logs Table
CREATE TABLE IF NOT EXISTS import_logs (
    id VARCHAR(64) PRIMARY KEY,
    import_id VARCHAR(64) NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    step VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'INFO' CHECK(severity IN ('INFO', 'WARNING', 'ERROR')),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance & Foreign Key Indexes
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_manufacturers_subscription ON manufacturers(subscription_id);
CREATE INDEX IF NOT EXISTS idx_users_manufacturer ON users(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON products(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_is_demo ON products(is_demo);
CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_imports_user_id ON imports(user_id);
CREATE INDEX IF NOT EXISTS idx_imports_manufacturer_id ON imports(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_imports_status ON imports(status);
CREATE INDEX IF NOT EXISTS idx_import_items_import_id ON import_items(import_id);
CREATE INDEX IF NOT EXISTS idx_import_items_status ON import_items(status);
CREATE INDEX IF NOT EXISTS idx_import_logs_import_id ON import_logs(import_id);
