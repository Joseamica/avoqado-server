import { randomUUID } from 'crypto'

const testUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(testUrl.hostname) ||
  !/^\/avoqado_h1a_test_\d+(?:_\d+)?$/.test(testUrl.pathname) ||
  process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
) {
  throw new Error('Esta suite requiere una base local desechable propia')
}
const prisma = (require('@/utils/prismaClient') as typeof import('@/utils/prismaClient')).default
const { applyKitchenPreparation, listKitchenPreparation } =
  require('@/services/kds/kitchenPreparation.service') as typeof import('@/services/kds/kitchenPreparation.service')
const { initialPreparation } = require('@/services/kds/kitchenPreparation') as typeof import('@/services/kds/kitchenPreparation')
const { processIntents } = require('@/services/mobile/sync.mobile.service') as typeof import('@/services/mobile/sync.mobile.service')
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

let venueId: string
let staffId: string
let stations: string[]
beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: 'FULLTEST-Preparación', email: `${randomUUID()}@example.test`, phone: '5500000000' },
  })
  venueId = (await prisma.venue.create({ data: { organizationId: org.id, name: 'FULLTEST-Cocina', slug: randomUUID(), status: 'ACTIVE' } }))
    .id
  staffId = (await prisma.staff.create({ data: { email: `${randomUUID()}@example.test`, firstName: 'FULLTEST', lastName: 'Mesero' } })).id
  const feature = await prisma.feature.upsert({
    where: { code: 'PLAN_PRO' },
    update: {},
    create: { code: 'PLAN_PRO', name: 'Pro', category: 'OPERATIONS', monthlyPrice: 0 },
  })
  await prisma.venueFeature.create({ data: { venueId, featureId: feature.id, monthlyPrice: 0 } })
  stations = await Promise.all(
    ['Barra', 'Cocina'].map(async name => (await prisma.printStation.create({ data: { venueId, name: 'FULLTEST-' + name } })).id),
  )
})

async function fixture(stationCount = 1) {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      paidAmount: 99,
      subtotal: 99,
      taxAmount: 0,
      total: 99,
      contratoDePrecio: 'IVA_INCLUIDO',
    },
  })
  const productRef = randomUUID()
  const tickets = await Promise.all(
    stations.slice(0, stationCount).map(stationId =>
      prisma.kdsOrder.create({
        data: {
          venueId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          printStationId: stationId,
          sourceKey: `round:${randomUUID()}:${stationId}`,
          preparationVersion: 1,
          items: {
            create: {
              productName: 'FULLTEST-Postre',
              quantity: 2,
              orderItemId: productRef,
              externalLineId: randomUUID(),
              modifiers: '["Sin azúcar"]',
              orderPromotionId: 'FULLTEST-combo-instance',
              serviceCourse: { id: 'dessert', label: 'Con el postre', kind: 'STANDARD', preparationVersion: 1, sortOrder: 3 },
              preparation: initialPreparation(2, 'STANDARD'),
            },
          },
        },
        include: { items: true },
      }),
    ),
  )
  const rows = tickets.flatMap(t => t.items)
  const act = async (action: string, quantity: number, reason?: string) => {
    const current = await prisma.kdsOrderItem.findMany({ where: { id: { in: rows.map(r => r.id) } }, orderBy: { id: 'asc' }, take: 2 })
    return applyKitchenPreparation(
      venueId,
      order.id,
      { action, reason, items: current.map(row => ({ id: row.id, expectedRevision: row.preparationRevision, quantity })) },
      staffId,
    )
  }
  return { order, rows, act }
}

test('paid sales retain held products through partial preparation and delivery at every station', async () => {
  const { order, rows, act } = await fixture(2)
  await expect(act('START', 1)).rejects.toMatchObject({ statusCode: 409 })
  await act('RELEASE', 1)
  await act('START', 1)
  const before = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })
  await applyKitchenPreparation(
    venueId,
    order.id,
    { action: 'READY', items: [{ id: before.id, expectedRevision: before.preparationRevision, quantity: 1 }] },
    staffId,
  )
  await expect(act('DELIVER', 1)).rejects.toMatchObject({ statusCode: 409 })
  const other = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[1].id } })
  await applyKitchenPreparation(
    venueId,
    order.id,
    { action: 'READY', items: [{ id: other.id, expectedRevision: other.preparationRevision, quantity: 1 }] },
    staffId,
  )
  await act('DELIVER', 1)
  const page = await listKitchenPreparation(venueId, { orderId: order.id })
  expect(page.items).toHaveLength(2)
  expect(
    page.items.every(row => row.stationCount === 2 && (row.preparation as any).HELD === 1 && (row.preparation as any).DELIVERED === 1),
  ).toBe(true)
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
    status: 'COMPLETED',
    paidAmount: expect.anything(),
  })
  expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).total)).toBe(99)
  expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0)
})

