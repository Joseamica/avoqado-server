/**
 * S10 (P2-4) contra Postgres REAL: el cotizador conoce a la clienta.
 *
 * Lo que se acredita aquí (rulings R1–R9'' de `task-S10-go.md`):
 * - cotización = modo estricto, por construcción (R1'''): la simulación y la cuenta real que arma el folio dan el MISMO total, las
 *   mismas filas y los mismos puntos consumidos. Los importes esperados se calculan a mano con la regla VIGENTE de la caja (el % del
 *   cupón se aplica sobre lo que queda y el recálculo de un canje posterior lo vuelve a derivar sobre la cuenta completa, con flotantes):
 *   así un cambio de composición no pasa en silencio. Sus imprecisiones son deuda de BASE (`hz:dcc49fe5:D2`).
 * - la simulación no deja rastro (R4, E8) y no toca ninguna fila `Discount` (R9): espía de consultas.
 * - una cotización detenida no frena a la caja de OTRA clienta (R9): nadie queda esperando su candado.
 * - los usos propios del motor cuentan sólo para el límite global (R9'').
 * - sin lugar o sin pool conocido, la cotización sale sin beneficios y el cobro de otra clienta termina (R5'', R8''').
 *
 * Proveedores simulados (sockets, Wallet, avisos); todo lo demás es el código real.
 */
import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import * as bitacora from '@/services/dashboard/activity-log.service'
import * as motor from '@/services/dashboard/discountEngine.service'
import { applyAutomaticDiscounts } from '@/services/dashboard/discountEngine.service'
import * as pedidos from '@/services/online-ordering/order.service'
import { crearCuentaDelPedidoEnTx, toQuoteSnapshot } from '@/services/online-ordering/order.service'
import { quoteCart, toPublicQuote } from '@/services/online-ordering/quote.service'
import {
  SIMULACION,
  aplicarBeneficiosEnTx,
  cotizarConBeneficios,
  topeGlobalDeSimulaciones,
  type EleccionDeBeneficios,
} from '@/services/online-ordering/beneficios.service'
import { payCashOrder, removeOrderDiscount } from '@/services/mobile/order.mobile.service'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { limpiarNegocioDePrueba, pidDe } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn(async () => ({ notified: 0 })),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn() }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

jest.setTimeout(90_000)

const RUN = cuid()
const PESOS = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v).toFixed(2)
let orgId: string
let venueId: string
let combo: string
let cafe: string
let ciclo = 0
const original = { ...SIMULACION, transaccion: { ...SIMULACION.transaccion } }

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `s10-${RUN}`, email: `s10-${RUN}@example.test`, phone: '5550000000' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `s10-${RUN}`, slug: `itest-s10-${RUN}`, status: 'LIVE_DEMO', timezone: 'America/Mexico_City' },
    })
  ).id
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Menú', slug: `menu-${RUN}` } })
  const producto = (name: string, price: number) =>
    prisma.product.create({ data: { venueId, categoryId: categoria.id, name, sku: `S10-${name}-${RUN}`, price, availableOnline: true } })
  combo = (await producto('Combo', 100)).id
  cafe = (await producto('Cafe', 21.35)).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, stampsEnabled: true, pointsPerDollar: 1, redemptionRate: 0.01, minPointsRedeem: 1, stampsRequired: 7 },
  })
})

beforeEach(() => {
  // El tope de este proceso depende de la URL de la base de pruebas: aquí se fija para que los casos simulen (el de la URL, en R8''').
  Object.assign(SIMULACION, { ...original, global: 3, transaccion: { ...original.transaccion } })
})

afterEach(() => jest.restoreAllMocks())

