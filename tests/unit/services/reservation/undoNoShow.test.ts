import { prismaMock } from '@tests/__helpers__/setup'
import { Prisma } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

/**
 * D4 · deshacer un «No asistió» (Task 1).
 *
 * `planUndoNoShow` decide QUÉ revertir con lo que el «No asistió» dejó escrito: la clase que se le devolvió
 * (REFUND «No-show refund…») se vuelve a descontar del MISMO saldo si todavía hay de dónde; la multa que no se cobró
 * se anula; el depósito retenido vuelve a PAID. Lo que no se puede revertir solo queda como pendiente para una persona.
 *
 * `undoNoShow` lo aplica: candado de la reserva PRIMERO, CAS NO_SHOW → CHECKED_IN, una corrección por reserva.
 */
const NOW = new Date('2026-10-28T15:00:00Z')

/**
 * Hallazgo #1 de Codex r2: una clase también se paga con una VENTA ligada a la reserva («Inscribir y cobrar» del POS
 * deja `Order.reservationId`), y una clase de $0 no se debe. El mock filtra con el `where` que manda el servicio: si
 * faltara el filtro de venta viva o el de cobrada, los casos CANCELLED/REFUNDED/PENDING lo delatan.
 */
type Venta = { status: string; paymentStatus: string }
const ventas = (...orders: Venta[]) =>
  jest.fn(async ({ where }: any) => {
    const o = orders.find(
      x => !(where.status?.notIn ?? []).includes(x.status) && (where.paymentStatus?.in ?? [x.paymentStatus]).includes(x.paymentStatus),
    )
    return o && where.reservationId === 'res-1' && where.venueId === 'venue-1' ? { id: 'ord-1' } : null
  })
const COBRO_DE_LA_CLASE: Array<[string, Venta[], number, string[]]> = [
  ['venta viva PAID («Inscribir y cobrar»)', [{ status: 'COMPLETED', paymentStatus: 'PAID' }], 200, []],
  ['venta viva PARTIAL (con abono)', [{ status: 'PENDING', paymentStatus: 'PARTIAL' }], 200, []],
  ['venta CANCELLED que estaba pagada', [{ status: 'CANCELLED', paymentStatus: 'PAID' }], 200, ['CLASS_UNPAID']],
  ['venta DELETED que estaba pagada', [{ status: 'DELETED', paymentStatus: 'PAID' }], 200, ['CLASS_UNPAID']],
  ['venta viva REFUNDED', [{ status: 'COMPLETED', paymentStatus: 'REFUNDED' }], 200, ['CLASS_UNPAID']],
  ['venta viva sin cobrar (PENDING)', [{ status: 'PENDING', paymentStatus: 'PENDING' }], 200, ['CLASS_UNPAID']],
  ['sin venta y clase gratis ($0)', [], 0, []],
  ['sin venta y clase de $200', [], 200, ['CLASS_UNPAID']],
]

/**
 * Hallazgo #1 de Codex r4: lo que la reserva guardó al reservar (`depositAmount`, p. ej. «paga en sucursal»: monto
 * puesto y `depositStatus` null) manda sobre el precio de HOY del catálogo. Sin monto guardado, el precio de hoy.
 * [caso, depositAmount, precio de hoy, pendientes]
 */
const MONTO_GUARDADO: Array<[string, number | null, number, string[]]> = [
  ['guardó $200 para pagar en sucursal y hoy la clase cuesta $0', 200, 0, ['CLASS_UNPAID']],
  ['guardó $0 y hoy la clase cuesta $200', 0, 200, []],
  ['sin monto guardado y hoy la clase cuesta $0 (como hoy)', null, 0, []],
]
const montoGuardado = (depositAmount: number | null, price: number) => ({
  classSessionId: 'cs-1',
  depositStatus: null,
  depositAmount: depositAmount == null ? null : new Prisma.Decimal(depositAmount),
  noShowFeeAmount: null,
  noShowFeeCapturedAt: null,
  product: { price: new Prisma.Decimal(price) },
})

