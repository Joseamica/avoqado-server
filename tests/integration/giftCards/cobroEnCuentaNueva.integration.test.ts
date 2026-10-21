/**
 * S2b (Q58) contra Postgres REAL: una venta de mostrador nace y se cobra con saldo en UNA transacción (`pay-new-order`).
 * Pasan las dos o ninguna: si el cobro falla, ni cuenta, ni premio quemado, ni descuento usado. La llave repetida (igual o con
 * otro cuerpo, una tras otra o a la vez), lo que ve otra caja mientras el cobro espera, el premio que ya no aplica (Q60) y quién
 * queda en la cuenta y quién en el cobro (Q76, Q110).
 *
 * Correr: source ~/.claude/worktrees/tarjetas-1b/urls-tarjetas-1b.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/cobroEnCuentaNueva.integration.test.ts --ci --runInBand
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
import { lockGiftCardsForUpdate } from '@/services/giftCards/giftCardLedger'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { reiniciarSellosParaPruebas } from '@/services/giftCards/giftCardPayKey'
import { listOrders, payGiftCardOnNewOrder } from '@/services/mobile/order.mobile.service'
import { getPaymentByKey, payNewOrder } from '@/controllers/mobile/giftCard.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'
import { crearNegocioDePrueba, esperarAQueAlguienEspereA, limpiarNegocioDePrueba, pidDe } from './sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const D = (v: number) => new Prisma.Decimal(v)
const PRESUPUESTO = { timeout: 15_000, maxWait: 5_000 }
const SUF = `nueva-${process.pid}-${Date.now()}`
let venueId: string
let organizationId: string
let staffA: string
let staffB: string
let staffC: string
let clienteId: string
let otroClienteId: string
let descuentoId: string
let n = 0

async function personal(nombre: string): Promise<string> {
  const id = (
    await prisma.staff.create({ data: { email: `${SUF}-${nombre}@staff.test`, firstName: nombre, lastName: 'QA', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { staffId: id, venueId, role: 'CASHIER', active: true } })
  return id
}

beforeAll(async () => {
  ;({ organizationId, venueId, staffId: staffA } = await crearNegocioDePrueba('nueva'))
  staffB = await personal('Beto')
  staffC = await personal('Carla')
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  await ensureGiftCardTender(prisma, venueId)
  clienteId = (await prisma.customer.create({ data: { venueId, firstName: 'Ana', lastName: 'López' } })).id
  otroClienteId = (await prisma.customer.create({ data: { venueId, firstName: 'Otro', lastName: 'Cliente' } })).id
  descuentoId = (
    await prisma.discount.create({ data: { venueId, name: '$100 de la blusa', type: 'FIXED_AMOUNT', value: 100, scope: 'ITEM' } })
  ).id
})

beforeEach(() => reiniciarSellosParaPruebas())

afterAll(async () => {
  await limpiarNegocioDePrueba(venueId)
})

/** Un sobre ACTIVE con su código real y su ACTIVATE (saldo = suma de la libreta). */
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

/** Un premio de $100 PENDIENTE del cliente, en su propia cartilla (un premio por cartilla). */
async function premio(de: string): Promise<string> {
  n += 1
  const cartilla = await prisma.stampCard.create({
    data: { customerId: de, venueId, cycle: n, stampsRequired: 5, stampsEarned: 5, completedAt: new Date() },
  })
  return (
    await prisma.stampReward.create({
      data: {
        stampCardId: cartilla.id,
        customerId: de,
        venueId,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 100,
        rewardLabel: '$100 de premio',
      },
    })
  ).id
}

const llaveNueva = (que: string) => `${SUF}-${que}`.slice(-60)

/** Una blusa de $1,000 con $100 de descuento de artículo (y, si se pide, un premio de $100): la cuenta queda en $900 o $800. */
function venta(llave: string, codigo: string, extra: Record<string, unknown> = {}) {
  return {
    items: [{ name: 'Blusa', quantity: 1, unitPrice: 100000, discountId: descuentoId }],
    staffId: staffA,
    orderType: 'TAKEOUT' as const,
    source: 'AVOQADO_ANDROID' as const,
    customerId: clienteId,
    idempotencyKey: llave,
    proof: { kind: 'CODE' as const, code: codigo },
    amount: D(500),
    tip: D(0),
    deviceId: null,
    procesadoPor: staffA,
    ...extra,
  }
}

