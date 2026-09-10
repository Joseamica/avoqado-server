const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { randomUUID, createHash } = require('crypto')
const dependency = name => require(path.join(process.cwd(), 'node_modules', name))
const { Prisma, PrismaClient, TerminalPaymentRequestStatus, TransactionStatus, PaymentMethod } = dependency('@prisma/client')
const ts = dependency('typescript')
const config = dependency('dotenv').parse(fs.readFileSync('/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.env'))
const url = new URL(config.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('LOCAL_DB_REQUIRED')
url.pathname = '/codex_testarudo_test_20260909'
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
const source = fs.readFileSync('src/services/terminal-payment.service.ts', 'utf8')
const start = source.indexOf('  async closeRowFromPaymentTx(')
const end = source.indexOf('\n  /**\n   * True when the order', start)
const helperStart = source.indexOf('function contratoDescuadrado(')
const helperEnd = source.indexOf('\n/**\n * La MARCA', helperStart)
if ([start, end, helperStart, helperEnd].some(n => n < 0)) throw new Error('SOURCE_BOUNDARY_CHANGED')
const isolated = source.slice(helperStart, helperEnd) + '\nclass Probe {' + source.slice(start, end) + '} globalThis.Probe = Probe;'
const code = ts.transpileModule(isolated, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
const capturedErrors = []
const context = {
  TerminalPaymentRequestStatus, TransactionStatus, PaymentMethod,
  IN_FLIGHT: ['PENDING', 'SENT', 'CANCEL_REQUESTED'],
  normalizeTerminalId: value => value.replace(/^AVQD-/i, '').toLowerCase(),
  logger: { error: (...args) => capturedErrors.push(args[0]) },
}
vm.createContext(context)
vm.runInContext(code, context)
const fixture = 'codex-audit-rest-' + randomUUID()
const rollback = new Error('OWNED_FIXTURE_ROLLBACK')
const results = []
async function main() {
  for (const origin of ['REST', 'SOCKET']) {
    try {
      await db.$transaction(async tx => {
        const org = await tx.organization.create({ data: { id: fixture, name: fixture, email: fixture + '@example.test', phone: '5500000000' } })
        const venue = await tx.venue.create({ data: { id: fixture, organizationId: org.id, name: fixture, slug: fixture } })
        const order = await tx.order.create({ data: { venueId: venue.id, orderNumber: fixture, subtotal: 100, taxAmount: 0, total: 100 } })
        const terminalB = await tx.terminal.create({ data: { venueId: venue.id, name: 'synthetic B', serialNumber: fixture + '-B', type: 'TPV_ANDROID' } })
        const request = await tx.terminalPaymentRequest.create({ data: { requestId: randomUUID(), venueId: venue.id, orderId: order.id, terminalId: fixture + '-A', amountCents: 10000, tipCents: 0, status: 'SENT', expiresAt: new Date(Date.now() + 60000) } })
        const payment = await tx.payment.create({ data: { venueId: venue.id, orderId: order.id, terminalId: terminalB.id, source: 'TPV', amount: 100, tipAmount: 0, method: 'CREDIT_CARD', status: 'COMPLETED', feePercentage: 0, feeAmount: 0, netAmount: 100, processorData: { terminalPaymentRequestId: request.requestId } } })
        await new context.Probe().closeRowFromPaymentTx(tx, request.requestId, payment.id, venue.id, undefined, origin)
        const result = await tx.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } })
        results.push({ origin, state: result.status, linkedToOtherTerminalPayment: result.paymentId === payment.id })
        throw rollback
      }, { timeout: 20000 })
    } catch (error) { if (error !== rollback) throw error }
  }
  const leftover = await db.organization.count({ where: { id: fixture } })
  console.log(JSON.stringify({ methodSourceSha256: createHash('sha256').update(source).digest('hex'), database: 'owned local PostgreSQL', results, fixtureOrganizationsRemaining: leftover, caughtMethodErrors: capturedErrors }, null, 2))
  if (leftover !== 0 || capturedErrors.length !== 0) throw new Error('PROBE_INCONCLUSIVE')
  if (results[0].state !== 'COMPLETED' || !results[0].linkedToOtherTerminalPayment || results[1].state !== 'SENT') throw new Error('REPRODUCTION_CHANGED')
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1 }).finally(() => db.$disconnect())
