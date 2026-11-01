const app = require('./app');
const config = require('./config');
const { initDb } = require('./db/database');
const { seedDatabase } = require('./db/seed');

// Initialize database
initDb();
seedDatabase();

const server = app.listen(config.PORT, () => {
    console.log(`=======================================================`);
    console.log(`⚓ ZARSEV Global Trade Platform & Smart Importer Active`);
    console.log(`🌐 Server running at: http://localhost:${config.PORT}`);
    console.log(`📦 Smart Importer Landing: http://localhost:${config.PORT}/importer`);
    console.log(`=======================================================`);
});

module.exports = server;
