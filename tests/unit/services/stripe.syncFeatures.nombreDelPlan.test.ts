/**
 * Planes editables B1, Task 8: `syncFeaturesToStripe` (corre al arrancar y desde `scripts/sync-features-to-stripe.ts`) escribe el nombre
 * del producto de Pro y Premium por el ÚNICO escritor del nombre (`escribirNombreDelPlan`, bajo `plan-offer-nombre`).
 *
 * 🔴 Sin versión del editor (sin versiones o con sólo la v1) hacia Stripe nada cambia: las mismas llamadas, con el mismo cuerpo y en el
 * mismo orden que hoy. `GRABACION_DE_HOY` es lo que hacía el código antes de este cambio con estas funciones (se comprobó corriendo esta
 * misma prueba contra él). Lo único nuevo en el `products.update` de un plan es la opción de tiempo (10 s), que no viaja a Stripe.
 */
const llamadas: unknown[][] = []
const mockOpcionesDeRetry: unknown[] = []
const mockStripe = {
  productsUpdate: jest.fn(),
  productsCreate: jest.fn(),
  productsRetrieve: jest.fn(),
  pricesCreate: jest.fn(),
}
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    products: {
      update: (...a: unknown[]) => mockStripe.productsUpdate(...a),
      create: (...a: unknown[]) => mockStripe.productsCreate(...a),
      retrieve: (...a: unknown[]) => mockStripe.productsRetrieve(...a),
    },
    prices: { create: (...a: unknown[]) => mockStripe.pricesCreate(...a) },
  })),
)
jest.mock('@/utils/retry', () => {
  const real = jest.requireActual('@/utils/retry')
  return {
    ...real,
    retry: jest.fn((fn: () => Promise<unknown>, opciones: unknown) => {
      mockOpcionesDeRetry.push(opciones)
      return fn()
    }),
  }
})

import logger from '@/config/logger'
import { syncFeaturesToStripe } from '@/services/stripe.service'
import { shouldRetryStripeError } from '@/utils/retry'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const decimal = (pesos: number) => ({ toNumber: () => pesos })
const FUNCIONES = () => [
  {
    id: 'f_pro',
    code: 'PLAN_PRO',
    name: 'Plan Pro',
    description: 'Todo Pro',
    monthlyPrice: decimal(999),
    stripeProductId: 'prod_pro',
    stripePriceId: 'price_pro',
  },
  {
    id: 'f_premium',
    code: 'PLAN_PREMIUM',
    name: 'Plan Premium',
    description: null,
    monthlyPrice: decimal(1699),
    stripeProductId: 'prod_premium',
    stripePriceId: null,
  },
  {
    id: 'f_inv',
    code: 'INVENTORY_TRACKING',
    name: 'Inventario',
    description: 'Stock',
    monthlyPrice: decimal(299),
    stripeProductId: 'prod_inv',
    stripePriceId: 'price_inv',
  },
  {
    id: 'f_chat',
    code: 'CHATBOT',
    name: 'Chatbot',
    description: null,
    monthlyPrice: decimal(199),
    stripeProductId: null,
    stripePriceId: null,
  },
]

/** Lo que el código de antes de este cambio le mandaba a Stripe con `FUNCIONES()`: método y cuerpo, en orden. */
const GRABACION_DE_HOY = [
  ['products.update', 'prod_pro', { name: 'Plan Pro', description: 'Todo Pro' }],
  ['products.update', 'prod_premium', { name: 'Plan Premium', description: undefined }],
  [
    'prices.create',
    {
      product: 'prod_premium',
      unit_amount: 169900,
      currency: 'mxn',
      recurring: { interval: 'month' },
      metadata: { featureId: 'f_premium', featureCode: 'PLAN_PREMIUM' },
    },
  ],
  ['products.update', 'prod_inv', { name: 'Inventario', description: 'Stock' }],
  ['products.create', { name: 'Chatbot', description: undefined, metadata: { featureId: 'f_chat', featureCode: 'CHATBOT' } }],
  [
    'prices.create',
    {
      product: 'prod_chat_new',
      unit_amount: 19900,
      currency: 'mxn',
      recurring: { interval: 'month' },
      metadata: { featureId: 'f_chat', featureCode: 'CHATBOT' },
    },
  ],
]
/** Las opciones de `retry` de cada una de esas llamadas (las mismas de hoy). */
const RETRY_DE_HOY = [
  'stripe.updateProduct',
  'stripe.updateProduct',
  'stripe.createPrice',
  'stripe.updateProduct',
  'stripe.createProduct',
  'stripe.createPrice',
].map((context: string) => ({ retries: 3, shouldRetry: shouldRetryStripeError, context }))

