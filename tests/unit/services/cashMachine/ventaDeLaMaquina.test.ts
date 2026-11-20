/**
 * Máquina de efectivo 1a (R4-1, R4-7, R3#6, R3#9, R5#1, R5#5, R5#7): UNA petición atómica por operación de la máquina. La cuenta nace
 * y se paga en la MISMA transacción que el cierre (nadie la ve abierta), con la venta y la propina aparte, en pesos, sin tocar el
 * cajón. La repetición devuelve lo mismo; lo contradictorio, lo imposible y lo que ya no se puede armar quedan como incidencia
 * DURABLE, escrita aparte de la transacción que se revierte.
 *
 * Corre el núcleo real (`crearVentaDeMostradorEnTx` + `registrarAbonoEnTx`) contra el doble de Prisma, como `payGiftCardOnNewOrder`.
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue(null),
  finalizeAreaTicketPaymentInTransaction: jest.fn().mockResolvedValue({ areaTicketOrder: false }),
}))
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  resolvePaymentShiftReconciliationEnabled: jest.fn().mockResolvedValue(false),
}))

import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { consultarVentaDeLaMaquina, registrarVentaDeLaMaquina, type CierreDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
import type { CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { claimShiftForCapturedPayment } from '@/services/shared/paymentShiftClaim'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: number) => new Prisma.Decimal(v)
const REF = 'AQ0123456789AB'
const AUTOR = { userId: 'staff-A', deviceUid: 'pc-uid-1', credencial: 'credencial-de-la-pc' }
const sqlDe = (a: any): string => (Array.isArray(a) ? a.join('?') : String(a?.sql ?? a?.strings?.join('?') ?? ''))

const pedido = (over: Partial<CreateOrderInput> = {}): CreateOrderInput =>
  ({
    items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750 }],
    staffId: 'staff-A',
    orderType: 'TAKEOUT',
    source: 'AVOQADO_ANDROID',
    ...over,
  }) as CreateOrderInput

const cierre = (over: Partial<CierreDeLaMaquina> = {}): CierreDeLaMaquina => ({
  outcome: 'PAGADO',
  dueCents: 18750,
  saleCents: 18750,
  tipCents: 0,
  creditCents: 20000,
  changeDispensedCents: 1250,
  occurredAtKnown: true,
  occurredAt: '2026-11-20T18:00:00.000Z',
  saleShiftId: 'shift-A',
  ...over,
})

const venta = (c: Partial<CierreDeLaMaquina> = {}, p: CreateOrderInput | undefined = pedido()) => ({
  referenceCC: REF,
  cierre: cierre(c),
  ...(cierre(c).outcome === 'PAGADO' ? { pedido: p } : {}),
})

/** Lo que la cuenta debe (pesos) según el servidor: lo relee el núcleo bajo el candado. */
let subtotalDelServidor: number
/** El turno A que mandó la PC y el vivo del negocio. */
let turnoA: { id: string; status: string; endTime: Date | null; startTime: Date } | null
let turnoVivo: { id: string; status: string } | null
/** Las incidencias durables (el INSERT … ON CONFLICT aparte) y los cierres guardados. */
let incidencias: Array<{ kind: string; sql: string; values: unknown[] }>
/** Lo que la base tiene por tipo de incidencia del folio (el INSERT … ON CONFLICT y las dudas que siembra cada prueba). */
let guardadas: Record<string, { kind: string; deviceId: string | null; payload: any; status: string }>
let cierres: any[]
/** El emparejamiento de la PC (`null` = nunca se emparejó). */
let binding: { active: boolean; revokedAt?: Date | null } | null
const HASH_DE_LA_PC = createHash('sha256').update('credencial-de-la-pc').digest('hex')