test('concurrent release from the same revision has exactly one winner and one audit', async () => {
  const { order, rows } = await fixture()
  const command = { action: 'RELEASE', items: [{ id: rows[0].id, expectedRevision: 0, quantity: 1 }] }
  const outcomes = await Promise.allSettled([
    applyKitchenPreparation(venueId, order.id, command, staffId),
    applyKitchenPreparation(venueId, order.id, command, staffId),
  ])
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1)
  const saved = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })
  expect(saved).toMatchObject({ preparationRevision: 1, preparation: { HELD: 1, PENDING: 1 } })
  expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'KITCHEN_RELEASE' } })).toBe(1)
})

test('replaying the same durable action twice preserves one change and returns the original ACK', async () => {
  const { order, rows } = await fixture()
  const id = randomUUID()
  const request = {
    venueId,
    staffId,
    deviceId: `FULLTEST-preparation-${randomUUID()}`,
    authorizeIntent: () => true,
    intents: [
      {
        id,
        seq: 1,
        type: 'KDS_ITEM_PROGRESS' as const,
        staffId,
        payload: { orderId: order.id, action: 'RELEASE', items: [{ id: rows[0].id, expectedRevision: 0, quantity: 1 }] },
      },
    ],
  }
  const first = await processIntents(request)
  expect(first[0].status).toBe('ACKED')
  expect((await processIntents(request))[0]).toEqual(first[0])
  expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })).preparationRevision).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'KITCHEN_RELEASE' } })).toBe(1)
})

test('losing the outer ACK write cannot lose the committed preparation result or execute it twice', async () => {
  const { order, rows } = await fixture()
  const id = randomUUID()
  const request = {
    venueId,
    staffId,
    deviceId: `FULLTEST-lost-ack-${randomUUID()}`,
    authorizeIntent: () => true,
    intents: [
      {
        id,
        seq: 1,
        type: 'KDS_ITEM_PROGRESS' as const,
        staffId,
        payload: { orderId: order.id, action: 'RELEASE', items: [{ id: rows[0].id, expectedRevision: 0, quantity: 1 }] },
      },
    ],
  }
  const failedWrite = jest.spyOn(prisma.posSyncIntent, 'update').mockRejectedValueOnce(new Error('FULLTEST lost outer ACK'))
  let first: Awaited<ReturnType<typeof processIntents>>
  try {
    first = await processIntents(request)
  } finally {
    failedWrite.mockRestore()
  }
  expect(first![0].status).toBe('ACKED')
  expect(
    await prisma.posSyncIntent.findUniqueOrThrow({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: id } } }),
  ).toMatchObject({ status: 'ACKED', resultJson: first![0].result })
  expect((await processIntents(request))[0]).toEqual(first![0])
  expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })).preparationRevision).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'KITCHEN_RELEASE' } })).toBe(1)
})

