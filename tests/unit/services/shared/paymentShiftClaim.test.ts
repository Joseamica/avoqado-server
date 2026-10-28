import { Prisma } from '@prisma/client'

import {
  claimShiftForCompletedPayment,
  claimShiftForCapturedPayment,
  claimShiftForRefund,
  esVentaDeTurnoCerrado,
  lockExistingOrderForPayment,
  marcaDeVentaDeTurnoCerrado,
  recordPendingPaymentShiftReconciliation,
  resolvePaymentShiftReconciliationEnabled,
} from '@/services/shared/paymentShiftClaim'

const VENUE_ID = 'venue-1'
const PAYMENT_ID = 'payment-1'

function makeTx(
  candidate: { id: string; status: string } | null,
  claimedCount = 1,
  settings: { enableShifts: boolean } | null = { enableShifts: true },
  /** Los turnos que EXISTEN en este negocio (la búsqueda por id + venueId). Sin lista, cualquier id existe. */
  turnosDelNegocio?: string[],
  /** El `shiftId` que el servidor ya le puso a la orden (`order.findFirst`). */
  turnoDeLaOrden: string | null = null,
) {
  return {
    shift: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        if (typeof where?.id !== 'string') return candidate
        if (where.venueId !== VENUE_ID) return null
        return !turnosDelNegocio || turnosDelNegocio.includes(where.id) ? { id: where.id } : null
      }),
      updateMany: jest.fn().mockResolvedValue({ count: claimedCount }),
    },
    order: {
      findFirst: jest.fn().mockResolvedValue({ shiftId: turnoDeLaOrden }),
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    // ¿La orden trae un renglón con tarjeta de regalo? `null` = mercancía (o sin lectura).
    orderItem: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    venueSettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
    },
  }
}