beforeEach(() => {
  jest.clearAllMocks()
  subtotalDelServidor = 187.5
  turnoA = { id: 'shift-A', status: 'OPEN', endTime: null, startTime: new Date('2026-11-20T14:00:00.000Z') }
  turnoVivo = { id: 'shift-A', status: 'OPEN' }
  incidencias = []
  guardadas = {}
  cierres = []
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockImplementation(async (plantilla: any, ...resto: unknown[]) => {
    const sql = sqlDe(plantilla)
    if (sql.includes('CashMachineIncident')) {
      // Plantilla etiquetada: los valores llegan sueltos después de las cadenas.
      const values = Array.isArray(plantilla) ? resto : ((plantilla?.values ?? []) as unknown[])
      const kind = String(values.find(v => ['CONFLICTO', 'IMPOSIBLE', 'NO_SE_PUDO_REGISTRAR', 'TRAS_REVOCAR'].includes(String(v))))
      incidencias.push({ kind, sql, values })
      const crudo = values.find(v => typeof v === 'string' && v.startsWith('{"eventos"')) as string
      const evento = JSON.parse(crudo).eventos[0]
      if (guardadas[kind]) guardadas[kind].payload.eventos.push(evento)
      else guardadas[kind] = { kind, deviceId: values[values.indexOf(crudo) + 1] as string, payload: JSON.parse(crudo), status: 'ABIERTO' }
      return [{ id: 'inc-1' }]
    }
    if (sql.includes('hashtextextended')) return [{ pg_advisory_xact_lock: '' }]
    if (sql.includes('clock_timestamp')) return [{ ms: BigInt(Date.parse('2026-11-20T18:05:00.000Z')) }]
    return [{ id: 'order-1' }]
  })
  prismaMock.staffVenue.findFirst.mockImplementation(async (a: any) => ({
    id: 'sv',
    staffId: a?.where?.staffId,
    venueId: 'venue-1',
    active: true,
  }))
  prismaMock.terminal.findFirst.mockResolvedValue({ id: 'terminal-pc' })
  // R4-3: la PC está emparejada (su credencial es de un binding ACTIVO de `terminal-pc`); `emparejamiento.test.ts` prueba el resto.
  binding = { active: true }
  prismaMock.cashMachineBinding.findFirst.mockImplementation(async (a: any) =>
    a?.where?.deviceId === 'terminal-pc' && a?.where?.credentialHash === HASH_DE_LA_PC ? binding : null,
  )
  prismaMock.shift.findFirst.mockImplementation(async (a: any) => {
    const where = a?.where ?? {}
    if (where.id) return turnoA && where.id === turnoA.id ? turnoA : null
    if (where.status?.in || where.status === 'OPEN')
      return turnoVivo && (where.status !== 'OPEN' || turnoVivo.status === 'OPEN') ? turnoVivo : null
    return null
  })
  prismaMock.shift.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.findFirst.mockResolvedValue({ shiftId: null })
  prismaMock.order.findUnique.mockImplementation(async (a: any) =>
    a?.where?.venueId_externalId
      ? null
      : {
          id: 'order-1',
          orderNumber: 'ORD-1',
          paymentStatus: 'PENDING',
          subtotal: D(subtotalDelServidor),
          discountAmount: D(0),
          serviceChargeAmount: D(0),
          status: 'CONFIRMED',
          contratoDePrecio: 'IVA_INCLUIDO',
          taxAmount: D(0),
          originSystem: 'AVOQADO',
          version: 1,
          areaTicketCode: null,
          tableId: null,
          total: D(subtotalDelServidor),
          paidAmount: D(0),
          remainingBalance: D(subtotalDelServidor),
        },
  )
  prismaMock.order.create.mockImplementation(async ({ data }: any) => ({ id: 'order-1', ...data, items: [], promotions: [] }))
  prismaMock.order.update.mockImplementation(async ({ data }: any) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    ...data,
    items: [],
    promotions: [],
  }))
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({ id: 'payment-1', createdAt: new Date(), ...data }))
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-abierta' })
  prismaMock.cashMachineClose.findUnique.mockImplementation(async () => cierres[0] ?? null)
  prismaMock.cashMachineIncident.findUnique.mockImplementation(
    async (a: any) => guardadas[a?.where?.venueId_referenceCC_kind?.kind] ?? null,
  )
  prismaMock.cashMachineIncident.findMany.mockImplementation(async (a: any) =>
    Object.values(guardadas).filter(g => (a?.where?.kind?.in ?? [g.kind]).includes(g.kind)),
  )
  prismaMock.$executeRaw.mockResolvedValue(0)
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' } as any)
  prismaMock.cashMachineClose.create.mockImplementation(async ({ data }: any) => {
    const fila = { id: 'close-1', createdAt: new Date(), ...data }
    cierres.push(fila)
    return fila
  })
})

