const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const { csrfProtection } = require('./middlewares/csrfProtection');

const authRoutes = require('./routes/authRoutes');
const manufacturerRoutes = require('./routes/manufacturerRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const importRoutes = require('./routes/importRoutes');
const approvalRoutes = require('./routes/approvalRoutes');
const productRoutes = require('./routes/productRoutes');
const rfqRoutes = require('./routes/rfqRoutes');
const quotationRoutes = require('./routes/quotationRoutes');
const staffRoutes = require('./routes/staffRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const auditRoutes = require('./routes/auditRoutes');
const contractRoutes = require('./routes/contractRoutes');
const productionRoutes = require('./routes/productionRoutes');
const qualityRoutes = require('./routes/qualityRoutes');
const shippingRoutes = require('./routes/shippingRoutes');
const settlementRoutes = require('./routes/settlementRoutes');
const buyerPortalRoutes = require('./routes/buyerPortalRoutes');

const app = express();

// Global Middleware (SEC-08: Restrictive CORS policy)
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        const lower = origin.toLowerCase();
        if (config.ALLOWED_ORIGINS.includes(lower)) {
            return callback(null, true);
        }
        return callback(new Error('CORS origin denied by security policy'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-buyer-token']
}));
app.use(cookieParser());

// Telemetry Ingress Isolation Guard (DEF-02, DEF-03)
const isTelemetryPath = (url) => typeof url === 'string' && url.includes('/telemetry');

// Global JSON and URL-encoded parser applies ONLY to non-telemetry routes
// Captures rawBody on all routes as safety fallback
app.use((req, res, next) => {
    if (isTelemetryPath(req.originalUrl || req.url)) {
        return next(); // Skips global 50mb parser completely!
    }
    express.json({
        limit: '50mb',
        verify: (req, res, buf) => {
            req.rawBody = buf;
        }
    })(req, res, (err) => {
        if (err) return next(err);
        express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
    });
});

// Exempt telemetry routes from browser cookie CSRF checks
app.use((req, res, next) => {
    if (isTelemetryPath(req.originalUrl || req.url)) {
        return next();
    }
    csrfProtection(req, res, next);
});

// Static asset serving
app.use('/storage', express.static(config.STORAGE_DIR));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve existing stitch screens directly
app.use('/existing/zarsev_1', express.static(path.join(__dirname, '..', 'zarsev_1')));
app.use('/existing/zarsev_2', express.static(path.join(__dirname, '..', 'zarsev_2')));
app.use('/existing/zarsev_3', express.static(path.join(__dirname, '..', 'zarsev_3')));
app.use('/existing/zarsev_4', express.static(path.join(__dirname, '..', 'zarsev_4')));
app.use('/existing/zarsev_5', express.static(path.join(__dirname, '..', 'zarsev_5')));
app.use('/existing/zarsev_6', express.static(path.join(__dirname, '..', 'zarsev_6')));
app.use('/existing/zarsev_7', express.static(path.join(__dirname, '..', 'zarsev_7')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/manufacturer', manufacturerRoutes);
app.use('/api/manufacturers', manufacturerRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/products', productRoutes);
app.use('/api/rfqs', rfqRoutes);
app.use('/api/quotations', quotationRoutes);
app.use('/api/admin/staff', staffRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin/audit-logs', auditRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/quality', qualityRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/settlement', settlementRoutes);
app.use('/api/buyer', buyerPortalRoutes);
app.use('/api/inquiries', (req, res, next) => {
    req.url = (req.url === '/all' || req.url === '/all/') ? '/inquiries/all' : '/inquiries';
    rfqRoutes(req, res, next);
});
app.use('/api/contact', (req, res, next) => {
    req.url = (req.url === '/all' || req.url === '/all/') ? '/inquiries/all' : '/inquiries';
    rfqRoutes(req, res, next);
});

// Importer UI Routes (Serving the 8 Required Screens)
const viewsDir = path.join(__dirname, '..', 'public', 'views');

// Screen 1: Smart Import landing page
app.get('/importer', (req, res) => {
    res.sendFile(path.join(viewsDir, 'landing.html'));
});

// Screen 2: Upload files and images screen
app.get('/importer/upload', (req, res) => {
    res.sendFile(path.join(viewsDir, 'upload.html'));
});

// Screen 3: Manufacturer selection screen
app.get('/importer/manufacturer-select', (req, res) => {
    res.sendFile(path.join(viewsDir, 'manufacturer-select.html'));
});

// Screen 4: Import processing/progress screen
app.get('/importer/progress/:id', (req, res) => {
    res.sendFile(path.join(viewsDir, 'progress.html'));
});

// Screen 5: Extracted products review screen
app.get('/importer/review/:id', (req, res) => {
    res.sendFile(path.join(viewsDir, 'review.html'));
});

// Screen 6: Bulk editing screen
app.get('/importer/bulk-edit/:id', (req, res) => {
    res.sendFile(path.join(viewsDir, 'bulk-edit.html'));
});

// Screen 7: Import history screen
app.get('/importer/history', (req, res) => {
    res.sendFile(path.join(viewsDir, 'history.html'));
});

// Screen 8: Failed imports and retry screen
app.get('/importer/failed/:id', (req, res) => {
    res.sendFile(path.join(viewsDir, 'failed-retry.html'));
});

// Approvals screen
app.get('/admin/approvals', (req, res) => {
    res.sendFile(path.join(viewsDir, 'approvals.html'));
});

// Role-Based Portals & Dashboards
app.get('/portal/manufacturer', (req, res) => {
    res.sendFile(path.join(viewsDir, 'portal-manufacturer.html'));
});
app.get('/portal/mfg', (req, res) => {
    res.sendFile(path.join(viewsDir, 'portal-manufacturer.html'));
});

app.get('/portal/admin', (req, res) => {
    res.sendFile(path.join(viewsDir, 'portal-admin.html'));
});

app.get('/portal/logistics', (req, res) => {
    res.sendFile(path.join(viewsDir, 'portal-logistics.html'));
});

app.get('/portal/buyer', (req, res) => {
    res.sendFile(path.join(viewsDir, 'portal-buyer.html'));
});

app.get('/help', (req, res) => {
    res.sendFile(path.join(viewsDir, 'help.html'));
});

// Main portal route (redirects or serves home)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_1', 'code.html'));
});

app.get('/catalog', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_2', 'code.html'));
});

// Semantic portal routes for editorial & spec pages
app.get('/services', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_3', 'code.html'));
});

app.get('/product-details', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_4', 'code.html'));
});

app.get('/consulting', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_5', 'code.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_6', 'code.html'));
});

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_7', 'code.html'));
});

// Centralized Error Sanitization Middleware (SEC-10)
app.use((err, req, res, next) => {
    if (err.message === 'CORS origin denied by security policy') {
        return res.status(403).json({ success: false, error: 'غير مصرح بالوصول عبر هذا المصدر (CORS Denied)' });
    }
    console.error('[Unhandled App Error]', err);
    const isProd = config.NODE_ENV === 'production';
    res.status(err.status || 500).json({
        success: false,
        error: isProd ? 'حدث خطأ داخلي في الخادم' : (err.message || 'حدث خطأ داخلي في الخادم')
    });
});

module.exports = app;