afterAll(async () => {
  Object.assign(SIMULACION, original)
  if (!venueId) return
  await limpiarNegocioDePrueba(venueId)
  await prisma.couponRedemption.deleteMany({ where: { couponCode: { discount: { venueId } } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.couponCode.deleteMany({ where: { discount: { venueId } } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.customerGroup.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
})

// ── siembra ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Escena {
  clientaId: string
  grupoId: string
  automaticoId: string
  cuponId: string
  codigo: string
  codigoId: string
  premioId: string
}

/**
 * Una clienta en su propio grupo (así su automático no toca a los demás casos), con un automático de grupo de $10, un cupón del 10 %,
 * un premio fijo de $1 y `puntos`. `cuponDelMismo`: el código es del MISMO descuento que el automático (R9'').
 */
async function escena(
  o: {
    puntos?: number
    cupon?: Partial<Prisma.DiscountUncheckedCreateInput>
    automatico?: Partial<Prisma.DiscountUncheckedCreateInput>
  } & {
    cuponDelMismo?: boolean
    premio?: 'PENDING' | 'REDEEMED'
  } = {},
): Promise<Escena> {
  const n = ++ciclo
  const grupo = await prisma.customerGroup.create({ data: { venueId, name: `grupo-${n}` } })
  const clienta = await prisma.customer.create({
    data: { venueId, firstName: `Ana ${n}`, loyaltyPoints: o.puntos ?? 0, customerGroupId: grupo.id },
  })
  const automatico = await prisma.discount.create({
    data: {
      venueId,
      name: `Grupo ${n}`,
      type: 'FIXED_AMOUNT',
      value: 10,
      // De CUENTA y de su grupo: sólo lo ve esta clienta (y quien se meta a su grupo), así los casos no se cruzan.
      scope: 'ORDER',
      customerGroupId: grupo.id,
      isAutomatic: true,
      isStackable: true,
      active: true,
      ...o.automatico,
    },
  })
  const cupon = o.cuponDelMismo
    ? automatico
    : await prisma.discount.create({
        data: { venueId, name: `Diez ${n}`, type: 'PERCENTAGE', value: 10, scope: 'ORDER', isAutomatic: false, active: true, ...o.cupon },
      })
  const codigo = `S10${n}${RUN.slice(-8)}`.toUpperCase()
  const codigoId = (await prisma.couponCode.create({ data: { discountId: cupon.id, code: codigo } })).id
  const cartilla = await prisma.stampCard.create({
    data: { customerId: clienta.id, venueId, cycle: 1, stampsRequired: 7, stampsEarned: 7, completedAt: new Date() },
  })
  const premioId = (
    await prisma.stampReward.create({
      data: {
        stampCardId: cartilla.id,
        customerId: clienta.id,
        venueId,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 1,
        rewardLabel: 'Galleta gratis',
        status: o.premio ?? 'PENDING',
        ...(o.premio === 'REDEEMED' ? { redeemedAt: new Date() } : {}),
      },
    })
  ).id
  return { clientaId: clienta.id, grupoId: grupo.id, automaticoId: automatico.id, cuponId: cupon.id, codigo, codigoId, premioId }
}

const carrito = (productId: string) => [{ productId, quantity: 1 }]

/** El MISMO camino que creará el folio (S11): la cuenta real + `aplicarBeneficiosEnTx` estricto, confirmados. */
async function estricto(productId: string, clientaId: string, eleccion: EleccionDeBeneficios) {
  const quote = await quoteCart(venueId, carrito(productId))
  const folio = `S10-${cuid()}`
  return withDeadlockRetry(
    async tx => {
      const { orderId } = await crearCuentaDelPedidoEnTx(tx, {
        venueId,
        externalId: folio,
        orderNumber: folio,
        quote: toQuoteSnapshot(quote),
        customer: { name: 'Ana', phone: null, email: null },
        customerId: clientaId,
        note: null,
        paymentMode: 'PAY_AT_PICKUP',
      })
      return { orderId, ...(await aplicarBeneficiosEnTx(tx, { venueId, orderId, customerId: clientaId, eleccion })) }
    },
    { etiqueta: 'prueba:estricto' },
  )
}

const montos = (aplicados: Array<{ tipo: string; monto: Prisma.Decimal }>) => aplicados.map(a => [a.tipo, PESOS(a.monto)])

/** Todo lo que una cotización NO debe dejar (R4, E8). */
async function foto(e: Escena) {
  const [descuentos, codigo, premio, clienta] = await Promise.all([
    prisma.discount.findMany({ where: { venueId }, select: { id: true, currentUses: true }, orderBy: { id: 'asc' }, take: 200 }),
    prisma.couponCode.findUnique({ where: { id: e.codigoId }, select: { currentUses: true } }),
    prisma.stampReward.findUnique({ where: { id: e.premioId }, select: { status: true, orderDiscountId: true, redeemedAt: true } }),
    prisma.customer.findUnique({ where: { id: e.clientaId }, select: { loyaltyPoints: true } }),
  ])
  return {
    cuentas: await prisma.order.count({ where: { venueId } }),
    cotizaciones: await prisma.order.count({ where: { orderNumber: { startsWith: 'COTIZACION-' } } }),
    filas: await prisma.orderDiscount.count({ where: { order: { venueId } } }),
    canjes: await prisma.couponRedemption.count({ where: { couponCode: { discount: { venueId } } } }),
    configuraciones: await prisma.loyaltyConfig.count({ where: { venueId } }),
    movimientos: await prisma.loyaltyTransaction.count({ where: { customer: { venueId } } }),
    bandeja: await prisma.walletPassOutbox.count({ where: { venueId } }),
    bitacora: await prisma.activityLog.count({ where: { venueId } }),
    descuentos,
    codigo,
    premio,
    clienta,
  }
}

/**
 * Espía de consultas (R9): cada transacción que se abre recibe un `tx` que anota toda operación sobre `Discount` y todo SQL crudo.
 * Sólo lo que corre dentro de una transacción: la simulación no escribe nada fuera de la suya.
 */
function espiarTransacciones() {
  const anotado: string[] = []
  const real = prisma.$transaction.bind(prisma) as (...a: any[]) => any
  const sqlDe = (a: any) => (Array.isArray(a) ? a.join('?') : String(a?.sql ?? a?.strings?.join('?') ?? a))
  const envolver = (tx: any) =>
    new Proxy(tx, {
      get(t, k) {
        const v = t[k]
        if (k === 'discount')
          return new Proxy(v, {
            get: (d, op) => (typeof d[op] === 'function' ? (...a: any[]) => (anotado.push(`discount.${String(op)}`), d[op](...a)) : d[op]),
          })
        if (typeof k === 'string' && /^\$(query|execute)Raw/.test(k)) return (...a: any[]) => (anotado.push(sqlDe(a[0])), v.apply(t, a))
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  const espia = jest
    .spyOn(prisma, '$transaction')
    .mockImplementation(((fn: any, opts: any) =>
      typeof fn === 'function' ? real((tx: any) => fn(envolver(tx)), opts) : real(fn, opts)) as any)
  return { anotado, espia }
}

// ── casos ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S10 · la cotización = el modo estricto, con la regla vigente de la caja (R1''')", () => {
  it('sin sesión: la de hoy (total = subtotal, sin beneficios)', async () => {
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: null, eleccion: { cupon: 'X' } })
    expect(PESOS(q.total)).toBe('100.00')
    expect(q).not.toHaveProperty('beneficios')
    expect(q).not.toHaveProperty('aplicados')
  })

  it('automático de grupo $10 + cupón 10 % + premio $1 sobre $100 ⇒ $79, igual que el estricto', async () => {
    const e = await escena()
    const eleccion = { cupon: e.codigo.toLowerCase(), premioId: e.premioId }
    // A mano, con la regla de hoy: el automático deja $90; el cupón es el 10 % de lo que queda ($9) y la cuenta queda en $81; el premio
    // vale $1 sobre $81, y su recálculo vuelve a derivar el 10 % sobre la cuenta completa ($10): 100 − 10 − 10 − 1 = $79.
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion })

    expect(q.beneficios).toEqual({ calculados: true })
    expect(q.descartados).toEqual([])
    expect(PESOS(q.totalConBeneficios!)).toBe('79.00')
    expect(montos(q.aplicados!)).toEqual([
      ['DESCUENTO', '10.00'],
      ['CUPON', '10.00'],
      ['PREMIO', '1.00'],
    ])
    expect(q.oferta).toMatchObject({ premio: { id: e.premioId, etiqueta: 'Galleta gratis' }, cupon: true })

    const real = await estricto(combo, e.clientaId, eleccion)
    expect(PESOS(real.total)).toBe('79.00')
    expect(montos(real.aplicados)).toEqual(montos(q.aplicados!))
    const filas = await prisma.orderDiscount.findMany({ where: { orderId: real.orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    expect(filas.map(f => PESOS(f.amount))).toEqual(['10.00', '10.00', '1.00'])
    expect(await prisma.stampReward.findUnique({ where: { id: e.premioId }, select: { status: true } })).toEqual({ status: 'REDEEMED' })
  })

  it('la misma combinación con 100 puntos a $0.01 ⇒ $78; el estricto quema exactamente 100', async () => {
    const e = await escena({ puntos: 300 })
    const eleccion = { cupon: e.codigo, premioId: e.premioId, puntos: 100 }
    // Tras el premio la cuenta vale $79; 100 puntos valen $1 (cabe en la base) y se queman los 100: $78.
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion })
    expect(PESOS(q.totalConBeneficios!)).toBe('78.00')
    expect(montos(q.aplicados!)).toEqual([
      ['DESCUENTO', '10.00'],
      ['CUPON', '10.00'],
      ['PREMIO', '1.00'],
      ['PUNTOS', '1.00'],
    ])
    expect((await prisma.customer.findUnique({ where: { id: e.clientaId } }))!.loyaltyPoints).toBe(300)

    const real = await estricto(combo, e.clientaId, eleccion)
    expect(PESOS(real.total)).toBe('78.00')
    expect(montos(real.aplicados)).toEqual(montos(q.aplicados!))
    expect((await prisma.customer.findUnique({ where: { id: e.clientaId } }))!.loyaltyPoints).toBe(200)
  })

  it('r2 #1 con la regla de hoy: $21.35, cupón 10 %, premio $1 y 5,000 puntos ⇒ 2.13 + 1.00 + 18.22, 1,822 puntos y $0', async () => {
    const e = await escena({ puntos: 5000, automatico: { active: false } })
    const eleccion = { cupon: e.codigo, premioId: e.premioId, puntos: 5000 }
    // A mano: el cupón nace en $2.14 (centavos de `montoDelCupon`); el recálculo del premio lo vuelve $2.13 (flotantes) y la cuenta
    // vale $18.22; los puntos topan en $18.22 y queman ⌈18.22 / 0.01⌉ = 1,822 (con flotantes). Deuda de BASE: hz:dcc49fe5:D2.
    const q = await cotizarConBeneficios(venueId, carrito(cafe), { customerId: e.clientaId, eleccion })
    expect(PESOS(q.totalConBeneficios!)).toBe('0.00')
    expect(montos(q.aplicados!)).toEqual([
      ['CUPON', '2.13'],
      ['PREMIO', '1.00'],
      ['PUNTOS', '18.22'],
    ])
    // W7: la oferta ya no dice «5,000 puntos (−$50)»: dice los que el canje usa y quema abajo (1,822, −$18.22).
    expect(q.oferta?.puntos).toMatchObject({ maxPuntos: 5000, usables: { puntos: 1822, monto: 18.22 } })

    const real = await estricto(cafe, e.clientaId, eleccion)
    expect(PESOS(real.total)).toBe('0.00')
    expect(montos(real.aplicados)).toEqual(montos(q.aplicados!))
    expect((await prisma.customer.findUnique({ where: { id: e.clientaId } }))!.loyaltyPoints).toBe(5000 - 1822)
    const movimiento = await prisma.loyaltyTransaction.findFirst({ where: { customerId: e.clientaId, type: 'REDEEM' } })
    expect(movimiento?.points).toBe(-1822)
  })

  it('E7: un cupón por producto se rechaza como en caja (descartado al cotizar; BENEFIT_UNAVAILABLE en estricto)', async () => {
    const e = await escena({ cupon: { scope: 'ITEM', targetItemIds: [combo] } })
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: { cupon: e.codigo } })
    expect(q.descartados).toEqual(['CUPON'])
    expect(PESOS(q.totalConBeneficios!)).toBe('90.00')
    await expect(estricto(combo, e.clientaId, { cupon: e.codigo })).rejects.toMatchObject({
      code: 'BENEFIT_UNAVAILABLE',
      details: { cual: 'CUPON' },
    })
  })

  it('un premio ya canjeado en el SAVEPOINT real: descartado y lo demás aplicado; en estricto, rechazo', async () => {
    const e = await escena({ puntos: 100, premio: 'REDEEMED' })
    const eleccion = { cupon: e.codigo, premioId: e.premioId, puntos: 100 }
    // Sin premio: automático $10, cupón $9 ($81); los puntos ($1) recalculan y el cupón vuelve a $10: $79.
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion })
    expect(q.descartados).toEqual(['PREMIO'])
    expect(PESOS(q.totalConBeneficios!)).toBe('79.00')
    expect(montos(q.aplicados!)).toEqual([
      ['DESCUENTO', '10.00'],
      ['CUPON', '10.00'],
      ['PUNTOS', '1.00'],
    ])
    await expect(estricto(combo, e.clientaId, eleccion)).rejects.toMatchObject({ code: 'BENEFIT_UNAVAILABLE', details: { cual: 'PREMIO' } })
  })
})

