#!/usr/bin/env node
/**
 * ZARSEV Sovereign Platform — Initial Super Admin Provisioning Tool
 *
 * PURPOSE:
 * Secure, operator-only CLI tool to provision the root Super Administrator account
 * on fresh production or staging deployments where demo seeding is disabled.
 *
 * SECURITY ENFORCEMENTS:
 * 1. CLI Execution Only: Never accessible over HTTP endpoints.
 * 2. Password Strength Validation: Enforces minimum 10 characters, upper, lower, digit, symbol.
 * 3. Modern PBKDF2 Hashing: Hashes credentials with 210,000 iterations of SHA-512.
 * 4. Zero Hardcoded Credentials: No default passwords or fallbacks.
 * 5. Single Root Admin Invariant: Refuses to run if a non-demo Super Admin already exists (unless --force).
 * 6. Production Safety: Explicitly sets is_demo=0, is_active=1.
 * 7. Transaction Integrity: Uses atomic SQLite transactions.
 * 8. Log Hygiene: Passwords and raw hashes are never logged or echoed to terminal.
 *
 * USAGE:
 * Interactive:
 *   node scripts/createAdmin.js
 * Non-Interactive (Automation / CI):
 *   node scripts/createAdmin.js --email admin@company.com --name "Platform Owner" --password "SecureSecret123!"
 */

const readline = require('readline');
const crypto = require('crypto');
const { initDb, getDb } = require('../src/db/database');
const { hashPassword } = require('../src/utils/authUtils');

// Validate RFC 5322 compatible email format
function validateEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    return emailRegex.test(email.trim());
}

// Validate password complexity requirements
function validatePasswordStrength(password) {
    if (!password || typeof password !== 'string') {
        return { valid: false, error: 'كلمة المرور مطلوبة ولا يمكن أن تكون فارغة.' };
    }
    if (password.length < 10) {
        return { valid: false, error: 'كلمة المرور يجب أن لا تقل عن 10 خانات.' };
    }
    if (!/[A-Z]/.test(password)) {
        return { valid: false, error: 'يجب أن تحتوي كلمة المرور على حرف كبير واحد على الأقل (A-Z).' };
    }
    if (!/[a-z]/.test(password)) {
        return { valid: false, error: 'يجب أن تحتوي كلمة المرور على حرف صغير واحد على الأقل (a-z).' };
    }
    if (!/[0-9]/.test(password)) {
        return { valid: false, error: 'يجب أن تحتوي كلمة المرور على رقم واحد على الأقل (0-9).' };
    }
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
        return { valid: false, error: 'يجب أن تحتوي كلمة المرور على رمز خاص واحد على الأقل (!@#$%...).' };
    }
    return { valid: true };
}

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].substring(2);
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                parsed[key] = args[i + 1];
                i++;
            } else {
                parsed[key] = true;
            }
        }
    }
    return parsed;
}

// Hidden input prompter using readline
function promptHidden(query) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        // Mute terminal output while typing sensitive password
        let muted = false;
        const oldWrite = rl._writeToOutput;
        rl._writeToOutput = function(stringToWrite) {
            if (muted) {
                rl.output.write('*');
            } else {
                oldWrite.call(rl, stringToWrite);
            }
        };

        rl.question(query, (val) => {
            rl.close();
            console.log(''); // New line after enter
            resolve(val);
        });

        muted = true;
    });
}

function promptText(query) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(query, (val) => {
            rl.close();
            resolve(val.trim());
        });
    });
}

