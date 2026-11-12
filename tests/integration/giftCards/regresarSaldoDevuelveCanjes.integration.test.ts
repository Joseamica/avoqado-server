/**
 * 🔴 LEALTAD (deuda «Regresar saldo y cancelar», P1, 31-oct). Una venta con premio de sellos o puntos canjeados, abonada en parte con
 * saldo de tarjeta de regalo, se cancela con «Regresar saldo y cancelar»: el saldo vuelve a la tarjeta y TAMBIÉN el canje al cliente,
 * en la misma transacción. Repetir no devuelve dos veces. Si algo impide regresar el saldo, el canje se queda como estaba.
 * Promesa y mapa de entradas: docs/audit/2026-11-08-regresar-saldo-devuelve-canjes/promesa.md (workspace).
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

import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { reiniciarSellosParaPruebas } from '@/services/giftCards/giftCardPayKey'
import { revertirCanjeEnTx } from '@/services/giftCards/giftCardLedger'
import {
  applyOrderDiscount,
  getGiftCardPaymentByKey,
  getOrder,
  payCashOrder,
  payGiftCardBalanceOnOrder,
  payGiftCardOnNewOrder,
  removeOrderDiscount,
  removeOrderDiscountInTransaction,
  returnGiftBalanceAndCancelOrder,
} from '@/services/mobile/order.mobile.service'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'
import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import type { TxConReintento } from '@/utils/serializableRetry'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from './sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const D = (v: number) => new Prisma.Decimal(v)
const SUF = `regresa-${process.pid}-${Date.now()}`
const PRESUPUESTO = { timeout: 15_000, maxWait: 5_000 }
const BITACORA = 'ORDER_CANCEL_LOYALTY_RETURNED'
let organizationId: string
let venueId: string
let staffId: string
let productId: string
let n = 0

beforeAll(async () => {
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('regresa'))
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  await ensureGiftCardTender(prisma, venueId)
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, redemptionRate: 0.01, minPointsRedeem: 100 } })
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Ropa', slug: `ropa-${SUF}` } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Blusa', sku: `B-${SUF}`, price: 1000 } })).id
})

beforeEach(() => reiniciarSellosParaPruebas())

afterAll(async () => {
  await limpiarNegocioDePrueba(venueId)
})

const folio = (que: string) => `${SUF}-${que}-${++n}`.slice(-60)

async function cliente(puntos = 10_000) {
  return (await prisma.customer.create({ data: { venueId, firstName: 'Ana', loyaltyPoints: puntos } })).id
}

async function tarjeta(monto: number) {
  const c = generateGiftCardCode()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId,
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

/** Una cuenta de $1,000 abierta, de un cliente. */
async function cuenta(customerId: string) {
  return (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: folio('o'),
        customerId,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: D(1000),
        discountAmount: D(0),
        taxAmount: D(0),
        total: D(1000),
        remainingBalance: D(1000),
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        items: { create: [{ productId, productName: 'Blusa', quantity: 1, unitPrice: D(1000), taxAmount: D(0), total: D(1000) }] },
      },
    })
  ).id
}

/** Un premio de $30 de la cartilla (llena) del cliente. */
async function premioPendiente(customerId: string) {
  const cartilla = await prisma.stampCard.create({
    data: { customerId, venueId, cycle: ++n, stampsRequired: 5, stampsEarned: 5, completedAt: new Date() },
  })
  return (
    await prisma.stampReward.create({
      data: { stampCardId: cartilla.id, customerId, venueId, rewardType: 'FIXED_AMOUNT', rewardValue: 30, rewardLabel: '$30 de premio' },
    })
  ).id
}

async function conPremio(orderId: string, customerId: string) {
  const id = await premioPendiente(customerId)
  await redeemStampReward(venueId, orderId, id, { staffId })
  return id
}