describe('D4 · planUndoNoShow', () => {
  const base = { depositStatus: null, noShowFeeAmount: null, noShowFeeCapturedAt: null }
  const redeem = { type: 'REDEEM', quantity: -1, reason: null, creditItemBalanceId: 'bal-1' }
  const refund = { type: 'REFUND', quantity: 1, reason: 'No-show refund — policy: ALWAYS', creditItemBalanceId: 'bal-1' }
  const saldo = (over: Record<string, unknown> = {}) => ({
    id: 'bal-1',
    remainingQuantity: 2,
    purchaseStatus: 'ACTIVE',
    expiresAt: new Date('2026-11-28T00:00:00Z'),
    packName: '5 clases de yoga',
    ...over,
  })

  const plan = async (input: any) => (await import('@/services/reservation/undoNoShow.service')).planUndoNoShow({ now: NOW, ...input })

  it('🔴 una CLASE sin paquete ni depósito: nada que revertir y queda «clase no pagada»', async () => {
    expect(await plan({ reservation: { ...base, classSessionId: 'cs-1' }, creditTxs: [], balances: [] })).toEqual({
      creditToReconsume: 0,
      clearFee: false,
      restoreDeposit: false,
      feeAmount: null,
      depositAmount: null,
      packName: null,
      pending: ['CLASS_UNPAID'],
    })
  })

  it.each([
    ['sin classSessionId (mesa o cita)', { ...base, classSessionId: null }],
    ['classSessionId ausente', base],
  ])('🔴 %s, sin paquete ni depósito: NO inventa «clase no pagada» (no hay clase que cobrar)', async (_caso, reservation) => {
    expect(await plan({ reservation, creditTxs: [], balances: [] })).toEqual({
      creditToReconsume: 0,
      clearFee: false,
      restoreDeposit: false,
      feeAmount: null,
      depositAmount: null,
      packName: null,
      pending: [],
    })
  })

  it('una clase con depósito retenido o con paquete canjeado no queda «clase no pagada»', async () => {
    const clase = { ...base, classSessionId: 'cs-1' }
    expect((await plan({ reservation: { ...clase, depositStatus: 'FORFEITED' }, creditTxs: [], balances: [] })).pending).toEqual([])
    expect((await plan({ reservation: clase, creditTxs: [redeem], balances: [saldo()] })).pending).toEqual([])
  })

  it('🔴 una clase cobrada en caja (venta viva PAID o PARTIAL) no queda «clase no pagada»', async () => {
    const clase = { ...base, classSessionId: 'cs-1' }
    expect((await plan({ reservation: clase, paidOrder: true, creditTxs: [], balances: [] })).pending).toEqual([])
    expect((await plan({ reservation: clase, paidOrder: false, creditTxs: [], balances: [] })).pending).toEqual(['CLASS_UNPAID'])
  })

  it.each([
    ['$0', { price: 0 }, []],
    ['$0.00 (Decimal)', { price: new Prisma.Decimal('0.00') }, []],
    ['$200', { price: new Prisma.Decimal('200') }, ['CLASS_UNPAID']],
    ['sin producto (no se sabe el precio)', null, ['CLASS_UNPAID']],
  ])('🔴 clase de %s sin paquete, depósito ni venta', async (_caso, product, pending) => {
    const reservation = { ...base, classSessionId: 'cs-1', product }
    expect((await plan({ reservation, creditTxs: [], balances: [] })).pending).toEqual(pending)
  })

  it.each(MONTO_GUARDADO)('🔴 %s (Codex r4 #1)', async (_caso, depositAmount, price, pending) => {
    expect((await plan({ reservation: montoGuardado(depositAmount, price), creditTxs: [], balances: [] })).pending).toEqual(pending)
  })

  it('🔴 la clase que se devolvió al faltar se vuelve a descontar del mismo saldo', async () => {
    expect(await plan({ reservation: base, creditTxs: [redeem, refund], balances: [saldo()] })).toEqual({
      creditToReconsume: 1,
      clearFee: false,
      restoreDeposit: false,
      feeAmount: null,
      depositAmount: null,
      packName: '5 clases de yoga',
      pending: [],
    })
  })

  it.each([
    ['saldo en 0', saldo({ remainingQuantity: 0 })],
    ['compra EXPIRED', saldo({ purchaseStatus: 'EXPIRED' })],
    ['paquete vencido', saldo({ expiresAt: new Date('2026-10-27T00:00:00Z') })],
  ])('🔴 %s: no hay de dónde descontar ⇒ pendiente CREDIT_NOT_RECONSUMED', async (_caso, balance) => {
    expect(await plan({ reservation: base, creditTxs: [redeem, refund], balances: [balance] })).toEqual({
      creditToReconsume: 0,
      clearFee: false,
      restoreDeposit: false,
      feeAmount: null,
      depositAmount: null,
      packName: null,
      pending: ['CREDIT_NOT_RECONSUMED'],
    })
  })

  it('🔴 si ya se volvió a descontar («No-show undo»), no se descuenta dos veces', async () => {
    const undo = { type: 'REDEEM', quantity: -1, reason: 'No-show undo', creditItemBalanceId: 'bal-1' }
    expect(await plan({ reservation: base, creditTxs: [redeem, refund, undo], balances: [saldo()] })).toEqual({
      creditToReconsume: 0,
      clearFee: false,
      restoreDeposit: false,
      feeAmount: null,
      depositAmount: null,
      packName: null,
      pending: [],
    })
  })

  it('una devolución por CANCELACIÓN no se re-descuenta (sólo la del «No asistió»)', async () => {
    const cancel = { ...refund, reason: 'Cancellation refund — policy: ALWAYS' }
    expect((await plan({ reservation: base, creditTxs: [redeem, cancel], balances: [saldo()] })).creditToReconsume).toBe(0)
  })

  it('depósito retenido (FORFEITED) ⇒ vuelve a PAID', async () => {
    const p = await plan({ reservation: { ...base, depositStatus: 'FORFEITED' }, creditTxs: [], balances: [] })
    expect(p.restoreDeposit).toBe(true)
    expect(p.pending).toEqual([])
  })

  it('multa anotada y NO cobrada ⇒ se anula', async () => {
    const p = await plan({ reservation: { ...base, depositStatus: 'FORFEITED', noShowFeeAmount: 50 }, creditTxs: [], balances: [] })
    expect(p.clearFee).toBe(true)
    expect(p.pending).toEqual([])
  })

  it('🔴 multa YA cobrada ⇒ no se toca y queda FEE_CAPTURED', async () => {
    const p = await plan({
      reservation: { ...base, depositStatus: 'FORFEITED', noShowFeeAmount: 50, noShowFeeCapturedAt: new Date('2026-10-28T14:00:00Z') },
      creditTxs: [],
      balances: [],
    })
    expect(p.clearFee).toBe(false)
    expect(p.pending).toEqual(expect.arrayContaining(['FEE_CAPTURED']))
  })

  it('pagada con paquete y sin devolución: nada que revertir ni pendiente', async () => {
    expect(await plan({ reservation: base, creditTxs: [redeem], balances: [saldo()] })).toEqual({
      creditToReconsume: 0,
      clearFee: false,
      restoreDeposit: false,
      feeAmount: null,
      depositAmount: null,
      packName: null,
      pending: [],
    })
  })

  describe('montos y nombre del paquete (para que la ventana diga exactamente qué se revierte)', () => {
    it('🔴 multa anotada y depósito retenido ⇒ sus montos en número con 2 decimales (Decimal incluido)', async () => {
      const decimal = (v: string) => ({ toString: () => v, valueOf: () => v }) // como Prisma.Decimal: Number(x) lo lee
      const p = await plan({
        reservation: { ...base, depositStatus: 'FORFEITED', noShowFeeAmount: decimal('50.5'), depositAmount: decimal('100') },
        creditTxs: [],
        balances: [],
      })
      expect(p.feeAmount).toBe(50.5)
      expect(p.depositAmount).toBe(100)
      expect(p.packName).toBeNull()
    })

    it('🔴 sólo hay monto de lo que SÍ se revierte: multa ya cobrada o depósito que no se retuvo ⇒ null', async () => {
      const cobrada = await plan({
        reservation: {
          ...base,
          depositStatus: 'PAID',
          noShowFeeAmount: 50,
          noShowFeeCapturedAt: new Date('2026-10-28T14:00:00Z'),
          depositAmount: 100,
        },
        creditTxs: [],
        balances: [],
      })
      expect(cobrada).toMatchObject({ clearFee: false, feeAmount: null, restoreDeposit: false, depositAmount: null })
    })

    it('depósito retenido sin monto escrito ⇒ restoreDeposit sí, depositAmount null (el texto cae al genérico)', async () => {
      const p = await plan({ reservation: { ...base, depositStatus: 'FORFEITED', depositAmount: null }, creditTxs: [], balances: [] })
      expect(p).toMatchObject({ restoreDeposit: true, depositAmount: null })
    })

    it('el nombre del paquete es el de la clase que se vuelve a descontar', async () => {
      const p = await plan({ reservation: base, creditTxs: [redeem, refund], balances: [saldo({ packName: 'Paquete mensual' })] })
      expect(p).toMatchObject({ creditToReconsume: 1, packName: 'Paquete mensual' })
    })

    it('si no hay de dónde descontar, no hay nombre de paquete', async () => {
      const p = await plan({ reservation: base, creditTxs: [redeem, refund], balances: [saldo({ remainingQuantity: 0 })] })
      expect(p).toMatchObject({ creditToReconsume: 0, packName: null })
    })

    it('🔴 varios paquetes: el nombre es el del primero por id de saldo, sin importar el orden de las transacciones', async () => {
      const refund2 = { ...refund, creditItemBalanceId: 'bal-2' }
      const p = await plan({
        reservation: base,
        creditTxs: [refund2, refund],
        balances: [saldo({ id: 'bal-2', packName: 'Zeta' }), saldo({ id: 'bal-1', packName: 'Alfa' })],
      })
      expect(p).toMatchObject({ creditToReconsume: 2, packName: 'Alfa' })
    })

    it('el primer saldo sin de dónde descontar no da su nombre: lo da el primero que sí se descuenta', async () => {
      const refund2 = { ...refund, creditItemBalanceId: 'bal-2' }
      const p = await plan({
        reservation: base,
        creditTxs: [refund, refund2],
        balances: [saldo({ id: 'bal-1', packName: 'Alfa', remainingQuantity: 0 }), saldo({ id: 'bal-2', packName: 'Zeta' })],
      })
      expect(p).toMatchObject({ creditToReconsume: 1, packName: 'Zeta' })
    })
  })
})