const llamadasAStripe = () => llamadas.filter((l: unknown[]) => typeof l[0] === 'string' && /^(products|prices)\./.test(l[0] as string))
/** Sólo método y cuerpo (sin las opciones de la petición, que no viajan a Stripe). */
const sinOpciones = (l: unknown[]) => (l[0] === 'products.update' ? l.slice(0, 3) : l.slice(0, 2))

/** La transacción del escritor del nombre: registra el candado y la lectura de la vigente en la misma bitácora que Stripe. */
function usarTx(puntero: unknown) {
  const tx = {
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...valores: unknown[]) => {
      llamadas.push(['candado', sql.join('?'), ...valores])
      return 0
    }),
    planOfferPointer: {
      findUnique: jest.fn(async (args: { select?: Record<string, unknown> }) => {
        llamadas.push([args.select?.currentVersion ? 'lee la vigente' : 'lee la observación'])
        return puntero === null ? null : { ...(puntero as object), nombresEnStripe: null }
      }),
      update: jest.fn(async () => ({})),
    },
    feature: {
      findUnique: jest.fn(async (args: { where: { code: string } }) => ({
        stripeProductId: FUNCIONES().find((f: { code: string }) => f.code === args.where.code)?.stripeProductId ?? null,
      })),
    },
  }
  prismaMock.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
  return tx
}

beforeEach(() => {
  llamadas.length = 0
  mockOpcionesDeRetry.length = 0
  mockStripe.productsUpdate.mockReset().mockImplementation(async (...a: unknown[]) => {
    llamadas.push(['products.update', ...a])
    return { id: a[0], name: (a[1] as { name: string }).name }
  })
  mockStripe.productsCreate.mockReset().mockImplementation(async (...a: unknown[]) => {
    llamadas.push(['products.create', ...a])
    return { id: 'prod_chat_new' }
  })
  mockStripe.productsRetrieve.mockReset().mockImplementation(async (...a: unknown[]) => {
    llamadas.push(['products.retrieve', ...a])
    return { id: a[0], name: 'lo que sea' }
  })
  mockStripe.pricesCreate.mockReset().mockImplementation(async (...a: unknown[]) => {
    llamadas.push(['prices.create', ...a])
    return { id: `price_new_${(a[0] as { product: string }).product}` }
  })
  prismaMock.feature.findMany.mockReset().mockResolvedValue(FUNCIONES())
  prismaMock.feature.update.mockReset().mockResolvedValue({})
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
})

afterAll(() => {
  prismaMock.$transaction.mockImplementation((callback: (t: unknown) => unknown) => callback(prismaMock))
})