describe('D8 · en qué renglón del carrito cae el premio de producto gratis (contra Postgres)', () => {
  /** La escena de siempre, con su premio cambiado a PRODUCTO GRATIS. */
  async function cafeGratis() {
    const e = await escena()
    await prisma.stampReward.update({
      where: { id: e.premioId },
      data: { rewardType: 'FREE_PRODUCT', rewardValue: null, rewardLabel: 'Café gratis' },
    })
    return e
  }
  /** El MISMO camino del folio (S11) con un carrito de varios renglones. */
  async function estrictoCon(items: Array<{ productId: string; quantity: number }>, clientaId: string, eleccion: EleccionDeBeneficios) {
    const quote = await quoteCart(venueId, items)
    const folio = `D8-${cuid()}`
    return withDeadlockRetry(
      async tx => {
        const { orderId } = await crearCuentaDelPedidoEnTx(tx, {
          venueId,
          externalId: folio,
          orderNumber: folio,
          quote: toQuoteSnapshot(quote),
          customer: { name: 'Ana', phone: null, email: null },
          customerId: clientaId,
          note: null,
          paymentMode: 'PAY_AT_PICKUP',
        })
        return aplicarBeneficiosEnTx(tx, { venueId, orderId, customerId: clientaId, eleccion })
      },
      { etiqueta: 'prueba:estricto-d8' },
    )
  }
  const premioDe = <T extends { tipo: string }>(aplicados: T[]) => aplicados.find(a => a.tipo === 'PREMIO')

  it('ofrecido: «Va en tu Combo» (renglón 1, el que más le regala) sin dejar rastro; elegido: lo aplicado y la oferta dicen el mismo, igual que el estricto', async () => {
    const e = await cafeGratis()
    const carro = [
      { productId: cafe, quantity: 1 },
      { productId: combo, quantity: 1 },
    ]
    const antes = await foto(e)

    const ofrecido = await cotizarConBeneficios(venueId, carro, { customerId: e.clientaId, eleccion: null })
    expect(ofrecido.beneficios).toEqual({ calculados: true })
    expect(ofrecido.oferta?.premio).toEqual({ id: e.premioId, etiqueta: 'Café gratis', lineIndex: 1 })
    expect(await foto(e)).toEqual(antes)

    const elegido = await cotizarConBeneficios(venueId, carro, { customerId: e.clientaId, eleccion: { premioId: e.premioId } })
    expect(premioDe(elegido.aplicados!)).toMatchObject({ nombre: 'Café gratis', lineIndex: 1 })
    expect(PESOS(premioDe(elegido.aplicados!)!.monto)).toBe('100.00')
    expect(elegido.oferta?.premio?.lineIndex).toBe(1)
    expect(await foto(e)).toEqual(antes)

    const real = await estrictoCon(carro, e.clientaId, { premioId: e.premioId })
    expect(premioDe(real.aplicados)?.lineIndex).toBe(1)
  })

  it('el índice es el del carrito que mandó la tienda: con el Combo primero, renglón 0', async () => {
    const e = await cafeGratis()
    const q = await cotizarConBeneficios(
      venueId,
      [
        { productId: combo, quantity: 1 },
        { productId: cafe, quantity: 2 },
      ],
      {
        customerId: e.clientaId,
        eleccion: null,
      },
    )
    expect(q.oferta?.premio?.lineIndex).toBe(0)
  })

  it('Codex r1: con la cuenta ya en cero (cupón de cuenta del 100 %), no se ofrece renglón: elegido, el canje lo descarta', async () => {
    const e = await cafeGratis()
    await prisma.discount.update({ where: { id: e.cuponId }, data: { value: 100 } })
    const ofrecido = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: { cupon: e.codigo } })
    expect(PESOS(ofrecido.totalConBeneficios!)).toBe('0.00')
    expect(ofrecido.oferta?.premio).toEqual({ id: e.premioId, etiqueta: 'Café gratis' })
    const elegido = await cotizarConBeneficios(venueId, carrito(combo), {
      customerId: e.clientaId,
      eleccion: { cupon: e.codigo, premioId: e.premioId },
    })
    expect(elegido.descartados).toEqual(['PREMIO'])
  })

  it('un premio de monto fijo (de cuenta) no trae renglón, ni ofrecido ni aplicado', async () => {
    const e = await escena()
    const ofrecido = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: null })
    expect(ofrecido.oferta?.premio).toEqual({ id: e.premioId, etiqueta: 'Galleta gratis' })
    const elegido = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: { premioId: e.premioId } })
    expect(premioDe(elegido.aplicados!)).not.toHaveProperty('lineIndex')
  })

  /** W7 A1: la escena del folio W2UJM: hamburguesa $129 + americano $30, $15 del motor, cupón 10 % y café gratis. */
  let carroA1: Array<{ productId: string; quantity: number }> | null = null
  async function escenaW2UJM() {
    const e = await cafeGratis()
    await prisma.discount.update({ where: { id: e.automaticoId }, data: { value: 15 } })
    if (!carroA1) {
      const categoria = await prisma.menuCategory.findFirstOrThrow({ where: { venueId }, select: { id: true } })
      const producto = async (name: string, price: number) =>
        (
          await prisma.product.create({
            data: { venueId, categoryId: categoria.id, name, sku: `A1-${name}-${RUN}`, price, availableOnline: true },
          })
        ).id
      carroA1 = [
        { productId: await producto('Hamburguesa', 129), quantity: 1 },
        { productId: await producto('Americano', 30), quantity: 1 },
      ]
    }
    return { e, carro: carroA1, eleccion: { cupon: e.codigo, premioId: e.premioId } }
  }

  it('🔴 Codex r2 #1 — control: cuenta llena SIN tope (fijo $50 + 10 % de lo que queda + fijo $45); quitar el $45 en la TPV cobra $45, como hoy', async () => {
    const venta = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `A1C${++ciclo}`,
        type: 'PICKUP',
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 100,
        discountAmount: 0,
        taxAmount: 0,
        total: 100,
        remainingBalance: 100,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        items: { create: [{ productId: combo, productName: 'Combo', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 }] },
      },
    })
    for (const [tipo, valor] of [
      ['FIXED_AMOUNT', 50],
      ['PERCENTAGE', 10],
      ['FIXED_AMOUNT', 45],
    ] as const) {
      expect(
        await motor.applyManualDiscount(venta.id, tipo, valor, `${tipo} ${valor}`, undefined, undefined, 'A1', venueId, true),
      ).toMatchObject({
        success: true,
      })
    }
    const filas = await prisma.orderDiscount.findMany({ where: { orderId: venta.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    expect(filas.map(f => PESOS(f.amount))).toEqual(['50.00', '5.00', '45.00'])

    await motor.removeDiscountFromOrder(venta.id, filas[2].id, undefined, venueId)

    const quedan = await prisma.orderDiscount.findMany({ where: { orderId: venta.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    expect(quedan.map(f => PESOS(f.amount))).toEqual(['50.00', '5.00'])
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: venta.id }, select: { discountAmount: true, total: true } })
    expect(PESOS(cuenta.discountAmount)).toBe('55.00')
    expect(PESOS(cuenta.total)).toBe('45.00')
    ;(bitacora.logAction as jest.Mock).mockClear()
  })

  it('🔴 W7 A1: quitar después el premio libera lugar y el cupón vuelve a lo suyo ($128.10), igual en la TPV que en el móvil', async () => {
    for (const quitar of [
      (orderId: string, filaId: string) => motor.removeDiscountFromOrder(orderId, filaId, undefined, venueId),
      (orderId: string, filaId: string) => removeOrderDiscount(venueId, orderId, filaId),
    ]) {
      const { e, carro, eleccion } = await escenaW2UJM()
      const real = await estrictoCon(carro, e.clientaId, eleccion)
      const premio = premioDe(real.aplicados)!
      const { orderId } = await prisma.orderDiscount.findUniqueOrThrow({ where: { id: premio.orderDiscountId } })
      await quitar(orderId, premio.orderDiscountId)

      const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { discountAmount: true, total: true } })
      const filas = await prisma.orderDiscount.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      expect(filas.map(f => PESOS(f.amount))).toEqual(['15.00', '15.90'])
      expect(PESOS(cuenta.discountAmount)).toBe('30.90')
      expect(PESOS(cuenta.total)).toBe('128.10')
      expect(await prisma.stampReward.findUnique({ where: { id: e.premioId }, select: { status: true } })).toEqual({ status: 'PENDING' })
    }
    // `logAction` es un jest.fn() global de la integración: sus llamadas de quitar no deben llegar al espía de «no deja rastro».
    ;(bitacora.logAction as jest.Mock).mockClear()
  })

  it('🔴 W7 puntos usables: la cotización dice los puntos que el canje de verdad usa, en el mismo punto de la cadena', async () => {
    // Sin premio: el motor deja $144 y el cupón $129.60; 20,000 puntos ($200) sólo usan lo que queda.
    const { e, carro } = await escenaW2UJM()
    await prisma.customer.update({ where: { id: e.clientaId }, data: { loyaltyPoints: 20000 } })
    const q = await cotizarConBeneficios(venueId, carro, { customerId: e.clientaId, eleccion: { cupon: e.codigo } })
    const usables = q.oferta!.puntos!.usables!
    expect(q.oferta!.puntos!.maxPuntos).toBe(20000)
    expect(usables.monto).toBe(129.6)
    expect(usables.puntos).toBeLessThan(20000)
    expect(toPublicQuote(q).oferta?.puntos?.usables).toEqual(usables)
    // Eligiéndolos, la cotización aplica exactamente eso…
    const conPuntos = await cotizarConBeneficios(venueId, carro, { customerId: e.clientaId, eleccion: { cupon: e.codigo, puntos: 20000 } })
    expect(conPuntos.aplicados!.find(a => a.tipo === 'PUNTOS')!.monto.toNumber()).toBe(usables.monto)
    expect(PESOS(conPuntos.totalConBeneficios!)).toBe('0.00')
    // …y el canje real quema esos mismos puntos y descuenta lo mismo; los % no pasan de la cuenta.
    const real = await estrictoCon(carro, e.clientaId, { cupon: e.codigo, puntos: 20000 })
    expect(real.aplicados.find(a => a.tipo === 'PUNTOS')!.monto.toNumber()).toBe(usables.monto)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: e.clientaId } })).loyaltyPoints).toBe(20000 - usables.puntos)
    const { orderId } = await prisma.orderDiscount.findUniqueOrThrow({ where: { id: real.aplicados[0].orderDiscountId } })
    expect(PESOS((await prisma.orderDiscount.aggregate({ where: { orderId }, _sum: { amount: true } }))._sum.amount!)).toBe('159.00')

    // Con el premio, ya no queda nada: la oferta dice 0 y el canje los rechaza (descartados al cotizar, rechazo en estricto).
    const otra = await escenaW2UJM()
    await prisma.customer.update({ where: { id: otra.e.clientaId }, data: { loyaltyPoints: 300 } })
    const sinLugar = await cotizarConBeneficios(venueId, otra.carro, { customerId: otra.e.clientaId, eleccion: otra.eleccion })
    expect(sinLugar.oferta!.puntos!.usables).toEqual({ puntos: 0, monto: 0 })
    const pidiendo = await cotizarConBeneficios(venueId, otra.carro, {
      customerId: otra.e.clientaId,
      eleccion: { ...otra.eleccion, puntos: 300 },
    })
    expect(pidiendo.descartados).toEqual(['PUNTOS'])
    await expect(estrictoCon(otra.carro, otra.e.clientaId, { ...otra.eleccion, puntos: 300 })).rejects.toMatchObject({
      code: 'BENEFIT_UNAVAILABLE',
      details: { cual: 'PUNTOS' },
    })
  })

  it('🔴 W7 A1 (folio W2UJM): $15 del motor + cupón 10 % + café gratis sobre $159 ⇒ 15 + 15.00 + 129 = $159 (hoy el cupón $15.90 y Σ $159.90), igual que el estricto', async () => {
    const { e, carro, eleccion } = await escenaW2UJM()
    // A mano: el motor deja $144; el cupón nace en 10 % de lo que queda ($14.40); P11 regala la hamburguesa entera ($129, cabe en
    // $129.60). El recálculo del premio vuelve a derivar el cupón sobre la cuenta completa ($15.90): ahí sólo caben $15.00.
    const q = await cotizarConBeneficios(venueId, carro, { customerId: e.clientaId, eleccion })
    expect(q.descartados).toEqual([])
    expect(PESOS(q.totalConBeneficios!)).toBe('0.00')
    expect(montos(q.aplicados!)).toEqual([
      ['DESCUENTO', '15.00'],
      ['CUPON', '15.00'],
      ['PREMIO', '129.00'],
    ])

    const real = await estrictoCon(carro, e.clientaId, eleccion)
    expect(PESOS(real.total)).toBe('0.00')
    expect(montos(real.aplicados)).toEqual(montos(q.aplicados!))
    const { orderId } = await prisma.orderDiscount.findUniqueOrThrow({ where: { id: real.aplicados[0].orderDiscountId } })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { subtotal: true, discountAmount: true } })
    const filas = await prisma.orderDiscount.aggregate({ where: { orderId }, _sum: { amount: true } })
    expect(PESOS(cuenta.subtotal)).toBe('159.00')
    expect(PESOS(cuenta.discountAmount)).toBe('159.00')
    expect(PESOS(filas._sum.amount!)).toBe('159.00')
    // Lo que el tope le quitó al cupón queda marcado en su reparto (para devolvérselo si se libera lugar sin recalcular).
    const cupon = await prisma.orderDiscount.findUniqueOrThrow({ where: { id: real.aplicados[1].orderDiscountId } })
    expect(cupon.reparto).toMatchObject({ topado: 90, renglones: expect.any(Object) })
  })
})

