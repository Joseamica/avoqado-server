// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Prisma } from '@prisma/client'

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    serializedItemCustodyEvent: { create: jest.fn() },
  },
}))

// Los resolvers que consultan la DB se stubean; `mapSaleStatus` es PURO y se
// usa REAL (requireActual) — es justamente la pieza que esta suite prueba de
// punta a punta: la columna "Estatus de Venta" del Excel decidiendo el estado
// final de la SaleVerification.
const resolveIccidMock = jest.fn()
const resolveVenueMock = jest.fn()
const resolveStaffByCodeMock = jest.fn()
const resolveCategoryMock = jest.fn()
const mapPaymentFormMock = jest.fn()
const parseAmountMock = jest.fn()
jest.mock('@/services/dashboard/manualSale.resolvers', () => ({
  __esModule: true,
  resolveIccid: (...a: any[]) => resolveIccidMock(...a),
  resolveVenue: (...a: any[]) => resolveVenueMock(...a),
  resolveStaffByCode: (...a: any[]) => resolveStaffByCodeMock(...a),
  resolveCategory: (...a: any[]) => resolveCategoryMock(...a),
  mapPaymentForm: (...a: any[]) => mapPaymentFormMock(...a),
  parseAmount: (...a: any[]) => parseAmountMock(...a),
  mapSaleStatus: (...a: any[]) => jest.requireActual('@/services/dashboard/manualSale.resolvers').mapSaleStatus(...a),
}))

const markAsSoldMock = jest.fn()
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  __esModule: true,
  serializedInventoryService: {
    markAsSold: (...a: any[]) => markAsSoldMock(...a),
  },
}))

const logActionMock = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: (...a: any[]) => logActionMock(...a),
}))

import { createOneManualSale, bulkManualSales } from '@/services/dashboard/manualSale.service'
import prisma from '@/utils/prismaClient'
import type { ManualSaleRowInput } from '@/schemas/dashboard/manualSale.schema'

const prismaMock = prisma as jest.Mocked<typeof prisma>

const ORG_ID = 'org-1'
const ACTOR_STAFF_ID = 'actor-staff-1'
const STORE_VENUE_ID = 'store-venue-1'
const SELLER_STAFF_ID = 'seller-staff-1'
const ICCID = '8952140064479469125F'

/** La fila real que Isaac reportó: el SIM salió, la línea no se pudo vincular. */
const rejectedRow: ManualSaleRowInput = {
  iccid: ICCID,
  promoterCode: 'P123',
  promoterName: 'Ana López',
  storeId: '898',
  storeName: 'BAE MUÑOZ SLP (898)',
  saleDate: '2026-08-11',
  saleType: 'Línea nueva',
  paymentForm: 'No aplica',
  amount: 'No aplica',
  simType: 'SIM de intercambio',
  saleStatus: 'Rechazada',
  rejectionNote: 'No se pudo vincular; el cliente ya se lo llevó',
}

function makeTxClient() {
  return {
    order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { create: jest.fn().mockResolvedValue({ id: 'orderitem-1' }) },
    payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    saleVerification: { create: jest.fn().mockResolvedValue({ id: 'verification-1' }) },
  }
}

function wireTx(tx: ReturnType<typeof makeTxClient>) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
}

function stubResolversHappy() {
  resolveIccidMock.mockResolvedValue({
    item: {
      id: 'sim-1',
      serialNumber: ICCID,
      categoryId: 'cat-1',
      custodyState: 'SUPERVISOR_HELD',
      assignedSupervisorId: 'sup-1',
    },
  })
  resolveVenueMock.mockResolvedValue({
    venue: { id: STORE_VENUE_ID, name: 'BAE MUÑOZ SLP', slug: 'bae-munoz-slp', timezone: 'America/Mexico_City' },
  })
  resolveStaffByCodeMock.mockResolvedValue({ staff: { id: SELLER_STAFF_ID, firstName: 'Ana', lastName: 'López', employeeCode: 'P123' } })
  resolveCategoryMock.mockResolvedValue({ categoryId: 'cat-1' })
  mapPaymentFormMock.mockReturnValue({ method: 'OTHER', amountApplies: false })
  parseAmountMock.mockReturnValue(new Prisma.Decimal(0))
}

const svDataOf = (tx: ReturnType<typeof makeTxClient>) => (tx.saleVerification.create as jest.Mock).mock.calls[0][0].data