const pagoCreado = () => prismaMock.payment.create.mock.calls[0]?.[0]?.data
const cierreCreado = () => prismaMock.cashMachineClose.create.mock.calls[0]?.[0]?.data

describe('registrarVentaDeLaMaquina · PAGADO', () => {
  it('🔴 18750 centavos llegan como Payment.amount = 187.50 pesos, con la semántica de la máquina y la llave del folio', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(r.status).toBe(200)
    expect(pagoCreado()).toMatchObject({
      amount: 187.5,
      tipAmount: 0,
      method: 'CASH',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderLabel: 'Efectivo · máquina',
      tenderSatFormaPago: '01',
      tenderCountsAsCash: false,
      cashMachineRef: REF,
      idempotencyKey: `maquina-${REF}`,
      status: 'COMPLETED',
      processedById: 'staff-A',
    })
    // La cuenta nace con la llave del folio, sin mesa, y pagada en la misma transacción.
    expect(prismaMock.order.create.mock.calls[0][0].data).toMatchObject({ externalId: `maquina-${REF}`, tableId: null })
    expect(prismaMock.order.updateMany.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
  })

  it('🔴 cambio que faltó (250) → CAMBIO, y la respuesta trae desenlace, quién y qué se debe', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ changeDispensedCents: 1000 }))
    expect(r.body).toEqual({
      referenceCC: REF,
      outcome: 'PAGADO',
      resolvedBy: 'MAQUINA',
      owedKind: 'CAMBIO',
      orderId: 'order-1',
      paymentId: 'payment-1',
      dueCents: 18750,
      saleCents: 18750,
      tipCents: 0,
      appliedCents: 18750,
      excedenteCents: 0,
      creditCents: 20000,
      changeDispensedCents: 1000,
      owedCents: 250,
      shiftStatus: 'EN_TURNO',
    })
    expect(cierreCreado()).toMatchObject({ deviceId: 'terminal-pc', resolvedBy: 'MAQUINA', owedKind: 'CAMBIO', owedCents: 250 })
  })

  it('🔴 la propina va aparte: $100 + $10 → amount 100.00 y tip 10.00, sin deuda falsa', async () => {
    subtotalDelServidor = 100
    const r = await registrarVentaDeLaMaquina(
      'venue-1',
      AUTOR,
      venta({ dueCents: 11000, saleCents: 10000, tipCents: 1000, creditCents: 11000, changeDispensedCents: 0 }),
    )
    expect(pagoCreado()).toMatchObject({ amount: 100, tipAmount: 10 })
    expect(r.body).toMatchObject({ appliedCents: 10000, excedenteCents: 0, owedCents: 0, owedKind: null })
    expect(prismaMock.order.updateMany.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PAID' })
  })

  it('🔴 el servidor cobra menos (186.20 contra 187.50): se paga 186.20, excedente 130 y la cuenta queda pagada exacta', async () => {
    subtotalDelServidor = 186.2
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ creditCents: 18750, changeDispensedCents: 0 }))
    expect(pagoCreado()).toMatchObject({ amount: 186.2, tipAmount: 0 })
    expect(r.body).toMatchObject({ appliedCents: 18620, excedenteCents: 130, owedCents: 130, owedKind: 'EXCEDENTE' })
    expect(prismaMock.order.updateMany.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PAID', remainingBalance: 0 })
  })

  it('🔴 la rebaja nunca toca la propina', async () => {
    subtotalDelServidor = 95
    const r = await registrarVentaDeLaMaquina(
      'venue-1',
      AUTOR,
      venta({ dueCents: 11000, saleCents: 10000, tipCents: 1000, creditCents: 11000, changeDispensedCents: 0 }),
    )
    expect(pagoCreado()).toMatchObject({ amount: 95, tipAmount: 10 })
    expect(r.body).toMatchObject({ appliedCents: 9500, excedenteCents: 500, owedCents: 500, owedKind: 'EXCEDENTE', tipCents: 1000 })
  })

  it('🔴 no toca el cajón aunque haya una caja abierta (NOT_DRAWER_CASH)', async () => {
    await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(prismaMock.cashDrawerEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.cashDrawerEvent.upsert).not.toHaveBeenCalled()
  })

  it('🔴 un producto que ya no existe: 202 NO_SE_PUDO_REGISTRAR, incidencia durable con el dinero, sin pago', async () => {
    prismaMock.product.findMany.mockResolvedValue([])
    const r = await registrarVentaDeLaMaquina(
      'venue-1',
      AUTOR,
      venta({}, pedido({ items: [{ productId: 'prod-borrado', quantity: 1 }] as any })),
    )
    expect(r).toEqual({
      status: 202,
      body: {
        referenceCC: REF,
        incident: 'NO_SE_PUDO_REGISTRAR',
        motivo: 'VENTA_RECHAZADA',
        outcome: 'PAGADO',
        resolvedBy: 'MAQUINA',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        creditCents: 20000,
        changeDispensedCents: 1250,
      },
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
    expect(incidencias.map(i => i.kind)).toEqual(['NO_SE_PUDO_REGISTRAR'])
    expect(JSON.stringify(incidencias[0].values)).toContain('20000')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_SALE_NOT_RECORDED', venueId: 'venue-1' }))
  })
  it('un 409 de concurrencia no es «no se pudo registrar»: sube tal cual y la PC reintenta el mismo folio', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new ConflictError('Conflicto de concurrencia persistente, por favor intente de nuevo'))
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta())).rejects.toMatchObject({ statusCode: 409, code: undefined })
    expect(incidencias).toEqual([])
  })
})

