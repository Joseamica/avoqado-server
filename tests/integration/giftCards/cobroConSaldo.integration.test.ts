/**
 * Cobrar con saldo contra Postgres REAL (Tarea A8): un Payment del tender de sistema y su REDEEM en UNA transacción, la
 * llave repetida, dos cajas sobre el mismo saldo, el saldo que no paga de más, «quedan $X», una cuenta de tarjetas que no
 * se paga con otra, y «regresar el saldo y cancelar». r1: la misma llave A LA VEZ (pago completo y parcial, A-2) y el
 * código reemplazado mientras el cobro espera el candado del sobre (A-1).
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/cobroConSaldo.integration.test.ts --ci --runInBand
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue('NOT_DRAWER_CASH'),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { lockGiftCardsForUpdate, operarSobreDeGerenteEnTx, revertirCanjeEnTx } from '@/services/giftCards/giftCardLedger'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { payCashOrder, payGiftCardBalanceOnOrder, returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { rechazoSellado, reiniciarSellosParaPruebas } from '@/services/giftCards/giftCardPayKey'
import { payWithBalance } from '@/controllers/mobile/giftCard.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'
import { esperarAQueAlguienEspereA, limpiarNegocioDePrueba, pidDe } from './sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const SUF = `saldo-${process.pid}-${Date.now()}`
const D = (v: number) => new Prisma.Decimal(v)
const PRESUPUESTO = { timeout: 15_000, maxWait: 5_000 }
let orgId: string
let venueId: string
let staffId: string
let tenderId: string
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF } })).id
  staffId = (await prisma.staff.create({ data: { email: `${SUF}@staff.test`, firstName: 'Caja', lastName: 'QA', active: true } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER', active: true } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  tenderId = (await ensureGiftCardTender(prisma, venueId)).id
})

// B1 r1 (fix 7): los `PaymentEffect` de ESTE negocio no se quedan para el worker de otra suite que barre toda la base.
// La libreta (`GiftCardActivity`) nunca se borra.
afterAll(async () => {
  await limpiarNegocioDePrueba(venueId)
})

/** Un sobre ACTIVE con su código real y su ACTIVATE (saldo = suma de la libreta). */
async function tarjeta(monto: number) {
  n += 1
  const c = generateGiftCardCode()
  const pageToken = generateOpaqueToken()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      codeHash: hashGiftCardCode(c.normalized),
      codeEnc: encryptGiftCardCode(c.normalized),
      codeLast4: c.last4,
      pageToken,
      initialAmount: D(monto),
      balance: D(monto),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
    },
  })
  await prisma.giftCardActivity.create({ data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) } })
  return { id: s.id, codigo: c.display, pageToken }
}

