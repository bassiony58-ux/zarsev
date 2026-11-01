const { getDb, initDb } = require('./database');
const { hashPassword } = require('../utils/authUtils');

function seedDatabase() {
    if (process.env.NODE_ENV === 'production') {
        console.warn('⚠️ [SECURITY] seedDatabase() blocked: Seeding is strictly forbidden in production mode (NODE_ENV=production).');
        return { success: false, message: 'Seeding forbidden in production' };
    }
    if (process.env.ENABLE_DEMO_SEED !== 'true') {
        console.log('ℹ️ [SEED] Seeding skipped: ENABLE_DEMO_SEED is not true.');
        return { success: false, message: 'ENABLE_DEMO_SEED not enabled' };
    }

    initDb();
    const db = getDb();

    // 1. Seed Subscriptions
    const checkSubs = db.prepare('SELECT COUNT(*) as count FROM subscriptions').get();
    if (checkSubs.count === 0) {
        const insertSub = db.prepare(`
            INSERT INTO subscriptions (id, name, allowed_formats, max_products_per_import, max_monthly_imports, max_file_size_mb, ai_extraction_enabled, bulk_import_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        insertSub.run(
            'sub_standard',
            'Standard (باقة المصدر الأساسية)',
            JSON.stringify(['xlsx', 'csv', 'images']),
            50,
            10,
            15,
            0,
            1
        );

        insertSub.run(
            'sub_pro',
            'Pro (باقة التصدير المتقدمة والذكاء الاصطناعي)',
            JSON.stringify(['xlsx', 'xls', 'csv', 'pdf', 'docx', 'images', 'zip']),
            250,
            50,
            50,
            1,
            1
        );

        insertSub.run(
            'sub_enterprise',
            'Enterprise (المؤسسات والمجمعات التصديرية الكبرى)',
            JSON.stringify(['xlsx', 'xls', 'csv', 'pdf', 'docx', 'images', 'zip']),
            1000,
            500,
            150,
            1,
            1
        );
        console.log('Seeded Subscriptions.');
    }

    // 2. Seed Manufacturers
    const checkMfgs = db.prepare('SELECT COUNT(*) as count FROM manufacturers').get();
    if (checkMfgs.count === 0) {
        const insertMfg = db.prepare(`
            INSERT INTO manufacturers (id, name_ar, name_en, code, business_model, subscription_id, country, city, contact_email, contact_phone, is_verified, is_demo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);

        // Direct Contract Manufacturers (managed by ZARSEV, no login needed)
        insertMfg.run(
            'mfg_bustan_citrus',
            'محطة البستان للحاصلات الزراعية والتصدير',
            'Al-Bustan Citrus Export Packing Station',
            'EGY-BUS-01',
            'DIRECT_CONTRACT',
            'sub_enterprise',
            'مصر',
            'النوبارية - البحيرة',
            'contracts@bustan-citrus.com',
            '+20 45 3890123',
            1
        );

        insertMfg.run(
            'mfg_damietta_agro',
            'مجمع دمياط للتبريد والتصنيع الزراعي',
            'Damietta Agro-Cooling Complex',
            'EGY-DAM-02',
            'DIRECT_CONTRACT',
            'sub_enterprise',
            'مصر',
            'ميناء دمياط اللوجستي',
            'logistics@damietta-agro.com',
            '+20 57 2700595',
            1
        );

        // Marketing Subscription Manufacturers (self-service account)
        insertMfg.run(
            'mfg_nile_fruits',
            'شركة ثمار النيل للتصدير والاستثمار الزراعي',
            'Nile Fruits Co. for Export',
            'EGY-NFL-03',
            'MARKETING_SUBSCRIPTION',
            'sub_pro',
            'مصر',
            'السادات - المنوفية',
            'export@nilefruits.com',
            '+20 48 2601144',
            1
        );

        insertMfg.run(
            'mfg_delta_iqf',
            'دلتا للصناعات الغذائية والتجميد السريع',
            'Delta IQF Food Industries',
            'EGY-DLT-04',
            'MARKETING_SUBSCRIPTION',
            'sub_standard',
            'مصر',
            'المنصورة - الدقهلية',
            'info@delta-iqf.com',
            '+20 50 2239911',
            1
        );
        console.log('Seeded Manufacturers.');
    }

    // 3. Seed Users
    const checkUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (checkUsers.count === 0) {
        const defaultPasswordHash = hashPassword('Demo@Zarsev2026');
        const insertUser = db.prepare(`
            INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, is_demo)
            VALUES (?, ?, ?, ?, ?, ?, 1, 1)
        `);

        // Super Admin (HQ)
        insertUser.run(
            'usr_super_admin',
            'المدير العام (ZARSEV HQ)',
            'admin@zarsev.com',
            defaultPasswordHash,
            'SUPER_ADMIN',
            null
        );

        // Logistics Officer
        insertUser.run(
            'usr_logistics_officer',
            'مسؤول العمليات اللوجستية والموانئ',
            'logistics@zarsev.com',
            defaultPasswordHash,
            'LOGISTICS_OFFICER',
            null
        );

        // Marketing Manufacturer 1 (Nile Fruits)
        insertUser.run(
            'usr_mfg_nile_fruits',
            'مدير تصدير ثمار النيل',
            'nile_export@company.com',
            defaultPasswordHash,
            'MANUFACTURER',
            'mfg_nile_fruits'
        );

        // Marketing Manufacturer 2 (Delta IQF)
        insertUser.run(
            'usr_mfg_delta_iqf',
            'مدير مبيعات دلتا للتجميد',
            'delta_sales@company.com',
            defaultPasswordHash,
            'MANUFACTURER',
            'mfg_delta_iqf'
        );
        console.log('Seeded Users.');
    }

    // 4. Seed Categories
    const checkCats = db.prepare('SELECT COUNT(*) as count FROM categories').get();
    if (checkCats.count === 0) {
        const insertCat = db.prepare(`
            INSERT INTO categories (id, parent_id, name_ar, name_en, slug, icon)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        // Parent Categories
        insertCat.run('cat_citrus', null, 'الموالح والحمضيات الطازجة', 'Fresh Citrus', 'citrus', 'nutrition');
        insertCat.run('cat_iqf', null, 'الخضار والفواكه المجمدة IQF', 'Frozen Fruits & Vegetables IQF', 'frozen-iqf', 'ac_unit');
        insertCat.run('cat_tubers', null, 'الدرنات والبصليات الطازجة', 'Tubers & Bulbs', 'tubers-bulbs', 'grass');
        insertCat.run('cat_dates', null, 'التمور الفاخرة والأعشاب الطبية', 'Premium Dates & Herbs', 'dates-herbs', 'spa');
        insertCat.run('cat_oils', null, 'الزيوت والمنتجات الغذائية المصنعة', 'Oils & Processed Foods', 'oils-processed', 'oil_barrel');
        insertCat.run('cat_textiles', null, 'المواد الخام والمنسوجات', 'Raw Materials & Textiles', 'raw-materials', 'inventory_2');

        // Subcategories
        insertCat.run('sub_valencia', 'cat_citrus', 'برتقال فالنسيا وبصري مصري', 'Valencia & Navel Oranges', 'valencia-navel', 'circle');
        insertCat.run('sub_lemon', 'cat_citrus', 'ليمون يوريكا وبنزهير', 'Eureka & Key Limes', 'lemons', 'circle');
        insertCat.run('sub_mandarin', 'cat_citrus', 'يوسفي كليمنتين وموركوت', 'Clementine & Murcott', 'mandarins', 'circle');

        insertCat.run('sub_strawberry_iqf', 'cat_iqf', 'فراولة مجمدة صنف فستيفال وفورتونا', 'IQF Strawberries', 'iqf-strawberries', 'circle');
        insertCat.run('sub_pomegranate_iqf', 'cat_iqf', 'حبات رمان وندر فول مجمدة', 'IQF Pomegranate Arils', 'iqf-pomegranate', 'circle');

        insertCat.run('sub_onions', 'cat_tubers', 'بصل أحمر وذهبي جاف', 'Red & Golden Onions', 'dry-onions', 'circle');
        insertCat.run('sub_potatoes', 'cat_tubers', 'بطاطس تصديرية عروة شتوية', 'Export Potatoes', 'export-potatoes', 'circle');

        insertCat.run('sub_medjool', 'cat_dates', 'تمر مجدول وسيوى عضوي', 'Organic Medjool & Siwi', 'medjool-dates', 'circle');
        console.log('Seeded Categories.');
    }

    // 5. Seed Initial Approved/Published Products from ZARSEV Catalog
    const checkProds = db.prepare('SELECT COUNT(*) as count FROM products').get();
    if (checkProds.count === 0) {
        const insertProd = db.prepare(`
            INSERT INTO products (
                id, manufacturer_id, category_id, subcategory_id, sku, name_ar, name_en,
                description_ar, description_en, specifications, packaging_info, country_of_origin,
                price, currency, price_unit, moq, available_quantity, status, is_demo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);

        const insertImg = db.prepare(`
            INSERT INTO product_images (id, product_id, url, thumbnail_url, is_primary, display_order)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        // Product 1: Valencia Oranges (Direct Contract)
        insertProd.run(
            'prod_valencia_01',
            'mfg_bustan_citrus',
            'cat_citrus',
            'sub_valencia',
            'EG-CIT-01',
            'برتقال فالنسيا وبصري مصري ممتاز (Grade A)',
            'Premium Egyptian Valencia Oranges',
            'ثمار منتقاة يدوياً بأعلى نسبة عصارة تتجاوز 48% ولون مميز. معالجة بغسيل وتشميع نباتي معقم لتلبية الشروط الأوروبية واليابانية والخليجية.',
            'Hand-selected Valencia oranges with juice content exceeding 48%, Brix 12.5, sorted optically.',
            JSON.stringify({
                calibers: '48, 56, 64, 72, 80, 88, 100',
                brix: '12.5° Brix',
                juice_content: '48%+',
                storage_temp: '+3°C to +5°C (Humidity 90%)',
                certifications: 'Global G.A.P., ISO 22000, BRCGS'
            }),
            'كرتون تلسكوبي مقوى 15 كجم أو Open Top 10 كجم (Palletized 80 cartons/pallet)',
            'مصر',
            750.00,
            'USD',
            'MT',
            '1 Reefer Container (24 MT)',
            '2500 MT',
            'PUBLISHED'
        );

        insertImg.run(
            'img_valencia_01',
            'prod_valencia_01',
            'https://lh3.googleusercontent.com/aida-public/AB6AXuBwRYRzgiNdrlCQnU3LUL2eJYSgoKYtc6NdQSxOS3T3vs7C0VfY2aLl9fwDpZATDnE4iW-JOzwRWGGg4ibdVIhlMFH_9A4Z0uEhFRw1NIjg8djz4uomTpwgfbAUcnyp-yS9YtOa_-n1KYaW64kMZeGBep2fDURDFyMBSwwQdESyyjvItwku-esF71rp9GlwzQkIQP9nORMN3jH9pvvCB3ieEmwkRMUzYh9DISqSTrQ',
            'https://lh3.googleusercontent.com/aida-public/AB6AXuDsXzdFy0_5wbzNVENk4agQVieNKCvQo9ZDbOoEH6H-nizK6ROJwWs2-9DdeCZlcJhcBV5g7ZTiRC-ZK826Y2qT9GZMBtNxOEDwmIT9Gz1hCZUGniIrmjcOguztohBhOvW6sA4CsnoY9zE8UqWS9Ee7YMUR_lHAUejYekL_oVMrV09Z9EfxvPhfI1JYUPy7oBTcSdaLbW3UN6cJrO2mmO2dDA3MeF70ehezlnzoW1k',
            1,
            1
        );

        // Product 2: IQF Strawberries (Marketing Subscription)
        insertProd.run(
            'prod_iqf_straw_02',
            'mfg_delta_iqf',
            'cat_iqf',
            'sub_strawberry_iqf',
            'EG-FRZ-04',
            'الفراولة المجمدة والرمان السريع IQF',
            'Frozen IQF Strawberries & Pomegranate',
            'تجميد فردي فائق السرعة خلال ساعات من الحصاد للحفاظ على القوام والنكهة الطبيعية. خلو تام من المتبقيات ومعتمدة لكبرى سلاسل الصناعات الغذائية.',
            'Individually quick frozen strawberries, zero MRLs residue, mechanical purity 99.5%.',
            JSON.stringify({
                purity: '99.5%',
                freezing_type: 'IQF Individual Quick Frozen',
                storage_temp: '-18°C or below',
                shelf_life: '24 Months'
            }),
            'أكياس بولي إيثيلين 10 كجم كرتون / جامبو 500 كجم',
            'مصر',
            1150.00,
            'EUR',
            'MT',
            '2 Reefer Containers (44 MT)',
            '1200 MT',
            'PUBLISHED'
        );

        insertImg.run(
            'img_iqf_straw_02',
            'prod_iqf_straw_02',
            'https://lh3.googleusercontent.com/aida-public/AB6AXuBje-sJkKEbL61PncaHJhLfvUfZUKD_9-B5KDHSFuT70gUjft79EzqKQh7rdZGfU9sTRSX6uJZdkIRP3bbbGDhN8FFExxIHeGeOzBmRE6Godeyo3qSBTLL7RhNO51M8nyU_IC_9Tr_YF2Al2XP1ynvkeqaGsMCmqqoQ7JHNduodsA6GiCi3IYi-wGujDhnF2ydDBHjbAoXj8Po7MG0IURnowVeMsHtNWakKy7-3JCc',
            null,
            1,
            1
        );

        // Product 3: Golden & Red Onions (Marketing Subscription)
        insertProd.run(
            'prod_onions_03',
            'mfg_nile_fruits',
            'cat_tubers',
            'sub_onions',
            'EG-VEG-09',
            'البصل الذهبي والأحمر والبطاطس العروة التصديرية',
            'Export Red and Golden Dry Onions',
            'بصل جاف ذو قشرة صلبة للشحن البعيد معالج ضد العفن الرمادي، وبطاطس شتوية خالية من العفن البني مخصصة للتصنيع والشحن الطازج.',
            'Golden and Red dry onions, cured outer skin, brown rot free certification.',
            JSON.stringify({
                calibers: '40-60mm, 50-70mm, 60-80mm',
                humidity: 'Max 14%',
                storage_temp: '+8°C to +10°C (Well ventilated)'
            }),
            'أكياس شبك Lenobags 10 و 25 كجم أو Jumbo 1.25 طن',
            'مصر',
            420.00,
            'USD',
            'MT',
            '1 Container (26 MT)',
            '3000 MT',
            'PUBLISHED'
        );

        console.log('Seeded Products.');
    }
}

if (require.main === module) {
    seedDatabase();
    console.log('ZARSEV Database initialization and seeding completed successfully!');
}

module.exports = { seedDatabase };
