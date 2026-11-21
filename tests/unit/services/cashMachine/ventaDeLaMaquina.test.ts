/**
 * Máquina de efectivo 1a (R4-1, R4-7, R3#6, R3#9, R5#1, R5#5, R5#7 y el rediseño tras la ronda 3 de Codex). La venta de la PC: la
 * evidencia se guarda PRIMERO (folio congelado + observación + desenlace) y después la cuenta nace, se paga y se cierra en UNA
 * transacción (nadie la ve abierta), con la venta y la propina aparte, en pesos, sin tocar el cajón. La repetición devuelve lo mismo; lo
 * contradictorio, lo imposible y lo que ya no se puede armar quedan como incidencia DURABLE.
 *
 * Corre el núcleo real (`crearVentaDeMostradorEnTx` + `registrarAbonoEnTx`) contra el doble de Prisma, con las tablas de la máquina en
 * memoria (`arnesDeLaMaquina.ts`). Los casos exactos de Codex r3 y r6 están en `redisenoR3.test.ts`.
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

import { logAction } from '@/services/dashboard/activity-log.service'
import { consultarVentaDeLaMaquina, registrarVentaDeLaMaquina, type CierreDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
import { claimShiftForCapturedPayment } from '@/services/shared/paymentShiftClaim'
import { prismaMock } from '../../../__helpers__/setup'
import { CARRITO, D, PC, REF, VENUE, cierre, lector, prepararArnes, type Arnes } from '../../../__helpers__/arnesDeLaMaquina'

let a: Arnes
beforeEach(() => {
  jest.clearAllMocks()
  a = prepararArnes(prismaMock)
})

const vender = (over: Partial<CierreDeLaMaquina> = {}, pedido: unknown = CARRITO, autor = PC) =>
  registrarVentaDeLaMaquina(VENUE, autor, { referenceCC: REF, cierre: cierre(over), pedido }, lector)
const pagoCreado = () => prismaMock.payment.create.mock.calls[0]?.[0]?.data
const acciones = () => (logAction as jest.Mock).mock.calls.map(c => c[0].action)

describe('registrarVentaDeLaMaquina · PAGADO', () => {
  it('🔴 18750 centavos llegan como Payment.amount = 187.50 pesos, con la semántica de la máquina y la llave del folio', async () => {
    const r = await vender()
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
      processedById: 'staff-cajera',
    })
    expect(prismaMock.order.create.mock.calls[0][0].data).toMatchObject({ externalId: `maquina-${REF}`, tableId: null })
    expect(prismaMock.order.updateMany.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED' })
  })

  it('🔴 cambio que faltó (250) → CAMBIO; la respuesta trae el acuse TERMINADO, el dueño, el desenlace y qué se debe', async () => {
    const r = await vender({ changeDispensedCents: 1000 })
    expect(r.body).toEqual({
      ack: 'TERMINADO',
      referenceCC: REF,
      deviceId: 'terminal-pc',
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
    expect(a.base.cierres[0]).toMatchObject({ deviceId: 'terminal-pc', resolvedBy: 'MAQUINA', owedKind: 'CAMBIO', owedCents: 250 })
    expect(acciones()).toContain('CASH_MACHINE_OWES_CUSTOMER')
  })

  it('🔴 la propina va aparte: $100 + $10 → amount 100.00 y tip 10.00, sin deuda falsa', async () => {
    a.subtotal.pesos = 100
    const r = await vender({ dueCents: 11000, saleCents: 10000, tipCents: 1000, creditCents: 11000, changeDispensedCents: 0 })
    expect(pagoCreado()).toMatchObject({ amount: 100, tipAmount: 10 })
    expect(r.body).toMatchObject({ appliedCents: 10000, excedenteCents: 0, owedCents: 0, owedKind: null })
  })

  it('🔴 el servidor cobra menos (186.20 contra 187.50): se paga 186.20, excedente 130 y la cuenta queda pagada exacta', async () => {
    a.subtotal.pesos = 186.2
    const r = await vender()
    expect(pagoCreado()).toMatchObject({ amount: 186.2 })
    expect(r.body).toMatchObject({ appliedCents: 18620, excedenteCents: 130, owedCents: 130, owedKind: 'EXCEDENTE' })
  })

  it('🔴 no toca el cajón aunque haya una caja abierta (NOT_DRAWER_CASH)', async () => {
    await vender()
    expect(prismaMock.cashDrawerEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.cashDrawerEvent.upsert).not.toHaveBeenCalled()
  })

  it('🔴 un producto que ya no existe: 202 TERMINADO NO_SE_PUDO_REGISTRAR, cierre físico e incidencia con el dinero, sin pago', async () => {
    prismaMock.product.findMany.mockResolvedValue([])
    const r = await vender({}, { ...CARRITO, items: [{ productId: 'prod-borrado', quantity: 1 }] })
    expect(r).toMatchObject({
      status: 202,
      body: {
        ack: 'TERMINADO',
        deviceId: 'terminal-pc',
        incident: 'NO_SE_PUDO_REGISTRAR',
        motivo: 'VENTA_RECHAZADA',
        creditCents: 20000,
        changeDispensedCents: 1250,
        owedKind: null,
        owedCents: 0,
      },
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(a.base.cierres[0]).toMatchObject({ motivoSinRegistro: 'VENTA_RECHAZADA', orderId: null, paymentId: null })
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['NO_SE_PUDO_REGISTRAR'])
    expect(acciones()).toContain('CASH_MACHINE_SALE_NOT_RECORDED')
  })
})

describe('registrarVentaDeLaMaquina · repetición y conflicto', () => {
  it('🔴 la misma operación otra vez (acuse perdido): la MISMA respuesta, un solo pago y una sola observación', async () => {
    const primera = await vender()
    const segunda = await vender()
    expect(segunda).toEqual(primera)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(a.base.cierres).toHaveLength(1)
    expect(a.base.observaciones).toHaveLength(1)
  })

  it('🔴 otro crédito con el mismo folio: 409 con la evidencia guardada (incidentId) y sin otro pago', async () => {
    await vender()
    await expect(vender({ creditCents: 19000, changeDispensedCents: 250 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
      details: expect.objectContaining({ motivo: 'OTRA_EVIDENCIA', deviceId: 'terminal-pc', incidentId: expect.any(String) }),
    })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(a.base.incidencias.map(i => i.kind)).toEqual(['CONFLICTO'])
    expect(acciones()).toContain('CASH_MACHINE_CLOSE_CONFLICT')
  })

  it('🔴 R5#7: GUARDADO y CANCELADO con cifras idénticas son operaciones DISTINTAS; la repetición del GUARDADO es la misma respuesta', async () => {
    const iguales = { creditCents: 5000, changeDispensedCents: 0 }
    const r = await vender({ outcome: 'GUARDADO', cancelMode: '2', ...iguales }, undefined)
    expect(r.body).toMatchObject({ outcome: 'GUARDADO', owedKind: 'GUARDADO', owedCents: 5000, orderId: null, paymentId: null })
    await expect(vender({ outcome: 'CANCELADO', cancelMode: '1', ...iguales }, undefined)).rejects.toMatchObject({ statusCode: 409 })
    await expect(vender({ outcome: 'GUARDADO', cancelMode: '2', ...iguales }, undefined)).resolves.toEqual(r)
  })

  it('🔴 después de un 202 el producto vuelve: la repetición da el MISMO 202 sin armar la cuenta, y el GET también', async () => {
    prismaMock.product.findMany.mockResolvedValue([])
    const conProductoBorrado = { ...CARRITO, items: [{ productId: 'prod-borrado', quantity: 1 }] }
    const primera = await vender({}, conProductoBorrado)
    expect(primera.status).toBe(202)
    prismaMock.product.findMany.mockReset()
    prismaMock.order.create.mockClear()
    await expect(vender({}, conProductoBorrado)).resolves.toEqual(primera)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    await expect(consultarVentaDeLaMaquina(VENUE, REF)).resolves.toEqual(primera)
  })
})

describe('registrarVentaDeLaMaquina · imposibles (422)', () => {
  it.each([
    ['PAGADO con cambio mayor que crédito − adeudo', { changeDispensedCents: 1300 }],
    ['GUARDADO que devolvió algo', { outcome: 'GUARDADO', cancelMode: '2', creditCents: 5000, changeDispensedCents: 100 }],
    ['CANCELADO con el crédito completo', { outcome: 'CANCELADO', cancelMode: '1', creditCents: 18750, changeDispensedCents: 0 }],
    ['GUARDADO con el crédito completo', { outcome: 'GUARDADO', cancelMode: '2', creditCents: 20000, changeDispensedCents: 0 }],
    [
      '🔴 un adeudo que la máquina no cobra ($187.35)',
      { dueCents: 18735, saleCents: 18735, creditCents: 20000, changeDispensedCents: 1265 },
    ],
    ['🔴 una cuenta de $0', { dueCents: 0, saleCents: 0, creditCents: 0, changeDispensedCents: 0 }],
    ['🔴 una cancelación sin el modo del cancel', { outcome: 'CANCELADO', creditCents: 5000, changeDispensedCents: 5000 }],
  ] as const)(
    '%s → 422 con su incidencia y su observación, sin desenlace ni pago (el folio queda congelado, F12)',
    async (_nombre, over) => {
      await expect(vender(over as Partial<CierreDeLaMaquina>)).rejects.toMatchObject({
        statusCode: 422,
        code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
        details: { incidentId: expect.any(String) },
      })
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(a.base.cierres).toEqual([])
      expect(a.base.folios).toEqual([expect.objectContaining({ deviceId: 'terminal-pc', decision: null })])
      expect(a.base.incidencias.map(i => i.kind)).toEqual(['IMPOSIBLE'])
      expect(a.base.observaciones).toHaveLength(1)
      expect(acciones()).toContain('CASH_MACHINE_CLOSE_IMPOSSIBLE')
    },
  )
})

describe('registrarVentaDeLaMaquina · turno (el congelado del folio)', () => {
  it('A abierto → la cuenta y el pago quedan en A', async () => {
    const r = await vender()
    expect(prismaMock.order.create.mock.calls[0][0].data.shiftId).toBe('shift-A')
    expect(pagoCreado().shiftId).toBe('shift-A')
    expect(r.body).toMatchObject({ shiftStatus: 'EN_TURNO' })
    expect(a.base.cierres[0]).toMatchObject({ saleShiftId: 'shift-A', shiftStatus: 'EN_TURNO' })
  })

  it('🔴 A cerrado y B abierto, el dinero entró durante A → sin turno, SALE_SHIFT_CLOSED, nunca B', async () => {
    a.turnoA = {
      id: 'shift-A',
      status: 'CLOSED',
      endTime: new Date('2026-11-20T19:00:00.000Z'),
      startTime: new Date('2026-11-20T14:00:00.000Z'),
    }
    const r = await vender()
    expect(pagoCreado().shiftId).toBeNull()
    expect(pagoCreado().posRawData).toEqual({ ventaDeTurnoCerrado: 'shift-A' })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(r.body).toMatchObject({ shiftStatus: 'TURNO_CERRADO' })
  })

  it('🔴 el dinero entró DESPUÉS de que A terminó, o ANTES de que empezara → por conciliar, ni A ni B', async () => {
    for (const turnoA of [
      { id: 'shift-A', status: 'CLOSED', endTime: new Date('2026-11-20T17:00:00.000Z'), startTime: new Date('2026-11-20T14:00:00.000Z') },
      { id: 'shift-A', status: 'OPEN', endTime: null, startTime: new Date('2026-11-20T18:30:00.000Z') },
    ]) {
      jest.clearAllMocks()
      a = prepararArnes(prismaMock)
      a.turnoA = turnoA
      const r = await vender()
      expect(pagoCreado().shiftId).toBeNull()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
    }
  })

  it('🔴 sin hora del cierre o sin turno de la venta → por conciliar, nunca el turno vivo', async () => {
    for (const over of [{ occurredAtKnown: false, occurredAt: null }, { saleShiftId: null }]) {
      jest.clearAllMocks()
      a = prepararArnes(prismaMock)
      const r = await vender(over)
      expect(pagoCreado().shiftId).toBeNull()
      expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
      expect(a.base.cierres[0]).toMatchObject({ occurredAtKnown: over.occurredAtKnown ?? true })
    }
  })

  it('🔴 Codex r1 #13: la venta sin turno deja su aviso durable en la misma transacción; en turno, no', async () => {
    await vender({ saleShiftId: null })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'CASH_MACHINE_SALE_WITHOUT_SHIFT' }) }),
    )
    jest.clearAllMocks()
    a = prepararArnes(prismaMock)
    await vender()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'CASH_MACHINE_SALE_WITHOUT_SHIFT' }) }),
    )
  })

  it('claim con porConciliar: NO_SHIFT sin sumar al turno vivo', async () => {
    const claim = await claimShiftForCapturedPayment(prismaMock as any, {
      venueId: VENUE,
      amountPesos: D(100),
      tipPesos: D(0),
      incrementTotalOrders: true,
      orderId: 'order-1',
      expectedShiftId: null,
      cajaCapturada: false,
      porConciliar: true,
    })
    expect(claim).toMatchObject({ shiftId: null, pendingReason: 'NO_SHIFT' })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })
})

describe('registrarVentaDeLaMaquina · sólo la PC emparejada (R4-3, R5#2)', () => {
  const NO_EMPAREJADA = { statusCode: 403, code: 'CASH_MACHINE_NOT_PAIRED' }

  it('🔴 otra caja con payments:create pero sin la credencial: 403 y no escribe nada, ni una incidencia', async () => {
    await expect(vender({}, CARRITO, { ...PC, credencial: null })).rejects.toMatchObject(NO_EMPAREJADA)
    await expect(vender({ changeDispensedCents: 99999 }, CARRITO, { ...PC, credencial: 'otra' })).rejects.toMatchObject(NO_EMPAREJADA)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(a.base.observaciones).toEqual([])
    expect(a.base.incidencias).toEqual([])
  })

  it('🔴 la PC revocada repite SU folio y recibe la misma respuesta, sin otra incidencia', async () => {
    const primera = await vender()
    a.base.vinculos[0].active = false
    a.base.vinculos[0].revokedAt = new Date('2026-11-20T17:00:00.000Z')
    await expect(vender()).resolves.toEqual(primera)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(a.base.incidencias).toEqual([])
  })

  it('🔴 recorte R1: un folio NUEVO de la PC revocada nunca es venta (antes, después, sin hora o sólo con la fecha): 202 PC_REVOCADA', async () => {
    for (const over of [
      { occurredAt: '2026-11-20T18:00:00.000Z' },
      { occurredAt: '2026-11-20T19:00:00.000Z' },
      { occurredAtKnown: false, occurredAt: null },
      { occurredAt: '2026-11-20' },
    ]) {
      jest.clearAllMocks()
      a = prepararArnes(prismaMock)
      a.base.vinculos[0].active = false
      a.base.vinculos[0].revokedAt = new Date('2026-11-20T18:30:00.000Z')
      const r = await vender(over)
      expect(r).toMatchObject({ status: 202, body: { ack: 'TERMINADO', motivo: 'PC_REVOCADA', creditCents: 20000 } })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(a.base.incidencias.map(i => i.kind).sort()).toEqual(['NO_SE_PUDO_REGISTRAR', 'TRAS_REVOCAR'])
      expect(acciones()).toContain('CASH_MACHINE_FOLIO_AFTER_UNPAIR')
    }
  })
})

describe('consultarVentaDeLaMaquina', () => {
  it('🔴 el GET devuelve la MISMA respuesta que el POST', async () => {
    const r = await vender({ changeDispensedCents: 1000 })
    await expect(consultarVentaDeLaMaquina(VENUE, REF)).resolves.toEqual(r)
  })

  it('un folio sin desenlace es 404 (también si sólo tiene duda)', async () => {
    await expect(consultarVentaDeLaMaquina(VENUE, REF)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('Codex r1 #1 y decisión a: un folio PAGADO nace pagado y sin descuento, o no es venta', () => {
  it('🔴 #1: el servidor arma la cuenta por MÁS de lo que entró ($200 contra $187.50): 202 SIN_SALDAR, el dinero en su cierre físico', async () => {
    a.subtotal.pesos = 200
    const r = await vender()
    expect(r).toMatchObject({ status: 202, body: { incident: 'NO_SE_PUDO_REGISTRAR', motivo: 'SIN_SALDAR', creditCents: 20000 } })
    expect(a.base.cierres[0]).toMatchObject({ motivoSinRegistro: 'SIN_SALDAR', paymentId: null })
  })

  it('🔴 Codex r2 #7: $100.01 de mercancía + $10 de propina con $110.00 recibidos: 202 SIN_SALDAR (la tolerancia no cuenta)', async () => {
    a.subtotal.pesos = 100.01
    const r = await vender({ dueCents: 11000, saleCents: 10000, tipCents: 1000, creditCents: 11000, changeDispensedCents: 0 })
    expect(r).toMatchObject({ status: 202, body: { motivo: 'SIN_SALDAR' } })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it.each([
    ['descuento libre de la cuenta', { discount: 1000 }],
    ['descuento de catálogo de la cuenta', { orderDiscountId: 'desc-1' }],
    ['cupón', { couponCode: 'BUENFIN' }],
    ['descuento del cliente', { descuentoDelCliente: { discountId: 'desc-c', montoCents: 500 } }],
    ['cortesía de un renglón', { items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750, isCortesia: true, cortesiaReason: 'x' }] }],
    ['descuento de renglón', { items: [{ productId: 'p1', quantity: 1, discountId: 'desc-r' }] }],
    ['«Ajuste de precio»', { items: [{ productId: 'p1', quantity: 1, adjustedUnitPrice: 18000 }] }],
    [
      'promoción',
      { items: [{ productId: 'p1', quantity: 1, promotionRef: { promotionId: 'pr', promotionInstanceId: 'i', selections: [] } }] },
    ],
  ])('🔴 decisión a: %s → 202 DESCUENTO sin armar la cuenta; el dinero queda', async (_n, over) => {
    const r = await vender({}, { ...CARRITO, ...over })
    expect(r).toMatchObject({ status: 202, body: { incident: 'NO_SE_PUDO_REGISTRAR', motivo: 'DESCUENTO', creditCents: 20000 } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 decisión a: un descuento que el servidor pone solo (la cuenta nace con descuento) tampoco se aplica: 202 DESCUENTO', async () => {
    prismaMock.order.create.mockImplementationOnce(async ({ data }: any) => ({
      id: 'order-1',
      ...data,
      discountAmount: D(10),
      items: [],
      promotions: [],
    }))
    const r = await vender()
    expect(r).toMatchObject({ status: 202, body: { motivo: 'DESCUENTO' } })
    expect(a.base.cierres[0]).toMatchObject({ motivoSinRegistro: 'DESCUENTO' })
  })

  it('🔴 Codex r2 #11: un carrito con premio de sellos pendiente es 202 PREMIO_PENDIENTE, nunca venta a precio completo', async () => {
    const r = await vender({}, { ...CARRITO, stampRewardId: 'premio-1' })
    expect(r).toMatchObject({ status: 202, body: { motivo: 'PREMIO_PENDIENTE' } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
})
