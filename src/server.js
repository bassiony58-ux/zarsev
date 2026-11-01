const app = require('./app');
const config = require('./config');
const { initDb } = require('./db/database');
const { seedDatabase } = require('./db/seed');

// Initialize database
initDb();

if (config.NODE_ENV === 'production') {
    console.log('🔒 Production mode: Demo seeding is strictly disabled.');
} else if (config.ENABLE_DEMO_SEED) {
    console.log('🌱 Development mode: Executing demo seeding (ENABLE_DEMO_SEED=true)...');
    seedDatabase();
} else {
    console.log('ℹ️ Demo seeding skipped (set ENABLE_DEMO_SEED=true in development to seed demo data).');
}

const server = app.listen(config.PORT, () => {
    console.log(`=======================================================`);
    console.log(`⚓ ZARSEV Global Trade Platform & Smart Importer Active`);
    console.log(`🌐 Server running at: http://localhost:${config.PORT}`);
    console.log(`📦 Smart Importer Landing: http://localhost:${config.PORT}/importer`);
    console.log(`=======================================================`);
});

module.exports = server;
