/**
 * BORRADOR fuera del target. NO ejecutado; no autoriza implementación.
 * Destino propuesto: tests/unit/services/mobile/cortesia-pendiente.mobile.service.test.ts.
 * ROOT decide el nombre final del módulo y promueve sólo después de leer este archivo.
 *
 * Al promoverse, probará el servicio nuevo sin mock; hoy ese módulo no existe.
 * compOrderItemInTransaction/recalculateOrderTotals existentes se usan sin mock.
 * El adaptador Prisma es memoria propia con commit/rollback; NO prueba Postgres ni locks reales.
 * No mock de assertNoLiveTerminalCharge, de cortesía, de precios o de permisos.
 * El permiso HTTP orders:read/comp pertenece al adapter futuro y NO se acredita aquí.
 */
import cuid = require('cuid')
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import * as compItems from '@/services/mobile/comp-item.mobile.service'
// Export inexistente a propósito: missing module/export NO cuenta como RED funcional.
import { revisarCortesiaPendiente } from '@/services/mobile/cortesia-pendiente.mobile.service'

/** DTO mínimo propuesto; son datos JSON reutilizables, sin token de preview. */
interface OriginalLine {
  externalId: string
  productId: string
  quantity: number
  modifierIds: string[]
  isCortesia: boolean
  cortesiaReason: string | null
}
interface CanonicalLine extends OriginalLine {
  id: string
  unitPriceCents: number
  totalCents: number
  discountCents: number
  taxCents: number
}
interface CanonicalSnapshot {
  orderId: string
  externalId: string
  orderNumber: string
  version: number
  status: string
  paymentStatus: string
  originSystem: string
  tableId: string | null
  servedById: string | null
  subtotalCents: number
  discountCents: number
  taxCents: number
  serviceChargeCents: number
  tipCents: number
  totalCents: number
  paidAmountCents: number
  remainingBalanceCents: number
  lines: CanonicalLine[]
}
interface ReviewInput {
  originalPaymentKey: string
  externalId: string
  expectedAmountCents: number
  expectedTipCents: number
  lines: OriginalLine[]
  confirm?: boolean
  expected?: CanonicalSnapshot
}
interface ReviewReply {
  outcome: 'PREVIEW' | 'APPLIED' | 'ALREADY_APPLIED'
  originalPaymentKey: string
  snapshot: CanonicalSnapshot
}
// Contexto INTERNO confiable del adapter autenticado, nunca campos del DTO recibido.
interface ReviewActor { actorId: string; overrideAuthorizedBy?: string }

const VENUE = cuid()
const OTHER_VENUE = cuid()
const ORDER = cuid()
const ORDER_EXTERNAL = cuid()
const KEY = cuid()
const ACTOR = cuid()
const ORIGINAL_STAFF = cuid()
const OTHER_STAFF = cuid()
const PRODUCT = cuid()
const MOD_A = cuid()
const MOD_B = cuid()
const PERMISSION_SET = cuid()
const ORIGINALS: Readonly<ReviewActor> = Object.freeze({ actorId: ACTOR })
const secondWriteFailure = new Error('owned-second-line-write-failure')
const auditFailure = new Error('owned-audit-write-failure')

type Row = Record<string, any>
interface State { order: Row; items: Row[]; payments: Row[]; audits: Row[]; discounts: Row[]; charges: Row[] }
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value))
const moneyColumns = new Set(['unitPrice', 'total', 'subtotal', 'discountAmount', 'taxAmount', 'serviceChargeAmount', 'tipAmount', 'paidAmount', 'remainingBalance', 'amount', 'value'])

/** Only storage field assignment, not pricing/comp/normalization logic. */
function applyStoredData(target: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) target[key] = Number(target[key] ?? 0) + Number(value.increment)
    else target[key] = moneyColumns.has(key) && value != null ? Number(value) : copy(value)
  }
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(v => matches(row, v))
    if (key === 'OR') return value.some((v: Row) => matches(row, v))
    if (key === 'NOT') return !matches(row, value)
    if (key === 'venueId_externalId') return row.venueId === value.venueId && row.externalId === value.externalId
    if (key === 'orderId_externalId') return row.orderId === value.orderId && row.externalId === value.externalId
    if (value && typeof value === 'object' && !(value instanceof Prisma.Decimal)) {
      const actual = Array.isArray(value.path) ? value.path.reduce((part: any, segment: string) => part?.[segment], row[key]) : row[key]
      if ('equals' in value) return JSON.stringify(actual) === JSON.stringify(value.equals)
      if ('in' in value) return value.in.includes(actual)
      if ('notIn' in value) return !value.notIn.includes(actual)
      if ('not' in value) return actual !== value.not
    }
    return row[key] === value
  })
}
function project(row: Row | null, args: Row = {}, relations: Row = {}): any {
  if (!row) return null
  const scalars = Object.fromEntries(Object.entries(row).filter(([key]) => !(key in relations)).map(([key, value]) =>
    [key, moneyColumns.has(key) && value != null ? new Prisma.Decimal(value) : copy(value)]))
  if (!args.select && !args.include) return scalars
  const fields = args.select ?? args.include
  const result: Row = args.select ? {} : scalars
  for (const [key, selection] of Object.entries(fields)) {
    if (!selection) continue
    if (key in relations) {
      const rows: Row[] = relations[key]
      const options: Row = typeof selection === 'object' ? selection : {}
      const selected = rows.filter(r => matches(r, options.where)).slice(0, options.take ?? rows.length)
      result[key] = selected.map(r => project(r, options, key === 'items' ? { modifiers: r.modifiers ?? [] } : {}))
    } else result[key] = scalars[key]
  }
  return result
}

