import { randomUUID } from 'crypto'
import type { Feature, VenueFeature } from '@prisma/client'

const testUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(testUrl.hostname) ||
  !/^\/avoqado_h1a_test_\d+_\d+$/.test(testUrl.pathname) ||
  process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
) {
  throw new Error('Esta suite exige una base local desechable propia; no se imprimió la URL')
}
const prisma = (require('@/utils/prismaClient') as typeof import('@/utils/prismaClient')).default
const { getVenueServiceCourses, getOrganizationServiceCourses, putVenueServiceCourses, putOrganizationServiceCourses } =
  require('@/services/service-courses/serviceCourse.service') as typeof import('@/services/service-courses/serviceCourse.service')
const { DEFAULT_SERVICE_COURSES } =
  require('@/services/service-courses/serviceCourseContract') as typeof import('@/services/service-courses/serviceCourseContract')
const { applyPromotionToOrder, removePromotionFromOrder } =
  require('@/services/promotions/promotion.service') as typeof import('@/services/promotions/promotion.service')
const { processIntents } = require('@/services/mobile/sync.mobile.service') as typeof import('@/services/mobile/sync.mobile.service')
const { addItemsToOrder } = require('@/services/tpv/order.tpv.service') as typeof import('@/services/tpv/order.tpv.service')
const { applyKitchenPreparation } =
  require('@/services/kds/kitchenPreparation.service') as typeof import('@/services/kds/kitchenPreparation.service')
const { authorKitchenTickets } =
  require('@/services/kds/kitchenTicketAuthoring.service') as typeof import('@/services/kds/kitchenTicketAuthoring.service')

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
const unique = () => randomUUID()
const courses = DEFAULT_SERVICE_COURSES.map(c => ({ ...c }))
const actor = { staffId: unique() }
let orgId: string
let proId: string
let freeId: string
let foreignId: string
let productId: string
let promotionId: string
let kitchenStationId: string
let groupIds: string[]
let optionIds: string[]
let existingFeature: Feature
let existingSubscription: VenueFeature

beforeAll(async () => {
  await prisma.staff.create({ data: { id: actor.staffId, email: `${unique()}@example.test`, firstName: 'FULLTEST', lastName: 'Mesero' } })
  const org = await prisma.organization.create({ data: { name: 'Prueba tiempos', email: `${unique()}@example.test`, phone: '5500000000' } })
  orgId = org.id
  const createVenue = (name: string, organizationId = orgId) =>
    prisma.venue.create({ data: { name, organizationId, slug: unique(), status: 'ACTIVE' } })
  proId = (await createVenue('Pro')).id
  freeId = (await createVenue('Gratis')).id
  const foreignOrg = await prisma.organization.create({ data: { name: 'Ajena', email: `${unique()}@example.test`, phone: '5500000000' } })
  foreignId = (await createVenue('Ajena', foreignOrg.id)).id
  // Model a prior suite's shared plan and subscription; never replace or clean them up.
  existingFeature = await prisma.feature.upsert({
    where: { code: 'PLAN_PRO' },
    update: {},
    create: { code: 'PLAN_PRO', name: 'Existing Pro plan', category: 'OPERATIONS', monthlyPrice: 37.25 },
  })
  existingSubscription = await prisma.venueFeature.create({
    data: { venueId: foreignId, featureId: existingFeature.id, monthlyPrice: 19.5, active: false },
  })
  const feature = await prisma.feature.upsert({
    where: { code: 'PLAN_PRO' },
    update: {},
    create: { code: 'PLAN_PRO', name: 'Pro', category: 'OPERATIONS', monthlyPrice: 0 },
  })
  await prisma.venueFeature.create({ data: { venueId: proId, featureId: feature.id, monthlyPrice: 0 } })
  kitchenStationId = (
    await prisma.printStation.create({
      data: { venueId: proId, name: 'FULLTEST-Cocina-mixta', isDefault: true, hasKitchenDisplay: true, kitchenDisplaySince: new Date(0) },
    })
  ).id
  const category = await prisma.menuCategory.create({ data: { venueId: proId, name: 'Cafés', slug: unique() } })
  const product = await prisma.product.create({
    data: { venueId: proId, categoryId: category.id, sku: unique(), name: 'Café', price: 80, tags: [] },
  })
  productId = product.id
  const promotion = await prisma.promotion.create({
    data: {
      venueId: proId,
      name: 'Dos cafés',
      type: 'BUNDLE',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9900,
      daysOfWeek: [],
      status: 'PUBLISHED',
      groups: {
        create: [0, 1].map(displayOrder => ({
          name: `Café ${displayOrder + 1}`,
          displayOrder,
          options: { create: { productId, quantity: 1, chargedQuantity: 1 } },
        })),
      },
    },
    include: { groups: { orderBy: { displayOrder: 'asc' }, include: { options: true } } },
  })
  promotionId = promotion.id
  groupIds = promotion.groups.map(g => g.id)
  optionIds = promotion.groups.map(g => g.options[0].id)
})