describe('registrarVentaDeLaMaquina · repetición y conflicto', () => {
  it('🔴 la misma operación por la consulta rápida: la MISMA respuesta y un solo pago', async () => {
    const primera = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    const segunda = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(segunda).toEqual(primera)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.cashMachineClose.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 la misma operación que pierde la carrera (P2002 del cierre): la respuesta de la ganadora', async () => {
    const primera = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    const ganadora = cierres[0]
    // La consulta rápida no la vio (llegaron juntas); dentro, el índice único choca.
    prismaMock.cashMachineClose.findUnique.mockReset().mockResolvedValueOnce(null).mockResolvedValue(ganadora)
    prismaMock.cashMachineClose.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['venueId', 'referenceCC'] },
      }),
    )
    const segunda = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(segunda).toEqual(primera)
  })

  it('🔴 otro crédito con el mismo folio: 409 y la incidencia durable queda aunque la transacción se revierta', async () => {
    await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    await expect(
      registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ creditCents: 19000, changeDispensedCents: 250 })),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
    })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(incidencias.map(i => i.kind)).toEqual(['CONFLICTO'])
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_CLOSE_CONFLICT' }))
  })

  it('🔴 conflicto en la carrera: la transacción perdedora se revierte y la incidencia se escribe aparte', async () => {
    await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    const ganadora = cierres[0]
    prismaMock.cashMachineClose.findUnique.mockReset().mockResolvedValueOnce(null).mockResolvedValue(ganadora)
    prismaMock.cashMachineClose.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: {} }),
    )
    await expect(
      registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ creditCents: 19000, changeDispensedCents: 250 })),
    ).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(incidencias.map(i => i.kind)).toEqual(['CONFLICTO'])
  })

  it('🔴 R5#7: GUARDADO y CANCELADO con cifras idénticas son operaciones DISTINTAS (409 en la segunda)', async () => {
    const iguales = { creditCents: 5000, changeDispensedCents: 0 }
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ outcome: 'GUARDADO', cancelMode: '2', ...iguales }))
    expect(r.body).toMatchObject({ outcome: 'GUARDADO', owedKind: 'GUARDADO', owedCents: 5000, orderId: null, paymentId: null })
    await expect(
      registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ outcome: 'CANCELADO', cancelMode: '1', ...iguales })),
    ).rejects.toMatchObject({
      statusCode: 409,
    })
    // Y la repetición del GUARDADO con el acuse perdido sigue siendo la misma respuesta.
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ outcome: 'GUARDADO', cancelMode: '2', ...iguales }))).resolves.toEqual(
      r,
    )
  })
})