let state: State
let input: ReviewInput
let trace: Array<{ scope: string; model: string; action: string; args: Row }>
let writes: Array<{ scope: string; model: string; action: string; args: Row }>
let transactions: any[]
let activeTransaction: boolean
let itemWriteCount: number
let failSecondItem: boolean
let failAudit: boolean
let afterLock: ((draft: State) => void) | undefined
let tableOwnership: boolean
let tablePermissions: string[]
const compSpy = jest.spyOn(compItems, 'compOrderItemInTransaction')

function fixture(count = 2, quantity = 1) {
  const items = Array.from({ length: count }, (_, index) => ({
    id: cuid(), orderId: ORDER, externalId: cuid(), productId: PRODUCT, productName: 'Artículo de prueba',
    quantity, unitPrice: 90, total: 110 * quantity, discountAmount: 0, taxAmount: 0,
    appliedDiscountId: null, orderPromotionId: null, giftCardId: null,
    isCortesia: false, cortesiaReason: null,
    modifiers: [{ id: cuid(), modifierId: MOD_A, price: 10 }, { id: cuid(), modifierId: MOD_B, price: 10 }],
  }))
  state = {
    order: { id: ORDER, venueId: VENUE, externalId: ORDER_EXTERNAL, orderNumber: 'LEGACY-OWNED',
      status: 'CONFIRMED', paymentStatus: 'PENDING', version: 1, originSystem: 'AVOQADO',
      contratoDePrecio: 'IVA_INCLUIDO', tableId: null, servedById: null, createdById: ORIGINAL_STAFF,
      subtotal: 110 * quantity * count, discountAmount: 0, taxAmount: 0, serviceChargeAmount: 0,
      tipAmount: 0, total: 110 * quantity * count, paidAmount: 0, remainingBalance: 110 * quantity * count },
    items, payments: [], discounts: [], charges: [],
    // Existing durable row makes preservation of audit history non-vacuous.
    audits: [{ id: cuid(), venueId: VENUE, action: 'OWNED_EXISTING_HISTORY', entity: 'Order', entityId: ORDER,
      staffId: ORIGINAL_STAFF, data: { preserved: true } }],
  }
  input = { originalPaymentKey: KEY, externalId: ORDER_EXTERNAL, expectedAmountCents: 0, expectedTipCents: 0,
    lines: items.map((row, index) => ({ externalId: row.externalId, productId: PRODUCT, quantity,
      modifierIds: [MOD_A, MOD_B], isCortesia: true,
      cortesiaReason: index === 0 ? 'Especial del administrador' : 'Amigos y familia' })) }
}