describe('syncFeaturesToStripe y el nombre de los planes', () => {
  it('🔴 sin versión del editor (sin versiones o sólo la v1): mismas llamadas a Stripe que hoy, con los mismos argumentos y en el mismo orden, sin products.retrieve; con PLAN_PRO sin stripePriceId crea su precio como hoy', async () => {
    for (const puntero of [null, punteroA('cv1', 1, versionUno())]) {
      llamadas.length = 0
      mockOpcionesDeRetry.length = 0
      const tx = usarTx(puntero)

      await syncFeaturesToStripe()

      const stripe = llamadasAStripe()
      expect(stripe.map(sinOpciones)).toEqual(GRABACION_DE_HOY)
      expect(mockOpcionesDeRetry).toEqual(RETRY_DE_HOY)
      expect(stripe.some((l: unknown[]) => l[0] === 'products.retrieve')).toBe(false)
      // La única opción nueva: el tope de 10 s en el products.update de los planes. Las demás funciones, sin opciones (como hoy).
      expect(stripe[0][3]).toEqual({ timeout: 10_000 })
      expect(stripe[1][3]).toEqual({ timeout: 10_000 })
      expect(stripe[3]).toHaveLength(3)
      // Lo nuevo es sólo el candado y la lectura de la vigente: nadie escribe la observación (la oferta no es dueña del nombre).
      expect(tx.planOfferPointer.update).not.toHaveBeenCalled()
      expect(llamadas.filter((l: unknown[]) => l[0] === 'lee la observación')).toEqual([])
      // Lo que se guarda en la base, como hoy.
      expect(prismaMock.feature.update.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        { where: { id: 'f_pro' }, data: { stripeProductId: 'prod_pro', stripePriceId: 'price_pro' } },
        { where: { id: 'f_premium' }, data: { stripeProductId: 'prod_premium', stripePriceId: 'price_new_prod_premium' } },
        { where: { id: 'f_inv' }, data: { stripeProductId: 'prod_inv', stripePriceId: 'price_inv' } },
        { where: { id: 'f_chat' }, data: { stripeProductId: 'prod_chat_new', stripePriceId: 'price_new_prod_chat_new' } },
      ])
      prismaMock.feature.update.mockClear()
    }

    // Y un PLAN_PRO sin precio crea el suyo, como hoy: después de su products.update.
    llamadas.length = 0
    usarTx(null)
    prismaMock.feature.findMany.mockResolvedValue([{ ...FUNCIONES()[0], stripePriceId: null }])
    await syncFeaturesToStripe()
    expect(llamadasAStripe().map(sinOpciones)).toEqual([
      ['products.update', 'prod_pro', { name: 'Plan Pro', description: 'Todo Pro' }],
      [
        'prices.create',
        {
          product: 'prod_pro',
          unit_amount: 99900,
          currency: 'mxn',
          recurring: { interval: 'month' },
          metadata: { featureId: 'f_pro', featureCode: 'PLAN_PRO' },
        },
      ],
    ])
  })

  it('🔴 con una vigente dueña del nombre de Pro, syncFeaturesToStripe escribe en prod_pro el nombre de la vigente (no Feature.name) y en las funciones el de siempre', async () => {
    const v2 = definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Pro Plus' }, productos: { PRO: 'Plan Avoqado Pro Plus' } })
    usarTx(punteroA('cv2', 2, v2))

    await syncFeaturesToStripe()

    const stripe = llamadasAStripe().map(sinOpciones)
    expect(stripe[0]).toEqual(['products.update', 'prod_pro', { name: 'Plan Avoqado Pro Plus', description: 'Todo Pro' }])
    // Premium no cambió de nombre en la v2: el del catálogo, como hoy. Y lo demás, igual que la grabación.
    expect(stripe.slice(1)).toEqual(GRABACION_DE_HOY.slice(1))
    expect(llamadas.some((l: unknown[]) => l[0] === 'products.retrieve')).toBe(false)
  })

  it('🔴 el update del nombre de un plan corre después de tomar plan-offer-nombre y con el nombre calculado de la vigente en esa tx', async () => {
    const v2 = definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Pro Plus' }, productos: { PRO: 'Plan Avoqado Pro Plus' } })
    const tx = usarTx(punteroA('cv2', 2, v2))

    await syncFeaturesToStripe()

    const orden = llamadas.map((l: unknown[]) => (l[0] === 'candado' ? `candado:${l[2]}` : (l[0] as string)))
    // Cada plan: candado → vigente → update (Pro, dueña de su nombre, anota además la observación). Las demás funciones, sin candado.
    expect(orden).toEqual([
      'candado:plan-offer-nombre',
      'lee la vigente',
      'products.update',
      'lee la observación',
      'candado:plan-offer-nombre',
      'lee la vigente',
      'products.update',
      'prices.create',
      'products.update',
      'products.create',
      'prices.create',
    ])
    expect((llamadas[0][1] as string).includes('pg_advisory_xact_lock(hashtext(?))')).toBe(true)
    expect(llamadas[2]).toEqual([
      'products.update',
      'prod_pro',
      { name: 'Plan Avoqado Pro Plus', description: 'Todo Pro' },
      { timeout: 10_000 },
    ])
    // La vigente se leyó con la transacción del candado, no con el cliente de afuera.
    expect(tx.planOfferPointer.findUnique).toHaveBeenCalledTimes(3)
    expect(tx.planOfferPointer.update).toHaveBeenCalledWith({
      where: { id: 'vigente' },
      data: { nombresEnStripe: { PRO: { esperado: 'Plan Avoqado Pro Plus', enStripe: 'Plan Avoqado Pro Plus', estado: 'RENOMBRADO' } } },
    })
    expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 15_000, timeout: 120_000 })
  })

  it('🔴 con versión del editor y products.update del plan fallando, NO crea el precio, igual que hoy', async () => {
    const v2 = definicionDePrueba({
      ids: idsDeLaVersion('v2'),
      nombres: { PREMIUM: 'Premium Max' },
      productos: { PREMIUM: 'Plan Avoqado Premium Max' },
    })
    usarTx(punteroA('cv2', 2, v2))
    const rechazo = Object.assign(new Error('Invalid request'), { type: 'StripeInvalidRequestError', statusCode: 400 })
    mockStripe.productsUpdate.mockImplementation(async (...a: unknown[]) => {
      llamadas.push(['products.update', ...a])
      if (a[0] === 'prod_premium') throw rechazo
      return { id: a[0], name: (a[1] as { name: string }).name }
    })

    await syncFeaturesToStripe()

    const stripe = llamadasAStripe().map(sinOpciones)
    // Premium (sin precio) intentó su nombre y NO creó su precio; las demás siguen.
    expect(stripe.filter((l: unknown[]) => l[0] === 'prices.create').map((l: unknown[]) => (l[1] as { product: string }).product)).toEqual([
      'prod_chat_new',
    ])
    expect(prismaMock.feature.update.mock.calls.map((c: unknown[]) => (c[0] as { where: { id: string } }).where.id)).toEqual([
      'f_pro',
      'f_inv',
      'f_chat',
    ])
    expect(logger.error).toHaveBeenCalledWith('❌ Error syncing feature PLAN_PREMIUM to Stripe:', rechazo)
  })

  it('🔴 si el candado o la lectura de la vigente fallan: aviso, NINGÚN nombre escrito para ese plan (ni sin candado) y sigue con el precio', async () => {
    usarTx(null)
    prismaMock.$transaction.mockRejectedValue(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))

    await syncFeaturesToStripe()

    const stripe = llamadasAStripe().map(sinOpciones)
    // Ni Pro ni Premium escriben su nombre; Premium igual crea su precio, y las demás funciones siguen como hoy.
    expect(stripe).toEqual(
      GRABACION_DE_HOY.filter((l: unknown[]) => !(l[0] === 'products.update' && /^prod_(pro|premium)$/.test(l[1] as string))),
    )
    expect(prismaMock.feature.update.mock.calls.map((c: unknown[]) => (c[0] as { where: { id: string } }).where.id)).toEqual([
      'f_pro',
      'f_premium',
      'f_inv',
      'f_chat',
    ])
    expect(logger.warn).toHaveBeenCalled()
  })
})