describe('registrarVentaDeLaMaquina · imposibles (422)', () => {
  it.each([
    ['PAGADO con cambio mayor que crédito − adeudo', { changeDispensedCents: 1300 }],
    ['GUARDADO que devolvió algo', { outcome: 'GUARDADO', cancelMode: '2', creditCents: 5000, changeDispensedCents: 100 }],
    ['CANCELADO con el crédito completo', { outcome: 'CANCELADO', cancelMode: '1', creditCents: 18750, changeDispensedCents: 0 }],
    ['GUARDADO con el crédito completo', { outcome: 'GUARDADO', cancelMode: '2', creditCents: 20000, changeDispensedCents: 0 }],
    // Codex r1 #12 (decisión h y R4-7 #6).
    [
      '🔴 un adeudo que la máquina no cobra ($187.35)',
      { dueCents: 18735, saleCents: 18735, creditCents: 20000, changeDispensedCents: 1265 },
    ],
    ['🔴 una cuenta de $0', { dueCents: 0, saleCents: 0, creditCents: 0, changeDispensedCents: 0 }],
    ['🔴 una cancelación sin el modo del cancel', { outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5000 }],
  ] as const)('%s → 422, incidencia durable y sin pago', async (_nombre, over) => {
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta(over as Partial<CierreDeLaMaquina>))).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
    expect(incidencias.map(i => i.kind)).toEqual(['IMPOSIBLE'])
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_CLOSE_IMPOSSIBLE' }))
  })
})

describe('registrarVentaDeLaMaquina · turno', () => {
  it('A abierto → la cuenta y el pago quedan en A', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(prismaMock.order.create.mock.calls[0][0].data.shiftId).toBe('shift-A')
    expect(pagoCreado().shiftId).toBe('shift-A')
    expect(r.body).toMatchObject({ shiftStatus: 'EN_TURNO' })
    expect(cierreCreado()).toMatchObject({ saleShiftId: 'shift-A', shiftStatus: 'EN_TURNO' })
  })

  it('🔴 A cerrado y B abierto, el dinero entró durante A → sin turno, SALE_SHIFT_CLOSED, nunca B', async () => {
    turnoA = {
      id: 'shift-A',
      status: 'CLOSED',
      endTime: new Date('2026-11-20T19:00:00.000Z'),
      startTime: new Date('2026-11-20T14:00:00.000Z'),
    }
    turnoVivo = { id: 'shift-B', status: 'OPEN' }
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(prismaMock.order.create.mock.calls[0][0].data.shiftId).toBeNull()
    expect(pagoCreado().shiftId).toBeNull()
    expect(pagoCreado().posRawData).toEqual({ ventaDeTurnoCerrado: 'shift-A' })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(r.body).toMatchObject({ shiftStatus: 'TURNO_CERRADO' })
  })

  it('🔴 el dinero entró DESPUÉS de que A terminó → por conciliar, ni A ni B', async () => {
    turnoA = {
      id: 'shift-A',
      status: 'CLOSED',
      endTime: new Date('2026-11-20T17:00:00.000Z'),
      startTime: new Date('2026-11-20T14:00:00.000Z'),
    }
    turnoVivo = { id: 'shift-B', status: 'OPEN' }
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(prismaMock.order.create.mock.calls[0][0].data.shiftId).toBeNull()
    expect(pagoCreado().shiftId).toBeNull()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
  })

  it('🔴 sin hora del cierre o sin turno de la venta → por conciliar, nunca el turno vivo', async () => {
    for (const over of [{ occurredAtKnown: false, occurredAt: null }, { saleShiftId: null }]) {
      jest.clearAllMocks()
      cierres = []
      const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta(over))
      expect(prismaMock.order.create.mock.calls[0][0].data.shiftId).toBeNull()
      expect(pagoCreado().shiftId).toBeNull()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
      expect(cierreCreado()).toMatchObject({ occurredAtKnown: over.occurredAtKnown ?? true })
    }
  })

  it('claim con porConciliar: NO_SHIFT sin sumar al turno vivo', async () => {
    const claim = await claimShiftForCapturedPayment(prismaMock as any, {
      venueId: 'venue-1',
      amountPesos: D(100),
      tipPesos: D(0),
      incrementTotalOrders: true,
      orderId: 'order-1',
      expectedShiftId: null,
      cajaCapturada: false,
      porConciliar: true,
    })
    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'NO_SHIFT', candidateShiftId: 'shift-A' })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })
})

