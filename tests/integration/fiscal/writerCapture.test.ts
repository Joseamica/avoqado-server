/**
 * IVA por producto, Plan 3b (T7): order writers against the REAL documentary capture — `issueCfdiForOrder` reserving,
 * capturing (`loadOrderForCfdiFromDb` + `capturarEntrada`) and sealing — not a direct snapshot. Real PostgreSQL:
 *  - capture first: a writer arriving while the capture holds the Order waits; the entry frozen before it is exactly
 *    a capture of the state BEFORE the writer and never changes after the writer commits.
 *  - writer first: a capture arriving while a writer holds the Order waits and freezes the writer's complete operation
 *    (exactly a capture of the state AFTER the writer).
 * Goldens pin the Order money and the frozen document for IVA_INCLUIDO and IVA_APARTE, modifiers/extras, comps,
 * discounts, promotions, service charges and PARTIAL, plus the paid-but-open repair pass (the F1 lock). Dependencies: a
 * Product change waits (FOR SHARE); the MenuCategory SAT fallback does not wait but is read once per capture; the
 * receptor is the explicit request parameter.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as orderLock from '@/services/shared/paymentShiftClaim'
import { issueCfdiForOrder, loadOrderForCfdiFromDb } from '@/services/fiscal/cfdi.service'
import { capturarEntrada, huellaDeEntrada, leerEntrada, paramsDesdeEntrada } from '@/services/fiscal/entradaDocumental'
import { addCustomerToOrder, addItemsToOrder, compItems } from '@/services/tpv/order.tpv.service'
import { applyManualDiscount } from '@/services/tpv/discount.tpv.service'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { applyPromotionToOrder } from '@/services/promotions/promotion.service'
import { applyServiceCharge } from '@/services/mobile/service-charge.mobile.service'
import { cleanupPaymentCache, processPosOrderEvent } from '@/services/pos-sync/posSyncOrder.service'
import { processPosOrderItemEvent } from '@/services/pos-sync/posSyncOrderItem.service'
import { moduleService } from '@/services/modules/module.service'
import { reconcileOrderFromPayments } from '@/services/tpv/payment.tpv.service'
import type { RichPosPayload } from '@/types/pos.types'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Local host only, and a disposable test DB: the fiscal one on this Mac, CI's (ci-cd.yml adopts that name instead of
// relaxing guards), or any `avoqado_<x>_test_…` like the money suites. Never av-db-25.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(
    ['/av_db_25_iva_test', '/avoqado_h1a_test_20260808'].includes(database.pathname) || /^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)
  )
) {
  throw new Error('This suite requires a local disposable test database (av_db_25_iva_test, avoqado_<x>_test_…), never av-db-25.')
}

const fixture = `writer-capture-${randomUUID()}`
const venueId = fixture
const PRODUCT_EXT = `${fixture}-cafe`
const CARD = [{ idformadepago: 'TAR', tipo: 2, descripcion: 'TARJETA CREDITO' }]
// SAT keys: category fallback, product override and the RESTAURANT sector default must all be distinguishable.
const CATEGORY_KEYS = ['50181700', 'H87'] as const
const SECTOR_KEYS = ['90101500', 'E48'] as const
const POSTRE_KEYS = ['50202306', 'XBX'] as const
const CAFE_KEYS = ['50201706', 'H87'] as const
const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
let staffId: string, staffVenueId: string, categoryId: string, platoId: string, postreId: string, cremaId: string
let promotionId: string, chargeId: string, fiscalEmisorId: string
let selections: Array<{ groupId: string; optionId: string }>
let sequence = 0

const provider = {
  name: 'facturapi',
  createInvoice: jest.fn(),
  findByExternalId: jest.fn(),
  getInvoice: jest.fn(),
  downloadXml: jest.fn(),
  downloadPdf: jest.fn(),
}
const deps = { resolveProvider: jest.fn(() => provider as any), storeArtifact: jest.fn(async () => 'https://test/file') }
const stamped = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'F',
  folio: '1',
  stampedAt: new Date(),
  status: 'valid',
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function barrier<T = void>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    release = resolve
  })
  return { promise, release }
}
type Outcome<T> = { value: T | undefined; error: any }
const resultOf = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    value => ({ value, error: undefined }),
    error => ({ value: undefined, error }),
  )
async function backendPid(tx: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
  return pid
}
/** Some connection is blocked by `pid` (row lock or FK check alike). Polls up to 30 s: the gates run on a loaded machine. */
async function blockedBy(pid: number) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (count > 0) return
    await pause(20)
  }
  throw new Error(`No connection waited on backend ${pid}`)
}