const saveOrg = async (list = courses) =>
  putOrganizationServiceCourses(orgId, { expectedRevision: (await getOrganizationServiceCourses(orgId)).revision, courses: list }, actor)
const order = () =>
  prisma.order.create({
    data: {
      venueId: proId,
      orderNumber: unique(),
      status: 'CONFIRMED',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 0,
      taxAmount: 0,
      total: 0,
    },
  })
const selections = () =>
  groupIds.map((groupId, i) => ({
    groupId,
    optionId: optionIds[i],
    serviceCourse: i === 0 ? { ...courses[0], label: 'Al momento' } : { id: 'historic', label: 'Con el postre', kind: 'STANDARD' as const },
  }))
const sale = (orderId: string, instanceId = unique()) => ({
  venueId: proId,
  orderId,
  promotionId,
  instanceId,
  selections: selections(),
  soldAt: new Date(),
})

test('the additive migration preserves defaults and Free reads remain visible', async () => {
  expect(await getVenueServiceCourses(proId)).toMatchObject({ source: 'DEFAULT', enabled: true, revision: 'o:0:v:0', courses })
  expect(await getVenueServiceCourses(freeId)).toMatchObject({ source: 'DEFAULT', enabled: false })
  await expect(putVenueServiceCourses(freeId, { expectedRevision: 'o:0:v:0', courses }, actor)).rejects.toMatchObject({ statusCode: 403 })
})

test('organization updates inherit without writing branch settings or another tenant', async () => {
  const renamed = courses.map(c => ({ ...c, label: `${c.label} compartido` }))
  const shared = await saveOrg(renamed)
  expect(await getVenueServiceCourses(proId)).toMatchObject({ source: 'ORGANIZATION', courses: renamed })
  expect(await getVenueServiceCourses(freeId)).toMatchObject({ source: 'ORGANIZATION', enabled: false })
  expect(await getVenueServiceCourses(foreignId)).toMatchObject({ source: 'DEFAULT', courses })
  expect(await prisma.venueSettings.count({ where: { venueId: { in: [proId, freeId] } } })).toBe(0)
  expect(shared).toMatchObject({ totalVenues: 2, inheritingVenues: 2 })
})

test('a complete branch override survives shared renames and restores inheritance', async () => {
  const current = await getVenueServiceCourses(proId)
  const own = await putVenueServiceCourses(proId, { expectedRevision: current.revision, courses }, actor)
  await saveOrg(courses.map(c => ({ ...c, label: `${c.label} nuevo` })))
  expect(await getVenueServiceCourses(proId)).toMatchObject({ revision: own.revision, source: 'VENUE', courses })
  expect(await getOrganizationServiceCourses(orgId)).toMatchObject({ totalVenues: 2, inheritingVenues: 1 })
  const inherited = await putVenueServiceCourses(proId, { expectedRevision: own.revision, courses: null }, actor)
  expect(inherited.source).toBe('ORGANIZATION')
  expect(inherited.venueRevision).toBe(2)
  expect(await getOrganizationServiceCourses(orgId)).toMatchObject({ inheritingVenues: 2 })
})