const abonar = (orderId: string, codigo: string, monto: number, propina = 0, idempotencyKey = folio('abono')) =>
  payGiftCardBalanceOnOrder(venueId, orderId, {
    idempotencyKey,
    proof: { kind: 'CODE' as const, code: codigo },
    amount: D(monto),
    tip: D(propina),
    staffId,
    deviceId: null,
  })

const regresar = (orderId: string, operationKey: string) => returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey })

const saldoDe = async (id: string) => (await prisma.giftCard.findUniqueOrThrow({ where: { id } })).balance.toFixed(2)
const premioDe = (id: string) => prisma.stampReward.findUniqueOrThrow({ where: { id } })
const puntosDe = async (id: string) => (await prisma.customer.findUniqueOrThrow({ where: { id } })).loyaltyPoints
const ajustes = (orderId: string) => prisma.loyaltyTransaction.count({ where: { orderId, type: 'ADJUST' } })
const ventaDe = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { orderDiscounts: true } })
const bitacoras = (orderId: string) => prisma.activityLog.count({ where: { venueId, entityId: orderId, action: BITACORA } })
const reembolsos = (orderId: string) => prisma.payment.count({ where: { venueId, orderId, type: 'REFUND' } })

describe('«Regresar saldo y cancelar» devuelve lo canjeado', () => {
  it('🔴 el premio de sellos vuelve, su descuento sale de la venta y el saldo regresa una sola vez', async () => {
    const c = await cliente()
    const orderId = await cuenta(c)
    const premioId = await conPremio(orderId, c)
    expect(Number((await ventaDe(orderId)).total)).toBe(970)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    expect(await saldoDe(t.id)).toBe('800.00')

    await expect(regresar(orderId, folio('k'))).resolves.toEqual({ replay: false })

    expect(await saldoDe(t.id)).toBe('1000.00')
    const v = await ventaDe(orderId)
    expect(v.status).toBe('CANCELLED')
    expect(v.orderDiscounts).toHaveLength(0)
    expect(Number(v.total)).toBe(1000)
    expect(await premioDe(premioId)).toMatchObject({ status: 'PENDING', redeemedAt: null, orderDiscountId: null })
    expect(await bitacoras(orderId)).toBe(1)
    expect(await reembolsos(orderId)).toBe(1)
  })

  it('🔴 los puntos canjeados regresan con un solo ajuste', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    expect(await puntosDe(c)).toBe(9_000)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)

    await regresar(orderId, folio('k'))

    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)
    expect((await ventaDe(orderId)).orderDiscounts).toHaveLength(0)
    expect(await saldoDe(t.id)).toBe('1000.00')
  })

  it('🔴 premio Y puntos en la misma venta, con propina en el abono: los dos vuelven y el saldo regresa completo', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    const premioId = await conPremio(orderId, c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    expect(Number((await ventaDe(orderId)).total)).toBe(960)
    const t = await tarjeta(1000)
    const llaveDelAbono = folio('abono')
    await abonar(orderId, t.codigo, 200, 20, llaveDelAbono)
    expect(await saldoDe(t.id)).toBe('780.00')

    await regresar(orderId, folio('k'))

    expect(await saldoDe(t.id)).toBe('1000.00')
    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)
    expect(await premioDe(premioId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    const v = await ventaDe(orderId)
    expect(v.status).toBe('CANCELLED')
    expect(v.orderDiscounts).toHaveLength(0)
    expect(await bitacoras(orderId)).toBe(1)
    // D19 (12-nov; Codex plan r2 #3): el abono de $200 + $20 regresó al saldo, así que vuelve a deberse (importe y propina). Lo
    // guardado dice la verdad: total $1,000 sin propina, cobrado $0, faltan $1,000. Antes contaba los $220 devueltos como cobrados.
    expect([Number(v.total), Number(v.tipAmount), Number(v.paidAmount), Number(v.remainingBalance)]).toEqual([1000, 0, 0, 1000])
    // El detalle (calculador canónico) y la recuperación por llave (columna guardada) dicen lo mismo (Codex r1 #1).
    expect((await getOrder(venueId, orderId)).preBillBalance).toMatchObject({ orderTotalCents: 100000, remainingBalanceCents: 100000 })
    expect(await getGiftCardPaymentByKey(venueId, llaveDelAbono)).toMatchObject({ orderRemaining: 1000 })
  })

  it('un descuento normal se queda en la venta anulada: sólo sale el canje', async () => {
    const c = await cliente()
    const orderId = await cuenta(c)
    const promo = await prisma.discount.create({ data: { venueId, name: 'Promo', type: 'FIXED_AMOUNT', value: 50, scope: 'ORDER' } })
    await applyOrderDiscount(venueId, orderId, promo.id, staffId)
    const premioId = await conPremio(orderId, c)
    expect(Number((await ventaDe(orderId)).total)).toBe(920)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)

    await regresar(orderId, folio('k'))

    const v = await ventaDe(orderId)
    expect(v.orderDiscounts.map(d => d.name)).toEqual(['Promo'])
    expect(Number(v.total)).toBe(950)
    expect(await premioDe(premioId)).toMatchObject({ status: 'PENDING' })
  })

  it('una venta sin canjes: sin bitácora, el mismo total y descuento; lo cobrado regresa a $0 porque el abono volvió al saldo (D19)', async () => {
    const c = await cliente()
    const orderId = await cuenta(c)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    const antes = await ventaDe(orderId)

    await regresar(orderId, folio('k'))

    const v = await ventaDe(orderId)
    expect(v.status).toBe('CANCELLED')
    expect([v.total, v.discountAmount].map(Number)).toEqual([antes.total, antes.discountAmount].map(Number))
    // D19: el abono de $200 regresó al saldo de la tarjeta ⇒ la cuenta (cancelada) ya no lo cuenta como cobrado.
    expect([v.paidAmount, v.remainingBalance].map(Number)).toEqual([0, Number(antes.total)])
    expect(await bitacoras(orderId)).toBe(0)
    expect(await saldoDe(t.id)).toBe('1000.00')
  })
})