const issue = (orderId: string) => issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId }, deps)
/** The real issuance, paused inside its capture transaction (Order FOR UPDATE and Products FOR SHARE held). */
function pausedIssue(orderId: string, at: 'beforeLoad' | 'afterLoad' = 'afterLoad') {
  const entered = barrier<number>(),
    finish = barrier()
  let paused = false
  const loadOrderForCfdi = async (id: string, opts?: Parameters<typeof loadOrderForCfdiFromDb>[1], tx?: Prisma.TransactionClient) => {
    const hold = async () => {
      if (paused) return
      paused = true
      entered.release(await backendPid(tx!))
      await finish.promise
    }
    if (at === 'beforeLoad') await hold()
    const bundle = await loadOrderForCfdiFromDb(id, opts, tx)
    if (at === 'afterLoad') await hold()
    return bundle
  }
  const issuing = resultOf(issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId }, { ...deps, loadOrderForCfdi }))
  return {
    entered: Promise.race([entered.promise, issuing.then(o => Promise.reject(new Error(`capture ended without pausing: ${o.error}`)))]),
    release: () => finish.release(),
    issuing,
  }
}
/** Pauses the next Order lock right after a writer acquires it. */
function pauseAfterOrderLock() {
  const entered = barrier<number>(),
    finish = barrier()
  const lock = orderLock.lockExistingOrderForPayment
  jest.spyOn(orderLock, 'lockExistingOrderForPayment').mockImplementationOnce(async (tx, input) => {
    const value = await lock(tx, input)
    entered.release(await backendPid(tx))
    await finish.promise
    return value
  })
  return {
    entered: (writer: Promise<unknown>) =>
      Promise.race([entered.promise, writer.then(() => Promise.reject(new Error('writer never acquired Order lock')))]),
    release: () => finish.release(),
  }
}