const saldoDe = async (id: string) => (await prisma.giftCard.findUniqueOrThrow({ where: { id } })).balance.toFixed(2)
const usosDelDescuento = async () => (await prisma.discount.findUniqueOrThrow({ where: { id: descuentoId } })).currentUses
const cuentasDe = (llave: string) => prisma.order.count({ where: { venueId, externalId: `giftpay:${llave}` } })
const estadoDelPremio = async (id: string) => (await prisma.stampReward.findUniqueOrThrow({ where: { id } })).status

/**
 * Q91 (molde de `cobroConSaldo`): espera a que OTRA sesión esté detenida en el candado de la LLAVE (`giftpay:<venue>:<llave>`, el
 * advisory de `tomarLlaveDeCobro`) que sostiene `pidQueTiene`. Esperar la cuenta o el sobre NO cuenta. Lanza si nadie espera en ~5 s.
 */
async function esperarAQueAlguienEspereLaLlave(pidQueTiene: number, llave: string): Promise<void> {
  const clave = `giftpay:${venueId}:${llave}`
  for (let i = 0; i < 200; i++) {
    // Un advisory de un bigint sale en pg_locks partido: la mitad alta en classid y la baja en objid, con objsubid = 1.
    const [fila] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_locks l
      WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.classid::bigint = ((hashtext(${clave})::bigint >> 32) & 4294967295)
        AND l.objid::bigint = (hashtext(${clave})::bigint & 4294967295)
        AND ${pidQueTiene}::int = ANY(pg_blocking_pids(l.pid))`
    if (Number(fila.n) > 0) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Nadie llegó a esperar el candado de la llave ${llave} que sostiene el proceso ${pidQueTiene}`)
}

