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
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: piCreate,
      retrieve: jest.fn(async (id: string) => ({
        id,
        client_secret: `secret_${id}`,
        status: 'requires_payment_method',
        latest_charge: null,
      })),
      cancel: jest.fn(async (id: string) => ({ id, status: 'canceled' })),
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