/** What a capture of the CURRENT committed state would freeze (the same functions the reservation uses). */
async function captureNow(orderId: string) {
  const bundle = await loadOrderForCfdiFromDb(orderId, { permitirEfectivo: true })
  if (!bundle) throw new Error(`order ${orderId} cannot be captured`)
  return capturarEntrada(bundle, receptor, orderId)
}
const cfdiOf = (orderId: string) => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-order-${orderId}` } })
async function frozen(orderId: string) {
  const cfdi = await cfdiOf(orderId)
  const entrada = leerEntrada(cfdi.entrada)!
  return {
    cfdi,
    entrada,
    document: {
      status: cfdi.status,
      montos: entrada.montos,
      paidCents: entrada.paidCents,
      renglones: entrada.renglones.length,
      conceptos: entrada.params.items.map(i => [
        i.description,
        i.satProductKey,
        i.satUnitKey,
        i.quantity,
        i.unitPriceCents,
        i.discountCents,
        i.taxIncluded,
      ]),
    },
  }
}
async function money(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  return {
    subtotal: Number(o.subtotal),
    discount: Number(o.discountAmount),
    charge: Number(o.serviceChargeAmount),
    tax: Number(o.taxAmount),
    total: Number(o.total),
    paid: Number(o.paidAmount),
    remaining: Number(o.remainingBalance),
    paymentStatus: o.paymentStatus,
  }
}

/** Everything a writer can change on the check, to prove it DID run after the capture. */
async function state(orderId: string) {
  const items = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 20 })
  return {
    money: await money(orderId),
    items: items.map(i => [i.id, i.quantity, Number(i.total), Number(i.discountAmount), i.isCortesia]),
    discounts: await prisma.orderDiscount.count({ where: { orderId } }),
    promotions: await prisma.orderPromotion.count({ where: { orderId } }),
  }
}
/**
 * Line order is not document content: the capture reads the lines without ORDER BY, so their order is the physical row
 * order, and a seal UPDATE (or free space reused by other tests) moves rows. Comparisons between two reads, and against
 * goldens, therefore order lines and concepts by content; everything else stays byte-for-byte.
 */
const byContent = (a: unknown, b: unknown) => huellaDeEntrada(a).localeCompare(huellaDeEntrada(b))
const sorted = (document: Awaited<ReturnType<typeof frozen>>['document']) => ({
  ...document,
  conceptos: [...document.conceptos].sort(byContent),
})
const canonical = (entrada: ReturnType<typeof capturarEntrada>) =>
  huellaDeEntrada({
    ...entrada,
    renglones: [...entrada.renglones].sort(byContent),
    params: { ...entrada.params, items: [...entrada.params.items].sort(byContent) },
  })
const sentToPac = (entrada: ReturnType<typeof capturarEntrada>, key: string) => ({
  ...paramsDesdeEntrada(entrada, key),
  idempotencyKey: key,
})

type Fixture = { id: string; version: number; items: string[]; externalId?: string; lineIds?: string[] }
/** Native IVA_INCLUIDO check: Plato $100 (category SAT fallback) + Refresco $50 (no product), $50 paid in cash. */
async function nativeOrder(paid = 50): Promise<Fixture> {
  const o = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `${fixture}-${++sequence}`,
      subtotal: 150,
      taxAmount: 0,
      total: 150,
      paidAmount: paid,
      remainingBalance: 150 - paid,
      paymentStatus: paid > 0 ? 'PARTIAL' : 'PENDING',
      contratoDePrecio: 'IVA_INCLUIDO',
      items: {
        create: [
          { productId: platoId, productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
          { productName: 'Refresco', quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 },
        ],
      },
      ...(paid > 0 && {
        payments: {
          create: { venueId, amount: paid, feePercentage: 0, feeAmount: 0, netAmount: paid, method: 'CASH', status: 'COMPLETED' },
        },
      }),
    },
    include: { items: { orderBy: { total: 'desc' } } },
  })
  return { id: o.id, version: o.version, items: o.items.map(i => i.id) }
}
/** Paid but open: the whole $150 is COMPLETED in cash and the transition to PAID never landed (the sweep's input). */
async function paidButOpen(): Promise<Fixture> {
  const o = await nativeOrder(150)
  await prisma.order.update({ where: { id: o.id }, data: { paidAmount: 0, remainingBalance: 150, paymentStatus: 'PENDING' } })
  return o
}
/** Settles the rest of the check in cash (payment lanes are not under test here). */
async function payRest(orderId: string) {
  const m = await money(orderId)
  await prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: m.remaining,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: m.remaining,
      method: 'CASH',
      status: 'COMPLETED',
    },
  })
  await prisma.order.update({ where: { id: orderId }, data: { paidAmount: m.total, remainingBalance: 0, paymentStatus: 'PAID' } })
}
/** Imported POS check (IVA_APARTE) built by the real events: header 100 + 16 = 116 paid by card, one line. */
async function posOrder(): Promise<Fixture> {
  const externalId = `SR1:1:${fixture}-${++sequence}`
  const header: RichPosPayload = {
    venueId,
    orderData: {
      externalId,
      orderNumber: externalId.split(':').pop()!,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      subtotal: 100,
      taxAmount: 16,
      discountAmount: 0,
      tipAmount: 0,
      total: 116,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      posRawData: { test: fixture },
    },
    staffData: { externalId: null, name: null, pin: null },
    tableData: { externalId: null },
    shiftData: { externalId: null, startTime: null },
    payments: [{ amount: 116, tipAmount: 0, methodExternalId: 'TAR', reference: null, posRawData: { test: fixture } }],
    paymentMethodsCatalog: CARD,
  }
  const order = await processPosOrderEvent(header)
  await processPosOrderItemEvent(posLine(externalId, 1))
  return { id: order.id, version: 0, items: [], externalId, lineIds: [`${externalId}:L0`] }
}
const posLine = (parentOrderExternalId: string, quantity: number) => ({
  venueId,
  parentOrderExternalId,
  itemData: {
    externalId: `${parentOrderExternalId}:L0`,
    deleted: false,
    productExternalId: PRODUCT_EXT,
    productName: 'Café',
    quantity,
    unitPrice: 100,
    taxAmount: 16 * quantity,
    total: 100 * quantity,
  },
})

const PLATO = ['Plato', ...CATEGORY_KEYS, 1, 10000, 0, true]
const REFRESCO = ['Refresco', ...SECTOR_KEYS, 1, 5000, 0, true]
const BASE_MONTOS = { subtotalCents: 12931, taxCents: 2069, totalCents: 15000 }
type Case = {
  run: (o: Fixture) => Promise<unknown>
  build: () => Promise<Fixture>
  /** Order money after the writer (POS: the imported header, untouched). */
  money: Awaited<ReturnType<typeof money>> | 'unchanged'
  document: Awaited<ReturnType<typeof frozen>>['document']
  /** Why the entry cannot be stamped yet (lastError), when it cannot. */
  because?: string
}
const CASES: Array<[string, Case]> = [
  [
    'addItemsToOrder (TPV line with a priced modifier)',
    {
      build: () => nativeOrder(),
      run: o => addItemsToOrder(venueId, o.id, [{ productId: postreId, quantity: 1, modifierIds: [cremaId] }], o.version),
      money: { subtotal: 175, discount: 0, charge: 0, tax: 0, total: 175, paid: 50, remaining: 125, paymentStatus: 'PARTIAL' },
      document: {
        status: 'VALIDATION_FAILED',
        montos: { subtotalCents: 15086, taxCents: 2414, totalCents: 17500 },
        paidCents: 5000,
        renglones: 3,
        conceptos: [PLATO, REFRESCO, ['Postre', ...POSTRE_KEYS, 1, 2000, 0, true], ['Crema (Postre)', ...POSTRE_KEYS, 1, 500, 0, true]],
      },
      because: 'no coincide con lo cobrado',
    },
  ],
  [
    'compItems (TPV courtesy of one line)',
    {
      build: () => nativeOrder(),
      run: o => compItems(venueId, o.id, { itemIds: [o.items[1]], reason: 'Cortesía', staffId }),
      money: { subtotal: 150, discount: 50, charge: 0, tax: 0, total: 100, paid: 50, remaining: 50, paymentStatus: 'PARTIAL' },
      document: {
        status: 'VALIDATION_FAILED',
        montos: { subtotalCents: 8621, taxCents: 1379, totalCents: 10000 },
        paidCents: 5000,
        renglones: 2,
        conceptos: [PLATO],
      },
      because: 'no coincide con lo cobrado',
    },
  ],
  [
    'applyManualDiscount (discount engine, 10 % of the check)',
    {
      build: () => nativeOrder(),
      run: o => applyManualDiscount(venueId, o.id, 'PERCENTAGE', 10, 'Manual', staffVenueId),
      money: { subtotal: 150, discount: 15, charge: 0, tax: 0, total: 135, paid: 50, remaining: 85, paymentStatus: 'PARTIAL' },
      // 🔴 B3a (spec §4.2, D7): cambia A PROPÓSITO. El 10 % ya no bloquea: consta en su reparto (1000 a Plato, 500 a Refresco).
      // Sigue sin timbrar porque la venta está a medio pagar.
      document: {
        status: 'VALIDATION_FAILED',
        montos: { subtotalCents: 11638, taxCents: 1862, totalCents: 13500 },
        paidCents: 5000,
        renglones: 2,
        conceptos: [
          ['Plato', ...CATEGORY_KEYS, 1, 10000, 1000, true],
          ['Refresco', ...SECTOR_KEYS, 1, 5000, 500, true],
        ],
      },
      because: 'no coincide con lo cobrado',
    },
  ],
  [
    'applyPromotionToOrder (mobile combo)',
    {
      build: () => nativeOrder(),
      run: o => applyPromotionToOrder({ venueId, orderId: o.id, promotionId, instanceId: randomUUID(), selections, soldAt: new Date() }),
      money: { subtotal: 240, discount: 0, charge: 0, tax: 0, total: 240, paid: 50, remaining: 190, paymentStatus: 'PARTIAL' },
      // 🔴 B3a (Tarea 5): cambia A PROPÓSITO. Las dos líneas del combo ya son conceptos a precio de lista con su descuento de
      // promoción; sigue sin timbrar porque la venta está a medio pagar.
      document: {
        status: 'VALIDATION_FAILED',
        montos: { subtotalCents: 20690, taxCents: 3310, totalCents: 24000 },
        paidCents: 5000,
        renglones: 4,
        conceptos: [PLATO, REFRESCO, ['Plato', ...CATEGORY_KEYS, 1, 10000, 2500, true], ['Postre', ...POSTRE_KEYS, 1, 2000, 500, true]],
      },
      because: 'no coincide con lo cobrado',
    },
  ],
  [
    'reconcileOrderFromPayments (paid-but-open check closed from its payments)',
    {
      build: () => paidButOpen(),
      run: o => reconcileOrderFromPayments(o.id),
      money: { subtotal: 150, discount: 0, charge: 0, tax: 0, total: 150, paid: 150, remaining: 0, paymentStatus: 'PAID' },
      document: { status: 'STAMPED', montos: BASE_MONTOS, paidCents: 15000, renglones: 2, conceptos: [PLATO, REFRESCO] },
    },
  ],
  [
    'processPosOrderItemEvent (imported IVA_APARTE line update)',
    {
      build: () => posOrder(),
      run: o => processPosOrderItemEvent(posLine(o.externalId!, 2)),
      money: 'unchanged',
      document: {
        status: 'VALIDATION_FAILED',
        montos: { subtotalCents: 10000, taxCents: 1600, totalCents: 11600 },
        paidCents: 11600,
        renglones: 1,
        conceptos: [['Café', ...CAFE_KEYS, 2, 10000, 0, false]],
      },
      because: 'no coincide con lo cobrado',
    },
  ],
]

beforeAll(async () => {
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: fixture, name: fixture, slug: fixture, type: 'RESTAURANT' } })
  staffId = (await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Writer', lastName: 'Capture' } })).id
  staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })).id
  categoryId = (
    await prisma.menuCategory.create({
      data: { venueId, name: 'Cocina', slug: 'cocina', defaultSatProductKey: CATEGORY_KEYS[0], defaultSatUnitKey: CATEGORY_KEYS[1] },
    })
  ).id
  platoId = (await prisma.product.create({ data: { venueId, categoryId, name: 'Plato', sku: `${fixture}-plato`, price: 100 } })).id
  postreId = (
    await prisma.product.create({
      data: {
        venueId,
        categoryId,
        name: 'Postre',
        sku: `${fixture}-postre`,
        price: 20,
        satProductKey: POSTRE_KEYS[0],
        satUnitKey: POSTRE_KEYS[1],
      },
    })
  ).id
  await prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: 'Café',
      sku: PRODUCT_EXT,
      externalId: PRODUCT_EXT,
      price: 100,
      satProductKey: CAFE_KEYS[0],
      satUnitKey: CAFE_KEYS[1],
    },
  })
  cremaId = (
    await prisma.modifierGroup.create({
      data: { venueId, name: 'Extras', modifiers: { create: [{ name: 'Crema', price: 5 }] } },
      include: { modifiers: true },
    })
  ).modifiers[0].id
  const combo = await prisma.promotion.create({
    data: {
      venueId,
      name: 'Combo',
      type: 'BUNDLE',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9000,
      status: 'PUBLISHED',
      daysOfWeek: [],
      groups: {
        create: [
          { name: 'Plato', displayOrder: 0, options: { create: [{ productId: platoId }] } },
          { name: 'Postre', displayOrder: 1, options: { create: [{ productId: postreId }] } },
        ],
      },
    },
    include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
  })
  promotionId = combo.id
  selections = combo.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id }))
  chargeId = (await prisma.serviceCharge.create({ data: { venueId, name: 'Servicio', type: 'PERCENTAGE', value: 10 } })).id
  fiscalEmisorId = (
    await prisma.fiscalEmisor.create({
      data: {
        venueId,
        rfc: 'AAA010101AAA',
        legalName: fixture,
        regimenFiscal: '601',
        lugarExpedicion: '01000',
        csdStatus: 'ACTIVE',
        invoiceCashSales: true,
      },
    })
  ).id
  await prisma.paymentProvider.create({
    data: { id: fixture, code: fixture, name: fixture, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  await prisma.merchantAccount.create({ data: { id: fixture, providerId: fixture, externalMerchantId: fixture, credentialsEncrypted: {} } })
  await prisma.merchantFiscalConfig.create({
    data: { merchantAccountId: fixture, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true },
  })
})
beforeEach(() => {
  jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(true)
  provider.createInvoice.mockReset().mockImplementation(async () => stamped())
  provider.findByExternalId.mockReset().mockResolvedValue(null)
  provider.getInvoice.mockReset()
  provider.downloadXml.mockReset().mockResolvedValue(Buffer.from('<xml/>'))
  provider.downloadPdf.mockReset().mockResolvedValue(Buffer.from('%PDF'))
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  if (!venueId) return
  const orders = { OR: [{ venueId }, { order: { venueId } }] }
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
  await prisma.cfdi.deleteMany({ where: { venueId } })
  await prisma.paymentAllocation.deleteMany({ where: { payment: orders } })
  await prisma.payment.deleteMany({ where: orders })
  await prisma.orderAction.deleteMany({ where: { order: { venueId } } })
  await prisma.orderCustomer.deleteMany({ where: { order: { venueId } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.promotion.deleteMany({ where: { venueId } })
  await prisma.serviceCharge.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.modifier.deleteMany({ where: { group: { venueId } } })
  await prisma.modifierGroup.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
  await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
  await prisma.merchantAccount.deleteMany({ where: { id: fixture } })
  await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
  cleanupPaymentCache()
})

describe('capture first: a later writer waits, and the entry frozen before it never changes', () => {
  it.each(CASES)('%s', async (_name, c) => {
    const o = await c.build()
    const moneyBefore = await money(o.id)
    const stateBefore = await state(o.id)
    const before = await captureNow(o.id)
    const capture = pausedIssue(o.id)
    let writer: Promise<Outcome<unknown>> | undefined
    try {
      const pid = await capture.entered
      writer = resultOf(c.run(o))
      await blockedBy(pid)
    } finally {
      capture.release()
      await capture.issuing
      await writer
    }
    expect((await capture.issuing).error).toBeUndefined()
    expect((await writer!).error).toBeUndefined()
    const { cfdi, entrada } = await frozen(o.id)
    // Frozen = a capture of the state BEFORE the writer, byte for byte, although the writer committed right after it.
    expect(cfdi.entradaHuella).toBe(huellaDeEntrada(before))
    expect(entrada).toEqual(JSON.parse(JSON.stringify(before)))
    expect(await state(o.id)).not.toEqual(stateBefore)
    expect(await money(o.id)).toEqual(c.money === 'unchanged' ? moneyBefore : c.money)
    if (cfdi.status === 'STAMPED') {
      // The PAC received only the frozen entry, and the seals belong to the lines it captured.
      expect(provider.createInvoice).toHaveBeenCalledTimes(1)
      expect(provider.createInvoice).toHaveBeenCalledWith(sentToPac(entrada, `${cfdi.idempotencyKey}#1`))
      const seals = await prisma.orderItemSelloIva.findMany({ where: { cfdiId: cfdi.id }, orderBy: { orderItemId: 'asc' }, take: 10 })
      expect(seals.map(s => s.orderItemId)).toEqual(entrada.renglones.map(r => r.orderItemId).sort())
    } else {
      expect(cfdi.lastError).toContain('no coincide con lo cobrado')
    }
  })
})