test('two simultaneous branch saves yield one success and one 409', async () => {
  const expectedRevision = (await getVenueServiceCourses(proId)).revision
  const results = await Promise.allSettled([
    putVenueServiceCourses(proId, { expectedRevision, courses }, actor),
    putVenueServiceCourses(proId, { expectedRevision, courses }, actor),
  ])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409, code: 'SERVICE_COURSES_STALE' } })
})

test('two simultaneous organization saves yield one success and one 409', async () => {
  const expectedRevision = (await getOrganizationServiceCourses(orgId)).revision
  const results = await Promise.allSettled([
    putOrganizationServiceCourses(orgId, { expectedRevision, courses }, actor),
    putOrganizationServiceCourses(orgId, { expectedRevision, courses }, actor),
  ])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } })
})

test('a shared update invalidates an inherited draft before it can become an override', async () => {
  const own = await getVenueServiceCourses(proId)
  await putVenueServiceCourses(proId, { expectedRevision: own.revision, courses: null }, actor)
  const draft = await getVenueServiceCourses(proId)
  await saveOrg()
  await expect(putVenueServiceCourses(proId, { expectedRevision: draft.revision, courses }, actor)).rejects.toMatchObject({
    statusCode: 409,
  })
})

test('combo prices match legacy exactly, while identical products keep different historical times', async () => {
  const modernOrder = await order()
  const legacyOrder = await order()
  const modern = await applyPromotionToOrder(sale(modernOrder.id))
  const legacyInput = sale(legacyOrder.id)
  const legacy = await applyPromotionToOrder({
    ...legacyInput,
    selections: legacyInput.selections.map(({ groupId, optionId }) => ({ groupId, optionId })),
  })
  const modernLines = await prisma.orderItem.findMany({ where: { orderId: modernOrder.id }, take: 2 })
  const legacyLines = await prisma.orderItem.findMany({ where: { orderId: legacyOrder.id }, take: 2 })
  const money = (lines: typeof modernLines) =>
    lines.map(l => [l.productId, l.quantity, Number(l.unitPrice), Number(l.discountAmount), Number(l.total)]).sort()
  expect(money(modernLines)).toEqual(money(legacyLines))
  expect(modern.netCents).toBe(legacy.netCents)
  expect(modern.netCents).toBe(9900)
  expect(modernLines.map(l => l.course).sort()).toEqual([null, 'Con el postre'].sort())
  expect(modernLines.every(l => l.orderPromotionId === modern.orderPromotionId)).toBe(true)
})

test('replay after a rename keeps the original snapshot and creates one whole combo', async () => {
  const target = await order()
  const input = sale(target.id)
  const first = await applyPromotionToOrder(input)
  await saveOrg()
  const replay = await applyPromotionToOrder(input)
  expect(replay).toMatchObject({ created: false, orderPromotionId: first.orderPromotionId })
  expect(await prisma.orderItem.count({ where: { orderId: target.id } })).toBe(2)
  const saved = await prisma.orderPromotion.findUniqueOrThrow({ where: { id: first.orderPromotionId } })
  expect(saved.snapshotJson).toMatchObject({ selections: selections() })
  await removePromotionFromOrder({ venueId: proId, orderId: target.id, orderPromotionId: first.orderPromotionId })
  expect(await prisma.orderItem.count({ where: { orderId: target.id } })).toBe(0)
})