describe('registrarVentaDeLaMaquina · sólo la PC emparejada (R4-3, R5#2)', () => {
  const NO_EMPAREJADA = { statusCode: 403, code: 'CASH_MACHINE_NOT_PAIRED' }

  it('🔴 otra caja con payments:create pero sin la credencial: 403 y no escribe nada, ni una incidencia', async () => {
    await expect(registrarVentaDeLaMaquina('venue-1', { ...AUTOR, credencial: null }, venta())).rejects.toMatchObject(NO_EMPAREJADA)
    // Ni siquiera con importes imposibles deja rastro: quien no está emparejado no escribe.
    await expect(
      registrarVentaDeLaMaquina('venue-1', { ...AUTOR, credencial: 'otra' }, venta({ changeDispensedCents: 99999 })),
    ).rejects.toMatchObject(NO_EMPAREJADA)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
    expect(incidencias).toHaveLength(0)
  })

  it('🔴 la PC revocada repite SU folio y recibe la misma respuesta, sin otra incidencia', async () => {
    const primera = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    binding = { active: false, revokedAt: new Date('2026-11-20T17:00:00.000Z') } // otra PC tomó la máquina
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta())).resolves.toEqual(primera)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(incidencias).toEqual([])
  })
})

describe('consultarVentaDeLaMaquina', () => {
  it('🔴 el GET devuelve la MISMA respuesta que el POST', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ changeDispensedCents: 1000 }))
    await expect(consultarVentaDeLaMaquina('venue-1', REF)).resolves.toEqual(r)
  })

  it('un folio sin cierre es 404', async () => {
    await expect(consultarVentaDeLaMaquina('venue-1', REF)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('Codex r1 #1 y decisión a: un folio PAGADO nace pagado y sin descuento, o no es venta', () => {
  it('🔴 #1: el servidor arma la cuenta por MÁS de lo que entró ($200 contra $187.50): 202 SIN_SALDAR, sin cierre, el dinero en la incidencia', async () => {
    subtotalDelServidor = 200
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(r).toMatchObject({ status: 202, body: { incident: 'NO_SE_PUDO_REGISTRAR', motivo: 'SIN_SALDAR', creditCents: 20000 } })
    // La transacción se revirtió antes del cierre: no queda un folio PAGADO con la cuenta debiendo.
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
    expect(incidencias.map(i => i.kind)).toEqual(['NO_SE_PUDO_REGISTRAR'])
  })

  it.each([
    ['descuento libre de la cuenta', { discount: 1000 }],
    ['descuento de catálogo de la cuenta', { orderDiscountId: 'desc-1' }],
    ['cupón', { couponCode: 'BUENFIN' }],
    ['descuento del cliente', { descuentoDelCliente: { discountId: 'desc-c', montoCents: 500 } }],
    ['premio de sellos', { stampRewardId: 'premio-1' }],
    ['cortesía de un renglón', { items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750, isCortesia: true, cortesiaReason: 'x' }] }],
    ['descuento de renglón', { items: [{ productId: 'p1', quantity: 1, discountId: 'desc-r' }] }],
    ['«Ajuste de precio»', { items: [{ productId: 'p1', quantity: 1, adjustedUnitPrice: 18000 }] }],
    [
      'promoción',
      { items: [{ productId: 'p1', quantity: 1, promotionRef: { promotionId: 'pr', promotionInstanceId: 'i', selections: [] } }] },
    ],
  ])('🔴 decisión a: %s → 202 DESCUENTO sin armar la cuenta; el dinero queda en la incidencia', async (_n, over) => {
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({}, pedido(over as Partial<CreateOrderInput>)))
    expect(r).toMatchObject({ status: 202, body: { incident: 'NO_SE_PUDO_REGISTRAR', motivo: 'DESCUENTO', creditCents: 20000 } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
  })

  it('🔴 decisión a: un descuento que el servidor pone solo (la cuenta nace con descuento) tampoco se aplica: 202 DESCUENTO', async () => {
    prismaMock.order.create.mockImplementationOnce(async ({ data }: any) => ({
      id: 'order-1',
      ...data,
      discountAmount: D(10),
      items: [],
      promotions: [],
    }))
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(r).toMatchObject({ status: 202, body: { motivo: 'DESCUENTO' } })
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
  })
})

describe('Codex r1 #3: después de un 202 el folio NO cambia de desenlace', () => {
  it('🔴 el producto vuelve: la repetición da el MISMO 202 sin armar la cuenta, y el GET también (no 404)', async () => {
    prismaMock.product.findMany.mockResolvedValue([])
    const conProductoBorrado = venta({}, pedido({ items: [{ productId: 'prod-borrado', quantity: 1 }] as any }))
    const primera = await registrarVentaDeLaMaquina('venue-1', AUTOR, conProductoBorrado)
    expect(primera.status).toBe(202)
    // Restauran el producto: el mismo folio NO se vuelve venta.
    prismaMock.product.findMany.mockReset()
    prismaMock.order.create.mockClear()
    const repetida = await registrarVentaDeLaMaquina('venue-1', AUTOR, conProductoBorrado)
    expect(repetida).toEqual(primera)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    await expect(consultarVentaDeLaMaquina('venue-1', REF)).resolves.toEqual(primera)
  })

  it('🔴 el mismo folio con otros importes después del 202: 409 con incidencia, nunca venta', async () => {
    await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({}, pedido({ discount: 500 })))
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ changeDispensedCents: 1000 }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(incidencias.map(i => i.kind)).toEqual(['NO_SE_PUDO_REGISTRAR', 'CONFLICTO'])
  })
})