describe('repetir no devuelve dos veces', () => {
  it('🔴 la misma llave después de terminar: `replay` y nada más se mueve', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    const premioId = await conPremio(orderId, c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    const llave = folio('k')
    await regresar(orderId, llave)

    await expect(regresar(orderId, llave)).resolves.toEqual({ replay: true })

    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)
    expect(await premioDe(premioId)).toMatchObject({ status: 'PENDING' })
    expect(await saldoDe(t.id)).toBe('1000.00')
    expect(await reembolsos(orderId)).toBe(1)
    expect(await bitacoras(orderId)).toBe(1)
  })

  it('🔴 sin llave `:0` (ya no quedaba saldo por regresar): la primera corrida devuelve el canje y su reintento no', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const t = await tarjeta(1000)
    const r = await abonar(orderId, t.codigo, 200)
    await prisma.$transaction(async tx => {
      const { refundPaymentId } = await writeRefundInTx(tx as unknown as TxConReintento, {
        originalPaymentId: r.paymentId,
        venueId,
        salesRefundCents: 20000,
        tipRefundCents: 0,
        refundedItems: [],
        reason: 'CANCELLED_ORDER',
        staffId,
        idempotencyKey: folio('devuelto'),
        tenderCommission: 'NONE',
        shift: 'CLAIM_LIVE',
        provenance: 'MANUAL',
      })
      await revertirCanjeEnTx(tx as unknown as TxConReintento, {
        venueId,
        originalPaymentId: r.paymentId,
        refundPaymentId,
        amount: D(200),
        staffId,
      })
    }, PRESUPUESTO)
    const llave = folio('k')

    await expect(regresar(orderId, llave)).resolves.toEqual({ replay: false })
    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)

    await expect(regresar(orderId, llave)).resolves.toEqual({ replay: true })
    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)
    expect(await bitacoras(orderId)).toBe(1)
  })

  it('🔴 dos a la vez con la misma llave: una sola regresa; la otra sale `replay` o pide reintentar, y al reintentar es `replay`', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    const llave = folio('k')

    const resultados = await Promise.allSettled([regresar(orderId, llave), regresar(orderId, llave)])

    const hechas = resultados.flatMap(r => (r.status === 'fulfilled' ? [r.value.replay] : []))
    expect(hechas.filter(replay => !replay)).toHaveLength(1)
    // La que perdió esperó el candado y vio la venta ya cancelada: `lockTableOrderScope` la devuelve como cambio de la cuenta (409).
    for (const r of resultados) if (r.status === 'rejected') expect(String(r.reason)).toContain('ORDER_TABLE_TOPOLOGY_CHANGED')
    await expect(regresar(orderId, llave)).resolves.toEqual({ replay: true })
    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)
    expect(await saldoDe(t.id)).toBe('1000.00')
    expect(await reembolsos(orderId)).toBe(1)
  })

  it('otra llave sobre la venta ya cancelada no devuelve otra vez', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    await regresar(orderId, folio('k'))

    // Todo su saldo ya está devuelto: la rama `todoDevuelto` lo reconoce como repetición aunque la llave sea otra.
    await expect(regresar(orderId, folio('otra'))).resolves.toEqual({ replay: true })

    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)
  })
})