async function main() {
    console.log('================================================================');
    console.log('⚓ ZARSEV Sovereign Platform — Root Super Admin Provisioning Tool');
    console.log('================================================================\n');

    initDb();
    const db = getDb();
    const cliArgs = parseArgs();

    // Invariant Check: Verify whether a real non-demo Super Admin already exists
    const existingAdmin = db.prepare(`
        SELECT id, name, email, created_at 
        FROM users 
        WHERE role = 'SUPER_ADMIN' AND is_demo = 0
    `).get();

    if (existingAdmin && !cliArgs.force) {
        console.error('❌ [PROVISIONING REFUSED]: A real production Super Admin account already exists in this database.');
        console.error(`   Administrator: ${existingAdmin.name} (${existingAdmin.email})`);
        console.error(`   Created at:    ${existingAdmin.created_at}`);
        console.error('\n   To provision an additional administrator, log in with existing credentials');
        console.error('   or pass the explicit flag --force if authorized by platform leadership.');
        process.exit(1);
    }

    // Acquire input (CLI args or interactive prompt)
    let email = cliArgs.email || process.env.ADMIN_EMAIL;
    let name = cliArgs.name || process.env.ADMIN_NAME;
    let password = cliArgs.password || process.env.ADMIN_PASSWORD;

    if (!email) {
        email = await promptText('Enter Super Admin Email: ');
    }
    if (!name) {
        name = await promptText('Enter Super Admin Full Name (Default: المدير العام): ') || 'المدير العام';
    }
    if (!password) {
        password = await promptHidden('Enter Secure Password: ');
        const confirmPassword = await promptHidden('Confirm Secure Password: ');
        if (password !== confirmPassword) {
            console.error('\n❌ [ERROR]: Password confirmation does not match.');
            process.exit(1);
        }
    }

    // Validate email
    if (!validateEmail(email)) {
        console.error('\n❌ [VALIDATION ERROR]: Invalid email address format.');
        process.exit(1);
    }

    // Validate password strength
    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
        console.error(`\n❌ [PASSWORD COMPLEXITY ERROR]: ${strength.error}`);
        process.exit(1);
    }

    // Check if email is already taken by any user
    const existingEmail = db.prepare('SELECT id, role FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (existingEmail && !cliArgs.force) {
        console.error(`\n❌ [ERROR]: A user account with email "${email}" already exists (Role: ${existingEmail.role}).`);
        process.exit(1);
    }

    // Generate PBKDF2 hash (210,000 iterations)
    console.log('\n🔒 Cryptographically hashing administrator password (PBKDF2-HMAC-SHA512 @ 210,000 iterations)...');
    const passwordHash = hashPassword(password);
    const userId = 'usr_admin_' + crypto.randomBytes(5).toString('hex');

    // Execute atomic transaction
    db.exec('BEGIN TRANSACTION;');
    try {
        if (existingEmail && cliArgs.force) {
            db.prepare(`
                UPDATE users 
                SET name = ?, password_hash = ?, role = 'SUPER_ADMIN', is_active = 1, is_demo = 0
                WHERE id = ?
            `).run(name, passwordHash, existingEmail.id);
            console.log(`✓ Existing user updated to Super Admin.`);
        } else {
            db.prepare(`
                INSERT INTO users (id, name, email, password_hash, role, manufacturer_id, is_active, is_demo)
                VALUES (?, ?, ?, ?, 'SUPER_ADMIN', NULL, 1, 0)
            `).run(userId, name, email.trim().toLowerCase(), passwordHash);
        }

        db.exec('COMMIT;');
        console.log('\n================================================================');
        console.log('✅ Super Administrator Account Successfully Provisioned!');
        console.log(`   User ID:     ${existingEmail ? existingEmail.id : userId}`);
        console.log(`   Name:        ${name}`);
        console.log(`   Email:       ${email.trim().toLowerCase()}`);
        console.log(`   Role:        SUPER_ADMIN`);
        console.log(`   Status:      ACTIVE (is_demo=0, is_active=1)`);
        console.log('================================================================');
        console.log('ℹ️  You may now log in securely via POST /api/auth/login or web interface.\n');
    } catch (err) {
        db.exec('ROLLBACK;');
        console.error('❌ [DATABASE TRANSACTION ERROR]: Failed to provision administrator account:', err.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal Provisioning Error:', err);
        process.exit(1);
    });
}

module.exports = {
    validateEmail,
    validatePasswordStrength,
    main
};