test('a failed audit rolls back all product revisions and header state', async () => {
  const { order, rows } = await fixture(2)
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION fulltest_fail_preparation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."entityId" = '${order.id}' THEN RAISE EXCEPTION 'FULLTEST audit unavailable'; END IF; RETURN NEW; END $$`,
  )
  await prisma.$executeRawUnsafe(
    'CREATE TRIGGER fulltest_fail_preparation_audit BEFORE INSERT ON "ActivityLog" FOR EACH ROW EXECUTE FUNCTION fulltest_fail_preparation_audit()',
  )
  try {
    await expect(
      applyKitchenPreparation(
        venueId,
        order.id,
        { action: 'RELEASE', items: rows.map(r => ({ id: r.id, expectedRevision: 0, quantity: 1 })) },
        staffId,
      ),
    ).rejects.toThrow()
    const saved = await prisma.kdsOrderItem.findMany({ where: { id: { in: rows.map(r => r.id) } }, take: 2 })
    expect(saved.every(r => r.preparationRevision === 0 && (r.preparation as any).HELD === 2)).toBe(true)
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER fulltest_fail_preparation_audit ON "ActivityLog"')
    await prisma.$executeRawUnsafe('DROP FUNCTION fulltest_fail_preparation_audit()')
  }
})

test('completed preparation remains available for an audited reopening without changing the sale', async () => {
  const { order, act } = await fixture()
  await act('RELEASE', 2)
  await act('START', 2)
  await act('READY', 2)
  await act('DELIVER', 2)
  expect((await listKitchenPreparation(venueId, { history: true })).items.some(row => row.orderId === order.id)).toBe(true)
  await act('REOPEN', 1, 'Reposición solicitada')
  const page = await listKitchenPreparation(venueId, { orderId: order.id })
  expect(page.items[0]).toMatchObject({ orderPromotionId: 'FULLTEST-combo-instance', preparation: { DELIVERED: 1, PENDING: 1 } })
  expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paidAmount)).toBe(99)
})

test('a real financial serialization retry does not block preparation or consume its earlier sequence', async () => {
  const { order, rows } = await fixture()
  await prisma.order.update({ where: { id: order.id }, data: { status: 'PENDING', paymentStatus: 'PENDING', paidAmount: 0 } })
  const deviceId = `FULLTEST-independent-lanes-${randomUUID()}`
  const financial = {
    id: randomUUID(),
    seq: 1,
    type: 'UPDATE_DETAILS' as const,
    payload: { orderId: order.id, name: 'FULLTEST-Updated after retry' },
  }
  const preparation = {
    id: randomUUID(),
    seq: 2,
    type: 'KDS_ITEM_PROGRESS' as const,
    staffId,
    payload: { orderId: order.id, action: 'RELEASE', items: [{ id: rows[0].id, expectedRevision: 0, quantity: 1 }] },
  }
  const params = { venueId, staffId, deviceId, authorizeIntent: () => true }
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION fulltest_financial_lane_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${order.id}' THEN RAISE EXCEPTION 'FULLTEST financial retry' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`,
  )
  try {
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER fulltest_financial_lane_retry BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION fulltest_financial_lane_retry()',
    )
    const acks = await processIntents({ ...params, intents: [financial, preparation] })
    expect(acks.map(ack => [ack.id, ack.status])).toEqual([
      [financial.id, 'RETRY'],
      [preparation.id, 'ACKED'],
    ])
    expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })).preparationRevision).toBe(1)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'KITCHEN_RELEASE' } })).toBe(1)
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fulltest_financial_lane_retry ON "Order"')
    await prisma.$executeRawUnsafe('DROP FUNCTION fulltest_financial_lane_retry()')
  }
  expect((await processIntents({ ...params, intents: [financial] }))[0].status).toBe('ACKED')
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).customerName).toBe(financial.payload.name)
  expect((await processIntents({ ...params, intents: [preparation] }))[0].status).toBe('ACKED')
  expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })).preparationRevision).toBe(1)
  expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0)
  expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).total)).toBe(99)
})

test('a future kitchen revision remains pending while financial updates can finish and replay later', async () => {
  const { order, rows, act } = await fixture()
  await prisma.order.update({ where: { id: order.id }, data: { status: 'PENDING', paymentStatus: 'PENDING', paidAmount: 0 } })
  const params = { venueId, staffId, deviceId: `FULLTEST-revision-lanes-${randomUUID()}`, authorizeIntent: () => true }
  const preparation = {
    id: randomUUID(),
    seq: 1,
    type: 'KDS_ITEM_PROGRESS' as const,
    staffId,
    payload: { orderId: order.id, action: 'START', items: [{ id: rows[0].id, expectedRevision: 1, quantity: 1 }] },
  }
  const financial = {
    id: randomUUID(),
    seq: 2,
    type: 'UPDATE_DETAILS' as const,
    payload: { orderId: order.id, name: 'FULLTEST-Financial lane progressed' },
  }
  const acks = await processIntents({ ...params, intents: [preparation, financial] })
  expect(acks[0]).toMatchObject({ status: 'RETRY', errorCode: 'PREPARATION_REVISION_PENDING' })
  expect(acks[1].status).toBe('ACKED')
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).customerName).toBe(financial.payload.name)
  await act('RELEASE', 1)
  expect((await processIntents({ ...params, intents: [preparation] }))[0].status).toBe('ACKED')
  expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })).preparationRevision).toBe(2)
  expect((await processIntents({ ...params, intents: [financial] }))[0].status).toBe('ACKED')
  expect(await prisma.activityLog.count({ where: { venueId, entityId: order.id, action: 'KITCHEN_START' } })).toBe(1)
  expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0)
})