function database(source: () => State, scope: 'global' | 'tx'): any {
  const call = (model: string, action: string, args: Row) => trace.push({ scope, model, action, args: copy(args) })
  const write = (model: string, action: string, args: Row) => {
    call(model, action, args)
    writes.push({ scope, model, action, args: copy(args) })
    if (scope !== 'tx') throw new Error('GLOBAL WRITE outside the owned transaction')
  }
  const order = {
    findUnique: jest.fn(async (args: Row) => {
      call('order', 'findUnique', args)
      const s = source()
      return project(matches(s.order, args.where) ? s.order : null, args, { items: s.items })
    }),
    findFirst: jest.fn(async (args: Row) => {
      call('order', 'findFirst', args)
      const s = source()
      return project(matches(s.order, args.where) ? s.order : null, args, { items: s.items })
    }),
    update: jest.fn(async (args: Row) => {
      write('order', 'update', args)
      if (!matches(source().order, args.where)) throw new Error('Owned order update missed')
      applyStoredData(source().order, args.data)
      return project(source().order, args)
    }),
    create: jest.fn(async (args: Row) => { write('order', 'create', args); throw new Error('Preview/review cannot create an order') }),
  }
  const orderItem = {
    findMany: jest.fn(async (args: Row) => {
      call('orderItem', 'findMany', args)
      const rows = source().items.filter(row => matches(row, args.where))
      return rows.slice(0, args.take ?? rows.length).map(row => project(row, args, { modifiers: row.modifiers }))
    }),
    findFirst: jest.fn(async (args: Row) => {
      call('orderItem', 'findFirst', args)
      const row = source().items.find(item => matches(item, args.where)) ?? null
      return project(row, args, { modifiers: row?.modifiers ?? [] })
    }),
    findUnique: jest.fn(async (args: Row) => {
      call('orderItem', 'findUnique', args)
      const row = source().items.find(item => matches(item, args.where)) ?? null
      return project(row, args, { modifiers: row?.modifiers ?? [] })
    }),
    count: jest.fn(async (args: Row) => { call('orderItem', 'count', args); return source().items.filter(row => matches(row, args.where)).length }),
    update: jest.fn(async (args: Row) => {
      write('orderItem', 'update', args)
      itemWriteCount++
      if (failSecondItem && itemWriteCount === 2) throw secondWriteFailure
      const row = source().items.find(item => matches(item, args.where))
      if (!row) throw new Error('Owned item update missed')
      applyStoredData(row, args.data)
      return project(row, args, { modifiers: row.modifiers })
    }),
  }
  const payment = {
    count: jest.fn(async (args: Row) => { call('payment', 'count', args); return source().payments.filter(row => matches(row, args.where)).length }),
    findFirst: jest.fn(async (args: Row) => { call('payment', 'findFirst', args); return source().payments.find(row => matches(row, args.where)) ?? null }),
    findMany: jest.fn(async (args: Row) => { call('payment', 'findMany', args); return source().payments.filter(row => matches(row, args.where)) }),
    create: jest.fn(async (args: Row) => { write('payment', 'create', args); throw new Error('Courtesy review cannot register a payment') }),
  }
  const activityLog = {
    findFirst: jest.fn(async (args: Row) => { call('activityLog', 'findFirst', args); return source().audits.find(row => matches(row, args.where)) ?? null }),
    findMany: jest.fn(async (args: Row) => { call('activityLog', 'findMany', args); return source().audits.filter(row => matches(row, args.where)) }),
    create: jest.fn(async (args: Row) => {
      write('activityLog', 'create', args)
      if (failAudit) throw auditFailure
      const row = { id: cuid(), ...copy(args.data) }
      source().audits.push(row)
      return row
    }),
  }
  return {
    $queryRaw: jest.fn(async (query: TemplateStringsArray, ...values: any[]) => {
      const sql = query.join(' ')
      call('$queryRaw', 'query', { sql, values })
      if (scope !== 'tx' || !sql.includes('FROM "Order"') || !sql.includes('FOR UPDATE')) throw new Error('Unexpected SQL or escaped lock')
      const s = source()
      if (!values.includes(s.order.id) || !values.includes(s.order.venueId)) return []
      afterLock?.(s)
      afterLock = undefined
      return [{ id: s.order.id }]
    }),
    order, orderItem, payment, activityLog,
    orderDiscount: {
      findMany: jest.fn(async (args: Row) => { call('orderDiscount', 'findMany', args); return source().discounts.filter(row => matches(row, args.where)) }),
      update: jest.fn(async (args: Row) => {
        write('orderDiscount', 'update', args)
        const row = source().discounts.find(row => matches(row, args.where))
        if (!row) throw new Error('Owned discount update missed')
        applyStoredData(row, args.data); return row
      }),
      create: jest.fn(async (args: Row) => { write('orderDiscount', 'create', args); const row = { id: cuid(), ...copy(args.data) }; source().discounts.push(row); return row }),
      delete: jest.fn(async (args: Row) => {
        write('orderDiscount', 'delete', args)
        const index = source().discounts.findIndex(row => matches(row, args.where))
        if (index < 0) throw new Error('Owned discount delete missed')
        return source().discounts.splice(index, 1)[0]
      }),
    },
    orderServiceCharge: {
      findMany: jest.fn(async (args: Row) => { call('orderServiceCharge', 'findMany', args); return source().charges.filter(row => matches(row, args.where)) }),
      update: jest.fn(async (args: Row) => { write('orderServiceCharge', 'update', args); const row = source().charges.find(row => matches(row, args.where)); if (!row) throw new Error('Owned charge missing'); applyStoredData(row, args.data); return row }),
    },
    terminalPaymentRequest: {
      findFirst: jest.fn(async (args: Row) => { call('terminalPaymentRequest', 'findFirst', args); return null }),
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  trace = []; writes = []; transactions = []; activeTransaction = false
  itemWriteCount = 0; failSecondItem = false; failAudit = false; afterLock = undefined
  tableOwnership = false; tablePermissions = ['tables:manage-all']
  fixture()
  const global = database(() => state, 'global')
  for (const model of ['order', 'orderItem', 'payment', 'activityLog', 'orderDiscount', 'orderServiceCharge', 'terminalPaymentRequest'] as const) {
    Object.assign(prismaMock[model], global[model])
  }
  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    if (activeTransaction) throw new Error('NESTED TRANSACTION in courtesy review')
    activeTransaction = true
    const draft = copy(state)
    const tx = database(() => draft, 'tx')
    transactions.push(tx)
    try { const result = await callback(tx); state = draft; return result }
    finally { activeTransaction = false }
  })
  prismaMock.venueSettings.findUnique.mockImplementation(async () => ({ enforceTableOwnership: tableOwnership }) as any)
  prismaMock.staff.findUnique.mockResolvedValue({ id: ACTOR, active: true } as any)
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => where?.role === 'SUPERADMIN' ? null : ({ id: cuid(), staffId: ACTOR, venueId: VENUE, role: 'MANAGER', active: true }) as any)
  prismaMock.staffVenue.findUnique.mockImplementation(async () => ({ role: 'MANAGER', active: true, permissionSetId: PERMISSION_SET, permissionSet: { permissions: tablePermissions } }) as any)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
})

