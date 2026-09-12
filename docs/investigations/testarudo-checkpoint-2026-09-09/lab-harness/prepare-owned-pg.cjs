const {createRequire} = require('module');
const fs = require('fs');
const req = createRequire(process.cwd() + '/package.json');
const {Client} = req('pg');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/codex_testarudo_test_20260909') throw Error('Not the owned local test database');
(async () => {
  const db = new Client({connectionString: url.toString()});
  await db.connect();
  try {
    await db.query('BEGIN');
    for (const [name, file] of [
      ['PaymentEffect', 'prisma/migrations/20260909210000_payment_effects_outbox/migration.sql'],
      ['TerminalPaymentRequest_sale_recovery_idx', 'prisma/migrations/20260909213000_terminal_payment_recovery_indexes/migration.sql'],
      ['PaymentEffect_orderId_kind_status_idx', 'prisma/migrations/20260909220000_payment_effect_lookup_indexes/migration.sql'],
      ['TerminalPaymentRequest_payment_owner_idx', 'prisma/migrations/20260909223000_terminal_recovery_attribution_cursor/migration.sql'],
    ]) {
      const exists = await db.query('SELECT to_regclass($1) AS name', ['"' + name + '"']);
      if (!exists.rows[0].name) await db.query(fs.readFileSync(file, 'utf8'));
    }
    await db.query('COMMIT');
    process.stdout.write('Owned local PostgreSQL schema prepared.\n');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { await db.end(); }
})().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
