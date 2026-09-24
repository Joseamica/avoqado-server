/**
 * 🔴 Codex C3 (22-sep): el cambio de plan se ejecuta DENTRO del candado de la regla común. Con los valores del SDK (80 s y
 * 2 reintentos) una sola llamada podía durar más que la transacción: el candado se soltaba con el cambio todavía en vuelo.
 */
const mockRetrieve = jest.fn()
const mockUpdate = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ subscriptions: { retrieve: mockRetrieve, update: mockUpdate } })))

import { tierQueVendeLaSuscripcion, updateSubscriptionPrice } from '../../../src/services/stripe.service'
import { prismaMock } from '@tests/__helpers__/setup'

const SIN = expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 })

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [{ id: 'si_plan' }] } })
  mockUpdate.mockResolvedValue({ id: 'sub_1', status: 'active' })
  prismaMock.feature.findMany.mockResolvedValue([
    { code: 'PLAN_PRO', stripeProductId: 'prod_pro' },
    { code: 'PLAN_PREMIUM', stripeProductId: 'prod_premium' },
  ] as never)
})

/** Un ítem que Stripe reconoce como el plan indicado (por el `lookup_key` de su precio). */
function itemDePlan(tier: 'pro' | 'premium', id = 'si_plan') {
  return { id, price: { id: `price_${tier}`, product: `prod_${tier}`, lookup_key: `plan_${tier}_monthly` } }
}

it('consulta y cambia sin reintentos del SDK, con tiempo propio', async () => {
  await updateSubscriptionPrice('sub_1', 'price_premium')

  expect(mockRetrieve).toHaveBeenCalledWith('sub_1', {}, SIN)
  expect(mockUpdate).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_plan', price: 'price_premium' }] }), SIN)
})

/**
 * 🔴 Codex R9 (ronda 2): cambiaba el PRIMER ítem sin mirar la forma de la suscripción. Con dos conceptos —o con una
 * página incompleta— el «primero» es el que Stripe devolvió de primeras: se podía sustituir el precio de una función
 * suelta creyendo cambiar el plan, y cobrarlo con `always_invoice`.
 */
describe('🔴 R9: no se cambia lo que no se puede identificar', () => {
  it('dos conceptos en la suscripción ⇒ 409 CAMBIO_AMBIGUO y CERO cambios', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [itemDePlan('pro'), itemDePlan('premium', 'si_otro')] } })

    await expect(updateSubscriptionPrice('sub_1', 'price_premium')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CAMBIO_AMBIGUO',
    })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('una página incompleta de ítems (`has_more`) ⇒ 409 CAMBIO_AMBIGUO y CERO cambios', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [itemDePlan('pro')], has_more: true } })

    await expect(updateSubscriptionPrice('sub_1', 'price_premium')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CAMBIO_AMBIGUO',
    })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('🔴 el ítem ya no vende el plan de ORIGEN que se pidió cambiar ⇒ 409 y CERO cambios', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [itemDePlan('premium')] } })

    await expect(updateSubscriptionPrice('sub_1', 'price_pro', { planOrigen: 'PLAN_PRO' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CAMBIO_AMBIGUO',
    })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('si el ítem SÍ vende el plan de origen, cambia normal', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [itemDePlan('pro')] } })

    await updateSubscriptionPrice('sub_1', 'price_premium', { planOrigen: 'PLAN_PRO' })

    expect(mockUpdate).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_plan', price: 'price_premium' }] }), SIN)
  })
})

/**
 * 🔴 Codex R7 (ronda 2): quien llama marcaba «ya se pudo cobrar» ANTES de esta función, así que un fallo de la CONSULTA
 * —que no manda nada— se contaba como desenlace dudoso y respondía 202. El aviso tiene que salir pegado al POST.
 */
describe('🔴 R7: el aviso de «ya se mandó» sale justo antes del POST', () => {
  it('se llama DESPUÉS de consultar y ANTES de cambiar', async () => {
    const orden: string[] = []
    mockRetrieve.mockImplementation(async () => {
      orden.push('consulta')
      return { id: 'sub_1', items: { data: [itemDePlan('pro')] } }
    })
    mockUpdate.mockImplementation(async () => {
      orden.push('cambio')
      return { id: 'sub_1', status: 'active' }
    })

    await updateSubscriptionPrice('sub_1', 'price_premium', {
      antesDeEnviar: () => {
        orden.push('aviso')
      },
    })

    expect(orden).toEqual(['consulta', 'aviso', 'cambio'])
  })

  it('🔴 si la CONSULTA falla, el aviso no llega a salir', async () => {
    mockRetrieve.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
    const aviso = jest.fn()

    await expect(updateSubscriptionPrice('sub_1', 'price_premium', { antesDeEnviar: aviso })).rejects.toThrow('timeout')
    expect(aviso).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 Codex R13 (ronda 2): cuando el alta RECUPERA un cobro anterior, «qué plan se cobró» sólo puede salir de lo que la
 * suscripción vende. Antes caía en el `tier` del formulario del reintento y el alta se cerraba anunciando PREMIUM sobre
 * un cobro PRO. Lo que no se puede determinar devuelve `null`: no se adivina.
 */
describe('🔴 R13: qué tier vende una suscripción', () => {
  const conItems = (items: unknown[], has_more = false) => ({ id: 'sub_1', items: { data: items, has_more } }) as never

  it('un solo ítem de plan: ese tier', async () => {
    await expect(tierQueVendeLaSuscripcion(conItems([itemDePlan('pro')]))).resolves.toBe('PRO')
    await expect(tierQueVendeLaSuscripcion(conItems([itemDePlan('premium')]))).resolves.toBe('PREMIUM')
  })

  it('🔴 dos planes, o un plan más otra cosa, o sin plan: null (no se adivina)', async () => {
    await expect(tierQueVendeLaSuscripcion(conItems([itemDePlan('pro'), itemDePlan('premium', 'si_2')]))).resolves.toBeNull()
    await expect(
      tierQueVendeLaSuscripcion(conItems([{ id: 'si_x', price: { id: 'p', product: 'prod_raro', lookup_key: null } }])),
    ).resolves.toBeNull()
  })

  it('🔴 una página incompleta: null (lo que no se vio entero no se sabe)', async () => {
    await expect(tierQueVendeLaSuscripcion(conItems([itemDePlan('pro')], true))).resolves.toBeNull()
  })
})

/**
 * 🔴 Codex R5: con llave de idempotencia, Stripe exige que el CUERPO sea idéntico en un reintento — si cambia, rechaza
 * la repetición por «parámetros distintos» y el 202 deja de poder reintentarse. El cuerpo no puede llevar la hora.
 */
describe('🔴 R5: el cuerpo del cambio es estable entre reintentos', () => {
  it('dos llamadas seguidas mandan EXACTAMENTE el mismo cuerpo', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [itemDePlan('pro')] } })

    await updateSubscriptionPrice('sub_1', 'price_premium', { idempotencyKey: 'k1' })
    await new Promise(r => setTimeout(r, 1100)) // el reloj avanza más de un segundo
    await updateSubscriptionPrice('sub_1', 'price_premium', { idempotencyKey: 'k1' })

    expect(mockUpdate.mock.calls[1][1]).toEqual(mockUpdate.mock.calls[0][1])
  })

  it('🔴 y no cobra el periodo completo: sin `proration_date`, Stripe prorratea desde la petición (los días que faltan)', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', items: { data: [itemDePlan('pro')] } })

    await updateSubscriptionPrice('sub_1', 'price_premium')

    expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty('proration_date')
  })
})