test('urgent combo component replays once, preserves cooking progress and audits acknowledgment and clearing', async () => {
  const { order, rows, act } = await fixture(2)
  await act('RELEASE', 1)
  await act('START', 1)
  const sibling = await prisma.kdsOrderItem.create({
    data: {
      kdsOrderId: rows[0].kdsOrderId,
      orderItemId: randomUUID(),
      externalLineId: randomUUID(),
      orderPromotionId: 'FULLTEST-combo-instance',
      productName: 'FULLTEST-Otro componente',
      quantity: 2,
      preparation: initialPreparation(2, 'STANDARD'),
    },
  })
  const id = randomUUID()
  const current = await prisma.kdsOrderItem.findMany({ where: { id: { in: rows.map(row => row.id) } }, take: 2 })
  const params = {
    venueId,
    staffId,
    deviceId: `FULLTEST-urgent-${randomUUID()}`,
    authorizeIntent: () => true,
    intents: [
      {
        id,
        seq: 1,
        type: 'KDS_ITEM_PROGRESS' as const,
        staffId,
        payload: {
          orderId: order.id,
          action: 'URGENT',
          items: current.map(row => ({ id: row.id, expectedRevision: row.preparationRevision, quantity: 1 })),
        },
      },
    ],
  }
  const acks = await processIntents(params)
  expect(acks[0].status).toBe('ACKED')
  expect((await processIntents(params))[0]).toEqual(acks[0])
  const urgent = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })
  expect(urgent.preparation).toMatchObject({ HELD: 0, PENDING: 1, PREPARING: 1, urgency: { requestId: id, acknowledged: false } })
  expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: sibling.id } })).preparation).toMatchObject({
    HELD: 2,
    PENDING: 0,
    PREPARING: 0,
  })
  await applyKitchenPreparation(
    venueId,
    order.id,
    { action: 'ACK_URGENT', items: [{ id: rows[0].id, expectedRevision: urgent.preparationRevision, quantity: 1 }] },
    staffId,
  )
  const seen = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })
  expect(seen.preparation).toMatchObject({ HELD: 0, PENDING: 1, PREPARING: 1, urgency: { requestId: id, acknowledged: true } })
  await act('CLEAR_URGENT', 1)
  expect((await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })).preparation).toMatchObject({
    HELD: 0,
    PENDING: 1,
    PREPARING: 1,
    urgency: null,
  })
  const logs = await prisma.activityLog.findMany({
    where: { venueId, entityId: order.id, action: { in: ['KITCHEN_URGENT', 'KITCHEN_ACK_URGENT', 'KITCHEN_CLEAR_URGENT'] } },
    select: { action: true, staffId: true },
    take: 4,
  })
  expect(logs).toHaveLength(3)
  expect(logs.every(log => log.staffId === staffId)).toBe(true)
  expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paidAmount)).toBe(99)
  expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0)
})

test('priority selection occurs in PostgreSQL before the hundred-ticket cap and normal tickets remain pageable', async () => {
  const { rows, act } = await fixture()
  await act('URGENT', 1)
  const urgentTicket = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: rows[0].id } })
  await prisma.kdsOrder.update({ where: { id: urgentTicket.kdsOrderId }, data: { createdAt: new Date('2000-01-01') } })
  const ids: string[] = Array.from({ length: 105 }, () => randomUUID())
  await prisma.kdsOrder.createMany({
    data: ids.map(id => ({ id, venueId, orderNumber: 'FULLTEST-normal-' + id, sourceKey: `sale:${id}:normal`, preparationVersion: 1 })),
  })
  await prisma.kdsOrderItem.createMany({
    data: ids.map(kdsOrderId => ({
      kdsOrderId,
      productName: 'FULLTEST-normal',
      quantity: 1,
      preparation: initialPreparation(1, 'IMMEDIATE'),
    })),
  })
  const { listKdsOrders } = require('@/services/mobile/kds.mobile.service') as typeof import('@/services/mobile/kds.mobile.service')
  const first = await listKdsOrders(venueId, undefined, undefined, { urgencyVersion: 1, offset: 0, limit: 100 })
  expect(first).toHaveLength(100)
  expect(first[0].id).toBe(urgentTicket.kdsOrderId)
  const next = await listKdsOrders(venueId, undefined, undefined, { urgencyVersion: 1, offset: 100, limit: 100 })
  expect(next.length).toBeGreaterThan(0)
  expect(next.every(row => !first.some(previous => previous.id === row.id))).toBe(true)
  expect(new Set([...first, ...next].filter(row => ids.includes(row.id)).map(row => row.id)).size).toBe(105)
})