describe('S10 · r5 #2: el desglose no se trunca en silencio', () => {
  it('51 filas (49 automáticos de $1 + premio + puntos) ⇒ las 51 en aplicados, igual que el estricto, y el total de la cuenta', async () => {
    // Una cuenta con muchas filas tarda más que el presupuesto de higiene: aquí se mide el desglose, no el tiempo.
    SIMULACION.transaccion.timeout = 30_000
    const e = await escena({ puntos: 300, automatico: { value: 1 } })
    for (let i = 1; i < 49; i++) {
      await prisma.discount.create({
        data: {
          venueId,
          name: `Grupo extra ${i}`,
          type: 'FIXED_AMOUNT',
          value: 1,
          scope: 'ORDER',
          customerGroupId: e.grupoId,
          isAutomatic: true,
          isStackable: true,
          active: true,
        },
      })
    }
    const eleccion = { premioId: e.premioId, puntos: 100 }
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion })

    expect(q.beneficios).toEqual({ calculados: true })
    expect(q.aplicados).toHaveLength(51)
    expect(q.aplicados!.filter(a => a.tipo === 'DESCUENTO')).toHaveLength(49)
    expect(q.aplicados!.slice(-2).map(a => a.tipo)).toEqual(['PREMIO', 'PUNTOS'])
    expect(q).not.toHaveProperty('aplicadosCompletos')
    // 100 − 49 × $1 − premio $1 − 100 puntos ($1) = $49.
    expect(PESOS(q.totalConBeneficios!)).toBe('49.00')

    const real = await estricto(combo, e.clientaId, eleccion)
    expect(real.aplicados).toHaveLength(51)
    expect(PESOS(real.total)).toBe('49.00')
    expect(montos(real.aplicados)).toEqual(montos(q.aplicados!))
  })
})