describe('D4 · undoNoShow', () => {
  const staffActor = { type: 'HUMAN' as const, staffId: 'staff-1' }
  const kioskActor = { type: 'SERVICE' as const, servicePrincipalId: 'kiosk-1' }
  const noShow = {
    id: 'res-1',
    venueId: 'venue-1',
    status: 'NO_SHOW',
    confirmationCode: 'ABC123',
    customerId: 'cust-1',
    depositStatus: 'FORFEITED',
    depositAmount: 100,
    noShowFeeAmount: 50,
    noShowFeeCapturedAt: null,
    noShowAt: new Date('2026-10-28T14:00:00Z'),
    statusLog: [
      { status: 'CONFIRMED', at: '2026-10-27T10:00:00Z', by: 'staff-9' },
      { status: 'NO_SHOW', at: '2026-10-28T14:00:00Z', by: 'SYSTEM' },
    ],
  }
  const txs = [
    { type: 'REDEEM', quantity: -1, reason: null, creditItemBalanceId: 'bal-1' },
    { type: 'REFUND', quantity: 1, reason: 'No-show refund — policy: ALWAYS', creditItemBalanceId: 'bal-1' },
  ]
  const balanceRow = {
    id: 'bal-1',
    remainingQuantity: 1,
    creditPackPurchaseId: 'pur-1',
    creditPackPurchase: { status: 'ACTIVE', expiresAt: null, customerId: 'cust-1', creditPack: { name: '5 clases de yoga' } },
  }

  let calls: string[]
  let tx: any
  let reservation: any
  let correction: any

  const tracked = (name: string, impl: (...a: any[]) => any) =>
    jest.fn((...a: any[]) => {
      calls.push(name)
      return impl(...a)
    })

  beforeEach(() => {
    jest.clearAllMocks()
    calls = []
    reservation = { ...noShow }
    correction = null
    tx = {
      $queryRaw: tracked('$queryRaw', (strings: TemplateStringsArray) => {
        const sql = strings.join('?')
        if (sql.includes('"Reservation"')) return Promise.resolve([{ id: reservation.id, status: reservation.status }])
        return Promise.resolve([{ id: 'bal-1' }])
      }),
      reservation: {
        findFirst: tracked('reservation.findFirst', () => Promise.resolve(reservation)),
        updateMany: tracked('reservation.updateMany', () => Promise.resolve({ count: 1 })),
        findUniqueOrThrow: tracked('reservation.findUniqueOrThrow', () => Promise.resolve({ ...reservation, status: 'CHECKED_IN' })),
      },
      reservationNoShowCorrection: {
        findUnique: tracked('correction.findUnique', () => Promise.resolve(correction)),
        create: tracked('correction.create', ({ data }: any) =>
          Promise.resolve({ id: 'corr-1', pending: data.pending, resolvedAt: null, plan: data.plan }),
        ),
      },
      aggregatorBooking: { findUnique: tracked('aggregatorBooking.findUnique', () => Promise.resolve(null)) },
      creditTransaction: {
        findMany: tracked('creditTransaction.findMany', () => Promise.resolve(txs)),
        create: tracked('creditTransaction.create', () => Promise.resolve({})),
      },
      creditItemBalance: {
        findMany: tracked('creditItemBalance.findMany', () => Promise.resolve([balanceRow])),
        update: tracked('creditItemBalance.update', () => Promise.resolve({})),
        count: tracked('creditItemBalance.count', () => Promise.resolve(0)),
      },
      creditPackPurchase: { updateMany: tracked('creditPackPurchase.updateMany', () => Promise.resolve({ count: 1 })) },
      order: { findFirst: tracked('order.findFirst', () => Promise.resolve(null)) },
      staffVenue: { findFirst: tracked('staffVenue.findFirst', () => Promise.resolve({ id: 'sv-1' })) },
      venue: { findUniqueOrThrow: jest.fn().mockResolvedValue({ organizationId: 'org-1' }) },
      activityLog: { create: tracked('activityLog.create', () => Promise.resolve({})) },
    }
  })

  const cmd = (over: Record<string, unknown> = {}) => ({
    reservationId: 'res-1',
    venueId: 'venue-1',
    actor: staffActor,
    source: 'DASHBOARD' as const,
    now: NOW,
    ...over,
  })
  const svc = () => import('@/services/reservation/undoNoShow.service')
  const writes = () => calls.filter(c => /\.(updateMany|create|update)$/.test(c))

  it('🔴 lo PRIMERO es el candado FOR UPDATE de la reserva; las lecturas van después', async () => {
    const { undoNoShow } = await svc()
    await undoNoShow(tx, cmd())

    expect(calls[0]).toBe('$queryRaw')
    const [strings, ...values] = tx.$queryRaw.mock.calls[0]
    const sql = (strings as string[]).join('?')
    expect(sql).toMatch(/FROM "Reservation"/)
    expect(sql).toMatch(/FOR UPDATE/)
    expect(sql).toMatch(/"venueId"/)
    expect(values).toEqual(['res-1', 'venue-1'])
  })

  it('🔴 el saldo que se re-descuenta se bloquea FOR UPDATE antes de escribir', async () => {
    const { undoNoShow } = await svc()
    await undoNoShow(tx, cmd())

    const balanceLock = tx.$queryRaw.mock.calls.findIndex((c: any[]) => (c[0] as string[]).join('?').includes('"CreditItemBalance"'))
    expect(balanceLock).toBe(1)
    expect((tx.$queryRaw.mock.calls[1][0] as string[]).join('?')).toMatch(/FOR UPDATE/)
    expect(calls.indexOf('$queryRaw', 1)).toBeLessThan(calls.indexOf('creditItemBalance.update'))
  })

  it('🔴 CHECKED_IN con corrección ⇒ ALREADY_UNDONE sin escribir nada', async () => {
    reservation = { ...noShow, status: 'CHECKED_IN' }
    correction = {
      id: 'corr-1',
      pending: [],
      resolvedAt: null,
      plan: { creditToReconsume: 1, clearFee: true, restoreDeposit: true, pending: [] },
    }
    const { undoNoShow } = await svc()

    const res = await undoNoShow(tx, cmd())

    expect(res.outcome).toBe('ALREADY_UNDONE')
    expect(res.correction).toEqual({ id: 'corr-1', pending: [], resolvedAt: null })
    expect(res.plan).toEqual(correction.plan)
    expect(writes()).toEqual([])
  })

  it.each(['CONFIRMED', 'CANCELLED', 'COMPLETED', 'PENDING'])('%s ⇒ 409 NO_SHOW_UNDO_NOT_APPLICABLE', async status => {
    reservation = { ...noShow, status }
    const { undoNoShow } = await svc()

    await expect(undoNoShow(tx, cmd())).rejects.toMatchObject({ statusCode: 409, code: 'NO_SHOW_UNDO_NOT_APPLICABLE' })
    expect(writes()).toEqual([])
  })

  it('CHECKED_IN SIN corrección (un check-in normal) ⇒ 409 NO_SHOW_UNDO_NOT_APPLICABLE', async () => {
    reservation = { ...noShow, status: 'CHECKED_IN' }
    const { undoNoShow } = await svc()

    await expect(undoNoShow(tx, cmd())).rejects.toMatchObject({ code: 'NO_SHOW_UNDO_NOT_APPLICABLE' })
    expect(writes()).toEqual([])
  })

  it('reserva de un pase (TotalPass/Wellhub) ⇒ 409 NO_SHOW_UNDO_PASS_BOOKING', async () => {
    tx.aggregatorBooking.findUnique = jest.fn().mockResolvedValue({ id: 'ab-1' })
    const { undoNoShow } = await svc()

    await expect(undoNoShow(tx, cmd())).rejects.toMatchObject({ statusCode: 409, code: 'NO_SHOW_UNDO_PASS_BOOKING' })
    expect(writes()).toEqual([])
  })

  it('reserva de otro negocio ⇒ 404', async () => {
    tx.$queryRaw = jest.fn().mockResolvedValue([])
    const { undoNoShow } = await svc()

    await expect(undoNoShow(tx, cmd())).rejects.toMatchObject({ statusCode: 404 })
  })

  it('🔴 caso feliz: CAS NO_SHOW → CHECKED_IN con depósito PAID, multa anulada y bitácora de corrección', async () => {
    const { undoNoShow } = await svc()

    const res = await undoNoShow(tx, cmd({ reason: 'sí vino, no tocó el kiosco' }))

    expect(res.outcome).toBe('UNDONE')
    expect(res.plan).toEqual({
      creditToReconsume: 1,
      clearFee: true,
      restoreDeposit: true,
      feeAmount: 50,
      depositAmount: 100,
      packName: '5 clases de yoga',
      pending: [],
    })
    const { where, data } = tx.reservation.updateMany.mock.calls[0][0]
    expect(where).toEqual({ id: 'res-1', venueId: 'venue-1', status: 'NO_SHOW' })
    expect(data).toEqual(
      expect.objectContaining({
        status: 'CHECKED_IN',
        noShowAt: null,
        checkedInAt: NOW,
        depositStatus: 'PAID',
        noShowFeeAmount: null,
      }),
    )
    expect(data.statusLog.at(-1)).toEqual({
      status: 'CHECKED_IN',
      at: NOW.toISOString(),
      by: 'staff-1',
      source: 'DASHBOARD',
      correctionOf: 'NO_SHOW',
      reason: 'sí vino, no tocó el kiosco',
    })
    expect(data.statusLog).toHaveLength(3) // el «No asistió» se conserva
  })

  it('la hora de llegada del kiosco (arrivedAt) es el checkedInAt', async () => {
    const arrivedAt = new Date('2026-10-28T13:58:00Z')
    const { undoNoShow } = await svc()

    await undoNoShow(tx, cmd({ actor: kioskActor, source: 'KIOSK', arrivedAt }))

    expect(tx.reservation.updateMany.mock.calls[0][0].data.checkedInAt).toEqual(arrivedAt)
  })

  it('🔴 el REDEEM «No-show undo» lleva createdById = StaffVenue.id del actor y deja la compra EXHAUSTED si se acaba', async () => {
    const { undoNoShow } = await svc()

    await undoNoShow(tx, cmd())

    expect(tx.staffVenue.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { staffId: 'staff-1', venueId: 'venue-1' } }))
    expect(tx.creditItemBalance.update).toHaveBeenCalledWith({ where: { id: 'bal-1' }, data: { remainingQuantity: { decrement: 1 } } })
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: {
        venueId: 'venue-1',
        customerId: 'cust-1',
        creditPackPurchaseId: 'pur-1',
        creditItemBalanceId: 'bal-1',
        type: 'REDEEM',
        quantity: -1,
        reservationId: 'res-1',
        reason: 'No-show undo',
        createdById: 'sv-1',
      },
    })
    expect(tx.creditPackPurchase.updateMany).toHaveBeenCalledWith({
      where: { id: 'pur-1', status: 'ACTIVE' },
      data: { status: 'EXHAUSTED' },
    })
  })

  it('🔴 el nombre del paquete sale de la MISMA lectura de saldos (sin consulta extra) y el ActivityLog guarda los montos', async () => {
    const { undoNoShow } = await svc()

    await undoNoShow(tx, cmd())

    expect(tx.creditItemBalance.findMany).toHaveBeenCalledTimes(1)
    expect(tx.creditItemBalance.findMany.mock.calls[0][0].select.creditPackPurchase.select.creditPack).toEqual({ select: { name: true } })
    expect(calls.filter(c => c === 'creditPack.findMany' || c === 'creditPack.findUnique')).toEqual([])
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      feeAmount: 50,
      depositAmount: 100,
      packName: '5 clases de yoga',
    })
  })

  it('el kiosco (actor SERVICE) re-descuenta con createdById null', async () => {
    const { undoNoShow } = await svc()

    await undoNoShow(tx, cmd({ actor: kioskActor, source: 'KIOSK' }))

    expect(tx.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(tx.creditTransaction.create.mock.calls[0][0].data.createdById).toBeNull()
  })

  it('🔴 guarda UNA corrección y el ActivityLog con el Staff.id', async () => {
    const { undoNoShow } = await svc()

    const res = await undoNoShow(tx, cmd())

    expect(tx.reservationNoShowCorrection.create).toHaveBeenCalledWith({
      data: {
        venueId: 'venue-1',
        reservationId: 'res-1',
        source: 'DASHBOARD',
        actorStaffId: 'staff-1',
        plan: {
          creditToReconsume: 1,
          clearFee: true,
          restoreDeposit: true,
          feeAmount: 50,
          depositAmount: 100,
          packName: '5 clases de yoga',
          pending: [],
        },
        pending: [],
      },
    })
    expect(res.correction).toEqual({ id: 'corr-1', pending: [], resolvedAt: null })
    expect(tx.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'RESERVATION_NO_SHOW_UNDONE',
          entity: 'Reservation',
          entityId: 'res-1',
          staffId: 'staff-1',
          venueId: 'venue-1',
        }),
      }),
    )
  })

  it('sin saldo para re-descontar: no escribe REDEEM y la corrección guarda el pendiente', async () => {
    tx.creditItemBalance.findMany = jest.fn().mockResolvedValue([{ ...balanceRow, remainingQuantity: 0 }])
    const { undoNoShow } = await svc()

    const res = await undoNoShow(tx, cmd())

    expect(res.plan.pending).toEqual(['CREDIT_NOT_RECONSUMED'])
    expect(tx.creditTransaction.create).not.toHaveBeenCalled()
    expect(tx.reservationNoShowCorrection.create.mock.calls[0][0].data.pending).toEqual(['CREDIT_NOT_RECONSUMED'])
  })

  describe('🔴 «clase no pagada» sólo para CLASES (hallazgo #2 de Codex)', () => {
    const sinPago = { depositStatus: null, depositAmount: null, noShowFeeAmount: null }

    it('una clase sin canje ni depósito ⇒ la corrección guarda CLASS_UNPAID', async () => {
      reservation = { ...noShow, ...sinPago, classSessionId: 'cs-1' }
      tx.creditTransaction.findMany = jest.fn().mockResolvedValue([])
      const { undoNoShow } = await svc()

      const res = await undoNoShow(tx, cmd())

      expect(res.plan.pending).toEqual(['CLASS_UNPAID'])
      expect(tx.reservationNoShowCorrection.create.mock.calls[0][0].data.pending).toEqual(['CLASS_UNPAID'])
    })

    it('una mesa o cita (sin classSessionId) sin canje ni depósito ⇒ ningún pendiente', async () => {
      reservation = { ...noShow, ...sinPago, classSessionId: null }
      tx.creditTransaction.findMany = jest.fn().mockResolvedValue([])
      const { undoNoShow } = await svc()

      const res = await undoNoShow(tx, cmd())

      expect(res.plan.pending).toEqual([])
      expect(tx.reservationNoShowCorrection.create.mock.calls[0][0].data.pending).toEqual([])
      expect(tx.order.findFirst).not.toHaveBeenCalled() // sin clase no hay qué cobrar: ni se pregunta
    })
  })

  describe('🔴 «clase no pagada» NO si se cobró en caja o es gratis (hallazgo #1 de Codex r2)', () => {
    const sinPago = { depositStatus: null, depositAmount: null, noShowFeeAmount: null }

    it.each(COBRO_DE_LA_CLASE)('%s ⇒ la corrección guarda lo que corresponde', async (_caso, orders, price, pending) => {
      reservation = { ...noShow, ...sinPago, classSessionId: 'cs-1', product: { price: new Prisma.Decimal(price) } }
      tx.creditTransaction.findMany = jest.fn().mockResolvedValue([])
      tx.order.findFirst = ventas(...orders)
      const { undoNoShow } = await svc()

      const res = await undoNoShow(tx, cmd())

      expect(res.plan.pending).toEqual(pending)
      expect(tx.reservationNoShowCorrection.create.mock.calls[0][0].data.pending).toEqual(pending)
    })

    it.each(MONTO_GUARDADO)(
      '🔴 %s ⇒ la corrección guarda lo que corresponde (Codex r4 #1)',
      async (_caso, depositAmount, price, pending) => {
        reservation = { ...noShow, ...montoGuardado(depositAmount, price) }
        tx.creditTransaction.findMany = jest.fn().mockResolvedValue([])
        const { undoNoShow } = await svc()

        const res = await undoNoShow(tx, cmd())

        expect(res.plan.pending).toEqual(pending)
        expect(tx.reservationNoShowCorrection.create.mock.calls[0][0].data.pending).toEqual(pending)
      },
    )

    it('🔴 la venta y el precio se leen en la MISMA transacción, después del candado de la reserva', async () => {
      reservation = { ...noShow, ...sinPago, classSessionId: 'cs-1' }
      tx.creditTransaction.findMany = jest.fn().mockResolvedValue([])
      const { undoNoShow } = await svc()

      await undoNoShow(tx, cmd())

      expect(calls.indexOf('order.findFirst')).toBeGreaterThan(calls.indexOf('$queryRaw'))
      expect(tx.order.findFirst).toHaveBeenCalledWith({
        where: {
          venueId: 'venue-1',
          reservationId: 'res-1',
          status: { notIn: ['CANCELLED', 'DELETED'] },
          paymentStatus: { in: ['PAID', 'PARTIAL'] },
        },
        select: { id: true },
      })
      expect(tx.reservation.findFirst.mock.calls[0][0]).toMatchObject({ include: { product: { select: { price: true } } } })
    })
  })
})

