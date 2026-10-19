/**
 * B2 · cancelar la venta de una tarjeta contra Postgres real (spec §5.6; índice R2; Review Focus 5).
 * «Se cancela la venta mientras otra caja la usa, o la terminal devuelve el dinero y la respuesta se pierde. Nunca se gasta un sobre
 * cancelado ni se devuelve dinero de uno usado.» Más las notas del coordinador: (4) idempotencia de iniciar Y liberar —el reintento con
 * la misma llave no escribe, otra operación con esa llave ⇒ IDEMPOTENCY_KEY_REUSED—; (5) nada se libera solo ni sin la confirmación.
 *
 * Negocio propio (`crearNegocioDePrueba`), nunca `setupTestData`: su limpieza borra por nombre en TODA la base (ver la siembra).
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/cancelacion.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import {
  claveDeSobre,
  estadoDeCancelacionDeVenta,
  iniciarCancelacionDeVenta,
  liberarCancelacionDeVenta,
} from '@/services/giftCards/giftCardCancel.service'
import { canjearSobresEnTx, lockGiftCardsForUpdate, operarSobreDeGerenteEnTx } from '@/services/giftCards/giftCardLedger'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
// `integration-setup.ts` mockea la bitácora (fire-and-forget): se comprueba la llamada, no la fila.
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  crearCobroConSaldoEnTx,
  crearCuentaDeMercancia,
  crearNegocioDePrueba,
  esperarAQueAlguienEspereA,
  limpiarNegocioDePrueba,
  pidDe,
  sembrarCanje,
  sembrarVentaDeTarjetas,
  sembrarVentaDeTarjetasSinPagar,
} from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

function barrera() {
  let soltar!: () => void
  const promesa = new Promise<void>(resolve => {
    soltar = resolve
  })
  return { promesa, soltar }
}
const resultado = <T>(promesa: Promise<T>) =>
  promesa.then(
    value => ({ value, error: undefined as unknown }),
    error => ({ value: undefined, error: error as unknown }),
  )

describe('B2 · cancelar la venta de una tarjeta de regalo', () => {
  let venueId: string
  let staffId: string
  let organizationId: string

  // Negocio propio con nombre único y SIN limpieza de la libreta (es de sólo inserción): ver la cabecera de la siembra.
  beforeAll(async () => {
    ;({ venueId, staffId, organizationId } = await crearNegocioDePrueba('b2-cancelacion'))
    // El tender de sistema se asegura con el cliente global, fuera de las transacciones de dinero de las pruebas (su contrato).
    await ensureGiftCardTender(prisma, venueId)
  })

  // B1 r1 (fix 7): los efectos que encolaron ESTOS cobros y reembolsos no se quedan para el worker de otra suite.
  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  beforeEach(() => (logAction as jest.Mock).mockClear())

  const venta = (over: Partial<Parameters<typeof sembrarVentaDeTarjetas>[0]> = {}) =>
    sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH', ...over })
  const bloqueosDe = (ids: string[]) =>
    prisma.giftCardActivity.findMany({ where: { giftCardId: { in: ids }, type: 'BLOCK' }, orderBy: { id: 'asc' }, take: 10 })
  const bitacora = (action: string, orderId: string) =>
    (logAction as jest.Mock).mock.calls.filter(([e]) => e.action === action && e.entityId === orderId).map(([e]) => e)

  it('iniciar: bloquea todos los sobres con CANCEL_IN_PROGRESS; repetir la misma llave no escribe nada nuevo', async () => {
    const v = await venta({ montos: [400, 600] })
    const r1 = await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-venta-0001' })
    const movimientos = await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds } } })
    const r2 = await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-venta-0001' })
    expect([...r1.giftCardIds].sort()).toEqual([...v.giftCardIds].sort())
    // Lo que bloqueó ESTA llamada: la primera, los dos; el reintento, nada (el MCP audita sólo si bloqueó algo).
    expect([...r1.bloqueadas].sort()).toEqual([...v.giftCardIds].sort())
    expect(r2).toEqual({ giftCardIds: r1.giftCardIds, bloqueadas: [] })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds } } })).toBe(movimientos)
    const bloqueos = await bloqueosDe(v.giftCardIds)
    expect(bloqueos).toHaveLength(2)
    expect(bloqueos.every(b => b.reason === 'CANCEL_IN_PROGRESS')).toBe(true)
    // Una llave por sobre, derivada de la del gerente.
    expect(bloqueos.map(b => b.operationKey).sort()).toEqual(v.giftCardIds.map(id => claveDeSobre('cancelar-venta-0001', id)).sort())
    const sobres = await prisma.giftCard.findMany({ where: { id: { in: v.giftCardIds } }, take: 2 })
    expect(sobres.every(s => s.status === 'BLOCKED')).toBe(true)
    // F9: la bitácora sale de lo que decidió la libreta bajo candado: una sola vez, nunca en el reintento.
    expect(bitacora('GIFT_CARD_SALE_CANCEL_STARTED', v.orderId)).toEqual([
      expect.objectContaining({ staffId, venueId, entity: 'Order', data: { giftCardIds: r1.giftCardIds } }),
    ])
  })

  it('iniciar otra vez con OTRA llave mientras sigue en curso: se respeta tal cual, sin escribir ni volver a registrar', async () => {
    const v = await venta()
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-otra-0001' })
    const antes = await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds } } })
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-otra-0002' })).resolves.toEqual({
      giftCardIds: v.giftCardIds,
      bloqueadas: [],
    })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds } } })).toBe(antes)
    expect(bitacora('GIFT_CARD_SALE_CANCEL_STARTED', v.orderId)).toHaveLength(1)
  })

  it('estadoDeCancelacionDeVenta (lo que pinta el detalle del dashboard) sale de la MISMA regla que iniciar', async () => {
    const libre = await venta()
    await expect(estadoDeCancelacionDeVenta(venueId, libre.orderId)).resolves.toEqual({ allowed: true, reason: null, message: null })
    await iniciarCancelacionDeVenta(venueId, libre.orderId, { staffId, operationKey: 'cancelar-estado-0001' })
    await expect(estadoDeCancelacionDeVenta(venueId, libre.orderId)).resolves.toEqual({
      allowed: false,
      reason: 'IN_PROGRESS',
      message: null,
    })
    const ayer = await venta({ cobradaEn: new Date(Date.now() - 30 * 60 * 60 * 1000) })
    await expect(estadoDeCancelacionDeVenta(venueId, ayer.orderId)).resolves.toEqual({
      allowed: false,
      reason: 'NOT_SAME_DAY',
      message: expect.any(String),
    })
    const usada = await venta()
    await sembrarCanje({ venueId, staffId, giftCardIds: usada.giftCardIds, total: 100, conSaldo: 100 })
    await expect(estadoDeCancelacionDeVenta(venueId, usada.orderId)).resolves.toEqual({
      allowed: false,
      reason: 'ALREADY_USED',
      message: expect.any(String),
    })
    // Ya devuelta: «ya se canceló», no «otro día» ni «ya se usó».
    await issueRefund({ venueId, paymentId: libre.pagos[0].id, amount: 50000, reason: 'CANCELLED_ORDER', staffId })
    await expect(estadoDeCancelacionDeVenta(venueId, libre.orderId)).resolves.toEqual({
      allowed: false,
      reason: 'ALREADY_CANCELLED',
      message: expect.any(String),
    })
    // Una cuenta que no es de tarjetas, o de otro negocio: sin venta que cancelar.
    const { orderId: mercancia } = await crearCuentaDeMercancia({ venueId, staffId, total: 100 })
    await expect(estadoDeCancelacionDeVenta(venueId, mercancia)).resolves.toEqual({ allowed: false, reason: null, message: null })
    const otro = await crearNegocioDePrueba('b2-cancelacion-otro')
    await expect(estadoDeCancelacionDeVenta(otro.venueId, usada.orderId)).resolves.toEqual({
      allowed: false,
      reason: null,
      message: expect.any(String),
    })
  })

  it('🔴 iniciar al día siguiente (zona del venue) ⇒ GIFT_CARD_CANCEL_WINDOW_CLOSED y nada se bloquea', async () => {
    const v = await venta({ cobradaEn: new Date(Date.now() - 30 * 60 * 60 * 1000) })
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-ayer-0001' })).rejects.toMatchObject({
      code: 'GIFT_CARD_CANCEL_WINDOW_CLOSED',
    })
    expect(await bloqueosDe(v.giftCardIds)).toHaveLength(0)
  })

  it('🔴 iniciar con un sobre ya usado ⇒ GIFT_CARD_ALREADY_USED', async () => {
    const v = await venta()
    await sembrarCanje({ venueId, staffId, giftCardIds: v.giftCardIds, total: 100, conSaldo: 100 })
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-usada-0001' })).rejects.toMatchObject({
      code: 'GIFT_CARD_ALREADY_USED',
    })
    expect(await bloqueosDe(v.giftCardIds)).toHaveLength(0)
  })

  it('🔴 Review Focus 5: otra caja canjea el sobre mientras se inicia la cancelación ⇒ gana el canje y la cancelación se rechaza', async () => {
    const v = await venta()
    const { orderId: mercancia } = await crearCuentaDeMercancia({ venueId, staffId, total: 200 })
    const tomado = barrera()
    const soltar = barrera()
    let pidDelCanje = 0
    const canje = prisma.$transaction(async tx => {
      await lockExistingOrderForPayment(tx, { venueId, orderId: mercancia })
      const cards = await lockGiftCardsForUpdate(tx, v.giftCardIds)
      pidDelCanje = await pidDe(tx)
      tomado.soltar()
      await soltar.promesa
      const pago = await crearCobroConSaldoEnTx(tx, { venueId, orderId: mercancia, monto: 200, staffId })
      await canjearSobresEnTx(tx, { venueId, orderId: mercancia, paymentId: pago.id, amount: new Prisma.Decimal(200), cards, staffId })
    }, ORDER_LOCK_WAIT_BUDGET)
    await tomado.promesa
    const cancelacion = resultado(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-concurrente-0001' }))
    // r1 (M1): la cancelación espera el candado de ESTE canje (`pg_blocking_pids`), no el de otra sesión de la base.
    await esperarAQueAlguienEspereA(pidDelCanje)
    soltar.soltar()
    await canje
    const r = await cancelacion
    expect(r.error).toMatchObject({ code: 'GIFT_CARD_ALREADY_USED' })
    expect(await bloqueosDe(v.giftCardIds)).toHaveLength(0)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: v.giftCardIds[0] } })).balance.toString()).toBe('300')
  })

  it('🔴 Review Focus 5: con la cancelación iniciada, otra caja ya no puede gastar el sobre', async () => {
    const v = await venta()
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-antes-0001' })
    const { orderId: mercancia } = await crearCuentaDeMercancia({ venueId, staffId, total: 200 })
    await expect(
      prisma.$transaction(async tx => {
        await lockExistingOrderForPayment(tx, { venueId, orderId: mercancia })
        const cards = await lockGiftCardsForUpdate(tx, v.giftCardIds)
        const pago = await crearCobroConSaldoEnTx(tx, { venueId, orderId: mercancia, monto: 200, staffId })
        await canjearSobresEnTx(tx, { venueId, orderId: mercancia, paymentId: pago.id, amount: new Prisma.Decimal(200), cards, staffId })
      }, ORDER_LOCK_WAIT_BUDGET),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^GIFT_CARD_(BLOCKED|INSUFFICIENT_BALANCE)$/) })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0], type: 'REDEEM' } })).toBe(0)
  })

  it('🔴 Codex #7 (cierre): liberar con una tarjeta de la venta bloqueada por OTRO motivo ⇒ 409 GIFT_CARD_BLOCKED (no anuncia «se pueden usar»)', async () => {
    const v = await venta({ montos: [300, 200] })
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-otro-motivo-1' })
    // B libera y después bloquea una tarjeta por actividad sospechosa; A, con el diálogo abierto, confirma con una llave nueva.
    await liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-otro-motivo-b', confirmacionNoDevuelto: true })
    await prisma.$transaction(async tx =>
      operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: v.giftCardIds[0],
        staffId,
        operationKey: 'bloqueo-otro-motivo-0001',
        op: { tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY', note: 'Contracargo en revisión' },
      }),
    )
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-otro-motivo-a', confirmacionNoDevuelto: true }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'GIFT_CARD_BLOCKED',
      message: 'Una tarjeta de esta venta está bloqueada por otro motivo; revísala antes de liberar.',
    })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: v.giftCardIds[0] } })).status).toBe('BLOCKED')
  })

  it('🔴 un sobre bloqueado por OTRO motivo: iniciar ⇒ GIFT_CARD_BLOCKED y el reembolso sigue en GIFT_CARD_CANCEL_NOT_STARTED', async () => {
    const v = await venta()
    await prisma.$transaction(async tx =>
      operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: v.giftCardIds[0],
        staffId,
        operationKey: 'bloqueo-sospechoso-0001',
        op: { tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY', note: 'Contracargo en revisión' },
      }),
    )
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-bloqueada-1' })).rejects.toMatchObject({
      code: 'GIFT_CARD_BLOCKED',
    })
    await expect(estadoDeCancelacionDeVenta(venueId, v.orderId)).resolves.toEqual({
      allowed: false,
      reason: null,
      message: expect.stringContaining('bloqueada por otro motivo'),
    })
    await expect(
      issueRefund({ venueId, paymentId: v.pagos[0].id, amount: 50000, reason: 'CANCELLED_ORDER', staffId }),
    ).rejects.toMatchObject({
      code: 'GIFT_CARD_CANCEL_NOT_STARTED',
    })
  })

  it('🔴 R2: reembolso del panel tras iniciar ⇒ REFUND, un DEACTIVATE por sobre y saldo en cero', async () => {
    const v = await venta({ montos: [300, 200] })
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-panel-0001' })
    const r = await issueRefund({ venueId, paymentId: v.pagos[0].id, amount: 50000, reason: 'CANCELLED_ORDER', staffId })
    expect(r.amount).toBe(500)
    const sobres = await prisma.giftCard.findMany({ where: { id: { in: v.giftCardIds } }, take: 2 })
    expect(sobres.every(s => s.status === 'DEACTIVATED' && s.balance.isZero())).toBe(true)
    const desactivaciones = await prisma.giftCardActivity.findMany({
      where: { giftCardId: { in: v.giftCardIds }, type: 'DEACTIVATE' },
      orderBy: { id: 'asc' },
      take: 5,
    })
    expect(desactivaciones).toHaveLength(2)
    expect(desactivaciones.every(d => d.refundPaymentId === r.refundId && d.reason === 'SALE_CANCELLED')).toBe(true)
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:REFUND_WITHOUT_CANCEL:${r.refundId}` } })).toBe(0)
  })

  it('🔴 A1 (cierre): con la cancelación en curso, una devolución PARCIAL del panel ⇒ 409 y nada se escribe (las tarjetas siguen bloqueadas)', async () => {
    const v = await venta({ montos: [300, 200] })
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-parcial-0001' })
    const rechazo = {
      statusCode: 409,
      code: 'GIFT_CARD_SALE_REFUND_MUST_BE_FULL',
      message: 'La venta de tarjetas se devuelve completa: reembolsa el cobro entero.',
    }
    // Por importe libre…
    await expect(
      issueRefund({ venueId, paymentId: v.pagos[0].id, amount: 30000, reason: 'CANCELLED_ORDER', staffId }),
    ).rejects.toMatchObject(rechazo)
    // …y por artículo (una de las dos tarjetas).
    const renglon = await prisma.orderItem.findFirstOrThrow({ where: { orderId: v.orderId, giftCardId: v.giftCardIds[0] } })
    await expect(
      issueRefund({ venueId, paymentId: v.pagos[0].id, items: [{ orderItemId: renglon.id }], reason: 'CANCELLED_ORDER', staffId }),
    ).rejects.toMatchObject(rechazo)
    expect(await prisma.payment.count({ where: { orderId: v.orderId, type: 'REFUND' } })).toBe(0)
    const sobres = await prisma.giftCard.findMany({ where: { id: { in: v.giftCardIds } }, take: 2 })
    expect(sobres.map(s => [s.status, s.balance.toFixed(2)]).sort()).toEqual([
      ['BLOCKED', '200.00'],
      ['BLOCKED', '300.00'],
    ])
    // El cobro entero sí cancela la venta.
    await issueRefund({ venueId, paymentId: v.pagos[0].id, amount: 50000, reason: 'CANCELLED_ORDER', staffId })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds }, type: 'DEACTIVATE' } })).toBe(2)
  })

  it('🔴 A1 (cierre): en la TERMINAL el dinero ya salió — la devolución parcial no se rechaza: desactiva y deja la anomalía `parcial`', async () => {
    const v = await venta({ montos: [400, 600], metodo: 'CREDIT_CARD' })
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-tpv-parcial-1' })
    const r = await recordRefund(
      venueId,
      {
        venueId,
        originalPaymentId: v.pagos[0].id,
        amount: 40000,
        reason: 'CUSTOMER_REQUEST',
        authorizationNumber: 'AUT-GC-P1',
        referenceNumber: 'REF-GC-P1',
        isPartialRefund: true,
        currency: 'MXN',
        idempotencyKey: 'tpv-gc-parcial-0001',
      },
      staffId,
    )
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds }, type: 'DEACTIVATE' } })).toBe(2)
    const anomalia = await prisma.moneyAnomaly.findFirst({ where: { stripeEventId: `giftcard:REFUND_WITHOUT_CANCEL:${r.id}` } })
    expect(anomalia?.observedState).toMatchObject({ parcial: true, monto: '400' })
  })

  it('🔴 A2 (cierre): abrir la devolución en la TERMINAL (POS y MCP) exige la cancelación iniciada de una venta de tarjetas pagada', async () => {
    const v = await venta({ montos: [500], metodo: 'CREDIT_CARD' })
    await prisma.payment.update({ where: { id: v.pagos[0].id }, data: { source: 'TPV' } })
    const abrir = () =>
      terminalPaymentService.requestRefundOnTerminal({
        terminalId: 'AVQD-NO-CONECTADA',
        venueId,
        requestedBy: staffId,
        paymentId: v.pagos[0].id,
      })
    await expect(abrir()).rejects.toMatchObject({ statusCode: 409, code: 'GIFT_CARD_CANCEL_NOT_STARTED' })
    // Con la cancelación iniciada pasa la regla y sigue a la terminal (aquí no hay ninguna conectada).
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-abrir-tpv-1' })
    await expect(abrir()).rejects.toThrow(/no está conectada/)
    // Una tarjeta usada: la regla única dice por qué (ALREADY_USED), también en la terminal.
    const usada = await venta({ montos: [500], metodo: 'CREDIT_CARD' })
    await prisma.payment.update({ where: { id: usada.pagos[0].id }, data: { source: 'TPV' } })
    await sembrarCanje({ venueId, staffId, giftCardIds: usada.giftCardIds, total: 100, conSaldo: 100 })
    await expect(
      terminalPaymentService.requestRefundOnTerminal({
        terminalId: 'AVQD-NO-CONECTADA',
        venueId,
        requestedBy: staffId,
        paymentId: usada.pagos[0].id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'GIFT_CARD_ALREADY_USED' })
  })

  it('A2 (cierre): la terminal NO frena lo que el gancho acepta sin cancelación — el abono de una venta SIN pagar', async () => {
    const v = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosConTerminal: [200] })
    await expect(
      terminalPaymentService.requestRefundOnTerminal({
        terminalId: 'AVQD-NO-CONECTADA',
        venueId,
        requestedBy: staffId,
        paymentId: v.abonos[0].id,
      }),
    ).rejects.toThrow(/no está conectada/)
  })

  it('🔴 Review Focus 5: una venta pagada en dos cobros se devuelve en dos reembolsos; el segundo no rebota ni desactiva otra vez', async () => {
    const v = await venta({ cobros: [300, 200] })
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-dos-cobros-1' })
    await issueRefund({ venueId, paymentId: v.pagos[0].id, amount: 30000, reason: 'CANCELLED_ORDER', staffId })
    await issueRefund({ venueId, paymentId: v.pagos[1].id, amount: 20000, reason: 'CANCELLED_ORDER', staffId })
    expect(await prisma.payment.count({ where: { orderId: v.orderId, type: 'REFUND' } })).toBe(2)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds }, type: 'DEACTIVATE' } })).toBe(1)
  })

  it('🔴 Review Focus 5: la terminal devolvió y la respuesta se perdió — el reintento con la misma llave no duplica nada', async () => {
    const v = await venta({ montos: [400, 600], metodo: 'CREDIT_CARD' })
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-tpv-0001' })
    const pedido = {
      venueId,
      originalPaymentId: v.pagos[0].id,
      amount: 100000,
      reason: 'CUSTOMER_REQUEST',
      authorizationNumber: 'AUT-GC-9',
      referenceNumber: 'REF-GC-9',
      isPartialRefund: false,
      currency: 'MXN',
      idempotencyKey: 'tpv-gc-reintento-0001',
    }
    const primero = await recordRefund(venueId, pedido, staffId)
    const segundo = await recordRefund(venueId, pedido, staffId)
    expect(segundo.id).toBe(primero.id)
    expect(await prisma.payment.count({ where: { orderId: v.orderId, type: 'REFUND' } })).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds }, type: 'DEACTIVATE' } })).toBe(2)
    expect(await prisma.moneyAnomaly.count({ where: { stripeEventId: `giftcard:REFUND_WITHOUT_CANCEL:${primero.id}` } })).toBe(0)
  })

  it('liberar (el gerente comprobó que la devolución NO se hizo): los sobres vuelven a ACTIVE con UNBLOCK; después de la devolución ya no se puede liberar', async () => {
    const v = await venta()
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-liberar-0001' })
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-venta-0001', confirmacionNoDevuelto: true }),
    ).resolves.toEqual({ liberadas: v.giftCardIds })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: v.giftCardIds[0] } })).status).toBe('ACTIVE')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0], type: 'UNBLOCK' } })).toBe(1)
    // Repetir la liberación con la misma llave no escribe otro UNBLOCK ni otra bitácora, y dice que no liberó nada.
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-venta-0001', confirmacionNoDevuelto: true }),
    ).resolves.toEqual({ liberadas: [] })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0], type: 'UNBLOCK' } })).toBe(1)
    expect(bitacora('GIFT_CARD_SALE_CANCEL_RELEASED', v.orderId)).toEqual([
      expect.objectContaining({ staffId, venueId, entity: 'Order', data: { giftCardIds: v.giftCardIds } }),
    ])
    // Liberada, la venta se puede volver a cancelar.
    await expect(estadoDeCancelacionDeVenta(venueId, v.orderId)).resolves.toEqual({ allowed: true, reason: null, message: null })

    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-liberar-0002' })
    // ⭐ (D4, estado de HOY): el reintento TARDÍO de la primera liberación (misma llave) no suelta la cancelación nueva y tampoco
    // responde «liberada»: las tarjetas volvieron a bloquearse ⇒ 409 con código, sin escribir nada.
    const antes = await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0] } })
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-venta-0001', confirmacionNoDevuelto: true }),
    ).rejects.toMatchObject({
      code: 'GIFT_CARD_BLOCKED',
      statusCode: 409,
      message:
        'Esta liberación ya se había hecho, pero después las tarjetas se volvieron a bloquear. Vuelve a abrir la venta para ver su estado.',
    })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: v.giftCardIds[0] } })).status).toBe('BLOCKED')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0] } })).toBe(antes)
    await issueRefund({ venueId, paymentId: v.pagos[0].id, amount: 50000, reason: 'CANCELLED_ORDER', staffId })
    // Devuelta la venta, la misma llave vieja tampoco dice «liberada»: dice lo que pasó.
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-venta-0001', confirmacionNoDevuelto: true }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_SALE_ALREADY_CANCELLED', statusCode: 409 })
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-venta-0002', confirmacionNoDevuelto: true }),
    ).rejects.toMatchObject({
      code: 'GIFT_CARD_SALE_ALREADY_CANCELLED',
    })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: v.giftCardIds[0] } })).status).toBe('DEACTIVATED')
  })

  it('🔴 B2 r1 M3: el reintento tardío de iniciar con una llave cuya cancelación ya se liberó ⇒ 409, sin escribir; una llave nueva sí cancela', async () => {
    const v = await venta({ montos: [300, 200] })
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-tardio-0001' })
    await liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-tardio-0001', confirmacionNoDevuelto: true })
    const antes = await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds } } })
    ;(logAction as jest.Mock).mockClear()
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-tardio-0001' })).rejects.toMatchObject({
      code: 'GIFT_CARD_CANCEL_NOT_STARTED',
      statusCode: 409,
    })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: v.giftCardIds } } })).toBe(antes)
    const sobres = await prisma.giftCard.findMany({ where: { id: { in: v.giftCardIds } }, take: 2 })
    expect(sobres.every(s => s.status === 'ACTIVE')).toBe(true)
    expect(logAction).not.toHaveBeenCalled()

    // Una cancelación NUEVA lleva su propia llave; después de la devolución, su reintento (todos DEACTIVATED) responde lo mismo.
    const nueva = await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-tardio-0002' })
    await issueRefund({ venueId, paymentId: v.pagos[0].id, amount: 50000, reason: 'CANCELLED_ORDER', staffId })
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-tardio-0002' })).resolves.toEqual({
      giftCardIds: nueva.giftCardIds,
      bloqueadas: [],
    })
  })

  it('🔴 r1 F6: liberar SIN confirmar que la devolución no se hizo ⇒ 400 y los sobres siguen bloqueados (lo incierto no se libera)', async () => {
    const v = await venta()
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-incierto-0001' })
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'liberar-incierto-0001' } as unknown as Parameters<
        typeof liberarCancelacionDeVenta
      >[2]),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: v.giftCardIds[0] } })).status).toBe('BLOCKED')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0], type: 'UNBLOCK' } })).toBe(0)
    // Nada lo libera solo: un día después sigue en curso (B7 avisa con CANCEL_STUCK; aquí sólo se comprueba que nadie lo soltó).
    await expect(estadoDeCancelacionDeVenta(venueId, v.orderId, new Date(Date.now() + 26 * 60 * 60 * 1000))).resolves.toEqual({
      allowed: false,
      reason: 'IN_PROGRESS',
      message: null,
    })
  })

  it('🔴 r1 B-7: la llave derivada de un sobre ya la ocupa OTRA operación ⇒ IDEMPOTENCY_KEY_REUSED; nada se bloquea por cancelación', async () => {
    const v = await venta()
    const llave = 'cancelar-choque-0001'
    // Un bloqueo normal (motivo SUSPICIOUS_ACTIVITY) que por accidente usó la llave que la cancelación deriva para ese sobre.
    await prisma.$transaction(async tx =>
      operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: v.giftCardIds[0],
        staffId,
        operationKey: claveDeSobre(llave, v.giftCardIds[0]),
        op: { tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY', note: 'Contracargo en revisión' },
      }),
    )
    const movimientosAntes = await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0] } })
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: llave })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
    // El sobre sigue bloqueado por el motivo de antes, sin un renglón nuevo y sin bitácora de «cancelación iniciada».
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0] } })).toBe(movimientosAntes)
    const bloqueos = await bloqueosDe(v.giftCardIds)
    expect(bloqueos.map(b => b.reason)).toEqual(['SUSPICIOUS_ACTIVITY'])
    expect(bitacora('GIFT_CARD_SALE_CANCEL_STARTED', v.orderId)).toHaveLength(0)

    // El reintento LEGÍTIMO (misma llave, mismo contenido) sigue devolviendo lo mismo sin escribir.
    const otra = await venta()
    const r1 = await iniciarCancelacionDeVenta(venueId, otra.orderId, { staffId, operationKey: 'cancelar-legitimo-0001' })
    const antes = await prisma.giftCardActivity.count({ where: { giftCardId: { in: otra.giftCardIds } } })
    const r2 = await iniciarCancelacionDeVenta(venueId, otra.orderId, { staffId, operationKey: 'cancelar-legitimo-0001' })
    expect(r2).toEqual({ ...r1, bloqueadas: [] })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: { in: otra.giftCardIds } } })).toBe(antes)
  })

  it('🔴 nota 4: liberar con una llave que ya ocupa OTRA operación (la del inicio) ⇒ IDEMPOTENCY_KEY_REUSED y el sobre sigue bloqueado', async () => {
    const v = await venta()
    const llave = 'cancelar-y-liberar-0001'
    await iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: llave })
    const antes = await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0] } })
    await expect(
      liberarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: llave, confirmacionNoDevuelto: true }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: v.giftCardIds[0] } })).status).toBe('BLOCKED')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: v.giftCardIds[0] } })).toBe(antes)
    expect(bitacora('GIFT_CARD_SALE_CANCEL_RELEASED', v.orderId)).toHaveLength(0)
  })

  it('una venta todavía SIN pagar ⇒ GIFT_CARD_SALE_NOT_PAID (se cancela desde el POS) y nada se bloquea', async () => {
    const v = await venta()
    await prisma.order.update({ where: { id: v.orderId }, data: { paymentStatus: 'PARTIAL' } })
    await expect(iniciarCancelacionDeVenta(venueId, v.orderId, { staffId, operationKey: 'cancelar-sin-pagar-1' })).rejects.toMatchObject({
      code: 'GIFT_CARD_SALE_NOT_PAID',
    })
    await expect(estadoDeCancelacionDeVenta(venueId, v.orderId)).resolves.toEqual({
      allowed: false,
      reason: 'NOT_PAID',
      message: expect.stringContaining('cancela la cuenta desde el POS'),
    })
    expect(await bloqueosDe(v.giftCardIds)).toHaveLength(0)
  })

  it('una cuenta que no es de tarjetas, o de otro negocio ⇒ GIFT_CARD_NOT_FOUND (404)', async () => {
    const { orderId } = await crearCuentaDeMercancia({ venueId, staffId, total: 100 })
    await expect(iniciarCancelacionDeVenta(venueId, orderId, { staffId, operationKey: 'cancelar-merc-0001' })).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    const v = await venta()
    const otro = await crearNegocioDePrueba('b2-cancelacion-ajeno')
    await expect(
      iniciarCancelacionDeVenta(otro.venueId, v.orderId, { staffId, operationKey: 'cancelar-ajena-0001' }),
    ).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
    })
    await expect(
      liberarCancelacionDeVenta(otro.venueId, v.orderId, { staffId, operationKey: 'liberar-ajena-0001', confirmacionNoDevuelto: true }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_NOT_FOUND' })
    expect(await bloqueosDe(v.giftCardIds)).toHaveLength(0)
  })
})
