const { Client } = require('M:/ZZZ/node_modules/pg');
const fs = require('fs');
const path = require('path');

const PORT = 5433;

async function initDisposableDb() {
  const adminClient = new Client({
    host: 'localhost',
    port: PORT,
    user: 'postgres',
    database: 'postgres'
  });

  await adminClient.connect();
  console.log('Connected to disposable PG on 5433 as postgres');

  // Create roles
  await adminClient.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zarsev_migrator') THEN
        CREATE ROLE zarsev_migrator WITH LOGIN PASSWORD 'bYhdH0mBrT8yLEP_3_0dXvJlS_8GNv9v';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zarsev_app') THEN
        CREATE ROLE zarsev_app WITH LOGIN PASSWORD 'RB5UlbM6PnFiYHgdud48ZDpSTtzUUJxN';
      END IF;
    END $$;
  `);

  // Drop and recreate test database on 5433
  await adminClient.query('DROP DATABASE IF EXISTS zarsev_test');
  await adminClient.query('CREATE DATABASE zarsev_test OWNER zarsev_migrator');
  await adminClient.query('GRANT ALL PRIVILEGES ON DATABASE zarsev_test TO zarsev_migrator');
  await adminClient.query('GRANT ALL PRIVILEGES ON DATABASE zarsev_test TO zarsev_app');
  await adminClient.end();
  console.log('Created database zarsev_test on port 5433');

  // Connect as migrator to zarsev_test on 5433
  const migratorClient = new Client({
    host: 'localhost',
    port: PORT,
    user: 'zarsev_migrator',
    password: 'bYhdH0mBrT8yLEP_3_0dXvJlS_8GNv9v',
    database: 'zarsev_test'
  });

  await migratorClient.connect();
  console.log('Connected to zarsev_test on 5433 as zarsev_migrator');

  // Grant schema permissions to zarsev_app
  await migratorClient.query('GRANT ALL ON SCHEMA public TO zarsev_app');
  await migratorClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO zarsev_app');
  await migratorClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO zarsev_app');

  // Apply baseline migrations 001 to 005
  const migrations = [
    '001_initial_schema.sql',
    '002_zarsev_core_foundation.sql',
    '003_buyer_rfq_and_inquiry_system.sql',
    '004_structured_commercial_quotations.sql',
    '005_buyer_token_hash_storage.sql'
  ];

  for (const m of migrations) {
    const filePath = path.resolve('M:/ZZZ/src/db/migrations/pg', m);
    if (fs.existsSync(filePath)) {
      const sql = fs.readFileSync(filePath, 'utf8');
      await migratorClient.query(sql);
      console.log(`Applied baseline migration: ${m}`);
    } else {
      console.log(`Migration file not found: ${m}`);
    }
  }

  // Verify baseline tables
  const res = await migratorClient.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `);
  console.log('Tables created on disposable zarsev_test:', res.rows.map(r => r.table_name));

  await migratorClient.end();
}

initDisposableDb().catch(err => {
  console.error('initDisposableDb error:', err);
  process.exit(1);
});