describe("S10 · R9'': los usos propios del motor sólo cuentan para el límite global", () => {
  it('r3 #1: automático y cupón del MISMO descuento en su último uso global ⇒ los dos modos dejan fuera el cupón ($90)', async () => {
    const e = await escena({ cuponDelMismo: true, automatico: { maxTotalUses: 1, currentUses: 0 } })
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: { cupon: e.codigo } })
    expect(q.descartados).toEqual(['CUPON'])
    expect(PESOS(q.totalConBeneficios!)).toBe('90.00')
    expect((await prisma.discount.findUnique({ where: { id: e.automaticoId } }))!.currentUses).toBe(0)

    await expect(estricto(combo, e.clientaId, { cupon: e.codigo })).rejects.toMatchObject({ details: { cual: 'CUPON' } })
    const sinCupon = await estricto(combo, e.clientaId, {})
    expect(PESOS(sinCupon.total)).toBe('90.00')
  })

  it('r4 #1: maxUsesPerCustomer = 1 sin usos, automático + cupón del mismo descuento ⇒ el cupón pasa en los dos modos ($80)', async () => {
    const e = await escena({ cuponDelMismo: true, automatico: { maxUsesPerCustomer: 1 } })
    const q = await cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: { cupon: e.codigo } })
    expect(q.descartados).toEqual([])
    expect(PESOS(q.totalConBeneficios!)).toBe('80.00')

    const real = await estricto(combo, e.clientaId, { cupon: e.codigo })
    expect(PESOS(real.total)).toBe('80.00')
    expect(montos(real.aplicados)).toEqual(montos(q.aplicados!))
  })
})