test('caller transaction rolls back combo metadata, components and totals together', async () => {
  const target = await order()
  await expect(
    prisma.$transaction(async tx => {
      await applyPromotionToOrder(sale(target.id), tx)
      throw new Error('rollback fixture')
    }),
  ).rejects.toThrow('rollback fixture')
  expect(await prisma.orderPromotion.count({ where: { orderId: target.id } })).toBe(0)
  expect(await prisma.orderItem.count({ where: { orderId: target.id } })).toBe(0)
  expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: target.id } })).total)).toBe(0)
})

test('real offline reducer acknowledges one round and preserves both component times on retry', async () => {
  const target = await order()
  const roundKey = unique()
  const instanceId = unique()
  const batch = {
    venueId: proId,
    staffId: actor.staffId,
    deviceId: unique(),
    authorizeIntent: () => true,
    intents: [
      {
        id: roundKey,
        seq: 1,
        type: 'ADD_ITEMS' as const,
        createdAtLocal: Date.now(),
        payload: {
          orderId: target.id,
          items: [{ quantity: 1, promotionRef: { promotionId, promotionInstanceId: instanceId, selections: selections() } }],
        },
      },
    ],
  }
  const first = await processIntents(batch)
  expect(first).toMatchObject([{ id: roundKey, status: 'ACKED' }])
  await saveOrg()
  expect(await processIntents(batch)).toEqual(first)
  expect(await prisma.orderPromotion.count({ where: { orderId: target.id } })).toBe(1)
  const lines = await prisma.orderItem.findMany({ where: { orderId: target.id }, take: 3, orderBy: { externalId: 'asc' } })
  expect(lines).toHaveLength(2)
  expect(lines.map(line => line.externalId)).toEqual(
    groupIds
      .slice()
      .sort()
      .map(id => `sync:${roundKey}:0:g:${id}`),
  )
  expect(lines.map(line => line.serviceCourse)).toEqual(
    groupIds
      .slice()
      .sort()
      .map(id => selections().find(s => s.groupId === id)!.serviceCourse),
  )
  expect(lines.reduce((sum, line) => sum + Math.round(Number(line.total) * 100), 0)).toBe(9900)
  expect(await prisma.posSyncIntent.count({ where: { venueId: proId, idempotencyKey: roundKey } })).toBe(1)
})

test('real online mixed round rolls back the whole package on a stale version', async () => {
  const target = await order()
  const items = [
    { quantity: 1, promotionRef: { promotionId, promotionInstanceId: unique(), selections: selections() } },
    { quantity: 1, productId, serviceCourse: courses[0] },
  ]
  await expect(addItemsToOrder(proId, target.id, items, target.version + 1, true)).rejects.toMatchObject({ statusCode: 409 })
  expect(await prisma.orderPromotion.count({ where: { orderId: target.id } })).toBe(0)
  expect(await prisma.orderItem.count({ where: { orderId: target.id } })).toBe(0)
  const sent = await addItemsToOrder(proId, target.id, items, target.version, true)
  expect(Math.round(Number(sent.total) * 100)).toBe(17900)
  const lines = await prisma.orderItem.findMany({ where: { orderId: target.id }, take: 3 })
  expect(lines).toHaveLength(3)
  expect(new Set(lines.map(line => line.sentToKitchenAt?.getTime())).size).toBe(1)
  expect(lines.every(line => line.sentToKitchenAt != null)).toBe(true)
})