describe('paymentShiftClaim — claim transaccional del turno para dinero capturado', () => {
  it('el wrapper probado no toca Shift cuando el Payment no está COMPLETED', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    await expect(
      claimShiftForCompletedPayment(tx as never, {
        paymentStatus: 'PENDING',
        venueId: VENUE_ID,
        amountPesos: new Prisma.Decimal('10.00'),
        tipPesos: new Prisma.Decimal('0.00'),
        incrementTotalOrders: true,
        orderId: null,
      }),
    ).resolves.toBeNull()

    expect(tx.shift.findFirst).not.toHaveBeenCalled()
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
  })

  it('el wrapper probado delega el claim canónico cuando el Payment está COMPLETED', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    await expect(
      claimShiftForCompletedPayment(tx as never, {
        paymentStatus: 'COMPLETED',
        venueId: VENUE_ID,
        amountPesos: new Prisma.Decimal('10.00'),
        tipPesos: new Prisma.Decimal('1.00'),
        incrementTotalOrders: true,
        orderId: null,
      }),
    ).resolves.toMatchObject({ shiftId: 'shift-open', pendingReason: null })

    expect(tx.shift.updateMany).toHaveBeenCalledTimes(1)
  })

  it('si falla el lookup previo del switch, conserva el default enabled y permite auditar el dinero', async () => {
    const lookup = {
      venueSettings: {
        findUnique: jest.fn().mockRejectedValue(new Error('settings timeout')),
      },
    }

    await expect(resolvePaymentShiftReconciliationEnabled(lookup as never, VENUE_ID)).resolves.toBe(true)
    expect(lookup.venueSettings.findUnique).toHaveBeenCalledTimes(1)
  })

  it('reclama con tenant/status/endTime y el claim mismo incrementa los totales en pesos', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos: new Prisma.Decimal('123.45'),
      tipPesos: new Prisma.Decimal('6.78'),
      incrementTotalOrders: true,
      orderId: null,
    })

    // 🔴 El candidato es el turno VIVO (`turnoVivoWhere`): `endTime` nulo Y estado OPEN/CLOSING.
    // Sin el filtro de estado un CLOSED con `endTime` nulo ganaba el `orderBy` y el cobro nacía
    // sin turno (revisión del 5-sep-2026).
    expect(tx.shift.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, endTime: null, status: { in: ['OPEN', 'CLOSING'] } },
      orderBy: { startTime: 'desc' },
      select: { id: true, status: true },
    })
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { id: 'shift-open', venueId: VENUE_ID, status: 'OPEN', endTime: null },
      data: {
        totalSales: { increment: new Prisma.Decimal('123.45') },
        totalTips: { increment: new Prisma.Decimal('6.78') },
        totalOrders: { increment: 1 },
      },
    })
    expect(claim).toEqual({
      shiftId: 'shift-open',
      candidateShiftId: 'shift-open',
      observedStatus: 'OPEN',
      pendingReason: null,
    })
  })

  // 🔴 Pendientes 1a (tarjetas de regalo, R3): la cuenta de tarjetas suma su dinero al turno pero no es una orden de venta.
  it('🔴 una cuenta de tarjetas (un renglón con giftCardId) suma venta y propina pero NO una orden', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })
    tx.orderItem.findFirst.mockResolvedValue({ id: 'renglon-tarjeta' })

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos: new Prisma.Decimal('300.00'),
      tipPesos: new Prisma.Decimal('0.00'),
      incrementTotalOrders: true,
      orderId: 'order-tarjetas',
    })

    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { id: 'shift-open', venueId: VENUE_ID, status: 'OPEN', endTime: null },
      data: {
        totalSales: { increment: new Prisma.Decimal('300.00') },
        totalTips: { increment: new Prisma.Decimal('0.00') },
      },
    })
    // Una sola lectura: A5 no deja mezclar tarjetas con mercancía, así que un renglón con tarjeta basta.
    expect(tx.orderItem.findFirst).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'order-tarjetas', giftCardId: { not: null } },
      select: { id: true },
    })
    expect(claim).toMatchObject({ shiftId: 'shift-open', pendingReason: null })
  })

  it('una orden de mercancía con orderId sí suma su orden', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos: new Prisma.Decimal('150.00'),
      tipPesos: new Prisma.Decimal('0.00'),
      incrementTotalOrders: true,
      orderId: 'order-mercancia',
    })

    expect(tx.shift.updateMany.mock.calls[0][0].data).toMatchObject({ totalOrders: { increment: 1 } })
    expect(tx.orderItem.findFirst).toHaveBeenCalledTimes(1)
  })

  it('sin orden (venta rápida, sombra) o con un abono que no cuenta orden, no lee renglones', async () => {
    const sinOrden = makeTx({ id: 'shift-open', status: 'OPEN' })
    await claimShiftForCapturedPayment(sinOrden as never, {
      venueId: VENUE_ID,
      amountPesos: new Prisma.Decimal('50.00'),
      tipPesos: new Prisma.Decimal('0.00'),
      incrementTotalOrders: true,
      orderId: null,
    })
    expect(sinOrden.orderItem.findFirst).not.toHaveBeenCalled()
    expect(sinOrden.shift.updateMany.mock.calls[0][0].data).toMatchObject({ totalOrders: { increment: 1 } })

    const segundoAbono = makeTx({ id: 'shift-open', status: 'OPEN' })
    await claimShiftForCapturedPayment(segundoAbono as never, {
      venueId: VENUE_ID,
      amountPesos: new Prisma.Decimal('50.00'),
      tipPesos: new Prisma.Decimal('0.00'),
      incrementTotalOrders: false,
      orderId: 'order-1',
    })
    expect(segundoAbono.orderItem.findFirst).not.toHaveBeenCalled()
    expect(segundoAbono.shift.updateMany.mock.calls[0][0].data).not.toHaveProperty('totalOrders')
  })

  it('si el cierre gana entre la lectura y el CAS no sella el turno y deja una anomalía atómica exacta', async () => {
    const tx = makeTx({ id: 'shift-closed-by-race', status: 'OPEN' }, 0)
    const amountPesos = new Prisma.Decimal('100.00')
    const tipPesos = new Prisma.Decimal('12.34')

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos,
      tipPesos,
      incrementTotalOrders: true,
      orderId: null,
    })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: 'order-1',
      staffId: 'staff-1',
      channel: 'recordOrderPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: true,
    })

    expect(claim.shiftId).toBeNull()
    expect(claim.pendingReason).toBe('CLAIM_LOST')
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: PAYMENT_ID,
        staffId: 'staff-1',
        venueId: VENUE_ID,
        data: {
          status: 'PENDING',
          reason: 'CLAIM_LOST',
          candidateShiftId: 'shift-closed-by-race',
          observedShiftStatus: 'OPEN',
          paymentId: PAYMENT_ID,
          orderId: 'order-1',
          channel: 'recordOrderPayment',
          amountPesos: '100.00',
          tipPesos: '12.34',
          totalPesos: '112.34',
        },
      },
    })
  })

  it('un turno ya CLOSING se conserva como candidato, no se muta y queda explícito', async () => {
    const tx = makeTx({ id: 'shift-closing', status: 'CLOSING' })
    const amountPesos = new Prisma.Decimal('25.00')
    const tipPesos = new Prisma.Decimal('0.00')

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos,
      tipPesos,
      incrementTotalOrders: true,
      orderId: null,
    })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: null,
      staffId: null,
      channel: 'recordFastPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: true,
    })

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-closing',
      observedStatus: 'CLOSING',
      pendingReason: 'SHIFT_NOT_OPEN',
    })
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('un venue sin turno captura igual y deja una sola conciliación explícita; un claim ganador no audita', async () => {
    const tx = makeTx(null)
    const amountPesos = new Prisma.Decimal('50.00')
    const tipPesos = new Prisma.Decimal('0.00')

    const missing = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos,
      tipPesos,
      incrementTotalOrders: true,
      orderId: null,
    })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim: missing,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: 'order-1',
      staffId: 'staff-1',
      channel: 'payCashOrder',
      amountPesos,
      tipPesos,
      reconciliationEnabled: true,
    })

    expect(missing.pendingReason).toBe('NO_SHIFT')
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      reason: 'NO_SHIFT',
      channel: 'payCashOrder',
      totalPesos: '50.00',
    })

    tx.activityLog.create.mockClear()
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim: { shiftId: 'shift-winner', candidateShiftId: 'shift-winner', observedStatus: 'OPEN', pendingReason: null },
      venueId: VENUE_ID,
      paymentId: 'payment-2',
      orderId: 'order-2',
      staffId: 'staff-1',
      channel: 'payCashOrder',
      amountPesos,
      tipPesos,
      reconciliationEnabled: true,
    })
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(tx.venueSettings.findUnique).not.toHaveBeenCalled()
  })

  it('respeta enableShifts ?? true: false silencia y una fila ausente conserva la alerta', async () => {
    const amountPesos = new Prisma.Decimal('80.00')
    const tipPesos = new Prisma.Decimal('8.00')
    const claim = { shiftId: null, candidateShiftId: null, observedStatus: null, pendingReason: 'NO_SHIFT' as const }
    const disabledTx = makeTx(null, 1, { enableShifts: false })

    const disabled = await resolvePaymentShiftReconciliationEnabled(disabledTx as never, VENUE_ID)
    await recordPendingPaymentShiftReconciliation(disabledTx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: null,
      staffId: 'staff-1',
      channel: 'recordFastPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: disabled,
    })

    expect(disabledTx.activityLog.create).not.toHaveBeenCalled()

    const defaultOnTx = makeTx(null, 1, null)
    const defaultOn = await resolvePaymentShiftReconciliationEnabled(defaultOnTx as never, VENUE_ID)
    await recordPendingPaymentShiftReconciliation(defaultOnTx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: null,
      staffId: 'staff-1',
      channel: 'recordFastPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: defaultOn,
    })

    expect(defaultOnTx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(defaultOnTx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      amountPesos: '80.00',
      tipPesos: '8.00',
      totalPesos: '88.00',
      reason: 'NO_SHIFT',
    })
  })
})