describe('S10 · la simulación no deja rastro ni toca Discount (R4, R9, E8)', () => {
  it('cotizar con todo elegido deja la base igual, no emite nada y no hace ningún UPDATE ni candado sobre Discount', async () => {
    const e = await escena({ puntos: 300 })
    const antes = await foto(e)
    const info = jest.spyOn(logger, 'info')
    const log = jest.spyOn(bitacora, 'logAction')
    ;(socketManager.broadcastToVenue as jest.Mock).mockClear()
    ;(notifyCustomerPassUpdated as jest.Mock).mockClear()
    const { anotado } = espiarTransacciones()

    const q = await cotizarConBeneficios(venueId, carrito(combo), {
      customerId: e.clientaId,
      eleccion: { cupon: e.codigo, premioId: e.premioId, puntos: 100 },
    })

    expect(q.beneficios).toEqual({ calculados: true })
    expect(q.aplicados).toHaveLength(4)
    expect(await foto(e)).toEqual(antes)
    expect(log).not.toHaveBeenCalled()
    expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
    expect(notifyCustomerPassUpdated).not.toHaveBeenCalled()
    expect(info.mock.calls.filter(c => String(c[0]).includes('Discount applied'))).toHaveLength(0)
    // R9: la simulación lee `Discount` (el motor y el cupón), pero nunca la escribe ni la bloquea, y no toma el asesor del cupón.
    expect(anotado.filter(a => /^discount\.(update|updateMany|upsert|delete|deleteMany|create)/.test(a))).toEqual([])
    expect(anotado.filter(a => /UPDATE\s+"Discount"|"Discount"[\s\S]*FOR (NO KEY )?UPDATE|cupon-descuento/i.test(a))).toEqual([])
    expect(anotado.some(a => a.startsWith('SAVEPOINT beneficio_'))).toBe(true)
  })
})

