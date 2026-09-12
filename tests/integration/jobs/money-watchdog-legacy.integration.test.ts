import '../../__helpers__/integration-setup'
import { Client } from 'pg'
import { buildWatchdogSql } from '@/jobs/money-integrity-watchdog.job'

// Execute the production SQL against session-local tables. No shared fixtures or public
// tables are changed, and rollback drops everything even when an assertion fails.
const tables = {
  Organization: 'id text, name text',
  Venue: 'id text, name text, slug text, "organizationId" text',
  Order: `id text, "venueId" text, "orderNumber" text, source text, "originSystem" text,
    status text, "paymentStatus" text, subtotal numeric, "discountAmount" numeric,
    "serviceChargeAmount" numeric, "taxAmount" numeric, "tipAmount" numeric,
    total numeric, "paidAmount" numeric, "createdAt" timestamp, "updatedAt" timestamp, "completedAt" timestamp`,
  Payment: '"orderId" text, "venueId" text, amount numeric, "tipAmount" numeric, status text, type text, "originSystem" text',
  OrderItem: 'id text, "orderId" text, "productId" text',
  Product: 'id text, "venueId" text, "trackInventory" boolean, "inventoryMethod" text',
  Recipe: '"productId" text',
  OrderItemModifier: '"orderItemId" text, "modifierId" text',
  Modifier: 'id text, "rawMaterialId" text, "quantityPerUnit" numeric',
  InventoryPosting: '"orderId" text, "venueId" text, "effectKind" text',
  Inventory: 'id text, "venueId" text',
  InventoryMovement: `"inventoryId" text, reference text, type text, quantity numeric,
    "previousStock" numeric, "newStock" numeric, "postingLineId" text, "createdAt" timestamp`,
  RawMaterialMovement: `"venueId" text, reference text, type text, quantity numeric,
    "previousStock" numeric, "newStock" numeric, "postingLineId" text, "createdAt" timestamp`,
}

const historical = 'VALE HISTÓRICO AUSENTE CON MOVIMIENTOS'
const missing = 'ORDEN SIN VALE DE INVENTARIO'
let client: Client

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  if (!/(?:^|[-_])test(?:$|[-_])/.test(new URL(connectionString).pathname.slice(1))) {
    throw new Error('This fixture requires an explicitly named test database.')
  }
  client = new Client({ connectionString, connectionTimeoutMillis: 5000 })
  await client.connect()
  await client.query('BEGIN')
  await client.query("SET LOCAL statement_timeout = '10s'")
  for (const [table, columns] of Object.entries(tables)) {
    await client.query(`CREATE TEMP TABLE "${table}" (${columns}) ON COMMIT DROP`)
  }
})

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK')
    await client.end()
  }
})

beforeEach(async () => {
  await client.query('SAVEPOINT watchdog_scenario')
  await client.query(
    `TRUNCATE ${Object.keys(tables)
      .map(table => `pg_temp."${table}"`)
      .join(', ')}`,
  )
  await client.query(`INSERT INTO pg_temp."Organization" VALUES ('org', 'Real organization')`)
  await client.query(`INSERT INTO pg_temp."Venue" VALUES ('venue', '0000 Watchdog legacy', 'watchdog-legacy', 'org')`)
})

afterEach(async () => {
  await client.query('ROLLBACK TO SAVEPOINT watchdog_scenario')
  await client.query('RELEASE SAVEPOINT watchdog_scenario')
})

async function seedOrder(options: { date?: string; tip?: number; status?: string; origin?: string; tracked?: boolean } = {}) {
  const { date = '2026-08-18 12:00:00', tip = 0, status = 'COMPLETED', origin = 'AVOQADO', tracked = true } = options
  await client.query(
    `INSERT INTO pg_temp."Order" VALUES
      ('order', 'venue', 'LEGACY-ORDER', 'TPV', $1, $2, 'PAID', 100, 0, 0, 0, $3::numeric, 100 + $3::numeric, 100 + $3::numeric,
       $4::timestamp, $4::timestamp, $4::timestamp)`,
    [origin, status, tip, date],
  )
  if (tracked) {
    await client.query(`INSERT INTO pg_temp."Product" VALUES ('product', 'venue', true, 'QUANTITY')`)
    await client.query(`INSERT INTO pg_temp."OrderItem" VALUES ('item', 'order', 'product')`)
  }
}

async function payment(options: { status?: string; origin?: string; amount?: number; tip?: number; type?: string } = {}) {
  const { status = 'COMPLETED', origin = 'AVOQADO', amount = 100, tip = 0, type = 'REGULAR' } = options
  await client.query(`INSERT INTO pg_temp."Payment" VALUES ('order', 'venue', $1, $2, $3, $4, $5)`, [amount, tip, status, type, origin])
}

