/**
 * Liga por prenda (Task 5), de punta a punta contra Postgres REAL: la clienta escoge la talla, se le aparta, se crea el intento
 * (Stripe simulado) y el cierre de siempre (`finalizePaymentLinkCheckout`) vende ESA talla: el renglón de la orden y el vale de
 * inventario llevan su `productId`. También la talla sin seguimiento por pieza llega hasta la orden.
 *
 * Correr: TEST_DATABASE_URL=<base desechable> npx jest --selectProjects integration --runInBand \
 *   --runTestsByPath tests/integration/dashboard/ligaPorPrenda.cobro.integration.test.ts --ci
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn().mockResolvedValue(1600),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
let n = 0
/** Estado de cada intento en el Stripe simulado (por omisión, todavía se puede confirmar). */
const estados = new Map<string, string>()
/** Como Stripe: la misma llave de idempotencia devuelve el MISMO intento. */
const porLlave = new Map<string, { id: string; client_secret: string; status: string; amount: number }>()
const piCreate = jest.fn(async (params: { amount: number }, opciones: { idempotencyKey: string }) => {
  const previo = porLlave.get(opciones.idempotencyKey)
  if (previo) return previo
  const pi = {
    id: `pi_talla_${process.pid}_${++n}`,
    client_secret: `secret_${n}`,
    status: 'requires_payment_method',
    amount: params.amount,
  }
  porLlave.set(opciones.idempotencyKey, pi)
  return pi
})
/** Encargo b578cd: detiene la RESPUESTA de una consulta (la foto ya se tomó: llega vieja si Stripe cambia mientras). */
let mockAntesDeResponder: ((id: string) => Promise<void>) | null = null
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: piCreate,
      retrieve: jest.fn(async (id: string) => {
        const foto = { id, client_secret: `secret_${id}`, status: estados.get(id) ?? 'requires_payment_method', latest_charge: null }
        if (mockAntesDeResponder) await mockAntesDeResponder(id)
        return foto
      }),
      cancel: jest.fn(async (id: string) => {
        estados.set(id, 'canceled')
        return { id, status: 'canceled' }
      }),
    },
  })),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createStripePaymentIntentForPaymentLink, finalizePaymentLinkCheckout } from '@/services/dashboard/paymentLink.service'
