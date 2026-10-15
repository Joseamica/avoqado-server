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

/** Un sobre ACTIVE con su código real y su ACTIVATE (saldo = suma de la libreta). */
async function tarjeta(monto: number) {
  n += 1
  const c = generateGiftCardCode()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      codeHash: hashGiftCardCode(c.normalized),
      codeEnc: encryptGiftCardCode(c.normalized),
      codeLast4: c.last4,
      pageToken: generateOpaqueToken(),
      initialAmount: D(monto),
      balance: D(monto),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
    },
  })
  await prisma.giftCardActivity.create({ data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) } })
  return { id: s.id, codigo: c.display }
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
})