describe('si no se puede regresar el saldo, el canje se queda como estaba', () => {
  it('pago mixto (saldo y efectivo): se rechaza y el premio y los puntos siguen canjeados', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    const premioId = await conPremio(orderId, c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    await payCashOrder(venueId, orderId, { amount: 10000, tip: 0, staffId, idempotencyKey: folio('cash') })

    await expect(regresar(orderId, folio('k'))).rejects.toMatchObject({ code: 'GIFT_CARD_TENDER_NOT_ALLOWED' })

    expect(await puntosDe(c)).toBe(9_000)
    expect(await premioDe(premioId)).toMatchObject({ status: 'REDEEMED' })
    expect((await ventaDe(orderId)).orderDiscounts).toHaveLength(2)
    expect(await bitacoras(orderId)).toBe(0)
  })

  it('🔴 sobre desactivado: el rechazo llega tarde y la devolución del canje se revierte con la transacción', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    const premioId = await conPremio(orderId, c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    await prisma.giftCard.update({ where: { id: t.id }, data: { status: 'DEACTIVATED', balance: D(0), deactivatedAt: new Date() } })

    await expect(regresar(orderId, folio('k'))).rejects.toMatchObject({
      code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
      details: { motivo: 'SOBRE_DESACTIVADO' },
    })

    expect(await puntosDe(c)).toBe(9_000)
    expect(await ajustes(orderId)).toBe(0)
    expect(await premioDe(premioId)).toMatchObject({ status: 'REDEEMED' })
    const v = await ventaDe(orderId)
    expect(v.status).toBe('CONFIRMED')
    expect(v.orderDiscounts).toHaveLength(2)
    expect(await bitacoras(orderId)).toBe(0)
  })
})