describe('D4 · previewUndoNoShow', () => {
  const previewClient = (status: string, passBooking: { id: string } | null = null, classSessionId: string | null = null): any => ({
    $queryRaw: jest.fn(),
    reservation: {
      findFirst: jest.fn().mockResolvedValue({
        status,
        classSessionId,
        depositStatus: null,
        depositAmount: null,
        noShowFeeAmount: null,
        noShowFeeCapturedAt: null,
      }),
    },
    aggregatorBooking: { findUnique: jest.fn().mockResolvedValue(passBooking) },
    creditTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    order: { findFirst: jest.fn().mockResolvedValue(null) },
  })

  it.each(COBRO_DE_LA_CLASE)(
    '🔴 %s ⇒ la vista previa dice lo que corresponde (hallazgo #1 de Codex r2)',
    async (_caso, orders, price, pending) => {
      const client = previewClient('NO_SHOW', null, 'cs-1')
      client.reservation.findFirst.mockResolvedValue({
        status: 'NO_SHOW',
        classSessionId: 'cs-1',
        depositStatus: null,
        depositAmount: null,
        noShowFeeAmount: null,
        noShowFeeCapturedAt: null,
        product: { price: new Prisma.Decimal(price) },
      })
      client.order.findFirst = ventas(...orders)
      const { previewUndoNoShow } = await import('@/services/reservation/undoNoShow.service')

      expect((await previewUndoNoShow(client, 'venue-1', 'res-1', NOW)).pending).toEqual(pending)
    },
  )

  it.each(MONTO_GUARDADO)('🔴 %s ⇒ la vista previa dice lo que corresponde (Codex r4 #1)', async (_caso, depositAmount, price, pending) => {
    const client = previewClient('NO_SHOW', null, 'cs-1')
    client.reservation.findFirst.mockResolvedValue({ status: 'NO_SHOW', ...montoGuardado(depositAmount, price) })
    const { previewUndoNoShow } = await import('@/services/reservation/undoNoShow.service')

    expect((await previewUndoNoShow(client, 'venue-1', 'res-1', NOW)).pending).toEqual(pending)
  })

  it('🔴 la vista previa lee el precio de la clase en la misma lectura de la reserva', async () => {
    const client = previewClient('NO_SHOW', null, 'cs-1')
    const { previewUndoNoShow } = await import('@/services/reservation/undoNoShow.service')

    await previewUndoNoShow(client, 'venue-1', 'res-1', NOW)

    expect(client.reservation.findFirst.mock.calls[0][0].select).toMatchObject({ product: { select: { price: true } } })
    expect(client.order.findFirst).toHaveBeenCalledTimes(1)
  })

  it.each(['CONFIRMED', 'CHECKED_IN', 'CANCELLED'])(
    'reserva en %s ⇒ 409 NO_SHOW_UNDO_NOT_APPLICABLE (también una llegada ya corregida: sólo el POST dice ALREADY_UNDONE)',
    async status => {
      const client = previewClient(status)
      const { previewUndoNoShow, NO_SHOW_UNDO_NOT_APPLICABLE } = await import('@/services/reservation/undoNoShow.service')

      const err = await previewUndoNoShow(client, 'venue-1', 'res-1', NOW).catch(e => e)

      expect(err).toBeInstanceOf(ConflictError)
      expect(err.statusCode).toBe(409)
      expect(err.code).toBe(NO_SHOW_UNDO_NOT_APPLICABLE)
      expect(client.creditTransaction.findMany).not.toHaveBeenCalled()
    },
  )

  it('reserva de un pase en NO_SHOW ⇒ 409 NO_SHOW_UNDO_PASS_BOOKING', async () => {
    const client = previewClient('NO_SHOW', { id: 'booking-1' })
    const { previewUndoNoShow, NO_SHOW_UNDO_PASS_BOOKING } = await import('@/services/reservation/undoNoShow.service')

    const err = await previewUndoNoShow(client, 'venue-1', 'res-1', NOW).catch(e => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect(err.code).toBe(NO_SHOW_UNDO_PASS_BOOKING)
    expect(client.aggregatorBooking.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { reservationId: 'res-1' } }))
    expect(client.creditTransaction.findMany).not.toHaveBeenCalled()
  })

  it('🔴 la vista previa lee classSessionId y sólo una CLASE sin pago deja «clase no pagada»', async () => {
    const { previewUndoNoShow } = await import('@/services/reservation/undoNoShow.service')
    const clase = previewClient('NO_SHOW', null, 'cs-1')
    const mesa = previewClient('NO_SHOW', null, null)

    expect((await previewUndoNoShow(clase, 'venue-1', 'res-1', NOW)).pending).toEqual(['CLASS_UNPAID'])
    expect((await previewUndoNoShow(mesa, 'venue-1', 'res-1', NOW)).pending).toEqual([])
    expect(clase.reservation.findFirst.mock.calls[0][0].select).toMatchObject({ classSessionId: true })
  })

  it('NO_SHOW ⇒ el mismo plan que aplicaría, sin FOR UPDATE ni escrituras', async () => {
    const client: any = {
      $queryRaw: jest.fn(),
      reservation: {
        findFirst: jest.fn().mockResolvedValue({
          status: 'NO_SHOW',
          depositStatus: 'FORFEITED',
          depositAmount: new Prisma.Decimal('100'),
          noShowFeeAmount: new Prisma.Decimal('50.00'),
          noShowFeeCapturedAt: null,
        }),
      },
      aggregatorBooking: { findUnique: jest.fn().mockResolvedValue(null) },
      creditTransaction: {
        findMany: jest.fn().mockResolvedValue([
          { type: 'REDEEM', quantity: -1, reason: null, creditItemBalanceId: 'bal-1' },
          { type: 'REFUND', quantity: 1, reason: 'No-show refund — policy: ALWAYS', creditItemBalanceId: 'bal-1' },
        ]),
      },
      creditItemBalance: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bal-1',
            remainingQuantity: 3,
            creditPackPurchaseId: 'pur-1',
            creditPackPurchase: { status: 'ACTIVE', expiresAt: null, customerId: 'c', creditPack: { name: '5 clases de yoga' } },
          },
        ]),
      },
    }
    const { previewUndoNoShow } = await import('@/services/reservation/undoNoShow.service')

    expect(await previewUndoNoShow(client, 'venue-1', 'res-1', NOW)).toEqual({
      creditToReconsume: 1,
      clearFee: true,
      restoreDeposit: true,
      feeAmount: 50,
      depositAmount: 100,
      packName: '5 clases de yoga',
      pending: [],
    })
    expect(client.reservation.findFirst.mock.calls[0][0].select).toMatchObject({ depositAmount: true, noShowFeeAmount: true })
    expect(client.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('D4 · resolveNoShowCorrection', () => {
  beforeEach(() => jest.clearAllMocks())

  it('marca resuelta con quién y la nota, y deja ActivityLog', async () => {
    prismaMock.reservationNoShowCorrection.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.venue.findUniqueOrThrow.mockResolvedValue({ organizationId: 'org-1' })
    const { resolveNoShowCorrection } = await import('@/services/reservation/undoNoShow.service')

    const { resolvedAt } = await resolveNoShowCorrection('venue-1', 'res-1', 'staff-2', 'se cobró en caja')

    expect(resolvedAt).toBeInstanceOf(Date)
    expect(prismaMock.reservationNoShowCorrection.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-1', reservationId: 'res-1', resolvedAt: null },
      data: { resolvedAt, resolvedByStaffId: 'staff-2', resolvedNote: 'se cobró en caja' },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'RESERVATION_NO_SHOW_CORRECTION_RESOLVED', staffId: 'staff-2' }) }),
    )
  })

  it('anota desde dónde se resolvió (source) en el ActivityLog; sin source queda null', async () => {
    prismaMock.reservationNoShowCorrection.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.venue.findUniqueOrThrow.mockResolvedValue({ organizationId: 'org-1' })
    const { resolveNoShowCorrection } = await import('@/services/reservation/undoNoShow.service')

    await resolveNoShowCorrection('venue-1', 'res-1', 'staff-2', 'ok', 'POS_IOS')
    await resolveNoShowCorrection('venue-1', 'res-1', 'staff-2')

    expect(prismaMock.activityLog.create.mock.calls[0][0].data.data).toEqual({ note: 'ok', source: 'POS_IOS' })
    expect(prismaMock.activityLog.create.mock.calls[1][0].data.data).toEqual({ note: null, source: null })
  })

  it('🔴 sobre una ya resuelta ⇒ devuelve la fecha de antes sin escribir', async () => {
    const antes = new Date('2026-10-28T12:00:00Z')
    prismaMock.reservationNoShowCorrection.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.reservationNoShowCorrection.findFirst.mockResolvedValue({ resolvedAt: antes })
    const { resolveNoShowCorrection } = await import('@/services/reservation/undoNoShow.service')

    expect(await resolveNoShowCorrection('venue-1', 'res-1', 'staff-2')).toEqual({ resolvedAt: antes })
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('sin corrección ⇒ 404', async () => {
    prismaMock.reservationNoShowCorrection.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.reservationNoShowCorrection.findFirst.mockResolvedValue(null)
    const { resolveNoShowCorrection } = await import('@/services/reservation/undoNoShow.service')

    await expect(resolveNoShowCorrection('venue-1', 'res-1', 'staff-2')).rejects.toMatchObject({ statusCode: 404 })
  })
})