// 🔴 «Cobrar sin red» (S5, D4): la cola de la terminal manda el turno en que se VENDIÓ. Si ya no es el vivo, la venta no entra al nuevo.
describe('paymentShiftClaim — el turno de la venta (expectedShiftId)', () => {
  const base = {
    venueId: VENUE_ID,
    amountPesos: new Prisma.Decimal('100.00'),
    tipPesos: new Prisma.Decimal('5.00'),
    incrementTotalOrders: true,
    orderId: null,
  }

  it('turno de la venta = el vivo ⇒ como hoy: lo reclama y suma', async () => {
    const tx = makeTx({ id: 'turno-A', status: 'OPEN' })

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })

    expect(claim).toEqual({ shiftId: 'turno-A', candidateShiftId: 'turno-A', observedStatus: 'OPEN', pendingReason: null })
    expect(tx.shift.updateMany).toHaveBeenCalledTimes(1)
  })

  it('turno de la venta cerrado y otro abierto ⇒ sin turno, SALE_SHIFT_CLOSED y NO toca los totales del vivo', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' })

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })

    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'turno-B',
      observedStatus: 'OPEN',
      pendingReason: 'SALE_SHIFT_CLOSED',
      saleShiftId: 'turno-A',
    })
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(tx.orderItem.findFirst).not.toHaveBeenCalled()
  })

  it('turno de la venta cerrado y ninguno abierto ⇒ SALE_SHIFT_CLOSED sin candidato', async () => {
    const tx = makeTx(null)

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })

    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: null,
      observedStatus: null,
      pendingReason: 'SALE_SHIFT_CLOSED',
      saleShiftId: 'turno-A',
    })
  })

  it('el turno de la venta se está cerrando (CLOSING) ⇒ SALE_SHIFT_CLOSED: ya no es el vivo OPEN', async () => {
    const tx = makeTx({ id: 'turno-A', status: 'CLOSING' })

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })

    expect(claim).toMatchObject({
      shiftId: null,
      candidateShiftId: 'turno-A',
      observedStatus: 'CLOSING',
      pendingReason: 'SALE_SHIFT_CLOSED',
    })
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
  })

  it('sin turno de la venta (ausente, null o vacío) ⇒ como hoy: el vivo', async () => {
    for (const expectedShiftId of [undefined, null, '']) {
      const tx = makeTx({ id: 'turno-B', status: 'OPEN' })
      const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId })
      expect(claim).toEqual({ shiftId: 'turno-B', candidateShiftId: 'turno-B', observedStatus: 'OPEN', pendingReason: null })
    }
  })

  it('turno de la venta = el vivo pero el cierre gana el CAS ⇒ SALE_SHIFT_CLOSED (lo cerró otro aparato), no CLAIM_LOST', async () => {
    const tx = makeTx({ id: 'turno-A', status: 'OPEN' }, 0)

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })

    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'turno-A',
      observedStatus: 'OPEN',
      pendingReason: 'SALE_SHIFT_CLOSED',
      saleShiftId: 'turno-A',
    })
  })

  it('el wrapper de la terminal (COMPLETED) también lo respeta', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' })

    const claim = await claimShiftForCompletedPayment(tx as never, { ...base, paymentStatus: 'COMPLETED', expectedShiftId: 'turno-A' })

    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: 'turno-A' })
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
  })

  it('la conciliación PAYMENT_WITHOUT_SHIFT lleva el motivo y el turno de la venta; sin turnos en el negocio, nada', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' })
    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })
    const conciliar = (reconciliationEnabled: boolean) =>
      recordPendingPaymentShiftReconciliation(tx as never, {
        claim,
        venueId: VENUE_ID,
        paymentId: PAYMENT_ID,
        orderId: 'order-1',
        staffId: 'staff-1',
        channel: 'recordFastPayment',
        amountPesos: base.amountPesos,
        tipPesos: base.tipPesos,
        reconciliationEnabled,
      })

    await conciliar(true)
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create.mock.calls[0][0].data).toMatchObject({ action: 'PAYMENT_WITHOUT_SHIFT', entityId: PAYMENT_ID })
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      status: 'PENDING',
      reason: 'SALE_SHIFT_CLOSED',
      saleShiftId: 'turno-A',
      candidateShiftId: 'turno-B',
      totalPesos: '105.00',
    })

    tx.activityLog.create.mockClear()
    await conciliar(false)
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  // 🔴 Codex servidor r1 #1: un turno inventado (o de otro negocio) sacaba el efectivo del arqueo. Sólo un turno REAL de ESTE
  // negocio puede sacar la venta del turno vivo; cualquier otro valor se ignora (como si no viniera: el vivo, como hoy).
  it.each([
    ['NO-EXISTE', ['turno-A']],
    ['turno-de-otro-negocio', ['turno-A']],
  ])('turno de la venta %s ⇒ se ignora: el vivo lo reclama y suma, sin SALE_SHIFT_CLOSED', async (pedido, existentes) => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, 1, { enableShifts: true }, existentes)

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: pedido })

    expect(claim).toEqual({ shiftId: 'turno-B', candidateShiftId: 'turno-B', observedStatus: 'OPEN', pendingReason: null })
    expect(tx.shift.updateMany).toHaveBeenCalledTimes(1)
    // La búsqueda va acotada al negocio: un id de otro negocio no existe aquí.
    expect(tx.shift.findFirst).toHaveBeenCalledWith({ where: { id: pedido, venueId: VENUE_ID }, select: { id: true } })
  })

  it('turno de la venta inventado y ningún turno vivo ⇒ como hoy: NO_SHIFT, nunca SALE_SHIFT_CLOSED', async () => {
    const tx = makeTx(null, 1, { enableShifts: true }, [])

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'NO-EXISTE' })

    expect(claim).toEqual({ shiftId: null, candidateShiftId: null, observedStatus: null, pendingReason: 'NO_SHIFT' })
  })

  it('turno de la venta REAL y cerrado ⇒ SALE_SHIFT_CLOSED, como hasta ahora', async () => {
    const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, 1, { enableShifts: true }, ['turno-A', 'turno-B'])

    const claim = await claimShiftForCapturedPayment(tx as never, { ...base, expectedShiftId: 'turno-A' })

    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: 'turno-A' })
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
  })

  // 🔴 Codex servidor r1 #2: la terminal creó la orden EN LÍNEA (el servidor la puso en el turno vivo B) creyendo seguir en A, perdió
  // la respuesta y subió el pago por la cola con A. El turno que el servidor le dio a la orden manda: el de la terminal estaba viejo.
  describe('la orden ya tiene turno del servidor', () => {
    const conOrden = { ...base, orderId: 'order-1' }

    it('orden en B (el vivo) y la terminal manda A (cerrado) ⇒ el pago va a B, como la orden', async () => {
      const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, 1, { enableShifts: true }, ['turno-A', 'turno-B'], 'turno-B')

      const claim = await claimShiftForCapturedPayment(tx as never, { ...conOrden, expectedShiftId: 'turno-A' })

      expect(claim).toEqual({ shiftId: 'turno-B', candidateShiftId: 'turno-B', observedStatus: 'OPEN', pendingReason: null })
      expect(tx.shift.updateMany).toHaveBeenCalledTimes(1)
      expect(tx.order.findFirst).toHaveBeenCalledWith({ where: { id: 'order-1', venueId: VENUE_ID }, select: { shiftId: true } })
    })

    it('orden en B, que también se cerró (C es el vivo) ⇒ SALE_SHIFT_CLOSED contra B, el turno de la orden', async () => {
      const tx = makeTx({ id: 'turno-C', status: 'OPEN' }, 1, { enableShifts: true }, ['turno-A', 'turno-B', 'turno-C'], 'turno-B')

      const claim = await claimShiftForCapturedPayment(tx as never, { ...conOrden, expectedShiftId: 'turno-A' })

      expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: 'turno-B' })
      expect(tx.shift.updateMany).not.toHaveBeenCalled()
    })

    it('orden sin turno ⇒ el turno de la venta validado: A cerrado ⇒ SALE_SHIFT_CLOSED contra A', async () => {
      const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, 1, { enableShifts: true }, ['turno-A', 'turno-B'], null)

      const claim = await claimShiftForCapturedPayment(tx as never, { ...conOrden, expectedShiftId: 'turno-A' })

      expect(claim).toMatchObject({ shiftId: null, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: 'turno-A' })
    })

    it('la terminal manda el vivo ⇒ el vivo, aunque la orden sea de un turno anterior (cuenta abierta que se cobra hoy)', async () => {
      const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, 1, { enableShifts: true }, ['turno-A', 'turno-B'], 'turno-A')

      const claim = await claimShiftForCapturedPayment(tx as never, { ...conOrden, expectedShiftId: 'turno-B' })

      expect(claim).toEqual({ shiftId: 'turno-B', candidateShiftId: 'turno-B', observedStatus: 'OPEN', pendingReason: null })
    })

    it('turno de la venta inventado ⇒ se ignora entero (ni siquiera se consulta la orden): el vivo', async () => {
      const tx = makeTx({ id: 'turno-B', status: 'OPEN' }, 1, { enableShifts: true }, ['turno-B'], 'turno-A')

      const claim = await claimShiftForCapturedPayment(tx as never, { ...conOrden, expectedShiftId: 'NO-EXISTE' })

      expect(claim).toMatchObject({ shiftId: 'turno-B', pendingReason: null })
      expect(tx.order.findFirst).not.toHaveBeenCalled()
    })
  })
})