/** Una cuenta de mercancía abierta de $monto. */
async function cuentaDeMercancia(monto: number) {
  n += 1
  return (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${SUF}-o${n}`,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: D(monto),
        taxAmount: D(0),
        total: D(monto),
        remainingBalance: D(monto),
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        items: { create: [{ productName: 'Blusa', quantity: 1, unitPrice: D(monto), taxAmount: D(0), total: D(monto) }] },
      },
    })
  ).id
}

const saldoDe = async (id: string) => (await prisma.giftCard.findUniqueOrThrow({ where: { id } })).balance.toFixed(2)

/** Espera a que OTRA sesión esté detenida en el candado de un sobre (molde de la integración de A4). */
async function esperarAQueAlguienEspereElSobre(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [fila] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "GiftCard"%FOR UPDATE%'`
    if (Number(fila.n) > 0) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('el cobro nunca llegó a esperar el candado del sobre')
}

describe('cobro con saldo · Postgres real', () => {
  it('cobra $400 + $50 de propina: UN Payment del tender de regalo y UN REDEEM en la misma transacción; la cuenta queda PARTIAL', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)

    const r = await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-k1`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(400),
      tip: D(50),
      staffId,
      deviceId: null,
    })

    expect(r).toMatchObject({
      amount: 400,
      tipAmount: 50,
      orderPaymentStatus: 'PARTIAL',
      orderRemaining: 600,
      redeemed: [{ giftCardId: t.id, amount: 450, balanceAfter: 550 }],
    })
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } })
    expect([
      pago.method,
      pago.fundsFlow,
      pago.tenderTypeId,
      pago.tenderSatFormaPago,
      pago.amount.toFixed(2),
      pago.tipAmount.toFixed(2),
    ]).toEqual(['OTHER', 'EXTERNAL_RECORDED', tenderId, '01', '400.00', '50.00'])
    const canjes = await prisma.giftCardActivity.findMany({ where: { giftCardId: t.id, type: 'REDEEM' }, take: 5 })
    expect(canjes.map(c => [c.paymentId, c.amount.toFixed(2), c.balanceAfter.toFixed(2)])).toEqual([[r.paymentId, '450.00', '550.00']])
    expect(await saldoDe(t.id)).toBe('550.00')
    // Ruling 3 (A8): sin turno abierto, la auditoría del turno nombra al cobro con saldo, no a `payCashOrder`.
    const sinTurno = await prisma.activityLog.findFirst({ where: { venueId, entityId: r.paymentId, action: 'PAYMENT_WITHOUT_SHIFT' } })
    expect(sinTurno?.data).toMatchObject({ channel: 'payGiftCardBalanceOnOrder', reason: 'NO_SHIFT', totalPesos: '450.00' })
  })

  it('🔴 la MISMA llave devuelve el mismo cobro sin descontar dos veces; con otro monto, IDEMPOTENCY_KEY_REUSED', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    const pedido = {
      idempotencyKey: `${SUF}-k2`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(0),
      staffId,
      deviceId: null,
    }

    const a = await payGiftCardBalanceOnOrder(venueId, orderId, pedido)
    const b = await payGiftCardBalanceOnOrder(venueId, orderId, pedido)
    expect(b).toMatchObject({ paymentId: a.paymentId, redeemed: [{ giftCardId: t.id, amount: 300, balanceAfter: 700 }] })
    expect([a.replay, b.replay]).toEqual([false, true]) // r1 (F9): sólo el primero deja bitácora (C3)
    expect(await saldoDe(t.id)).toBe('700.00')
    await expect(payGiftCardBalanceOnOrder(venueId, orderId, { ...pedido, amount: D(200) })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
    expect(await saldoDe(t.id)).toBe('700.00')
  })

  it('🔴 r1 (A-2): la MISMA llave dos veces A LA VEZ pagando TODA la cuenta: un solo cobro y las dos respuestas son ese cobro', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(500)
    const pedido = {
      idempotencyKey: `${SUF}-sim-1`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(500),
      tip: D(0),
      staffId,
      deviceId: null,
    }

    const [a, b] = await Promise.all([
      payGiftCardBalanceOnOrder(venueId, orderId, pedido),
      payGiftCardBalanceOnOrder(venueId, orderId, pedido),
    ])

    expect(a.paymentId).toBe(b.paymentId)
    expect([a.replay, b.replay].sort()).toEqual([false, true])
    expect(await saldoDe(t.id)).toBe('500.00')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
  })

  it('🔴 r1 (A-2): la MISMA llave dos veces A LA VEZ con un pago PARCIAL que deja la tarjeta sin saldo para repetirlo: un solo cobro', async () => {
    const t = await tarjeta(300)
    const orderId = await cuentaDeMercancia(500)
    const pedido = {
      idempotencyKey: `${SUF}-sim-2`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(200),
      tip: D(0),
      staffId,
      deviceId: null,
    }

    const [a, b] = await Promise.all([
      payGiftCardBalanceOnOrder(venueId, orderId, pedido),
      payGiftCardBalanceOnOrder(venueId, orderId, pedido),
    ])

    expect(a.paymentId).toBe(b.paymentId)
    expect([a.replay, b.replay].sort()).toEqual([false, true])
    expect(await saldoDe(t.id)).toBe('100.00')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PARTIAL')
  })

  it('🔴 r1 (A-1): el gerente repone el código mientras un cobro con el código ANTERIOR espera el candado: 404 y nada se descuenta', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    let avisarQueRepuso!: () => void
    const yaRepuso = new Promise<void>(resolve => (avisarQueRepuso = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))

    // El gerente toma el candado del sobre y le cambia el código; no confirma hasta que el cobro esté esperando.
    const gerente = prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [t.id])
      const r = await operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: t.id,
        staffId,
        operationKey: `${SUF}-repone-1`,
        op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' },
      })
      avisarQueRepuso()
      await puedeSoltar
      return r
    }, PRESUPUESTO)
    await yaRepuso

    // El cobro resuelve el código VIEJO (la base aún no ve el cambio sin confirmar) y se detiene en el candado del sobre.
    const cobro = payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-viejo-1`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    cobro.catch(() => undefined) // el veredicto se lee abajo
    await esperarAQueAlguienEspereElSobre()
    soltar()

    const [repuesto, resultado] = await Promise.allSettled([gerente, cobro])
    expect(repuesto.status).toBe('fulfilled')
    expect(resultado.status).toBe('rejected')
    expect((resultado as PromiseRejectedResult).reason).toMatchObject({ code: 'GIFT_CARD_NOT_FOUND', statusCode: 404 })
    expect(await saldoDe(t.id)).toBe('1000.00')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(0)
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
  })

  it('🔴 dos cajas cobran $400 del MISMO saldo de $500 a la vez (dos cuentas): una pasa, la otra recibe «quedan $100»', async () => {
    const t = await tarjeta(500)
    const [o1, o2] = [await cuentaDeMercancia(800), await cuentaDeMercancia(800)]

    const [uno, dos] = await Promise.allSettled([
      payGiftCardBalanceOnOrder(venueId, o1, {
        idempotencyKey: `${SUF}-c1`,
        proof: { kind: 'CODE' as const, code: t.codigo },
        amount: D(400),
        tip: D(0),
        staffId,
        deviceId: null,
      }),
      payGiftCardBalanceOnOrder(venueId, o2, {
        idempotencyKey: `${SUF}-c2`,
        proof: { kind: 'CODE' as const, code: t.codigo },
        amount: D(400),
        tip: D(0),
        staffId,
        deviceId: null,
      }),
    ])
    const fallidos = [uno, dos].filter(x => x.status === 'rejected') as PromiseRejectedResult[]
    expect([uno, dos].filter(x => x.status === 'fulfilled')).toHaveLength(1)
    expect(fallidos).toHaveLength(1)
    expect(fallidos[0].reason).toMatchObject({ code: 'GIFT_CARD_INSUFFICIENT_BALANCE', details: { saldoDisponible: 100 } })
    expect(await saldoDe(t.id)).toBe('100.00')
    expect(await prisma.payment.count({ where: { venueId, orderId: { in: [o1, o2] } } })).toBe(1)
  })

  it('el saldo no paga de más: un monto mayor a lo que debe la cuenta se rechaza y nada se escribe', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(300)
    await expect(
      payGiftCardBalanceOnOrder(venueId, orderId, {
        idempotencyKey: `${SUF}-k3`,
        proof: { kind: 'CODE' as const, code: t.codigo },
        amount: D(300.01),
        tip: D(0),
        staffId,
        deviceId: null,
      }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_AMOUNT_OUT_OF_RANGE' })
    expect(await saldoDe(t.id)).toBe('1000.00')
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
  })

  it('pagar TODO lo que debe la cuenta con saldo la deja PAID (con sus efectos de cierre)', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(600)
    const r = await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-k4`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(600),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    expect(r).toMatchObject({
      orderPaymentStatus: 'PAID',
      orderRemaining: 0,
      redeemed: [{ giftCardId: t.id, amount: 600, balanceAfter: 400 }],
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
  })

  it('una cuenta de tarjetas no se paga con saldo de otra tarjeta', async () => {
    const t = await tarjeta(1000)
    const venta = await createGiftCardOrder(venueId, staffId, {
      idempotencyKey: `${SUF}-venta`,
      sobres: [{ amount: 500, deliveryChannel: 'PRINTED' }],
    })
    await expect(
      payGiftCardBalanceOnOrder(venueId, venta.orderId, {
        idempotencyKey: `${SUF}-k5`,
        proof: { kind: 'CODE' as const, code: t.codigo },
        amount: D(500),
        tip: D(0),
        staffId,
        deviceId: null,
      }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_TENDER_NOT_ALLOWED' })
    expect(await saldoDe(t.id)).toBe('1000.00')
  })

  it('🔴 regresar el saldo y cancelar: reembolsos del tender de regalo, REDEEM_REVERSAL, saldo de vuelta y cuenta CANCELLED; el reintento no repite', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-r1`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-r2`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(200),
      tip: D(20),
      staffId,
      deviceId: null,
    })
    expect(await saldoDe(t.id)).toBe('480.00')

    await expect(returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: `${SUF}-regresa-1` })).resolves.toEqual({
      replay: false,
    })

    expect(await saldoDe(t.id)).toBe('1000.00')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    const reembolsos = await prisma.payment.findMany({ where: { venueId, orderId, type: 'REFUND' }, take: 5 })
    expect(reembolsos.map(p => [p.tenderTypeId, p.method, p.fundsFlow]).sort()).toEqual([
      [tenderId, 'OTHER', 'EXTERNAL_RECORDED'],
      [tenderId, 'OTHER', 'EXTERNAL_RECORDED'],
    ])
    const reversos = await prisma.giftCardActivity.findMany({ where: { giftCardId: t.id, type: 'REDEEM_REVERSAL' }, take: 5 })
    expect(reversos.map(r => r.amount.toFixed(2)).sort()).toEqual(['220.00', '300.00'])

    await expect(returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: `${SUF}-regresa-1` })).resolves.toEqual({
      replay: true,
    })
    expect(await saldoDe(t.id)).toBe('1000.00')
    expect(await prisma.payment.count({ where: { venueId, orderId, type: 'REFUND' } })).toBe(2)

    const otra = await cuentaDeMercancia(500)
    await payGiftCardBalanceOnOrder(venueId, otra, {
      idempotencyKey: `${SUF}-r3`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(100),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    await expect(returnGiftBalanceAndCancelOrder(venueId, otra, { staffId, operationKey: `${SUF}-regresa-1` })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
  })

  it('regresar el saldo NO aplica si la cuenta también tiene un pago en efectivo (el guardia general no se relaja)', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-m1`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId, idempotencyKey: `${SUF}-m2` })
    await expect(returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: `${SUF}-regresa-2` })).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
    })
    expect(await saldoDe(t.id)).toBe('700.00')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CONFIRMED')
  })

  it('🔴 ruling 7 (A8): un sobre DESACTIVADO (la terminal devolvió su compra, E1) no recibe saldo: regresar el saldo se rechaza y nada se mueve', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-d1`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    // Lo que deja `desactivarSobresDeCuentaEnTx` con `dineroYaDevuelto` (E1): DEACTIVATED en saldo 0.
    await prisma.giftCard.update({ where: { id: t.id }, data: { status: 'DEACTIVATED', balance: D(0), deactivatedAt: new Date() } })

    await expect(returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: `${SUF}-regresa-d1` })).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
      statusCode: 409,
      details: { motivo: 'SOBRE_DESACTIVADO', giftCardIds: [t.id] },
    })
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: t.id } })
    expect([sobre.status, sobre.balance.toFixed(2)]).toEqual(['DEACTIVATED', '0.00'])
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM_REVERSAL' } })).toBe(0)
    expect(await prisma.payment.count({ where: { venueId, orderId, type: 'REFUND' } })).toBe(0)
    // El cobro con saldo sigue vivo y visible en la cuenta abierta.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CONFIRMED')
    expect(await prisma.payment.count({ where: { venueId, orderId, status: 'COMPLETED', type: 'REGULAR' } })).toBe(1)
  })

  it('🔴 ronda 1 (fix 1): todo lo pagado con saldo ya estaba devuelto — regresar el saldo cancela sin escribir dinero, y su reintento es `replay: true` sin escribir nada', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    const r = await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `${SUF}-f1`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(300),
      tip: D(20),
      staffId,
      deviceId: null,
    })
    // Ese cobro ya se devolvió completo a la tarjeta (lo que hará el reembolso de B1): REFUND del tender + REDEEM_REVERSAL.
    await prisma.$transaction(async tx => {
      const { refundPaymentId } = await writeRefundInTx(tx, {
        originalPaymentId: r.paymentId,
        venueId,
        salesRefundCents: 30000,
        tipRefundCents: 2000,
        refundedItems: [],
        reason: 'CANCELLED_ORDER',
        staffId,
        idempotencyKey: `${SUF}-f1-devuelto`,
        tenderCommission: 'NONE',
        shift: 'CLAIM_LIVE',
        provenance: 'MANUAL',
      })
      await revertirCanjeEnTx(tx, { venueId, originalPaymentId: r.paymentId, refundPaymentId, amount: D(320), staffId })
    }, PRESUPUESTO)
    expect(await saldoDe(t.id)).toBe('1000.00')
    const huella = async () => ({
      pagos: await prisma.payment.count({ where: { venueId, orderId } }),
      movimientosDeLaTarjeta: await prisma.giftCardActivity.count({ where: { giftCardId: t.id } }),
      saldo: await saldoDe(t.id),
    })
    const antes = await huella()

    await expect(returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: `${SUF}-regresa-f1` })).resolves.toEqual({
      replay: false,
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
    expect(await huella()).toEqual(antes) // no había nada que regresar: ni REFUND ni REDEEM_REVERSAL nuevos

    // El reintento de la cola (la respuesta se perdió): misma operación, sin la llave :0 → repetición, no un 400.
    await expect(returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: `${SUF}-regresa-f1` })).resolves.toEqual({
      replay: true,
    })
    expect(await huella()).toEqual(antes)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED')
  })

  it.each(['SENT', 'UNKNOWN'] as const)(
    '🔴 Codex #1 (cierre): con un cobro de terminal %s sobre la cuenta ⇒ 409 y el saldo intacto; resuelto, sí cobra',
    async status => {
      const t = await tarjeta(1000)
      const orderId = await cuentaDeMercancia(500)
      const requestId = `${SUF}-tpr-${status}`
      // El cobro de la terminal que el banco todavía puede aprobar (su desenlace no está acreditado).
      await prisma.terminalPaymentRequest.create({
        data: {
          requestId,
          venueId,
          terminalId: `term-${SUF}`,
          status,
          amountCents: 50000,
          orderId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
      const pedido = (llave: string) => ({
        idempotencyKey: llave,
        proof: { kind: 'CODE' as const, code: t.codigo },
        amount: D(500),
        tip: D(0),
        staffId,
        deviceId: null,
      })
      try {
        await expect(payGiftCardBalanceOnOrder(venueId, orderId, pedido(`${SUF}-vivo-${status}`))).rejects.toMatchObject({
          statusCode: 409,
          code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
          message: 'Hay un cobro en curso en la terminal para esta cuenta. Espera su resultado (o cancélalo) antes de cobrar con saldo.',
        })
        expect(await saldoDe(t.id)).toBe('1000.00')
        expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
        // El banco RECHAZÓ ese cobro (código que acredita «sin cobro»): ya no bloquea y el saldo paga.
        await prisma.terminalPaymentRequest.update({ where: { requestId }, data: { status: 'FAILED', failureCode: 'BANK_DECLINED' } })
        const r = await payGiftCardBalanceOnOrder(venueId, orderId, pedido(`${SUF}-libre-${status}`))
        expect(r).toMatchObject({ amount: 500, orderPaymentStatus: 'PAID' })
        expect(await saldoDe(t.id)).toBe('500.00')
      } finally {
        await prisma.terminalPaymentRequest.deleteMany({ where: { requestId } })
      }
    },
  )
})

/** 1b S2: la liga (PAGE_TOKEN), la venta ya devuelta (L31), el rechazo reintentable (Q94-a) y el autor de un reenvío (Q110). */
describe('cobro con saldo · 1b S2 · Postgres real', () => {
  beforeEach(() => reiniciarSellosParaPruebas())

  const porLiga = (llave: string, pageToken: string, monto: number) => ({
    idempotencyKey: llave,
    proof: { kind: 'PAGE_TOKEN' as const, pageToken },
    amount: D(monto),
    tip: D(0),
    staffId,
    deviceId: null,
  })

  it('cobro con PAGE_TOKEN baja el saldo y escribe su REDEEM', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    const r = await payGiftCardBalanceOnOrder(venueId, orderId, porLiga(`${SUF}-liga-1`, t.pageToken, 250))
    expect(r).toMatchObject({ replay: false, amount: 250, redeemed: [{ giftCardId: t.id, amount: 250, balanceAfter: 750 }] })
    expect(await saldoDe(t.id)).toBe('750.00')
    const canjes = await prisma.giftCardActivity.findMany({ where: { giftCardId: t.id, type: 'REDEEM' }, take: 5 })
    expect(canjes.map(c => [c.paymentId, c.amount.toFixed(2)])).toEqual([[r.paymentId, '250.00']])
  })

  it('🔴 tras reponer el código, la liga vieja responde 404 y la nueva cobra', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(1000)
    await prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [t.id])
      await operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: t.id,
        staffId,
        operationKey: `${SUF}-repone-liga`,
        op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' },
      })
    }, PRESUPUESTO)
    const nueva = (await prisma.giftCard.findUniqueOrThrow({ where: { id: t.id } })).pageToken
    expect(nueva).not.toBe(t.pageToken)

    await expect(payGiftCardBalanceOnOrder(venueId, orderId, porLiga(`${SUF}-liga-vieja`, t.pageToken, 300))).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    expect(await saldoDe(t.id)).toBe('1000.00')
    const r = await payGiftCardBalanceOnOrder(venueId, orderId, porLiga(`${SUF}-liga-nueva`, nueva, 300))
    expect(r).toMatchObject({ replay: false, redeemed: [{ giftCardId: t.id, amount: 300, balanceAfter: 700 }] })
    expect(await saldoDe(t.id)).toBe('700.00')
  })

  it('cobrar con saldo una venta REFUNDED responde 400 «Order is already paid» (L31 de Q20: fija lo que ya pasa)', async () => {
    const t = await tarjeta(1000)
    n += 1
    const orderId = (
      await prisma.order.create({
        data: {
          venueId,
          orderNumber: `${SUF}-o${n}`,
          contratoDePrecio: 'IVA_INCLUIDO',
          subtotal: D(500),
          taxAmount: D(0),
          total: D(500),
          remainingBalance: D(0),
          status: 'COMPLETED',
          paymentStatus: 'REFUNDED',
          items: { create: [{ productName: 'Blusa', quantity: 1, unitPrice: D(500), taxAmount: D(0), total: D(500) }] },
        },
      })
    ).id
    const llave = `${SUF}-devuelta`
    const err = await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: llave,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(100),
      tip: D(0),
      staffId,
      deviceId: null,
    }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: 'Order is already paid' })
    expect(err.code).toBeUndefined()
    expect(rechazoSellado(venueId, llave)).toBeNull() // 4xx sin `code`: no se sella (las apps lo tratan como definitivo)
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(0)
    expect(await saldoDe(t.id)).toBe('1000.00')
  })

  it('🔴 Q94-a: terminal pendiente ⇒ rechazo; acreditada sin cargo ⇒ la MISMA llave cobra al momento', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(500)
    const requestId = `${SUF}-tpr-q94`
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId: `term-${SUF}`,
        status: 'PENDING',
        amountCents: 50000,
        orderId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const pedido = {
      idempotencyKey: `${SUF}-q94-K`,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(200),
      tip: D(0),
      staffId,
      deviceId: null,
    }
    try {
      await expect(payGiftCardBalanceOnOrder(venueId, orderId, pedido)).rejects.toMatchObject({
        statusCode: 409,
        code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
      })
      expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(0)
      // La terminal se acredita «sin cargo» (un código de CODIGOS_SIN_COBRO); sin adelantar el reloj, la MISMA llave.
      await prisma.terminalPaymentRequest.update({ where: { requestId }, data: { status: 'FAILED', failureCode: 'BANK_DECLINED' } })
      const r = await payGiftCardBalanceOnOrder(venueId, orderId, pedido)
      expect(r).toMatchObject({ replay: false, amount: 200 })
      expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
      expect(await saldoDe(t.id)).toBe('800.00')
    } finally {
      await prisma.terminalPaymentRequest.deleteMany({ where: { requestId } })
    }
  })

  it('🔴 Q91: un envío con una llave tomada ESPERA el candado de esa llave (otra transacción lo sostiene) y luego cobra', async () => {
    const t = await tarjeta(1000)
    const orderId = await cuentaDeMercancia(500)
    const llave = `${SUF}-q91-espera`
    let avisar!: (pid: number) => void
    const pidQueTiene = new Promise<number>(resolve => (avisar = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))
    // El «primer envío» de la llave, a medio camino: sostiene SÓLO el candado de la llave.
    const primero = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'giftpay:' + venueId + ':' + llave}))`
      avisar(await pidDe(tx))
      await puedeSoltar
    }, PRESUPUESTO)

    const pid = await pidQueTiene
    const segundo = payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: llave,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(200),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    segundo.catch(() => undefined) // el veredicto se lee abajo
    await esperarAQueAlguienEspereA(pid) // espera de verdad el candado de la llave, no la suerte de un setTimeout
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
    soltar()
    await primero
    await expect(segundo).resolves.toMatchObject({ replay: false, amount: 200 })
    expect(await saldoDe(t.id)).toBe('800.00')
  })

  it('🔴 Q91: rechazo por saldo → el saldo sube → la MISMA llave ⇒ el MISMO rechazo (sellado); una llave nueva cobra', async () => {
    const t = await tarjeta(100)
    const orderId = await cuentaDeMercancia(500)
    const pedido = (llave: string) => ({
      idempotencyKey: llave,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(200),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    const primero = await payGiftCardBalanceOnOrder(venueId, orderId, pedido(`${SUF}-q91-sello`)).catch(e => e)
    expect(primero).toMatchObject({ code: 'GIFT_CARD_INSUFFICIENT_BALANCE', message: 'Quedan $100.00 en la tarjeta de regalo.' })
    await prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [t.id])
      await operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: t.id,
        staffId,
        operationKey: `${SUF}-q91-sube`,
        op: { tipo: 'AJUSTE', direccion: 'INCREMENT', amount: D(500), reason: 'CUSTOMER_REQUEST' },
      })
    }, PRESUPUESTO)
    expect(await saldoDe(t.id)).toBe('600.00')

    const repetido = await payGiftCardBalanceOnOrder(venueId, orderId, pedido(`${SUF}-q91-sello`)).catch(e => e)
    expect(repetido).toBe(primero) // el MISMO rechazo (code, message y detalles), aunque ya alcance
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
    expect(await saldoDe(t.id)).toBe('600.00')

    await expect(payGiftCardBalanceOnOrder(venueId, orderId, pedido(`${SUF}-q91-nueva`))).resolves.toMatchObject({ replay: false })
    expect(await saldoDe(t.id)).toBe('400.00')
  })

  describe('Q110: el autor es SIEMPRE la sesión que manda', () => {
    let staffB: string
    beforeAll(async () => {
      staffB = (await prisma.staff.create({ data: { email: `${SUF}-b@staff.test`, firstName: 'Beto', lastName: 'QA', active: true } })).id
      await prisma.staffVenue.create({ data: { staffId: staffB, venueId, role: 'CASHIER', active: true } })
    })

    /** La ruta `pay-gift-card` desde el controller (el esquema ya convirtió los pesos) con la sesión `quien`. */
    async function cobrarComo(quien: string, orderId: string, body: Record<string, unknown>) {
      let data: any
      const res: any = { status: () => res, json: (b: any) => ((data = b.data), res) }
      const req: any = {
        params: { venueId, orderId },
        body,
        authContext: { userId: quien },
        headers: {},
        ip: '127.0.0.1',
        get: () => undefined,
      }
      await payWithBalance(req, res)
      return data
    }
    /** `GIFT_CARD_REDEEMED` (mejor esfuerzo): la integración tiene `logAction` espiado (`integration-setup.ts`); se leen sus llamadas. */
    const bitacorasDe = (paymentId: string) =>
      (logAction as jest.Mock).mock.calls.map(([a]) => a).filter(a => a.action === 'GIFT_CARD_REDEEMED' && a.entityId === paymentId)
    const cuerpo = (llave: string, codigo: string, extra: Record<string, unknown> = {}) => ({
      idempotencyKey: llave,
      proof: { kind: 'CODE', code: codigo },
      amount: D(100),
      tip: D(0),
      ...extra,
    })
    const deAna = () => ({ iniciadoPor: staffId, iniciadoPorNombre: 'Ana' })

    it('🔴 A manda, la respuesta se pierde SIN registrarse, y B reenvía la misma llave con iniciadoPor A ⇒ a nombre de B, con la nota', async () => {
      const t = await tarjeta(1000)
      const orderId = await cuentaDeMercancia(1000)
      const r = await cobrarComo(staffB, orderId, cuerpo(`${SUF}-q110-K1`, t.codigo, deAna()))
      expect(r.replay).toBe(false)
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } })).processedById).toBe(staffB)
      const canje = await prisma.giftCardActivity.findFirstOrThrow({ where: { paymentId: r.paymentId, type: 'REDEEM' } })
      expect(canje.staffId).toBe(staffB)
      const [bitacora] = bitacorasDe(r.paymentId)
      expect(bitacora.staffId).toBe(staffB)
      expect(bitacora.data).toMatchObject({ iniciadoPorSegunElAparato: { iniciadoPor: staffId, iniciadoPorNombre: 'Ana' } })
    })

    it('🔴 un cobro NUEVO de B, llave nueva, con iniciadoPor A ⇒ a nombre de B (la nota no cambia el autor)', async () => {
      const t = await tarjeta(1000)
      const orderId = await cuentaDeMercancia(1000)
      const r = await cobrarComo(staffB, orderId, cuerpo(`${SUF}-q110-K2`, t.codigo, deAna()))
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } })).processedById).toBe(staffB)
      expect((await prisma.giftCardActivity.findFirstOrThrow({ where: { paymentId: r.paymentId, type: 'REDEEM' } })).staffId).toBe(staffB)
    })

    it('🔴 con el cobro de A ya registrado, el reenvío de B con la misma llave ⇒ replay: true y sigue a nombre de A', async () => {
      const t = await tarjeta(1000)
      const orderId = await cuentaDeMercancia(1000)
      const a = await cobrarComo(staffId, orderId, cuerpo(`${SUF}-q110-K3`, t.codigo))
      const b = await cobrarComo(staffB, orderId, cuerpo(`${SUF}-q110-K3`, t.codigo, deAna()))
      expect([a.replay, b.replay, b.paymentId]).toEqual([false, true, a.paymentId])
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).processedById).toBe(staffId)
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
      expect(await saldoDe(t.id)).toBe('900.00')
      // Una sola bitácora, la del cobro de A: el reintento (replay) no escribe otra.
      expect(bitacorasDe(a.paymentId).map(b => [b.staffId, b.data.iniciadoPorSegunElAparato])).toEqual([[staffId, undefined]])
    })
  })
})