describe('S10 · R9: una cotización detenida no frena a la caja de OTRA clienta', () => {
  it('detenida tras el motor, la caja aplica el MISMO automático a otra clienta del grupo sin esperar nada', async () => {
    const e = await escena()
    const otra = await prisma.customer.create({ data: { venueId, firstName: 'Bea', customerGroupId: e.grupoId } })
    const venta = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `S10C${++ciclo}`,
        type: 'PICKUP',
        customerId: otra.id,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 100,
        discountAmount: 0,
        taxAmount: 0,
        total: 100,
        remainingBalance: 100,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        items: { create: [{ productId: combo, productName: 'Combo', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 }] },
      },
    })
    // La pausa no debe vencer la transacción de la simulación: aquí se mide si la caja espera, no el tiempo.
    SIMULACION.transaccion.timeout = 20_000
    let abrir!: () => void
    const compuerta = new Promise<void>(r => (abrir = r))
    let pidDeLaSimulacion: number | null = null
    let detenida!: () => void
    const yaDetenida = new Promise<void>(r => (detenida = r))
    const real = motor.aplicarDescuentosDelMotorEnTx
    jest.spyOn(motor, 'aplicarDescuentosDelMotorEnTx').mockImplementation(async (tx, a) => {
      const r = await real(tx, a)
      if (a.simulacion) {
        pidDeLaSimulacion = await pidDe(tx)
        detenida()
        await compuerta
      }
      return r
    })

    const cotizacion = cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: { cupon: e.codigo } })
    await yaDetenida
    let esperando = 0
    let terminada = false
    const caja = applyAutomaticDiscounts(venta.id, undefined, venueId).finally(() => (terminada = true))
    while (!terminada) {
      const [fila] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND ${pidDeLaSimulacion}::int = ANY(pg_blocking_pids(pid))`
      esperando = Math.max(esperando, fila.n)
      await new Promise(r => setTimeout(r, 10))
    }
    const r = await caja

    expect(esperando).toBe(0)
    expect(r.applied.map(d => d.discountId)).toEqual([e.automaticoId])
    expect((await prisma.discount.findUnique({ where: { id: e.automaticoId } }))!.currentUses).toBe(1)
    abrir()
    const q = await cotizacion
    expect(q.beneficios).toEqual({ calculados: true })
    expect(PESOS(q.totalConBeneficios!)).toBe('81.00')
  })
})

describe("S10 · carga (R5'', R8''')", () => {
  it('10 cotizaciones a la vez: ninguna truena; las que no alcanzan lugar salen sin beneficios y sin descartados', async () => {
    const e = await escena({ puntos: 300 })
    const eleccion = { cupon: e.codigo, premioId: e.premioId, puntos: 100 }
    const todas = await Promise.all(
      Array.from({ length: 10 }, () => cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion })),
    )
    for (const q of todas) {
      if (q.beneficios?.calculados) expect(PESOS(q.totalConBeneficios!)).toBe('78.00')
      else {
        expect(q).toMatchObject({ beneficios: { calculados: false } })
        expect(q.descartados).toBeUndefined()
      }
    }
    expect(todas.some(q => q.beneficios?.calculados)).toBe(true)
  })

  it('sin connection_limit explícito ⇒ 0 simulaciones: calculados:false sin abrir transacción, y el cobro de otra clienta termina', async () => {
    SIMULACION.global = topeGlobalDeSimulaciones(`${process.env.DATABASE_URL!.split('?')[0]}?pgbouncer=true`)
    expect(SIMULACION.global).toBe(0)
    const e = await escena()
    const otra = await prisma.customer.create({ data: { venueId, firstName: 'Caro' } })
    const venta = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `S10P${++ciclo}`,
        type: 'PICKUP',
        customerId: otra.id,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 100,
        discountAmount: 0,
        taxAmount: 0,
        total: 100,
        remainingBalance: 100,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        items: { create: [{ productId: combo, productName: 'Combo', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 }] },
      },
    })
    const cuentaProvisional = jest.spyOn(pedidos, 'crearCuentaDelPedidoEnTx')

    const [q] = await Promise.all([
      cotizarConBeneficios(venueId, carrito(combo), { customerId: e.clientaId, eleccion: { cupon: e.codigo } }),
      payCashOrder(venueId, venta.id, { amount: 10_000, tip: 0, idempotencyKey: `s10-cobro-${venta.id}` } as any),
    ])

    expect(q).toMatchObject({ beneficios: { calculados: false } })
    expect(PESOS(q.total)).toBe('100.00')
    expect(cuentaProvisional).not.toHaveBeenCalled()
    expect((await prisma.order.findUnique({ where: { id: venta.id } }))!.paymentStatus).toBe('PAID')
  })
})
