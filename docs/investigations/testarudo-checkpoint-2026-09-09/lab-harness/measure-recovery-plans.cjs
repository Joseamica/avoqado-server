// Temporary benchmark. Owned local DB only; the entire synthetic dataset rolls back.
const { createRequire } = require('module');
const req = createRequire(process.cwd() + '/package.json');
const { PrismaClient, Prisma } = req('@prisma/client');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/codex_testarudo_test_20260909') throw Error('Owned local database required');
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const prefix = 'plan-' + require('crypto').randomUUID();
const count = 100000;
const started = Date.now();
function progress(label) { process.stderr.write(label + ' after ' + Math.round((Date.now() - started)/1000) + 's\n'); }
const output = [];
const rollback = new Error('BENCHMARK_ROLLBACK');
async function explain(tx, name, sql) {
  const rows = await tx.$queryRaw(sql);
  const plan = rows[0]['QUERY PLAN'][0];
  output.push({ name, plan });
}
(async () => {
  try {
    await db.$transaction(async tx => {
      await tx.organization.create({ data: { id: prefix, name: prefix, email: prefix + '@example.test', phone: '5500000000' } });
      await tx.venue.create({ data: { id: prefix, organizationId: prefix, name: prefix, slug: prefix } });
      const order = await tx.order.create({ data: { venueId: prefix, orderNumber: prefix, subtotal: 100, taxAmount: 0, total: 100 } });
      const payment = await tx.payment.create({ data: { venueId: prefix, orderId: order.id, amount: 100, feePercentage: 0, feeAmount: 0, netAmount: 100, tipAmount: 0, method: 'CREDIT_CARD', status: 'COMPLETED', source: 'TPV', splitType: 'FULLPAYMENT' } });
      const request = await tx.terminalPaymentRequest.create({ data: { venueId: prefix, orderId: order.id, requestId: prefix, terminalId: prefix, status: 'COMPLETED', amountCents: 10000, expiresAt: new Date() } });
      const effect = await tx.paymentEffect.create({ data: { venueId: prefix, paymentId: payment.id, orderId: order.id, kind: 'REVIEW', dedupeKey: prefix, payload: { rating: 5 }, status: 'PENDING', nextAttemptAt: new Date(Date.now() - 3600000) } });
      await tx.$executeRaw(Prisma.sql`INSERT INTO "Order" SELECT cloned.* FROM "Order" o CROSS JOIN generate_series(1, ${count}) g CROSS JOIN LATERAL jsonb_populate_record(NULL::"Order", to_jsonb(o) || jsonb_build_object('id', ${prefix} || '-order-' || g, 'orderNumber', ${prefix} || '-order-' || g)) AS cloned WHERE o.id = ${order.id}`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO "Payment" SELECT cloned.* FROM "Payment" p CROSS JOIN generate_series(1, ${count}) g CROSS JOIN LATERAL jsonb_populate_record(NULL::"Payment", to_jsonb(p) || jsonb_build_object('id', ${prefix} || '-payment-' || g, 'orderId', ${prefix} || '-order-' || g, 'processorData', jsonb_build_object('terminalPaymentRequestId', ${prefix} || '-request-' || g))) AS cloned WHERE p.id = ${payment.id}`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO "TerminalPaymentRequest" SELECT cloned.* FROM "TerminalPaymentRequest" r CROSS JOIN generate_series(1, ${count}) g CROSS JOIN LATERAL jsonb_populate_record(NULL::"TerminalPaymentRequest", to_jsonb(r) || jsonb_build_object('id', ${prefix} || '-request-' || g, 'requestId', ${prefix} || '-request-' || g, 'orderId', ${prefix} || '-order-' || g, 'terminalId', ${prefix} || '-terminal-' || g, 'status', CASE WHEN g % 1000 = 0 THEN 'UNKNOWN' ELSE 'COMPLETED' END)) AS cloned WHERE r.id = ${request.id}`);
      await tx.$executeRaw(Prisma.sql`INSERT INTO "PaymentEffect" SELECT cloned.* FROM "PaymentEffect" e CROSS JOIN generate_series(1, ${count}) g CROSS JOIN LATERAL jsonb_populate_record(NULL::"PaymentEffect", to_jsonb(e) || jsonb_build_object('id', ${prefix} || '-effect-' || g, 'dedupeKey', ${prefix} || '-effect-' || g, 'paymentId', ${prefix} || '-payment-' || g, 'orderId', ${prefix} || '-order-' || g, 'status', CASE WHEN g % 10 = 0 THEN 'PENDING' ELSE 'DONE' END)) AS cloned WHERE e.id = ${effect.id}`);
      progress('Synthetic rows inserted');
      for (const table of ['Order', 'Payment', 'TerminalPaymentRequest', 'PaymentEffect']) await tx.$executeRawUnsafe('ANALYZE "' + table + '"');
      await explain(tx, 'exact-request-payment', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM "Payment" WHERE "venueId" = ${prefix} AND "processorData" #> ARRAY['terminalPaymentRequestId'] = ${JSON.stringify(prefix + '-request-50000')}::jsonb AND status = 'COMPLETED' AND method IN ('CREDIT_CARD', 'DEBIT_CARD') ORDER BY "createdAt" DESC, id DESC LIMIT 1`);
      await explain(tx, 'same-order-unresolved-guard', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM "TerminalPaymentRequest" WHERE "venueId" = ${prefix} AND "orderId" = ${prefix + '-order-50000'} AND (status IN ('PENDING', 'SENT', 'CANCEL_REQUESTED', 'UNKNOWN', 'TIMED_OUT') OR (status = 'FAILED' AND "failureCode" IN ('ACK_TIMEOUT', 'ACK_REJECTED', 'TPV_ERROR')) OR (status = 'CANCELLED' AND ("cancelDisposition" IS NULL OR "cancelDisposition" <> 'ACCEPTED'))) ORDER BY "createdAt" DESC, id DESC LIMIT 1`);
      await explain(tx, 'operator-pending-page', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id, "paymentId", status, attempts FROM "PaymentEffect" WHERE "venueId" = ${prefix} AND status = 'PENDING' ORDER BY "createdAt" DESC, id DESC LIMIT 101`);
      const candidates = Array.from({ length: 100 }, (_, i) => prefix + '-terminal-' + ((i + 1) * 1000));
      await explain(tx, 'picker-live-candidates', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT \"terminalId\" FROM \"TerminalPaymentRequest\" WHERE \"venueId\" = ${prefix} AND \"terminalId\" IN (${Prisma.join(candidates)}) AND (status IN ('PENDING', 'SENT', 'CANCEL_REQUESTED', 'UNKNOWN', 'TIMED_OUT') OR (status = 'FAILED' AND \"failureCode\" IN ('ACK_TIMEOUT', 'ACK_REJECTED', 'TPV_ERROR')) OR (status = 'CANCELLED' AND (\"cancelDisposition\" IS NULL OR \"cancelDisposition\" <> 'ACCEPTED'))) GROUP BY \"terminalId\" ORDER BY \"terminalId\" LIMIT 100`);
      await explain(tx, 'historical-payment-owner', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM "TerminalPaymentRequest" WHERE "paymentId" = ${payment.id} AND "requestId" <> ${prefix} LIMIT 1`);
      await explain(tx, 'recovery-cursor-page', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id, "requestId" FROM "TerminalPaymentRequest" WHERE status = 'UNKNOWN' ORDER BY "createdAt", id LIMIT 200`);
      await explain(tx, 'operator-pending-total', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*) FROM "PaymentEffect" WHERE "venueId" = ${prefix} AND status = 'PENDING'`);
      await explain(tx, 'outbox-claim-selection', Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM "PaymentEffect" WHERE (status = 'PENDING' AND "nextAttemptAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) OR (status = 'PROCESSING' AND "leaseUntil" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) ORDER BY "nextAttemptAt", id LIMIT 25 FOR UPDATE SKIP LOCKED`);
      throw rollback;
    }, { timeout: 900000, maxWait: 60000 });
  } catch (e) { if (e !== rollback) throw e; }
  process.stdout.write(JSON.stringify({ syntheticRowsPerTable: count, rolledBack: true, findings: output }, null, 2) + '\n');
})().finally(() => db.$disconnect()).catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