describe('writer first: the capture waits and freezes the complete operation (money goldens)', () => {
  it.each(CASES)('%s freezes the complete operation', async (_name, c) => {
    const o = await c.build()
    const moneyBefore = await money(o.id)
    const hold = pauseAfterOrderLock()
    const writer = resultOf(c.run(o))
    let issuing: Promise<Outcome<unknown>> | undefined
    try {
      const pid = await hold.entered(writer)
      issuing = resultOf(issue(o.id))
      await blockedBy(pid)
    } finally {
      hold.release()
      await writer
      await issuing
    }
    expect((await writer).error).toBeUndefined()
    expect((await issuing!).error).toBeUndefined()
    const { cfdi, entrada, document } = await frozen(o.id)
    // Frozen = a capture of the state AFTER the writer: its whole operation (the reason proves it for the discount,
    // which the document cannot spread over two concepts and therefore does not carry).
    expect(cfdi.entradaHuella).toBe(huellaDeEntrada(entrada))
    expect(canonical(entrada)).toBe(canonical(await captureNow(o.id)))
    expect(await money(o.id)).toEqual(c.money === 'unchanged' ? moneyBefore : c.money)
    expect(sorted(document)).toEqual(sorted(c.document))
    if (c.because) expect(cfdi.lastError).toContain(c.because)
  })

  it('once the rest is paid, the recapture stamps the complete operation: extras, IVA-included split, paid = document', async () => {
    const o = await nativeOrder()
    await addItemsToOrder(venueId, o.id, [{ productId: postreId, quantity: 1, modifierIds: [cremaId] }], o.version)
    expect((await issue(o.id)).status).toBe('VALIDATION_FAILED')
    await payRest(o.id)
    expect((await issue(o.id)).status).toBe('STAMPED')
    const { cfdi, entrada, document } = await frozen(o.id)
    expect(sorted(document)).toEqual(sorted({ ...CASES[0][1].document, status: 'STAMPED', paidCents: 17500 }))
    expect(cfdi.entradaHuella).toBe(huellaDeEntrada(entrada))
    expect(canonical(entrada)).toBe(canonical(await captureNow(o.id)))
    expect(provider.createInvoice).toHaveBeenCalledWith(sentToPac(entrada, `${cfdi.idempotencyKey}#1`))
  })

  it('a service charge (mobile) stays in the Order money and blocks the entry with its reason', async () => {
    const o = await nativeOrder(0)
    await applyServiceCharge(venueId, o.id, chargeId)
    await payRest(o.id)
    expect(await money(o.id)).toEqual({
      subtotal: 150,
      discount: 0,
      charge: 15,
      tax: 0,
      total: 165,
      paid: 165,
      remaining: 0,
      paymentStatus: 'PAID',
    })
    expect((await issue(o.id)).status).toBe('VALIDATION_FAILED')
    const { cfdi, document } = await frozen(o.id)
    expect(sorted(document)).toEqual(
      sorted({
        status: 'VALIDATION_FAILED',
        montos: BASE_MONTOS,
        paidCents: 16500,
        renglones: 2,
        conceptos: [PLATO, REFRESCO],
      }),
    )
    expect(cfdi.lastError).toContain('cargo por servicio')
  })
})