describe('Codex r1 #4 (decisión e): el folio es de la PC que lo subió primero', () => {
  const PC_B = { userId: 'staff-B', deviceUid: 'pc-uid-2', credencial: 'credencial-de-la-pc' }

  it('🔴 la duda la subió A: B (emparejada con otra máquina) no la cierra — 409 con incidencia y sin venta', async () => {
    guardadas.ESPERANDO = { kind: 'ESPERANDO', deviceId: 'terminal-A', payload: {}, status: 'ABIERTO' }
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(incidencias.map(i => i.kind)).toEqual(['CONFLICTO'])
  })

  it('🔴 el cierre lo guardó A: B con los MISMOS importes recibe 409, no la evidencia de A', async () => {
    await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 'terminal-B' })
    prismaMock.cashMachineBinding.findFirst.mockResolvedValue({ active: true })
    await expect(registrarVentaDeLaMaquina('venue-1', PC_B, venta())).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 la duda de A aparece bajo el candado (carrera): la venta de B se revierte y queda el conflicto', async () => {
    // La lectura previa no la vio; dentro del candado, sí.
    prismaMock.cashMachineIncident.findUnique.mockResolvedValue(null)
    prismaMock.cashMachineIncident.findMany.mockResolvedValue([{ kind: 'ESPERANDO', deviceId: 'terminal-A' }] as any)
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta())).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
  })
})