async function movement(
  options: {
    raw?: boolean
    venue?: string
    reference?: string
    quantity?: number
    type?: string
    date?: string
    postingLine?: string
  } = {},
) {
  const {
    raw = false,
    venue = 'venue',
    reference = 'order',
    quantity = -1,
    type = raw ? 'USAGE' : 'SALE',
    date = '2026-08-18 12:00:01',
    postingLine = null,
  } = options
  if (raw) {
    await client.query(
      `INSERT INTO pg_temp."RawMaterialMovement" VALUES ($1, $2, $3, $4::numeric, 7, 7 + $4::numeric, $5, $6::timestamp)`,
      [venue, reference, type, quantity, postingLine, date],
    )
  } else {
    await client.query(`INSERT INTO pg_temp."Inventory" VALUES ('inventory', $1)`, [venue])
    await client.query(
      `INSERT INTO pg_temp."InventoryMovement" VALUES ('inventory', $1, $2, $3::numeric, 7, 7 + $3::numeric, $4, $5::timestamp)`,
      [reference, type, quantity, postingLine, date],
    )
  }
}

async function checks() {
  const { counts, details } = buildWatchdogSql()
  const result = await client.query(details)
  const totals = await client.query(counts)
  for (const row of totals.rows) {
    expect(result.rows.filter(detail => detail.check === row.check)).toHaveLength(row.n)
  }
  return result.rows.map(row => row.check) as string[]
}

describe.each(['UTC', 'America/Mexico_City'])('historical watchdog SQL under %s', zone => {
  beforeEach(async () => {
    await client.query(`SELECT set_config('TimeZone', $1, true)`, [zone])
  })

  it.each([false, true])('classifies an old deduction as a visible historical notice (raw=%s)', async raw => {
    await seedOrder()
    await payment()
    await movement({ raw })
    expect(await checks()).toEqual([historical])
  })

  it('does not exempt a new missing posting merely because a stock movement exists', async () => {
    await seedOrder({ date: '2026-09-01 12:00:00' })
    await payment()
    await movement({ date: '2026-09-01 12:00:01' })
    expect(await checks()).toEqual([missing])
  })

  it.each([
    { venue: 'another-venue' },
    { raw: true, venue: 'another-venue' },
    { reference: 'another-order' },
    { quantity: 1 },
    { type: 'ADJUSTMENT' },
    { date: '2026-08-18 11:59:00' },
    { date: '2026-08-18 12:16:00' },
    { postingLine: 'modern-line' },
  ])('keeps the error when the movement is not evidence of this legacy sale: %j', async evidence => {
    await seedOrder()
    await payment()
    await movement(evidence)
    expect(await checks()).toEqual([missing])
  })

  it('keeps an old sale with no stock movements as an error', async () => {
    await seedOrder()
    await payment()
    expect(await checks()).toEqual([missing])
  })

  it('does not reclassify an old order that was changed after the historical window', async () => {
    await seedOrder()
    await payment()
    await movement()
    await client.query(`UPDATE pg_temp."Order" SET "updatedAt" = '2026-09-01 12:00:00'::timestamp`)
    expect(await checks()).toEqual([missing])
  })

  it('keeps overpayment visible on the same order as the historical notice', async () => {
    await seedOrder()
    await payment({ amount: 200 })
    await movement()
    expect(await checks()).toEqual(expect.arrayContaining([historical, 'SOBREPAGO']))
  })

  it('does not report a missing sale posting when one exists', async () => {
    await seedOrder()
    await payment()
    await client.query(`INSERT INTO pg_temp."InventoryPosting" VALUES ('order', 'venue', 'SALE')`)
    expect(await checks()).toEqual([])
  })

  it('recognizes a cancelled import whose payments are all imported and refunded', async () => {
    await seedOrder({ status: 'CANCELLED', origin: 'POS_SOFTRESTAURANT', tip: 500, tracked: false })
    await payment({ status: 'REFUNDED', origin: 'POS_SOFTRESTAURANT', tip: 500 })
    expect(await checks()).not.toContain('PROPINA NO CUADRA')
  })

  it.each([
    { orderStatus: 'COMPLETED', orderOrigin: 'POS_SOFTRESTAURANT', paymentStatus: 'REFUNDED', paymentOrigin: 'POS_SOFTRESTAURANT' },
    { orderStatus: 'CANCELLED', orderOrigin: 'AVOQADO', paymentStatus: 'REFUNDED', paymentOrigin: 'POS_SOFTRESTAURANT' },
    { orderStatus: 'CANCELLED', orderOrigin: 'POS_SOFTRESTAURANT', paymentStatus: 'FAILED', paymentOrigin: 'POS_SOFTRESTAURANT' },
    { orderStatus: 'CANCELLED', orderOrigin: 'POS_SOFTRESTAURANT', paymentStatus: 'REFUNDED', paymentOrigin: 'AVOQADO' },
  ])('preserves tip mismatches outside the proven import case: %j', async row => {
    await seedOrder({ status: row.orderStatus, origin: row.orderOrigin, tip: 500, tracked: false })
    await payment({ status: row.paymentStatus, origin: row.paymentOrigin, tip: 500 })
    expect(await checks()).toContain('PROPINA NO CUADRA')
  })

  it('does not hide a tip mismatch when an imported refund coexists with a completed payment', async () => {
    await seedOrder({ status: 'CANCELLED', origin: 'POS_SOFTRESTAURANT', tip: 500, tracked: false })
    await payment({ status: 'REFUNDED', origin: 'POS_SOFTRESTAURANT', tip: 500 })
    await payment()
    expect(await checks()).toContain('PROPINA NO CUADRA')
  })
})