describe('B3a: promociones con los escritores reales (B2 → B3a)', () => {
  it('promoción + 10 % de la cuenta (B2 → B3a): cada renglón lleva lo que dice su reparto y la factura sale', async () => {
    const o = await nativeOrder()
    await applyPromotionToOrder({ venueId, orderId: o.id, promotionId, instanceId: randomUUID(), selections, soldAt: new Date() })
    await applyManualDiscount(venueId, o.id, 'PERCENTAGE', 10, 'Manual', staffVenueId)
    expect(await money(o.id)).toMatchObject({ subtotal: 240, discount: 24, total: 216 })
    await payRest(o.id)
    expect((await issue(o.id)).status).toBe('STAMPED')
    const { document } = await frozen(o.id)
    expect(sorted(document)).toEqual(
      sorted({
        status: 'STAMPED',
        montos: { subtotalCents: 18621, taxCents: 2979, totalCents: 21600 },
        paidCents: 21600,
        renglones: 4,
        conceptos: [
          ['Plato', ...CATEGORY_KEYS, 1, 10000, 1000, true],
          ['Refresco', ...SECTOR_KEYS, 1, 5000, 500, true],
          ['Plato', ...CATEGORY_KEYS, 1, 10000, 3250, true],
          ['Postre', ...POSTRE_KEYS, 1, 2000, 650, true],
        ],
      }),
    )
  })

  it('🔴 promoción → 10 % de la cuenta → cortesía de la terminal sobre la línea del combo → factura (B2 N1 + B3a)', async () => {
    const o = await nativeOrder()
    await applyPromotionToOrder({ venueId, orderId: o.id, promotionId, instanceId: randomUUID(), selections, soldAt: new Date() })
    await applyManualDiscount(venueId, o.id, 'PERCENTAGE', 10, 'Manual', staffVenueId)
    const lineaDelCombo = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: o.id, productId: platoId, orderPromotionId: { not: null } },
    })
    await compItems(venueId, o.id, { itemIds: [lineaDelCombo.id], reason: 'Cortesía', staffId })
    // Desde B2c `compItems` es recalculador y vuelve a sacar el 10 % sólo sobre lo que no es promoción ni regalado (R8):
    // 10 % de $150 = $15; cabecera 15 + 75 del espejo COMP = 90.
    expect(await money(o.id)).toMatchObject({ subtotal: 240, discount: 90, total: 150 })
    // B2 (N1): el reparto del 10 % ya no le da parte a la línea regalada.
    const delDiez = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: o.id, isComp: false } })
    expect((delDiez.reparto as { renglones: Record<string, number> }).renglones[lineaDelCombo.id] ?? 0).toBe(0)
    await payRest(o.id)
    expect((await issue(o.id)).status).toBe('STAMPED')
    const { document } = await frozen(o.id)
    expect(document.conceptos.map(c => c[0]).sort()).toEqual(['Plato', 'Postre', 'Refresco'])
    // Modelo del PAC: Plato 10000/1000 + Refresco 5000/500 + Postre 2000/500 ⇒ montos { 12931, 2069, 15000 } = cobrado.
    expect(document.montos.totalCents).toBe(15000)
    expect(document.paidCents).toBe(15000)
  })
})