describe('paymentShiftClaim — claim transaccional del turno para reembolsos', () => {
  it('historial de componentes incompleto: observa OPEN pero fuerza pendiente sin decrementarlo', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    const claim = await claimShiftForRefund(
      tx as never,
      {
        venueId: VENUE_ID,
        salesRefundPesos: new Prisma.Decimal('20.00'),
        tipRefundPesos: new Prisma.Decimal('10.00'),
        forcePendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
      } as never,
    )

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-open',
      observedStatus: 'OPEN',
      pendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
    })

    await recordPendingPaymentShiftReconciliation(
      tx as never,
      {
        claim,
        venueId: VENUE_ID,
        paymentId: PAYMENT_ID,
        orderId: 'order-1',
        staffId: 'staff-1',
        channel: 'issueRefund',
        amountPesos: new Prisma.Decimal('-20.00'),
        tipPesos: new Prisma.Decimal('-10.00'),
        unclassifiedPriorRefundPesos: new Prisma.Decimal('40.00'),
        reconciliationEnabled: true,
      } as never,
    )

    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: PAYMENT_ID,
        staffId: 'staff-1',
        venueId: VENUE_ID,
        data: {
          status: 'PENDING',
          reason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
          candidateShiftId: 'shift-open',
          observedShiftStatus: 'OPEN',
          paymentId: PAYMENT_ID,
          orderId: 'order-1',
          channel: 'issueRefund',
          amountPesos: '-20.00',
          tipPesos: '-10.00',
          totalPesos: '-30.00',
          shiftAttributionStatus: 'PENDING',
          unclassifiedPriorRefundPesos: '40.00',
        },
      },
    })
  })

  it('historial de componentes incompleto: sin candidato conserva la razón de historia y tampoco muta', async () => {
    const tx = makeTx(null)

    const claim = await claimShiftForRefund(
      tx as never,
      {
        venueId: VENUE_ID,
        salesRefundPesos: new Prisma.Decimal('30.00'),
        tipRefundPesos: new Prisma.Decimal('0.00'),
        forcePendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
      } as never,
    )

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: null,
      observedStatus: null,
      pendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
    })
  })

  it('reclama el turno OPEN con un solo decremento tenant-safe de venta y propina', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    const claim = await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('45.67'),
      tipRefundPesos: new Prisma.Decimal('4.33'),
    })

    expect(tx.shift.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, endTime: null, status: { in: ['OPEN', 'CLOSING'] } },
      orderBy: { startTime: 'desc' },
      select: { id: true, status: true },
    })
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { id: 'shift-open', venueId: VENUE_ID, status: 'OPEN', endTime: null },
      data: {
        totalSales: { decrement: new Prisma.Decimal('45.67') },
        totalTips: { decrement: new Prisma.Decimal('4.33') },
      },
    })
    expect(claim).toEqual({
      shiftId: 'shift-open',
      candidateShiftId: 'shift-open',
      observedStatus: 'OPEN',
      pendingReason: null,
    })
  })

  it('trata CLOSING como dinero post-corte: conserva candidato y nunca lo decrementa', async () => {
    const tx = makeTx({ id: 'shift-closing', status: 'CLOSING' })

    const claim = await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('50.00'),
      tipRefundPesos: new Prisma.Decimal('10.00'),
    })

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-closing',
      observedStatus: 'CLOSING',
      pendingReason: 'SHIFT_NOT_OPEN',
    })
  })

  it('si el cierre gana el CAS, conserva el OPEN observado como claim perdido sin atribuir turno', async () => {
    const tx = makeTx({ id: 'shift-lost', status: 'OPEN' }, 0)

    const claim = await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('50.00'),
      tipRefundPesos: new Prisma.Decimal('0.00'),
    })

    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-lost',
      observedStatus: 'OPEN',
      pendingReason: 'CLAIM_LOST',
    })
  })

  it('omite totalTips cuando la devolución no incluye propina', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('50.00'),
      tipRefundPesos: new Prisma.Decimal('0.00'),
    })

    expect(tx.shift.updateMany.mock.calls[0][0].data).toEqual({
      totalSales: { decrement: new Prisma.Decimal('50.00') },
    })
  })
})