async function run(body: ReviewInput = input, actor: ReviewActor = ORIGINALS, venue = VENUE): Promise<ReviewReply> {
  return await revisarCortesiaPendiente(venue, actor, body) as unknown as ReviewReply
}
async function preview(): Promise<ReviewReply> { return run({ ...copy(input), confirm: false }) }
function confirm(snapshot: CanonicalSnapshot): ReviewInput { return { ...copy(input), confirm: true, expected: copy(snapshot) } }
function newAudits() { return state.audits.filter(row => row.action === 'ORDER_ITEM_COMPED') }
function noFinancialSideEffects() {
  expect(prismaMock.order.create).not.toHaveBeenCalled()
  expect(prismaMock.payment.create).not.toHaveBeenCalled()
  for (const tx of transactions) expect(tx.payment.create).not.toHaveBeenCalled()
  expect(state.payments).toHaveLength(0)
  expect(logAction).not.toHaveBeenCalled() // fire-and-forget is not durable authorization.
}
/** Every rejection must be an intended 4xx, never the proposed fail-closed 503 seam. */
async function rejected(body: ReviewInput, allowed = [400, 409], actor: ReviewActor = ORIGINALS, venue = VENUE) {
  const before = copy(state)
  let error: any
  try { await run(body, actor, venue) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  expect(allowed).toContain(error?.statusCode)
  expect(error?.statusCode).not.toBe(503)
  expect(state).toEqual(before)
  expect(writes).toHaveLength(0) // rejection must validate all before the first write, not rely on rollback.
}

describe('Task4 revisarCortesiaPendiente — financial service only, isolated unit draft', () => {
  it('preview/default-confirm resolves the original external identity and returns the full header/line tuple without effects', async () => {
    const before = copy(state)
    const reply = await run(copy(input))
    expect(reply).toMatchObject({ outcome: 'PREVIEW', originalPaymentKey: KEY, snapshot: {
      orderId: ORDER, externalId: ORDER_EXTERNAL, orderNumber: 'LEGACY-OWNED', version: 1, status: 'CONFIRMED', paymentStatus: 'PENDING', originSystem: 'AVOQADO',
      tableId: null, servedById: null, subtotalCents: 22000, discountCents: 0, taxCents: 0, serviceChargeCents: 0,
      tipCents: 0, totalCents: 22000, paidAmountCents: 0, remainingBalanceCents: 22000,
    } })
    expect(reply.snapshot.lines).toHaveLength(2)
    for (const row of state.items) expect(reply.snapshot.lines).toEqual(expect.arrayContaining([expect.objectContaining({
      id: row.id, externalId: row.externalId, productId: PRODUCT, quantity: 1,
      isCortesia: false, cortesiaReason: null, unitPriceCents: 9000, totalCents: 11000, discountCents: 0, taxCents: 0,
    })]))
    for (const row of reply.snapshot.lines) expect([...row.modifierIds].sort()).toEqual([MOD_A, MOD_B].sort())
    expect(trace.some(c => c.model === 'order' && JSON.stringify(c.args.where).includes(ORDER_EXTERNAL) && JSON.stringify(c.args.where).includes(VENUE))).toBe(true)
    expect(writes).toHaveLength(0); expect(compSpy).not.toHaveBeenCalled(); expect(state).toEqual(before)
    noFinancialSideEffects()
  })

  it.each([[1, 1], [1, 2], [2, 1], [100, 1]])('confirms the COMPLETE %i-line original with quantity %i through the real helper in one tx', async (count, quantity) => {
    fixture(count, quantity)
    const source = JSON.stringify(input)
    const p = await preview()
    expect(p.snapshot.lines).toHaveLength(count)
    const beforeConfirmTx = transactions.length
    const result = await run(confirm(p.snapshot))
    expect(result).toMatchObject({ outcome: 'APPLIED', originalPaymentKey: KEY, snapshot: { orderId: ORDER, totalCents: 0, paymentStatus: 'PENDING' } })
    expect(Number(state.order.total)).toBe(0)
    expect(state.items.every(row => row.isCortesia === true && Number(row.total) === 0)).toBe(true)
    expect(transactions).toHaveLength(beforeConfirmTx + 1)
    expect(compSpy).toHaveBeenCalledTimes(count)
    const usedTx = compSpy.mock.calls[0][0]
    expect(usedTx).toBe(transactions[beforeConfirmTx])
    expect(compSpy.mock.calls.every(([tx]) => tx === usedTx)).toBe(true)
    expect(transactions.filter(tx => tx === usedTx)).toHaveLength(1)
    for (const original of input.lines) {
      const canonical = state.items.find(row => row.externalId === original.externalId)!
      expect(canonical.cortesiaReason).toBe(original.cortesiaReason)
      expect(compSpy).toHaveBeenCalledWith(usedTx, expect.objectContaining({ venueId: VENUE, orderId: ORDER, itemId: canonical.id, reason: original.cortesiaReason, staffId: ACTOR }))
      expect(newAudits()).toEqual(expect.arrayContaining([expect.objectContaining({ venueId: VENUE, staffId: ACTOR, entity: 'OrderItem', entityId: canonical.id,
        data: expect.objectContaining({ orderId: ORDER, orderNumber: 'LEGACY-OWNED', originalPaymentKey: KEY, reason: original.cortesiaReason }) })]))
    }
    expect(newAudits()).toHaveLength(count)
    const firstWrite = trace.findIndex(c => ['create', 'update', 'delete'].includes(c.action))
    const lock = trace.findIndex(c => c.model === '$queryRaw' && c.args.sql.includes('FOR UPDATE'))
    expect(lock).toBeGreaterThanOrEqual(0); expect(lock).toBeLessThan(firstWrite)
    expect(writes.every(c => c.scope === 'tx')).toBe(true)
    expect(JSON.stringify(input)).toBe(source)
    noFinancialSideEffects()
  })

  it('line order and modifier order are not identity; equal product IDs retain distinct original reasons', async () => {
    const p = await preview()
    const body = confirm(p.snapshot)
    body.lines.reverse().forEach(row => row.modifierIds.reverse())
    await run(body)
    for (const original of input.lines) expect(state.items.find(row => row.externalId === original.externalId)?.cortesiaReason).toBe(original.cortesiaReason)
    expect(newAudits()).toHaveLength(2)
  })

  it('exact repetition after lost commit response preserves the entire canonical state and durable line audits', async () => {
    const body = confirm((await preview()).snapshot)
    await run(body)
    const committed = copy(state)
    writes = []; compSpy.mockClear()
    const expectedReply = await preview()
    const replay = await run(body)
    expect(replay).toMatchObject({ outcome: 'ALREADY_APPLIED', originalPaymentKey: KEY, snapshot: { orderId: ORDER, totalCents: 0 } })
    expect(replay.snapshot).toEqual(expectedReply.snapshot)
    expect(state).toEqual(committed); expect(writes).toHaveLength(0); expect(compSpy).not.toHaveBeenCalled()
    noFinancialSideEffects()
  })

  it('one exact pre-existing comp and one missing comp only authorize/mutate the missing original line', async () => {
    state.items[0].isCortesia = true; state.items[0].cortesiaReason = input.lines[0].cortesiaReason
    state.items[0].discountAmount = state.items[0].total; state.items[0].total = 0
    state.order.subtotal = 110; state.order.total = 110; state.order.remainingBalance = 110
    const existingLine = copy(state.items[0])
    const existingHistory = copy(state.audits)
    const p = await preview()
    await run(confirm(p.snapshot))
    expect(compSpy).toHaveBeenCalledTimes(1)
    expect(compSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ itemId: state.items[1].id, reason: input.lines[1].cortesiaReason }))
    expect(newAudits()).toHaveLength(1)
    expect(state.items[0]).toEqual(existingLine)
    expect(state.audits.slice(0, existingHistory.length)).toEqual(existingHistory)
  })

  it.each(['missing-order', 'foreign-venue'])('%s cannot become a new account or a lookup by product', async kind => {
    const body = { ...copy(input), externalId: kind === 'missing-order' ? cuid() : ORDER_EXTERNAL, confirm: false }
    await rejected(body, [404], ORIGINALS, kind === 'foreign-venue' ? OTHER_VENUE : VENUE)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it.each(['empty', '101', 'duplicate-external', 'blank-reason', 'nonzero-capture'])('invalid input %s is not an executable confirmation', async kind => {
    const body = confirm((await preview()).snapshot)
    if (kind === 'empty') body.lines = []
    if (kind === '101') body.lines = Array.from({ length: 101 }, () => ({ ...copy(input.lines[0]), externalId: cuid() }))
    if (kind === 'duplicate-external') body.lines[1].externalId = body.lines[0].externalId
    if (kind === 'blank-reason') body.lines[1].cortesiaReason = '  '
    if (kind === 'nonzero-capture') body.expectedAmountCents = 11000
    await rejected(body)
  })

  it.each(['orderId', 'externalId'])('a tampered expected canonical %s cannot authorize the resolved account', async field => {
    const body = confirm((await preview()).snapshot)
    body.expected![field as 'orderId' | 'externalId'] = cuid()
    await rejected(body, [409])
    expect(compSpy).not.toHaveBeenCalled()
  })

  it('101 canonical rows cannot look like a complete 100-row original; read overflow/count without truncating', async () => {
    fixture(101)
    input.lines = input.lines.slice(0, 100)
    await rejected({ ...copy(input), confirm: false })
    expect(trace.some(c => (c.model === 'orderItem' && (c.args.take === 101 || c.action === 'count')) || c.args.select?.items?.take === 101 || c.args.include?.items?.take === 101)).toBe(true)
  })

  it.each(['missing-line', 'extra-line', 'product', 'quantity', 'modifier', 'modifier-multiplicity', 'other-comp-reason', 'promotion'])('second-line mismatch %s rejects BEFORE the first mutation', async kind => {
    const body = confirm((await preview()).snapshot)
    if (kind === 'missing-line') body.lines.pop()
    if (kind === 'extra-line') body.lines.push({ ...copy(input.lines[1]), externalId: cuid() })
    if (kind === 'product') state.items[1].productId = cuid()
    if (kind === 'quantity') state.items[1].quantity = 2
    if (kind === 'modifier') state.items[1].modifiers[1].modifierId = cuid()
    if (kind === 'modifier-multiplicity') body.lines[1].modifierIds = [MOD_A, MOD_A]
    if (kind === 'other-comp-reason') { state.items[1].isCortesia = true; state.items[1].cortesiaReason = 'Motivo ajeno'; state.items[1].total = 0 }
    if (kind === 'promotion') state.items[1].orderPromotionId = cuid()
    await rejected(body)
    expect(compSpy).not.toHaveBeenCalled()
  })

  it.each(['version', 'paidAmount', 'tipAmount', 'status', 'paymentStatus', 'total', 'taxAmount', 'serviceChargeAmount'])('canonical header %s changed after preview rejects even without a version increment', async field => {
    const body = confirm((await preview()).snapshot)
    state.order[field] = field === 'status' ? 'CANCELLED' : field === 'paymentStatus' ? 'PARTIAL' : field === 'version' ? 2 : Number(state.order[field]) + 1
    await rejected(body)
  })

  it('all-applied flags do not excuse an unrelated header change after the preview/commit', async () => {
    const body = confirm((await preview()).snapshot)
    await run(body)
    writes = []; compSpy.mockClear()
    state.order.tipAmount = 1 // deliberately does NOT bump version.
    await rejected(body)
  })

  it.each(['COMPLETED', 'PENDING', 'FAILED'])('any existing %s Payment, including amount0, forbids another comp despite PENDING header', async status => {
    const body = confirm((await preview()).snapshot)
    state.payments.push({ id: cuid(), venueId: VENUE, orderId: ORDER, amount: 0, tipAmount: 0, status, type: 'REGULAR' })
    await rejected(body)
  })

  it.each(['PAID', 'PARTIAL', 'REFUNDED', 'COMPLETED', 'CANCELLED', 'DELETED', 'positive-paid'])('ineligible header %s rejects even when the supplied expected tuple matches it', async kind => {
    const body = confirm((await preview()).snapshot)
    if (['PAID', 'PARTIAL', 'REFUNDED'].includes(kind)) {
      state.order.paymentStatus = kind; body.expected!.paymentStatus = kind
    } else if (kind === 'positive-paid') {
      state.order.paidAmount = 1; state.order.remainingBalance -= 1
      body.expected!.paidAmountCents = 100; body.expected!.remainingBalanceCents -= 100
    } else {
      state.order.status = kind; body.expected!.status = kind
    }
    await rejected(body)
    expect(compSpy).not.toHaveBeenCalled()
  })

  it('real terminal blocker query runs under the same Order lock and prevents comp before every write', async () => {
    const body = confirm((await preview()).snapshot)
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      const draft = copy(state); const tx = database(() => draft, 'tx'); transactions.push(tx)
      tx.terminalPaymentRequest.findFirst.mockResolvedValue({ requestId: cuid() })
      const result = await callback(tx); state = draft; return result
    })
    await rejected(body, [409])
    const { UNRESOLVED_FINANCIAL_OUTCOME } = await import('@/services/terminal-payment.service')
    const tx = transactions[transactions.length - 1]
    expect(tx.terminalPaymentRequest.findFirst).toHaveBeenCalledWith({ where: { venueId: VENUE, orderId: ORDER, ...UNRESOLVED_FINANCIAL_OUTCOME }, select: { requestId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.terminalPaymentRequest.findFirst.mock.invocationCallOrder[0])
  })

  it('fresh identity/version must be read again after the lock, not trusted from the outside preview', async () => {
    const body = confirm((await preview()).snapshot)
    afterLock = draft => { draft.order.version++ }
    await rejected(body, [409])
  })

  it('missing trusted actor cannot authorize financial writes', async () => {
    await rejected(confirm((await preview()).snapshot), [401, 403], { actorId: '' })
  })

  it('table ownership uses the resolved canonical order and the actor effective permission, not a role/client claim', async () => {
    tableOwnership = true; tablePermissions = ['orders:comp'] // MANAGER role alone must not grant manage-all.
    state.order.tableId = cuid(); state.order.servedById = OTHER_STAFF
    const p = await preview()
    await rejected(confirm(p.snapshot), [403])
    expect(prismaMock.staffVenue.findUnique).toHaveBeenCalled()
  })

  it('real ownership override permits this resolved table and audits the current trusted actor', async () => {
    tableOwnership = true; tablePermissions = ['orders:comp', 'tables:manage-all']
    state.order.tableId = cuid(); state.order.servedById = OTHER_STAFF
    await run(confirm((await preview()).snapshot))
    expect(newAudits()).toHaveLength(2)
    expect(newAudits().every(row => row.staffId === ACTOR && row.staffId !== ORIGINAL_STAFF)).toBe(true)
  })

  it('a verified override supplied by the internal adapter is durable per line without replacing the current actor', async () => {
    const overrideAuthorizedBy = cuid()
    await run(confirm((await preview()).snapshot), { actorId: ACTOR, overrideAuthorizedBy })
    expect(newAudits()).toHaveLength(2)
    for (const audit of newAudits()) expect(audit).toMatchObject({ staffId: ACTOR,
      data: expect.objectContaining({ overrideAuthorizedBy, originalPaymentKey: KEY, orderId: ORDER }) })
  })

  it('ownership permission revoked while acquiring the Order lock is reread before comp', async () => {
    tableOwnership = true; tablePermissions = ['orders:comp', 'tables:manage-all']
    state.order.tableId = cuid(); state.order.servedById = OTHER_STAFF
    const body = confirm((await preview()).snapshot)
    afterLock = () => { tablePermissions = ['orders:comp'] }
    await rejected(body, [403])
    const tx = transactions[transactions.length - 1]
    const roleReads = prismaMock.staffVenue.findUnique.mock.invocationCallOrder
    expect(roleReads.length).toBeGreaterThan(0)
    expect(roleReads[roleReads.length - 1]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(compSpy).not.toHaveBeenCalled()
  })

  it('an inactive current actor cannot obtain the real ownership override', async () => {
    tableOwnership = true
    state.order.tableId = cuid(); state.order.servedById = OTHER_STAFF
    const body = confirm((await preview()).snapshot)
    prismaMock.staff.findUnique.mockResolvedValue({ id: ACTOR, active: false } as any)
    await rejected(body, [401, 403])
    expect(compSpy).not.toHaveBeenCalled()
  })

  it('failure on the second real item write rolls back first comp, header and durable audit together', async () => {
    const body = confirm((await preview()).snapshot)
    const before = copy(state)
    failSecondItem = true
    await expect(run(body)).rejects.toBe(secondWriteFailure)
    expect(itemWriteCount).toBe(2)
    expect(state).toEqual(before)
    expect(writes.some(c => c.model === 'orderItem')).toBe(true)
    expect(compSpy.mock.calls.every(([tx]) => tx === compSpy.mock.calls[0][0])).toBe(true)
    noFinancialSideEffects()
  })

  it('durable audit failure rejects and rolls back the financial mutation, not a successful fire-and-forget log', async () => {
    const body = confirm((await preview()).snapshot)
    const before = copy(state)
    failAudit = true
    await expect(run(body)).rejects.toBe(auditFailure)
    expect(writes.some(c => c.model === 'orderItem')).toBe(true)
    expect(state).toEqual(before); expect(logAction).not.toHaveBeenCalled()
  })

  it('a fixed service charge that prevents final total0 causes rollback; the test does not remove it to force a comp', async () => {
    state.charges.push({ id: cuid(), orderId: ORDER, name: 'Servicio fijo', type: 'FIXED_AMOUNT', amount: 5, value: 5 })
    state.order.serviceChargeAmount = 5; state.order.total += 5; state.order.remainingBalance += 5
    const body = confirm((await preview()).snapshot)
    const before = copy(state)
    let error: any
    try { await run(body) } catch (caught) { error = caught }
    expect([400, 409]).toContain(error?.statusCode); expect(error?.statusCode).not.toBe(503)
    expect(state).toEqual(before)
    expect(state.charges[0].amount).toBe(5)
  })
})

describe('Task4 courtesy review — real global superadmin authority', () => {
  function globalActor(globalRoleActive: boolean) {
    tableOwnership = true
    state.order.tableId = cuid()
    state.order.servedById = OTHER_STAFF
    prismaMock.staffVenue.findUnique.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: cuid() } as any)
    prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
      globalRoleActive && where?.staffId === ACTOR && where?.active === true &&
        where?.role === 'SUPERADMIN' && where?.staff?.active === true
        ? { id: cuid() } as any : null)
  }

  it('an active global superadmin can correct a venue without a local StaffVenue row', async () => {
    globalActor(true)
    const result = await run(confirm((await preview()).snapshot))
    expect(result).toMatchObject({ outcome: 'APPLIED', snapshot: { orderId: ORDER, totalCents: 0 } })
    expect(newAudits()).toHaveLength(2)
    expect(newAudits().every(row => row.staffId === ACTOR)).toBe(true)
    noFinancialSideEffects()
  })

  it('a claimed superadmin role with no live authority cannot authorize comp', async () => {
    globalActor(false)
    const actor = { actorId: ACTOR, role: 'SUPERADMIN' }
    await rejected(confirm((await preview()).snapshot), [403], actor)
    expect(compSpy).not.toHaveBeenCalled()
  })

  it('impersonation cannot acquire a global bypass absent in the effective venue role', async () => {
    globalActor(true)
    const actor = { actorId: ACTOR, isImpersonating: true }
    await rejected(confirm((await preview()).snapshot), [403], actor)
    expect(compSpy).not.toHaveBeenCalled()
  })
})