// B3a ronda final, ajuste 6 (`applyManualDiscount` guarda `taxReduction: 0`): ¿una venta con descuento manual timbra exacto lo cobrado?
// El POS móvil crea TODA venta con IVA incluido (`createOrderWithItems`), así que su descuento manual no baja IVA: es el D16 correcto,
// porque en México el precio ya lo trae. La única venta NET nativa es la importada de SoftRestaurant, y ésa no acepta descuentos.
describe('B3a ronda final (6): descuento manual del POS móvil → factura', () => {
  it('control — 🔴 venta del POS móvil (Plato $100 + Postre $20) con $15 de descuento tecleado por el cajero: IVA incluido, el descuento no toca el IVA y la factura timbra exacto lo cobrado ($105)', async () => {
    const venta = await createOrderWithItems(venueId, {
      items: [
        { productId: platoId, quantity: 1 },
        { productId: postreId, quantity: 1 },
      ],
      staffId,
      discount: 1500,
      source: 'AVOQADO_ANDROID',
    })
    const orden = await prisma.order.findUniqueOrThrow({ where: { id: venta.id } })
    expect(orden.contratoDePrecio).toBe('IVA_INCLUIDO')
    expect(await money(venta.id)).toMatchObject({ subtotal: 120, discount: 15, tax: 0, total: 105 })
    const filas = await prisma.orderDiscount.findMany({ where: { orderId: venta.id }, take: 5 })
    expect(filas.map(f => [Number(f.amount), Number(f.taxReduction)])).toEqual([[15, 0]])
    await payRest(venta.id)
    expect((await issue(venta.id)).status).toBe('STAMPED')
    const { cfdi, entrada, document } = await frozen(venta.id)
    expect(document.paidCents).toBe(10500)
    expect(document.conceptos.reduce((s, c) => s + Number(c[5]), 0)).toBe(1500)
    // Lo que dirá el XML (regla del PAC): subtotal 103.45 − descuento 12.93, IVA 14.48, total 105.00 = lo cobrado.
    expect(document.montos).toEqual({ subtotalCents: 9052, taxCents: 1448, totalCents: 10500 })
    expect(provider.createInvoice).toHaveBeenCalledWith(sentToPac(entrada, `${cfdi.idempotencyKey}#1`))
  })

  it('control — la única venta NET nativa (importada de SoftRestaurant) no acepta descuento manual: no hay NET con descuento manual que facturar', async () => {
    const pos = await posOrder()
    await expect(applyManualDiscount(venueId, pos.id, 'PERCENTAGE', 10, 'Manual', staffVenueId)).rejects.toMatchObject({
      code: 'ORDEN_IMPORTADA_DEL_POS',
    })
    expect(await prisma.orderDiscount.count({ where: { orderId: pos.id } })).toBe(0)
  })

  // HIPOTÉTICA: ningún escritor nativo crea hoy una venta NET sin pagar que no sea importada (el móvil, la terminal, ligas, reservas y
  // delivery nacen con IVA incluido; SoftRestaurant se rechaza arriba; el demo y el cobro manual nacen pagados). Se arma a mano para
  // fijar qué pasaría: el descuento manual no marca `reduceImpuesto`, `sincronizarRepartos` no le baja el IVA, y la factura NO timbra
  // un total distinto: se detiene con su motivo. Si algún día se decide que el descuento manual baje el IVA aparte (spec §4.8, D16),
  // esta prueba cambia a propósito.
  it('control — hipotética: venta NET nativa sin pagar + 10 % manual ⇒ el IVA cobrado no baja y la factura se detiene con su motivo (nunca timbra distinto)', async () => {
    const o = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-${++sequence}`,
        subtotal: 120,
        taxAmount: 19.2,
        total: 139.2,
        remainingBalance: 139.2,
        paymentStatus: 'PENDING',
        contratoDePrecio: 'IVA_APARTE',
        items: {
          create: [
            { productId: platoId, productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 16, total: 100 },
            { productId: postreId, productName: 'Postre', quantity: 1, unitPrice: 20, taxAmount: 3.2, total: 20 },
          ],
        },
      },
    })
    await applyManualDiscount(venueId, o.id, 'PERCENTAGE', 10, 'Manual', staffVenueId)
    expect(await money(o.id)).toMatchObject({ subtotal: 120, discount: 12, tax: 19.2, total: 127.2 })
    expect((await prisma.orderDiscount.findMany({ where: { orderId: o.id }, take: 5 })).map(f => Number(f.taxReduction))).toEqual([0])
    await payRest(o.id)
    expect((await issue(o.id)).status).toBe('VALIDATION_FAILED')
    expect(provider.createInvoice).not.toHaveBeenCalled()
    expect((await cfdiOf(o.id)).lastError).toContain('El total de la factura ($125.28) no coincide con lo cobrado ($127.20)')
  })
})

describe('what the capture depends on, and what protects it', () => {
  // Each dependency test restores the shared catalog in an OUTER finally: a failure must never leak into the next test.
  it('a Product move to another category waits for the capture; the frozen keys are the ones read under its lock', async () => {
    const o = await nativeOrder()
    const other = await prisma.menuCategory.create({
      data: { venueId, name: 'Barra', slug: `barra-${++sequence}`, defaultSatProductKey: '50192100', defaultSatUnitKey: 'KGM' },
    })
    const capture = pausedIssue(o.id)
    let move: Promise<Outcome<unknown>> | undefined
    try {
      try {
        const pid = await capture.entered
        // The same statement the menu editor runs when it moves products into a category.
        move = resultOf(prisma.product.updateMany({ where: { id: { in: [platoId] }, venueId }, data: { categoryId: other.id } }))
        await blockedBy(pid)
      } finally {
        capture.release()
        await capture.issuing
        await move
      }
      expect((await move!).error).toBeUndefined()
      const { document } = await frozen(o.id)
      expect(document.conceptos[0]).toEqual(PLATO)
      expect((await captureNow(o.id)).params.items[0]).toMatchObject({ satProductKey: '50192100', satUnitKey: 'KGM' })
    } finally {
      await prisma.product.update({ where: { id: platoId }, data: { categoryId } })
    }
  })

  it.each([
    ['after the capture read it', 'afterLoad', CATEGORY_KEYS],
    ['before the capture read it', 'beforeLoad', ['50181900', 'KGM']],
  ] as const)(
    'a MenuCategory SAT change committed %s does not wait: the entry freezes ONE committed pair and keeps it',
    async (_when, at, expected) => {
      const o = await nativeOrder()
      const capture = pausedIssue(o.id, at)
      try {
        let committed: Outcome<unknown> | undefined
        try {
          await capture.entered
          // No lock protects the category row: the update commits while the capture still holds the Order.
          committed = await Promise.race([
            resultOf(
              prisma.menuCategory.update({
                where: { id: categoryId },
                data: { defaultSatProductKey: '50181900', defaultSatUnitKey: 'KGM' },
              }),
            ),
            pause(10_000).then(() => ({ value: undefined, error: new Error('the category update waited for the capture') })),
          ])
        } finally {
          capture.release()
          await capture.issuing
        }
        expect(committed!.error).toBeUndefined()
        const { document } = await frozen(o.id)
        // Both keys come from the same row read: never half old, half new.
        expect(document.conceptos[0]).toEqual(['Plato', ...expected, 1, 10000, 0, true])
        expect((await captureNow(o.id)).params.items[0]).toMatchObject({ satProductKey: '50181900', satUnitKey: 'KGM' })
      } finally {
        await prisma.menuCategory.update({
          where: { id: categoryId },
          data: { defaultSatProductKey: CATEGORY_KEYS[0], defaultSatUnitKey: CATEGORY_KEYS[1] },
        })
      }
    },
  )

  it('the order customer never becomes the receptor: the entry freezes the explicit request parameters', async () => {
    const o = await nativeOrder()
    const customer = await prisma.customer.create({
      data: { venueId, firstName: 'Cliente', lastName: 'Frecuente', email: `${fixture}@c.test` },
    })
    await addCustomerToOrder(venueId, o.id, customer.id)
    await prisma.order.update({ where: { id: o.id }, data: { customerId: customer.id, customerName: 'Cliente Frecuente' } })
    await issue(o.id)
    const { cfdi, entrada } = await frozen(o.id)
    expect(entrada.params.receptor).toEqual(receptor)
    expect(cfdi).toMatchObject({ receptorRfc: receptor.rfc, receptorNombre: receptor.razonSocial })
    expect(await prisma.orderCustomer.count({ where: { orderId: o.id, customerId: customer.id } })).toBe(1)
  })
})