describe('pay-new-order · Postgres real', () => {
  it.each([
    ['saldo insuficiente', 300, false, 'GIFT_CARD_INSUFFICIENT_BALANCE'],
    ['tarjeta bloqueada', 1000, true, 'GIFT_CARD_BLOCKED'],
  ])('🔴 el cobro falla dentro de la transacción ⇒ ni cuenta ni premio consumido (%s)', async (_caso, monto, bloquear, code) => {
    const t = await tarjeta(monto)
    if (bloquear) await prisma.giftCard.update({ where: { id: t.id }, data: { status: 'BLOCKED' } })
    const premioId = await premio(clienteId)
    const llave = llaveNueva(`falla-${code}`)
    const usosAntes = await usosDelDescuento()

    await expect(payGiftCardOnNewOrder(venueId, venta(llave, t.codigo, { stampRewardId: premioId }))).rejects.toMatchObject({
      code,
      statusCode: 409,
    })

    expect(await cuentasDe(llave)).toBe(0)
    expect(await estadoDelPremio(premioId)).toBe('PENDING')
    expect(await usosDelDescuento()).toBe(usosAntes)
    expect(await saldoDe(t.id)).toBe(D(monto).toFixed(2))
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: llave } })).toBe(0)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(0)
  })

  it('🔴 Q60: un premio que no se puede aplicar (de otro cliente) rechaza todo con 409 GIFT_CARD_STAMP_REWARD_NOT_APPLIED', async () => {
    const t = await tarjeta(1000)
    const ajeno = await premio(otroClienteId)
    const llave = llaveNueva('premio-ajeno')
    await expect(payGiftCardOnNewOrder(venueId, venta(llave, t.codigo, { stampRewardId: ajeno }))).rejects.toMatchObject({
      code: 'GIFT_CARD_STAMP_REWARD_NOT_APPLIED',
      statusCode: 409,
      message: 'Ese premio ya no aplica a esta venta. Quítalo y vuelve a cobrar.',
    })
    expect(await cuentasDe(llave)).toBe(0)
    expect(await estadoDelPremio(ajeno)).toBe('PENDING')
    expect(await saldoDe(t.id)).toBe('1000.00')
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: llave } })).toBe(0)
  })

  it('🔴 pasa ⇒ una cuenta, un cobro y lo que falta: $800 con $500 de saldo ⇒ faltan $300, el premio quemado y el descuento usado', async () => {
    const t = await tarjeta(1000)
    const premioId = await premio(clienteId)
    const llave = llaveNueva('parcial')
    const usosAntes = await usosDelDescuento()

    const r = await payGiftCardOnNewOrder(venueId, venta(llave, t.codigo, { stampRewardId: premioId }))

    expect(r).toMatchObject({
      replay: false,
      amount: 500,
      orderRemaining: 300,
      orderPaymentStatus: 'PARTIAL',
      redeemed: [{ giftCardId: t.id, amount: 500, balanceAfter: 500 }],
    })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
    expect([cuenta.externalId, cuenta.total.toFixed(2), cuenta.paymentStatus, cuenta.tipAmount.toFixed(2)]).toEqual([
      `giftpay:${llave}`,
      '800.00',
      'PARTIAL',
      '0.00',
    ])
    expect(await estadoDelPremio(premioId)).toBe('REDEEMED')
    expect(await usosDelDescuento()).toBe(usosAntes + 1)
    expect(await saldoDe(t.id)).toBe('500.00')
    expect(await prisma.payment.count({ where: { venueId, orderId: r.orderId } })).toBe(1)
  })

  it('con amount = total ⇒ PAID, con el vale de inventario de la venta y la comanda armada (como en pay-gift-card)', async () => {
    // La comanda sólo lleva artículos del catálogo (un importe libre no se cocina): una playera de $900 y una pantalla de cocina.
    const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Ropa', slug: `ropa-${SUF}` } })).id
    const productId = (
      await prisma.product.create({ data: { venueId, sku: `PLAY-${SUF}`, name: 'Playera', categoryId, price: new Prisma.Decimal(900) } })
    ).id
    const estacion = await prisma.printStation.create({ data: { venueId, name: 'Cocina', isDefault: true, hasKitchenDisplay: true } })
    try {
      const t = await tarjeta(1000)
      const r = await payGiftCardOnNewOrder(
        venueId,
        venta(llaveNueva('completa'), t.codigo, { items: [{ productId, quantity: 1 }], amount: D(900) }),
      )
      expect(r).toMatchObject({ orderPaymentStatus: 'PAID', orderRemaining: 0 })
      const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
      expect([cuenta.paymentStatus, cuenta.total.toFixed(2), cuenta.kitchenPendingAt]).toEqual(['PAID', '900.00', null])
      // El vale de inventario de la venta existe y quedó resuelto (la playera no lleva inventario), nunca colgado en PENDING.
      const vale = await prisma.inventoryPosting.findFirst({ where: { venueId, orderId: r.orderId, effectKind: 'SALE' } })
      expect([vale?.status, vale?.skipReason]).toEqual(['SKIPPED', 'NO_TRACKED_ITEMS'])
      // La comanda de pantalla, armada después del commit.
      const renglones = await prisma.orderItem.findMany({
        where: { orderId: r.orderId },
        select: { id: true, sentToKitchenAt: true },
        take: 5,
      })
      expect(renglones.map(x => x.sentToKitchenAt !== null)).toEqual([true])
      expect(await prisma.kdsOrderItem.count({ where: { orderItemId: renglones[0].id } })).toBe(1)
    } finally {
      await prisma.printStation.update({ where: { id: estacion.id }, data: { active: false, isDefault: false } })
    }
  })

  it('🔴 (d) misma llave y mismo cuerpo ⇒ la misma cuenta y el mismo cobro (`replay`), un solo REDEEM', async () => {
    const t = await tarjeta(1000)
    const llave = llaveNueva('repite')
    const a = await payGiftCardOnNewOrder(venueId, venta(llave, t.codigo))
    const b = await payGiftCardOnNewOrder(venueId, venta(llave, t.codigo))
    expect([a.replay, b.replay]).toEqual([false, true])
    expect([b.orderId, b.paymentId]).toEqual([a.orderId, a.paymentId])
    expect(await cuentasDe(llave)).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
    expect(await saldoDe(t.id)).toBe('500.00')
  })

  it('🔴 (d) misma llave y otro cuerpo (otro artículo) ⇒ 409 IDEMPOTENCY_KEY_REUSED, sin otra cuenta', async () => {
    const t = await tarjeta(1000)
    const llave = llaveNueva('otro-cuerpo')
    await payGiftCardOnNewOrder(venueId, venta(llave, t.codigo))
    await expect(
      payGiftCardOnNewOrder(venueId, venta(llave, t.codigo, { items: [{ name: 'Falda', quantity: 1, unitPrice: 100000 }] })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
    expect(await cuentasDe(llave)).toBe(1)
    expect(await saldoDe(t.id)).toBe('500.00')
  })

  it('(d) GET …/payments/:llave ⇒ found, con su orderId', async () => {
    const t = await tarjeta(1000)
    const llave = llaveNueva('consulta')
    const a = await payGiftCardOnNewOrder(venueId, venta(llave, t.codigo))
    let data: any
    const res: any = { json: (b: any) => ((data = b.data), res) }
    await getPaymentByKey({ params: { venueId, idempotencyKey: llave } } as any, res)
    expect(data).toMatchObject({ found: true, payment: { paymentId: a.paymentId, orderId: a.orderId, orderRemaining: 400 } })
  })

  /**
   * «A la vez», como en S2 (Q91): T sostiene el sobre, así el PRIMER envío A (el servicio real) queda detenido DENTRO de su
   * transacción con la llave tomada y la cuenta ya creada. B, con la misma llave, entra mientras A sigue ahí y espera EL CANDADO
   * DE LA LLAVE de A (no la cuenta ni el sobre). Al soltar T, A cobra y B sale por la llave.
   */
  async function aLaVez(llave: string, giftCardId: string, cuerpoA: () => Promise<unknown>, cuerpoB: () => Promise<unknown>) {
    let avisar!: (pid: number) => void
    const pid = new Promise<number>(resolve => (avisar = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))
    const T = prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [giftCardId])
      avisar(await pidDe(tx))
      await puedeSoltar
    }, PRESUPUESTO)
    T.catch(() => undefined)
    const enVuelo: Promise<unknown>[] = [T]
    try {
      const pidT = await pid
      const A = cuerpoA()
      enVuelo.push(A.catch(() => undefined))
      const pidA = await esperarAQueAlguienEspereA(pidT) // A ya tiene la llave y la cuenta, y espera el sobre
      const B = cuerpoB()
      enVuelo.push(B.catch(() => undefined))
      await esperarAQueAlguienEspereLaLlave(pidA, llave) // B espera la LLAVE de A
      expect(await cuentasDe(llave)).toBe(0) // la cuenta de A todavía no existe afuera
      soltar()
      return await Promise.allSettled([A, B])
    } finally {
      soltar()
      await Promise.allSettled(enVuelo)
    }
  }

  it('🔴 (d) dos envíos A LA VEZ con la misma llave ⇒ el segundo espera la llave y devuelve el cobro del primero: una cuenta y un cobro', async () => {
    const t = await tarjeta(1000)
    const llave = llaveNueva('a-la-vez')
    const [a, b] = await aLaVez(
      llave,
      t.id,
      () => payGiftCardOnNewOrder(venueId, venta(llave, t.codigo)),
      () => payGiftCardOnNewOrder(venueId, venta(llave, t.codigo)),
    )
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled'])
    const [ra, rb] = [(a as PromiseFulfilledResult<any>).value, (b as PromiseFulfilledResult<any>).value]
    expect([ra.replay, rb.replay]).toEqual([false, true])
    expect([rb.orderId, rb.paymentId]).toEqual([ra.orderId, ra.paymentId])
    expect(await cuentasDe(llave)).toBe(1)
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: llave } })).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
    expect(await saldoDe(t.id)).toBe('500.00')
  })

  it('🔴 (d) dos envíos A LA VEZ con la misma llave y cuerpos distintos ⇒ el primero pasa y el segundo 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const t = await tarjeta(1000)
    const llave = llaveNueva('a-la-vez-distintos')
    const [a, b] = await aLaVez(
      llave,
      t.id,
      () => payGiftCardOnNewOrder(venueId, venta(llave, t.codigo)),
      () => payGiftCardOnNewOrder(venueId, venta(llave, t.codigo, { items: [{ name: 'Falda', quantity: 1, unitPrice: 100000 }] })),
    )
    expect(a).toMatchObject({ status: 'fulfilled', value: { replay: false } })
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 } })
    expect(await cuentasDe(llave)).toBe(1)
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: llave } })).toBe(1)
    expect(await saldoDe(t.id)).toBe('500.00')
  })

  it('🔴 (e) otra caja nunca ve una cuenta sin su cobro: mientras el cobro espera el sobre, la cuenta no existe afuera; si falla, nunca existe', async () => {
    const t = await tarjeta(1000)
    const llave = llaveNueva('otra-caja')
    const antes = (await listOrders(venueId, { page: 1, pageSize: 100 })).meta.total
    let avisar!: (pid: number) => void
    const pid = new Promise<number>(resolve => (avisar = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))
    // Otra transacción toma el sobre y, antes de soltarlo, lo bloquea: el cobro que espera ese candado fallará al entrar.
    const T = prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [t.id])
      avisar(await pidDe(tx))
      await puedeSoltar
      await tx.giftCard.update({ where: { id: t.id }, data: { status: 'BLOCKED' } })
    }, PRESUPUESTO)
    T.catch(() => undefined)
    const enVuelo: Promise<unknown>[] = [T]
    try {
      const pidT = await pid
      const A = payGiftCardOnNewOrder(venueId, venta(llave, t.codigo))
      enVuelo.push(A.catch(() => undefined))
      await esperarAQueAlguienEspereA(pidT) // A ya creó la cuenta en SU transacción y espera el sobre
      expect((await listOrders(venueId, { page: 1, pageSize: 100 })).meta.total).toBe(antes)
      expect(await prisma.order.findFirst({ where: { venueId, externalId: `giftpay:${llave}` } })).toBeNull()

      soltar()
      await expect(A).rejects.toMatchObject({ code: 'GIFT_CARD_BLOCKED' })
      expect(await cuentasDe(llave)).toBe(0)
      expect((await listOrders(venueId, { page: 1, pageSize: 100 })).meta.total).toBe(antes)
    } finally {
      soltar()
      await Promise.allSettled(enVuelo)
    }
  })

  describe('Q76 y Q110: la cuenta es del vendedor; el cobro, de la sesión que lo manda', () => {
    /** `pay-new-order` desde el controller (el esquema ya convirtió los pesos) con la sesión `quien`. */
    async function pagarComo(quien: string, body: Record<string, unknown>) {
      let data: any
      const res: any = { status: () => res, json: (b: any) => ((data = b.data), res) }
      const req: any = { params: { venueId }, body, authContext: { userId: quien }, headers: {}, ip: '127.0.0.1', get: () => undefined }
      await payNewOrder(req, res)
      return data
    }
    const bitacorasDe = (paymentId: string) =>
      (logAction as jest.Mock).mock.calls.map(([a]) => a).filter(a => a.action === 'GIFT_CARD_REDEEMED' && a.entityId === paymentId)
    const cuerpo = (llave: string, codigo: string, extra: Record<string, unknown> = {}) => ({
      items: [{ name: 'Blusa', quantity: 1, unitPrice: 30000 }],
      idempotencyKey: llave,
      proof: { kind: 'CODE', code: codigo },
      amount: D(100),
      tip: D(0),
      ...extra,
    })
    const deAna = () => ({ iniciadoPor: staffA, iniciadoPorNombre: 'Ana' })

    it('🔴 B reenvía con iniciadoPor A ⇒ el cobro y el REDEEM a nombre de B, con la nota; sin vendedor en el cuerpo, la cuenta es de B', async () => {
      const t = await tarjeta(1000)
      const r = await pagarComo(staffB, cuerpo(llaveNueva('q110-1'), t.codigo, deAna()))
      expect(r.replay).toBe(false)
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } })).processedById).toBe(staffB)
      expect((await prisma.giftCardActivity.findFirstOrThrow({ where: { paymentId: r.paymentId, type: 'REDEEM' } })).staffId).toBe(staffB)
      const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
      expect([cuenta.servedById, cuenta.createdById]).toEqual([staffB, staffB])
      const [bitacora] = bitacorasDe(r.paymentId)
      expect(bitacora.staffId).toBe(staffB)
      expect(bitacora.data).toMatchObject({ iniciadoPorSegunElAparato: { iniciadoPor: staffA, iniciadoPorNombre: 'Ana' } })
    })

    it('🔴 Q76: con el vendedor C en el cuerpo, la cuenta queda de C aunque el cobro lo procese B (con iniciadoPor A)', async () => {
      const t = await tarjeta(1000)
      const r = await pagarComo(staffB, cuerpo(llaveNueva('q76-c'), t.codigo, { staffId: staffC, ...deAna() }))
      const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
      expect([cuenta.servedById, cuenta.createdById]).toEqual([staffC, staffC])
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } })).processedById).toBe(staffB)
    })

    it('🔴 el primer envío de A sin los campos y el reenvío de B con ellos y la misma llave ⇒ `replay: true` (no IDEMPOTENCY_KEY_REUSED)', async () => {
      const t = await tarjeta(1000)
      const llave = llaveNueva('q110-reenvio')
      const a = await pagarComo(staffA, cuerpo(llave, t.codigo))
      const b = await pagarComo(staffB, cuerpo(llave, t.codigo, deAna()))
      expect([a.replay, b.replay, b.paymentId, b.orderId]).toEqual([false, true, a.paymentId, a.orderId])
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).processedById).toBe(staffA)
      expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
      // Una sola bitácora, la del cobro de A: el reintento (replay) no escribe otra.
      expect(bitacorasDe(a.paymentId).map(x => [x.staffId, x.data.iniciadoPorSegunElAparato])).toEqual([[staffA, undefined]])
    })
  })
})