describe('lo que sigue después de cancelar', () => {
  it('🔴 dinero ya capturado que revive la venta: la ve sin el descuento y debe la diferencia SIN contar el abono que regresó al saldo (D19); no hay otra devolución', async () => {
    const c = await cliente()
    const orderId = await cuenta(c)
    const premioId = await conPremio(orderId, c)
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    await regresar(orderId, folio('k'))

    await recordOrderPayment(
      venueId,
      orderId,
      {
        venueId,
        amount: 77000,
        tip: 0,
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        // El abono con saldo dejó la cuenta en FULLPAYMENT.
        splitType: 'FULLPAYMENT',
        tpvId: venueId,
        staffId,
        paidProductsId: [],
        idempotencyKey: randomUUID(),
        currency: 'MXN',
        isInternational: false,
        authorizationNumber: 'TEST-AUTH-ONLY',
        referenceNumber: randomUUID(),
        typeOfCard: 'CREDIT',
      } as never,
      staffId,
    )

    const v = await ventaDe(orderId)
    expect(v.status).not.toBe('CANCELLED')
    expect(Number(v.total)).toBe(1000)
    // D19 (Codex plan r2 #3): el abono de $200 regresó a la tarjeta; el negocio sólo tiene los $770 ⇒ faltan $230 (antes decía $30).
    expect(Number(v.remainingBalance)).toBe(230)
    expect(await premioDe(premioId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    expect(await bitacoras(orderId)).toBe(1)
  })

  it('«quitar el descuento» después de cancelar no devuelve otra vez', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const filaId = (await ventaDe(orderId)).orderDiscounts[0].id
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)
    await regresar(orderId, folio('k'))

    await expect(removeOrderDiscount(venueId, orderId, filaId, staffId)).rejects.toBeDefined()

    expect(await puntosDe(c)).toBe(10_000)
    expect(await ajustes(orderId)).toBe(1)
  })

  it('🔴 repetir la venta nueva cobrada con saldo (misma llave) después de cancelar: `replay` y no vuelve a quemar el premio', async () => {
    const c = await cliente()
    const premioId = await premioPendiente(c)
    const t = await tarjeta(1000)
    const llave = folio('nueva')
    const venta = {
      items: [{ name: 'Blusa', quantity: 1, unitPrice: 100000 }],
      staffId,
      orderType: 'TAKEOUT' as const,
      source: 'AVOQADO_ANDROID' as const,
      customerId: c,
      idempotencyKey: llave,
      proof: { kind: 'CODE' as const, code: t.codigo },
      amount: D(200),
      tip: D(0),
      deviceId: null,
      procesadoPor: staffId,
      stampRewardId: premioId,
    }
    const primera = await payGiftCardOnNewOrder(venueId, venta)
    expect(primera.orderPaymentStatus).toBe('PARTIAL')
    expect(await premioDe(premioId)).toMatchObject({ status: 'REDEEMED' })
    await regresar(primera.orderId, folio('k'))
    expect(await premioDe(premioId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    expect(await saldoDe(t.id)).toBe('1000.00')

    const repetida = await payGiftCardOnNewOrder(venueId, venta)

    expect(repetida.replay).toBe(true)
    expect(await premioDe(premioId)).toMatchObject({ status: 'PENDING', orderDiscountId: null })
    expect(await saldoDe(t.id)).toBe('1000.00')
  })
})

describe('la guarda general no se relaja', () => {
  it('«quitar el descuento» normal sobre una venta con abono se sigue rechazando', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const filaId = (await ventaDe(orderId)).orderDiscounts[0].id
    const t = await tarjeta(1000)
    await abonar(orderId, t.codigo, 200)

    await expect(removeOrderDiscount(venueId, orderId, filaId, staffId)).rejects.toMatchObject({ statusCode: 400 })

    expect(await puntosDe(c)).toBe(9_000)
    expect((await ventaDe(orderId)).orderDiscounts).toHaveLength(1)
  })

  it('con la opción del camino de regresar saldo, una venta PAID se sigue rechazando', async () => {
    const c = await cliente(10_000)
    const orderId = await cuenta(c)
    await redeemPointsToOrder(venueId, orderId, c, 1_000, staffId)
    const filaId = (await ventaDe(orderId)).orderDiscounts[0].id
    await prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } })

    await expect(
      prisma.$transaction(
        tx =>
          removeOrderDiscountInTransaction(tx as unknown as TxConReintento, venueId, orderId, filaId, staffId, {
            abonosDeSaldoSeRegresanEnEstaTx: true,
          }),
        PRESUPUESTO,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(await puntosDe(c)).toBe(9_000)
  })
})