describe('Codex r1 #5 (decisión d): la PC revocada mientras estaba sin internet', () => {
  const REVOCADA_EN = new Date('2026-11-20T18:30:00.000Z')
  beforeEach(() => {
    binding = { active: false, revokedAt: REVOCADA_EN }
  })

  it('🔴 un folio NUEVO cobrado ANTES de revocarla se registra normal Y queda TRAS_REVOCAR para revisión', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ occurredAt: '2026-11-20T18:00:00.000Z' }))
    expect(r.status).toBe(200)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(incidencias.map(i => i.kind)).toEqual(['TRAS_REVOCAR'])
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_FOLIO_AFTER_UNPAIR' }))
  })

  it('🔴 un folio cobrado DESPUÉS de revocarla, o sin hora: el dinero queda (202 PC_REVOCADA), no es venta', async () => {
    for (const over of [{ occurredAt: '2026-11-20T19:00:00.000Z' }, { occurredAtKnown: false, occurredAt: null }] as Array<
      Partial<CierreDeLaMaquina>
    >) {
      jest.clearAllMocks()
      guardadas = {}
      incidencias = []
      const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta(over))
      expect(r).toMatchObject({ status: 202, body: { motivo: 'PC_REVOCADA', creditCents: 20000 } })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(incidencias.map(i => i.kind)).toEqual(['TRAS_REVOCAR', 'NO_SE_PUDO_REGISTRAR'])
    }
  })

  it('🔴 su repetición da el MISMO 202 sin otra incidencia de revocada (ya es SU folio)', async () => {
    const primera = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ occurredAt: '2026-11-20T19:00:00.000Z' }))
    incidencias = []
    await expect(registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ occurredAt: '2026-11-20T19:00:00.000Z' }))).resolves.toEqual(primera)
    expect(incidencias).toEqual([])
  })
})

describe('Codex r1 #11 y #13: el turno de la venta', () => {
  it('🔴 #11: el dinero entró ANTES de que empezara el turno que mandó la PC → por conciliar, ni ese turno ni el vivo', async () => {
    turnoA = { id: 'shift-A', status: 'OPEN', endTime: null, startTime: new Date('2026-11-20T18:30:00.000Z') }
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(prismaMock.order.create.mock.calls[0][0].data.shiftId).toBeNull()
    expect(pagoCreado().shiftId).toBeNull()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
  })

  it('🔴 #11: el turno acreditado desaparece a media subida (un admin lo borra): SALE_SHIFT_CLOSED con SU referencia, nunca el vivo', async () => {
    turnoVivo = { id: 'shift-B', status: 'OPEN' }
    prismaMock.shift.findFirst.mockImplementation(async (a: any) => (a?.where?.id ? null : turnoVivo))
    const claim = await claimShiftForCapturedPayment(prismaMock as any, {
      venueId: 'venue-1',
      amountPesos: D(100),
      tipPesos: D(0),
      incrementTotalOrders: true,
      orderId: 'order-1',
      expectedShiftId: 'shift-A',
      cajaCapturada: false,
      turnoDelServidor: true,
    })
    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: 'shift-A' })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 #13: la venta de la máquina sin turno deja su aviso durable aunque la conciliación esté apagada', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', AUTOR, venta({ saleShiftId: null }))
    expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'CASH_MACHINE_SALE_WITHOUT_SHIFT', entityId: 'payment-1', venueId: 'venue-1' }),
      }),
    )
  })

  it('#13: en turno, sin aviso', async () => {
    await registrarVentaDeLaMaquina('venue-1', AUTOR, venta())
    expect(prismaMock.activityLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'CASH_MACHINE_SALE_WITHOUT_SHIFT' }) }),
    )
  })
})