test.each(['online', 'offline'] as const)(
  'a real %s mixed round keeps a combo component held until release and delivers all products without changing the sale',
  async mode => {
    const table = await prisma.table.create({ data: { venueId: proId, number: unique(), capacity: 4, qrCode: unique() } })
    const created = await order()
    const target = await prisma.order.update({ where: { id: created.id }, data: { tableId: table.id } })
    const items: Parameters<typeof addItemsToOrder>[2] = [
      {
        quantity: 1,
        promotionRef: {
          promotionId,
          promotionInstanceId: unique(),
          selections: selections().map(s => ({ ...s, serviceCourse: { ...s.serviceCourse, preparationVersion: 1 as const } })),
        },
      },
      { quantity: 1, productId, serviceCourse: { ...courses[0], preparationVersion: 1 } },
    ]
    const sent =
      mode === 'online'
        ? await addItemsToOrder(proId, target.id, items, target.version, true)
        : await (async () => {
            const roundKey = unique()
            const batch = {
              venueId: proId,
              staffId: actor.staffId,
              deviceId: unique(),
              authorizeIntent: () => true,
              intents: [
                { id: roundKey, seq: 1, type: 'ADD_ITEMS' as const, createdAtLocal: Date.now(), payload: { orderId: target.id, items } },
              ],
            }
            const ack = await processIntents(batch)
            expect(ack).toMatchObject([{ id: roundKey, status: 'ACKED' }])
            expect(await processIntents(batch)).toEqual(ack)
            expect(await prisma.posSyncIntent.count({ where: { venueId: proId, idempotencyKey: roundKey } })).toBe(1)
            return prisma.order.findUniqueOrThrow({ where: { id: target.id } })
          })()
    const rows = await prisma.kdsOrderItem.findMany({ where: { kdsOrder: { orderId: target.id, venueId: proId } }, take: 4 })
    expect(rows).toHaveLength(3)
    expect(rows.filter(row => row.orderPromotionId)).toHaveLength(2)
    expect(new Set(rows.map(row => row.orderItemId)).size).toBe(3)
    const held = rows.find(row => (row.preparation as { HELD: number }).HELD === 1)!
    expect(held).toBeDefined()
    expect(held.orderPromotionId).not.toBeNull()
    expect(held.serviceCourse).toMatchObject({ label: 'Con el postre', preparationVersion: 1 })
    const act = async (id: string, action: string) => {
      const current = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id } })
      return applyKitchenPreparation(
        proId,
        target.id,
        { action, items: [{ id, expectedRevision: current.preparationRevision, quantity: 1 }] },
        actor.staffId,
      )
    }
    await expect(act(held.id, 'START')).rejects.toMatchObject({ statusCode: 409 })
    for (const row of rows.filter(row => row.id !== held.id)) {
      expect(row.preparation).toMatchObject({ HELD: 0, PENDING: 1 })
      for (const action of ['START', 'READY', 'DELIVER']) await act(row.id, action)
    }
    expect(await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({
      preparationRevision: 0,
      preparation: { HELD: 1, PENDING: 0, DELIVERED: 0 },
    })
    for (const action of ['RELEASE', 'START', 'READY', 'DELIVER']) await act(held.id, action)
    await authorKitchenTickets({ venueId: proId, orderId: target.id, trigger: 'ROUND' })
    expect(await prisma.kdsOrderItem.count({ where: { kdsOrder: { orderId: target.id } } })).toBe(3)
    expect(await prisma.kdsOrder.findFirstOrThrow({ where: { orderId: target.id } })).toMatchObject({
      preparationVersion: 1,
      printStationId: kitchenStationId,
      status: 'COMPLETED',
    })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: target.id } })
    expect(after.version).toBe(sent.version)
    expect(Number(after.total)).toBe(179)
    expect(await prisma.orderItem.count({ where: { orderId: target.id } })).toBe(3)
    expect(await prisma.orderPromotion.count({ where: { orderId: target.id } })).toBe(1)
    expect(await prisma.payment.count({ where: { orderId: target.id } })).toBe(0)
  },
)

test('catalog fixtures preserve an existing shared Pro plan and another venue subscription', async () => {
  expect(await prisma.feature.findUniqueOrThrow({ where: { code: 'PLAN_PRO' } })).toEqual(existingFeature)
  expect(await prisma.venueFeature.findUniqueOrThrow({ where: { id: existingSubscription.id } })).toEqual(existingSubscription)
  expect(await prisma.venueFeature.findFirstOrThrow({ where: { venueId: proId, featureId: existingFeature.id } })).toMatchObject({
    active: true,
    monthlyPrice: expect.anything(),
  })
})