describe('manualSale — venta RECHAZADA subida fuera del TPV', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    logActionMock.mockResolvedValue(undefined)
    markAsSoldMock.mockResolvedValue({ item: { id: 'sim-1', serialNumber: ICCID } })
  })

  // ── FEATURE NUEVA ────────────────────────────────────────────────────────
  it('deja la SaleVerification en REJECTED con el motivo del Excel en reviewNotes', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    const result = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, rejectedRow)

    expect(result).toMatchObject({ ok: true, saleStatus: 'REJECTED' })
    const svData = svDataOf(tx)
    expect(svData.status).toBe('REJECTED')
    expect(svData.reviewNotes).toBe('No se pudo vincular; el cliente ya se lo llevó')
    // REJECT_FINAL no exige motivos del catálogo: el enum de rechazo cubre fallas
    // de documentación, no "no se pudo vincular la línea".
    expect(svData.rejectionReasons ?? []).toEqual([])
    // El revisor sigue siendo quien sube el archivo, fechado el día real de la venta.
    expect(svData.reviewedById).toBe(ACTOR_STAFF_ID)
    expect(svData.reviewedAt).toEqual(svData.createdAt)
  })

  it('el SIM SALE del inventario aunque la venta esté rechazada (opción A, decisión Isaac 2026-08-17)', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, rejectedRow)

    // Ésta es la razón de ser de la tarea: hoy el dashboard sigue diciendo que
    // el SIM lo tiene el supervisor. Marcarlo vendido es lo que arregla eso.
    expect(markAsSoldMock).toHaveBeenCalledTimes(1)
    const [venueArg, serialArg, orderItemIdArg, , optsArg] = markAsSoldMock.mock.calls[0]
    expect(venueArg).toBe(STORE_VENUE_ID)
    expect(serialArg).toBe(ICCID)
    expect(orderItemIdArg).toBe('orderitem-1')
    expect(optsArg).toMatchObject({ staffId: SELLER_STAFF_ID, skipCustodyCheck: true })
  })

  it('marca la orden como venta rechazada en posRawData para que los reportes puedan separarla', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, rejectedRow)

    const orderData = (tx.order.create as jest.Mock).mock.calls[0][0].data
    expect(orderData.posRawData).toMatchObject({ manualSerializedSale: true, manualSaleStatus: 'REJECTED' })
  })

  it('audita la venta rechazada con su propia acción, distinguible en la bitácora', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, rejectedRow)

    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MANUAL_SALE_REJECTED_CREATED',
        entity: 'Order',
        entityId: 'order-1',
        staffId: ACTOR_STAFF_ID,
        venueId: STORE_VENUE_ID,
        data: expect.objectContaining({ iccid: ICCID, saleStatus: 'REJECTED' }),
      }),
    )
  })

  it.each(['Rechazada', 'RECHAZADA', ' rechazado ', 'rechazadas'])('acepta "%s" como rechazo', async raw => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, { ...rejectedRow, saleStatus: raw })

    expect(svDataOf(tx).status).toBe('REJECTED')
  })

  it('una rechazada sin motivo se registra igual, con reviewNotes vacío', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    const result = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, { ...rejectedRow, rejectionNote: undefined })

    expect(result.ok).toBe(true)
    expect(svDataOf(tx).reviewNotes).toBeNull()
  })

  it('un estatus que no se reconoce NO escribe nada y devuelve un error en español', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    const result = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, { ...rejectedRow, saleStatus: 'Pendiente' })

    // Nunca asumir "aprobada" ante un valor raro: filtraría a Walmart una venta
    // que el operador quiso marcar como perdida.
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/estatus/i)
    expect(tx.order.create).not.toHaveBeenCalled()
    expect(markAsSoldMock).not.toHaveBeenCalled()
  })

  it('el motivo NO se guarda cuando la venta viene aprobada', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, {
      ...rejectedRow,
      saleStatus: 'Aprobada',
      rejectionNote: 'texto que no aplica',
    })

    const svData = svDataOf(tx)
    expect(svData.status).toBe('COMPLETED')
    expect(svData.reviewNotes).toBeNull()
  })

  // ── REGRESIÓN: el camino aprobado que ya existía no cambia ───────────────
  it('sin columna de estatus (archivos viejos de Isaac) la venta sigue siendo COMPLETED', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    const legacyRow: ManualSaleRowInput = { ...rejectedRow }
    delete legacyRow.saleStatus
    delete legacyRow.rejectionNote
    const result = await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, legacyRow)

    expect(result).toMatchObject({ ok: true, saleStatus: 'COMPLETED' })
    expect(svDataOf(tx).status).toBe('COMPLETED')
    expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'MANUAL_SALE_CREATED' }))
  })

  it('el monto lo sigue mandando el Excel: "No aplica" se registra en cero', async () => {
    stubResolversHappy()
    const tx = makeTxClient()
    wireTx(tx)

    await createOneManualSale(ORG_ID, ACTOR_STAFF_ID, rejectedRow)

    const payData = (tx.payment.create as jest.Mock).mock.calls[0][0].data
    expect(new Prisma.Decimal(payData.amount).toString()).toBe('0')
    expect(payData.status).toBe('COMPLETED')
  })
})

describe('manualSale — bulk con estatus por fila', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    logActionMock.mockResolvedValue(undefined)
    markAsSoldMock.mockResolvedValue({ item: { id: 'sim-1', serialNumber: ICCID } })
    stubResolversHappy()
  })

  it('la vista previa devuelve el estatus de cada fila para que la pantalla lo muestre', async () => {
    const result = await bulkManualSales(
      ORG_ID,
      ACTOR_STAFF_ID,
      [rejectedRow, { ...rejectedRow, iccid: '8952140064479469126F', saleStatus: 'Aprobada' }],
      false,
    )

    expect(result.crear).toHaveLength(2)
    expect(result.crear[0]).toMatchObject({ iccid: ICCID, saleStatus: 'REJECTED' })
    expect(result.crear[1]).toMatchObject({ saleStatus: 'COMPLETED' })
  })

  it('una fila con estatus inválido cae en error y no bloquea a las demás', async () => {
    const result = await bulkManualSales(
      ORG_ID,
      ACTOR_STAFF_ID,
      [
        { ...rejectedRow, saleStatus: 'no sé' },
        { ...rejectedRow, iccid: '8952140064479469127F' },
      ],
      false,
    )

    expect(result.error).toHaveLength(1)
    expect(result.error[0].motivo).toMatch(/estatus/i)
    expect(result.crear).toHaveLength(1)
  })
})
