const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');

const authRoutes = require('./routes/authRoutes');
const manufacturerRoutes = require('./routes/manufacturerRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const importRoutes = require('./routes/importRoutes');
const approvalRoutes = require('./routes/approvalRoutes');
const productRoutes = require('./routes/productRoutes');

const app = express();

// Global Middleware
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static asset serving
app.use('/storage', express.static(config.STORAGE_DIR));
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

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
app.use('/api/manufacturers', manufacturerRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/products', productRoutes);

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

// Main portal route (redirects or serves home)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_1', 'code.html'));
});

app.get('/catalog', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'zarsev_2', 'code.html'));
});

module.exports = app;