describe('Task4 courtesy review — bounded nested originals and canonical reads', () => {
  // Operational budget of this recovery entry, not a change to catalogue/order creation.
  // Overflow keeps the original for manual review; it must never truncate or allocate by arbitrary quantity.
  function withModifiers(count: number) {
    fixture(1)
    state.items[0].modifiers = Array.from({ length: count }, () => ({ id: cuid(), modifierId: MOD_A, quantity: 1, price: 10 }))
    input.lines[0].modifierIds = Array.from({ length: count }, () => MOD_A)
    state.items[0].total = 90 + count * 10
    state.order.subtotal = state.items[0].total
    state.order.total = state.items[0].total
    state.order.remainingBalance = state.items[0].total
  }

  it('accepts the explicit boundary of 100 modifier units and a 500-character original reason', async () => {
    withModifiers(100)
    input.lines[0].cortesiaReason = 'r'.repeat(500)
    const result = await run(confirm((await preview()).snapshot))
    expect(result).toMatchObject({ outcome: 'APPLIED', snapshot: { totalCents: 0 } })
    expect(result.snapshot.lines[0].modifierIds).toHaveLength(100)
    expect(newAudits()).toHaveLength(1)
    noFinancialSideEffects()
  })

  it('rejects 101 original modifier units structurally before reading or writing the order', async () => {
    withModifiers(101)
    await rejected({ ...copy(input), confirm: false }, [400])
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('reads at most budget+1 canonical modifiers and rejects overflow without a partial preview', async () => {
    withModifiers(101)
    input.lines[0].modifierIds = input.lines[0].modifierIds.slice(0, 100)
    await rejected({ ...copy(input), confirm: false }, [409])
    expect(trace.some(c => c.model === 'orderItem' && c.action === 'findMany' && c.args.select?.modifiers?.take === 101)).toBe(true)
  })

  it('rejects compact modifier quantity overflow before materializing its units', async () => {
    withModifiers(1)
    state.items[0].modifiers[0].quantity = 1_000_000_000
    await rejected({ ...copy(input), confirm: false }, [409])
  })

  it('rejects a 501-character original reason before lookup and preserves the whole original', async () => {
    input.lines[0].cortesiaReason = 'r'.repeat(501)
    await rejected({ ...copy(input), confirm: false }, [400])
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('rejects an oversized expected modifier snapshot before the confirmation lookup', async () => {
    const body = confirm((await preview()).snapshot)
    const expected = body.expected! as CanonicalSnapshot & { lines: Array<CanonicalLine & { modifiers: Row[] }> }
    expected.lines[0].modifiers = Array.from({ length: 101 }, () => copy(expected.lines[0].modifiers[0]))
    trace = []; writes = []; prismaMock.order.findUnique.mockClear()
    await rejected(body, [400])
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })
})