describe('lockExistingOrderForPayment — el candado de la Order decide dinero y nunca contesta en silencio', () => {
  const input = { venueId: VENUE_ID, orderId: 'order-1' }

  it('una transacción sin $queryRaw revienta con un mensaje claro: false significaría «la orden no es de este venue»', async () => {
    const txSinQueryRaw = makeTx({ id: 'shift-open', status: 'OPEN' })

    await expect(lockExistingOrderForPayment(txSinQueryRaw as never, input)).rejects.toThrow(
      'lockExistingOrderForPayment requiere una transacción con $queryRaw',
    )
    expect(txSinQueryRaw.shift.findFirst).not.toHaveBeenCalled()
  })

  // Regresión: el contrato del SELECT … FOR UPDATE no cambia.
  it('devuelve true sólo cuando el SELECT … FOR UPDATE trae exactamente la fila de la orden del venue', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'order-1' }]) }

    await expect(lockExistingOrderForPayment(tx as never, input)).resolves.toBe(true)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('devuelve false cuando ninguna fila se bloquea: la orden ya no pertenece a este venue', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) }

    await expect(lockExistingOrderForPayment(tx as never, input)).resolves.toBe(false)
  })
  it('conserva false para un lector que no devuelve filas', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(undefined) }
    await expect(lockExistingOrderForPayment(tx as never, input)).resolves.toBe(false)
  })
})

// 🔴 Revisión de S5 #1: el efectivo de la venta tardía ya lo contó el cajón de SU turno (cerrado). La marca va en la MISMA fila del
// Payment (`posRawData`) para que el cajón —en línea y el barrido de respaldo— no lo sume a la caja abierta de hoy.
describe('marca de venta de un turno cerrado (Payment.posRawData)', () => {
  it('sólo existe con turno de la venta; se reconoce en la fila y nada más la confunde', () => {
    expect(marcaDeVentaDeTurnoCerrado('turno-A')).toEqual({ ventaDeTurnoCerrado: 'turno-A' })
    expect(marcaDeVentaDeTurnoCerrado(undefined)).toBeUndefined()

    expect(esVentaDeTurnoCerrado({ splitType: 'FULLPAYMENT', ventaDeTurnoCerrado: 'turno-A' })).toBe(true)
    for (const otra of [null, undefined, {}, { splitType: 'FULLPAYMENT' }, ['ventaDeTurnoCerrado'], 'ventaDeTurnoCerrado']) {
      expect(esVentaDeTurnoCerrado(otra as never)).toBe(false)
    }
  })
})