import { PaymentLinkHoldSweeperJob } from '@/jobs/payment-link-hold-sweeper.job'
import { borrarMundoComisiones, categoria, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

let m: MundoComisiones
let liga: { shortCode: string }
let grupo: string

/** Una talla de la familia (la escritura de `productGroupId` pide la marca del escritor único). */
async function talla(nombre: string, precio: number, existencia: number | null): Promise<string> {
  const cat = await categoria(m)
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('avoqado.product_group_writer', 'on', true)`
    const p = await tx.product.create({
      data: {
        venueId: m.venueId,
        categoryId: cat,
        sku: `${m.key}-${nombre}`,
        name: `Blusa · ${nombre}`,
        price: new Prisma.Decimal(precio),
        productGroupId: grupo,
        variantKey: `${m.key}-${nombre}`,
        trackInventory: existencia !== null,
        inventoryMethod: existencia !== null ? 'QUANTITY' : null,
      } as any,
    })
    if (existencia !== null) await tx.inventory.create({ data: { productId: p.id, venueId: m.venueId, currentStock: existencia } })
    return p.id
  })
}

beforeEach(async () => {
  m = await crearMundoComisiones('liga-talla')
  grupo = (await prisma.productGroup.create({ data: { venueId: m.venueId, name: 'Blusa', categoryId: await categoria(m) } })).id
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: 'STRIPE_CONNECT' },
    create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: m.venueId,
      businessName: 'Liga por prenda',
      contactEmail: `${m.key}-canal@example.test`,
      publicKey: `pk_test_${m.key}`,
      secretKeyHash: `hash-${m.key}`,
      providerId: proveedor.id,
      providerCredentials: { connectAccountId: 'acct_talla' },
      chargesEnabled: true,
    } as any,
  })
  liga = await prisma.paymentLink.create({
    data: {
      shortCode: `${Math.random().toString(36).slice(2, 10)}${n}`,
      venueId: m.venueId,
      ecommerceMerchantId: canal.id,
      createdById: m.owner,
      title: 'Blusa',
      amountType: 'FIXED',
      purpose: 'ITEM',
      productGroupId: grupo,
      isReusable: true,
      tippingConfig: { enabled: true, presets: [10] },
    },
  })
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fixture'
})

afterEach(async () => {
  estados.clear()
  mockAntesDeResponder = null
  if (m?.venueId) await prisma.paymentLinkStockHold.deleteMany({ where: { venueId: m.venueId } })
  await borrarMundoComisiones(m)
})

it.each([
  ['con seguimiento por pieza', 3],
  ['sin seguimiento por pieza', null],
])('talla %s: creación → cierre vende ESA talla', async (_n, existencia) => {
  const m1 = await talla('M', 500, existencia)
  await talla('L', 520, existencia)

  const r: any = await createStripePaymentIntentForPaymentLink(liga.shortCode, {
    productId: m1,
    browserToken: 'tok_integracion_0123456789',
    tipAmount: 50,
    customerEmail: `${m.key}-ana@example.test`,
  } as any)
  expect(r.amount).toBe(550)
  expect(piCreate.mock.calls.at(-1)![0]).toMatchObject({ amount: 55000, payment_method_types: ['card'] })

  const ficha = await prisma.paymentLinkStockHold.findFirstOrThrow({ where: { venueId: m.venueId } })
  expect(ficha).toMatchObject({ productId: m1, status: 'ACTIVE', stripePaymentIntentId: r.paymentIntentId, stripeAccountId: 'acct_talla' })

  // Repetir el POST con el mismo navegador y los mismos datos no crea otro intento.
  const llamadas = piCreate.mock.calls.length
  const otra: any = await createStripePaymentIntentForPaymentLink(liga.shortCode, {
    productId: m1,
    browserToken: 'tok_integracion_0123456789',
    tipAmount: 50,
    customerEmail: `${m.key}-ana@example.test`,
  } as any)
  expect(otra.paymentIntentId).toBe(r.paymentIntentId)
  expect(piCreate.mock.calls.length).toBe(llamadas)

  await finalizePaymentLinkCheckout({ stripeSessionId: r.paymentIntentId, paymentIntentId: r.paymentIntentId, amountPaidCents: 55000 })
  // Task 6: el cierre consume la ficha en la misma transacción del cobro.
  expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: ficha.id } })).toMatchObject({ status: 'CONSUMED' })

  const orden = await prisma.order.findFirstOrThrow({ where: { venueId: m.venueId, source: 'PAYMENT_LINK' }, include: { items: true } })
  expect(orden.items.map(i => i.productId)).toEqual([m1])
  if (existencia !== null) {
    const lineas = await prisma.inventoryPostingLine.findMany({ where: { posting: { venueId: m.venueId } }, take: 10 })
    expect(lineas.map(l => l.productId)).toEqual([m1])
  }
})

it('dos POST simultáneos del mismo navegador y talla → una ficha, un intento y una sesión', async () => {
  const m1 = await talla('S', 500, 1)
  const pedir = () =>
    createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: m1, browserToken: 'tok_concurrente_0123456789' } as any)
  const [a, b]: any[] = await Promise.all([pedir(), pedir()])
  expect(a.paymentIntentId).toBe(b.paymentIntentId)
  expect(await prisma.paymentLinkStockHold.count({ where: { venueId: m.venueId, status: 'ACTIVE' } })).toBe(1)
  expect(await prisma.checkoutSession.count({ where: { paymentLink: { venueId: m.venueId } } })).toBe(1)
  // La única pieza sigue apartada para ESTE navegador: otro navegador la ve agotada.
  await expect(
    createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: m1, browserToken: 'tok_otro_navegador_0123456789' } as any),
  ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_SOLD_OUT' })
})

describe('Task 6: cerrar y vencer', () => {
  const navegador = 'tok_vencer_0123456789abcdef'
  const apartar = async (productId: string) =>
    (await createStripePaymentIntentForPaymentLink(liga.shortCode, { productId, browserToken: navegador } as any)) as any
  /** El barrido con un Stripe propio (la cuenta con que se llama queda registrada). */
  const barrido = (stripe: { retrieve: jest.Mock; cancel: jest.Mock }) =>
    new PaymentLinkHoldSweeperJob({ cron: { start: jest.fn(), stop: jest.fn() } as any, stripe: { paymentIntents: stripe } as any })

  it('el barrido suelta la ficha vencida, cancela su intento con la cuenta congelada y la pieza vuelve a contar', async () => {
    const m1 = await talla('V', 500, 1)
    const r = await apartar(m1)
    const ficha = await prisma.paymentLinkStockHold.findFirstOrThrow({ where: { venueId: m.venueId } })
    await prisma.paymentLinkStockHold.update({ where: { id: ficha.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const stripe = {
      retrieve: jest.fn(async (id: string) => ({ id, status: 'requires_payment_method' })),
      cancel: jest.fn(async (id: string) => ({ id, status: 'canceled' })),
    }
    const res = await barrido(stripe).runNow()
    expect(res).toMatchObject({ errors: 0 })
    expect(stripe.cancel).toHaveBeenCalledWith(r.paymentIntentId, undefined, { stripeAccount: 'acct_talla' })
    expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: ficha.id } })).toMatchObject({
      status: 'RELEASED',
      releasedReason: 'intento_cancelado',
    })
    // La única pieza vuelve a estar libre para otro navegador.
    await expect(
      createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: m1, browserToken: 'tok_otra_clienta_0123456789' } as any),
    ).resolves.toMatchObject({ paymentIntentId: expect.any(String) })
  })

  it('el cobro llega con la ficha ya vencida y soltada → la venta se registra igual y la ficha no revive', async () => {
    const m1 = await talla('W', 500, 2)
    const r = await apartar(m1)
    const ficha = await prisma.paymentLinkStockHold.findFirstOrThrow({ where: { venueId: m.venueId } })
    await prisma.paymentLinkStockHold.update({ where: { id: ficha.id }, data: { status: 'RELEASED', releasedReason: 'vencida' } })

    await finalizePaymentLinkCheckout({ stripeSessionId: r.paymentIntentId, paymentIntentId: r.paymentIntentId, amountPaidCents: 50000 })

    expect(await prisma.order.count({ where: { venueId: m.venueId, source: 'PAYMENT_LINK' } })).toBe(1)
    expect(await prisma.payment.count({ where: { venueId: m.venueId, processorId: r.paymentIntentId } })).toBe(1)
    expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: ficha.id } })).toMatchObject({
      status: 'RELEASED',
      releasedReason: 'vencida',
    })
  })

  it('regresión: el aviso repetido de Stripe (P2002 del cobro) no deja dos órdenes ni dos vales', async () => {
    const m1 = await talla('X', 500, 2)
    const r = await apartar(m1)
    const cerrar = () =>
      finalizePaymentLinkCheckout({ stripeSessionId: r.paymentIntentId, paymentIntentId: r.paymentIntentId, amountPaidCents: 50000 })
    await cerrar()
    // El segundo aviso se cuela antes de ver la sesión COMPLETED (dos réplicas a la vez): lo detiene el índice único del cobro.
    await prisma.checkoutSession.update({ where: { sessionId: r.paymentIntentId }, data: { status: 'PENDING' } })
    await expect(cerrar()).rejects.toMatchObject({ code: 'P2002' })

    expect(await prisma.order.count({ where: { venueId: m.venueId, source: 'PAYMENT_LINK' } })).toBe(1)
    expect(await prisma.payment.count({ where: { venueId: m.venueId, processorId: r.paymentIntentId } })).toBe(1)
    expect(await prisma.inventoryPosting.count({ where: { venueId: m.venueId } })).toBe(1)
    expect(await prisma.paymentLinkStockHold.count({ where: { venueId: m.venueId, status: 'CONSUMED' } })).toBe(1)
  })
})

/**
 * 🔴 Codex código r2 (#2 a medias): dos pestañas del mismo navegador, M y L. La de L revisa sus fichas cuando la de M todavía no
 * ligaba su intento; luego M lo liga y empieza a pagar (processing). L suelta la ficha de M en `takeOrReuseHold` y, al ver su
 * intento en curso, contesta 409. Antes la ficha de M se quedaba RELEASED: OTRA compradora apartaba la última M y la pagaba
 * mientras M seguía pagando dentro de sus 15 minutos. Ahora la ficha de M vuelve a ACTIVE (CAS) y la última M sigue apartada.
 */
describe('carrera M/L: la ficha de M no se suelta mientras su pago sigue', () => {
  const navegador = 'tok_carrera_ml_0123456789ab'
  let espia: jest.SpyInstance | null = null
  afterEach(() => {
    espia?.mockRestore()
    espia = null
  })
  /** La revisión de previas de L corre ANTES de que M ligue su intento: no la ve. */
  function previasSinM(idM: string) {
    const real = prisma.paymentLinkStockHold.findMany.bind(prisma.paymentLinkStockHold)
    espia = jest.spyOn(prisma.paymentLinkStockHold, 'findMany').mockImplementationOnce((async (args: any) => {
      const filas = (await real(args)) as Array<{ id: string }>
      return filas.filter(f => f.id !== idM)
    }) as any)
  }

  it('M en processing → 409 a L, M sigue ACTIVE y una tercera compradora NO puede apartar la última M', async () => {
    const tallaM = await talla('CM', 500, 1)
    const tallaL = await talla('CL', 520, 1)
    const rM: any = await createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaM, browserToken: navegador } as any)
    const fichaM = await prisma.paymentLinkStockHold.findFirstOrThrow({ where: { stripePaymentIntentId: rM.paymentIntentId } })
    estados.set(rM.paymentIntentId, 'processing')

    previasSinM(fichaM.id)
    await expect(
      createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaL, browserToken: navegador } as any),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })

    expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: fichaM.id } })).toMatchObject({
      status: 'ACTIVE',
      releasedReason: null,
      expiresAt: fichaM.expiresAt,
    })
    // La ficha nueva de L (sin intento entregado) se soltó: L no queda apartada.
    expect(await prisma.paymentLinkStockHold.count({ where: { venueId: m.venueId, productId: tallaL, status: 'ACTIVE' } })).toBe(0)
    await expect(
      createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaM, browserToken: 'tok_tercera_compradora_0123' } as any),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_SOLD_OUT' })
  })

  it('L reusada con su intento ya entregado: con M en processing → 409, M vuelve a ACTIVE y L se queda como estaba', async () => {
    const tallaM = await talla('RM', 500, 1)
    const tallaL = await talla('RL', 520, 1)
    // Primero L (su pestaña ya tiene su intento) y después M, con el mismo navegador: apartar M suelta L y la de M queda viva.
    const rL: any = await createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaL, browserToken: navegador } as any)
    const fichaL = await prisma.paymentLinkStockHold.findFirstOrThrow({ where: { stripePaymentIntentId: rL.paymentIntentId } })
    // Escenario de la carrera: las dos fichas vivas a la vez (la de L ya entregada a su pestaña, la de M pagando).
    const fichaM = await prisma.paymentLinkStockHold.create({
      data: {
        venueId: m.venueId,
        paymentLinkId: fichaL.paymentLinkId,
        productId: tallaM,
        browserToken: navegador,
        amountCents: 50000,
        quantity: 1,
        expiresAt: new Date(Date.now() + 14 * 60_000),
        stripePaymentIntentId: 'pi_m_en_curso',
        stripeAccountId: 'acct_talla',
      },
    })
    estados.set('pi_m_en_curso', 'processing')

    previasSinM(fichaM.id)
    await expect(
      createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaL, browserToken: navegador } as any),
    ).rejects.toMatchObject({ code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })

    expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: fichaM.id } })).toMatchObject({ status: 'ACTIVE' })
    expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: fichaL.id } })).toMatchObject({
      status: 'ACTIVE',
      stripePaymentIntentId: rL.paymentIntentId,
    })
    await expect(
      createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaM, browserToken: 'tok_tercera_compradora_0456' } as any),
    ).rejects.toMatchObject({ code: 'PAYMENT_LINK_VARIANT_SOLD_OUT' })
  })
})

/**
 * Encargo b578cd · Codex r3b #1, contra Postgres real: POST de M en vuelo + dos POST de L del mismo navegador. L₁ y L₂ revisan
 * previas cuando M todavía no tiene intento; M liga pi_M y la clienta lo confirma; L₁ aparta (suelta M, crea L) y su consulta de
 * pi_M se queda en el camino; L₂ REUSA L. Antes: L₂ veía `released` vacío, creaba y entregaba pi_L → dos cobros posibles.
 */
describe('encargo b578cd: la solicitud que reusa la ficha nueva de otra también cierra lo que esa otra soltó', () => {
  const navegador = 'tok_b578cd_r3b_0123456789'
  let espia: jest.SpyInstance | null = null
  afterEach(() => {
    espia?.mockRestore()
    espia = null
  })

  async function secuencia(antesDeL2: (piM: string) => void = () => undefined) {
    const tallaM = await talla('BM', 500, 1)
    const tallaL = await talla('BL', 520, 1)
    const rM: any = await createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaM, browserToken: navegador } as any)
    const fichaM = await prisma.paymentLinkStockHold.findFirstOrThrow({ where: { stripePaymentIntentId: rM.paymentIntentId } })
    estados.set(rM.paymentIntentId, 'processing')
    // La revisión de previas (la consulta con OR, fuera del candado) de las dos L corrió antes de que M ligara su intento.
    const real = prisma.paymentLinkStockHold.findMany.bind(prisma.paymentLinkStockHold)
    espia = jest.spyOn(prisma.paymentLinkStockHold, 'findMany').mockImplementation((async (args: any) => {
      const filas = (await real(args)) as Array<{ id: string }>
      return args?.where?.OR ? filas.filter(f => f.id !== fichaM.id) : filas
    }) as any)
    let abrir!: () => void
    const puerta = new Promise<void>(r => (abrir = r))
    let consultas = 0
    mockAntesDeResponder = async id => {
      if (id === rM.paymentIntentId && consultas++ === 0) await puerta
    }
    const creadosAntes = piCreate.mock.calls.length
    const pagarL = () =>
      createStripePaymentIntentForPaymentLink(liga.shortCode, { productId: tallaL, browserToken: navegador } as any).then(
        (r: any) => ({ ok: true as const, r }),
        (e: any) => ({ ok: false as const, code: e?.code as string }),
      )
    const l1 = pagarL()
    for (let i = 0; i < 400 && consultas === 0; i++) await new Promise(r => setTimeout(r, 5))
    expect(consultas).toBe(1)
    antesDeL2(rM.paymentIntentId)
    const r2 = await pagarL()
    abrir()
    const r1 = await l1
    return { r1, r2, fichaM, tallaL, piM: rM.paymentIntentId as string, creados: piCreate.mock.calls.length - creadosAntes }
  }

  it('pi_M cobrando → L₂ y L₁ reciben 409 sin crear intento; M sigue apartada y L queda libre', async () => {
    const { r1, r2, fichaM, tallaL, creados } = await secuencia()
    expect(r2).toEqual({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    expect(r1).toEqual({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    expect(creados).toBe(0)
    expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: fichaM.id } })).toMatchObject({
      status: 'ACTIVE',
      releasedReason: null,
    })
    expect(await prisma.paymentLinkStockHold.count({ where: { productId: tallaL, status: 'ACTIVE' } })).toBe(0)
  })

  it('la consulta de L₁ llega vieja («processing») y pi_M ya se rechazó: L₂ lo cancela, entrega pi_L y L₁ NO suelta L', async () => {
    const { r1, r2, fichaM, piM } = await secuencia(pi => estados.set(pi, 'requires_payment_method'))
    expect(r2).toMatchObject({ ok: true })
    expect(estados.get(piM)).toBe('canceled')
    expect(r1).toEqual({ ok: false, code: 'PAYMENT_LINK_PAYMENT_IN_PROGRESS' })
    const piL = (r2 as any).r.paymentIntentId
    expect(await prisma.paymentLinkStockHold.findFirstOrThrow({ where: { stripePaymentIntentId: piL } })).toMatchObject({
      status: 'ACTIVE',
    })
    expect(await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: fichaM.id } })).toMatchObject({
      status: 'RELEASED',
      releasedReason: 'intento_cancelado',
    })
  })
})
