/**
 * Planes editables B2, Task 6 (§18, b2-r6 #5, b2-r7 #3, b2-r9 #4): qué tarjeta cobraría Stripe al terminar una prueba.
 *
 * La jerarquía de Stripe: el método de la suscripción → su `default_source` → la predeterminada del cliente → el
 * `default_source` del cliente. El primero que exista decide, y sólo cuenta si es una TARJETA (la suscripción del alta sólo
 * admite `card`): si es de otro tipo, «sin tarjeta». Un cliente borrado es «sin cliente», nunca un cliente sin tarjeta.
 *
 * Stripe simulado; el ayudante es el real.
 */
const mockPmRetrieve = jest.fn()
const mockCustomerRetrieve = jest.fn()
const mockRetrieveSource = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    paymentMethods: { retrieve: mockPmRetrieve },
    customers: { retrieve: mockCustomerRetrieve, retrieveSource: mockRetrieveSource },
  })),
)

import type Stripe from 'stripe'
import { avisoDeLaPruebaSinTarjeta, clienteDeStripeVivo, tarjetaQueCobraria } from '@/services/billing/tarjetaQueCobraria'

/** El tope de cada lectura de Stripe del ayudante: 5 s y sin reintentos (fix round 1). */
const TOPE = { timeout: 5_000, maxNetworkRetries: 0 }

const tarjeta = (id: string, brand: string, last4: string) => ({ id, object: 'payment_method', type: 'card', card: { brand, last4 } })
const PMS: Record<string, unknown> = {
  pm_sub: tarjeta('pm_sub', 'visa', '1111'),
  pm_cliente: tarjeta('pm_cliente', 'mastercard', '4444'),
  pm_oxxo: { id: 'pm_oxxo', object: 'payment_method', type: 'oxxo' },
}
const fuenteVieja = { id: 'card_vieja', object: 'card', brand: 'Visa', last4: '4242' }

const cliente = (o: Record<string, unknown> = {}) =>
  ({
    id: 'cus_1',
    object: 'customer',
    invoice_settings: { default_payment_method: null },
    default_source: null,
    ...o,
  }) as unknown as Stripe.Customer
const sub = (o: Record<string, unknown> = {}) =>
  ({ id: 'sub_1', customer: 'cus_1', default_payment_method: null, default_source: null, ...o }) as unknown as Stripe.Subscription

beforeEach(() => {
  jest.clearAllMocks()
  mockPmRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (!PMS[id]) throw Object.assign(new Error('No such payment_method'), { code: 'resource_missing', statusCode: 404 })
    return PMS[id]
  })
  mockRetrieveSource.mockReset().mockImplementation(async (_c: string, id: string) => {
    if (id === 'card_vieja') return fuenteVieja
    if (id === 'ba_1') return { id: 'ba_1', object: 'bank_account', last4: '6789' }
    throw Object.assign(new Error('No such source'), { code: 'resource_missing', statusCode: 404 })
  })
  mockCustomerRetrieve.mockReset()
})

describe('tarjetaQueCobraria — la jerarquía de Stripe', () => {
  it('🔴 b2-r6 #5: sin método en la suscripción ni predeterminada del cliente, pero con customer.default_source (una tarjeta vieja) → esa tarjeta, tipo source', async () => {
    const r = await tarjetaQueCobraria({ sub: sub(), customer: cliente({ default_source: 'card_vieja' }) })

    expect(r).toEqual({ id: 'card_vieja', tipo: 'source', brand: 'Visa', last4: '4242' })
    expect(mockRetrieveSource).toHaveBeenCalledWith('cus_1', 'card_vieja', {}, TOPE)
    // Expandida (como la deja `clienteDeStripeVivo`), sin otra llamada.
    mockRetrieveSource.mockClear()
    const expandida = await tarjetaQueCobraria({ sub: sub(), customer: cliente({ default_source: fuenteVieja }) })
    expect(expandida).toEqual({ id: 'card_vieja', tipo: 'source', brand: 'Visa', last4: '4242' })
    expect(mockRetrieveSource).not.toHaveBeenCalled()
  })

  it('🔴 b2-r7 #3: la predeterminada del cliente es un método que no es card → null («sin tarjeta»), aunque exista', async () => {
    const r = await tarjetaQueCobraria({
      sub: sub(),
      // Aunque detrás haya una tarjeta vieja: la predeterminada decide, y no es tarjeta.
      customer: cliente({ invoice_settings: { default_payment_method: 'pm_oxxo' }, default_source: 'card_vieja' }),
    })

    expect(r).toBeNull()
    expect(mockRetrieveSource).not.toHaveBeenCalled()
    // Y una fuente que no es tarjeta (una cuenta de banco), tampoco.
    expect(await tarjetaQueCobraria({ sub: sub(), customer: cliente({ default_source: 'ba_1' }) })).toBeNull()
  })

  it('el orden: el método de la suscripción gana a su default_source, que gana a la predeterminada del cliente, que gana al default_source del cliente', async () => {
    const todos = cliente({ invoice_settings: { default_payment_method: 'pm_cliente' }, default_source: 'card_vieja' })

    expect(
      await tarjetaQueCobraria({ sub: sub({ default_payment_method: 'pm_sub', default_source: 'card_vieja' }), customer: todos }),
    ).toEqual({
      id: 'pm_sub',
      tipo: 'payment_method',
      brand: 'visa',
      last4: '1111',
    })
    expect(await tarjetaQueCobraria({ sub: sub({ default_source: 'card_vieja' }), customer: todos })).toEqual({
      id: 'card_vieja',
      tipo: 'source',
      brand: 'Visa',
      last4: '4242',
    })
    expect(await tarjetaQueCobraria({ sub: sub(), customer: todos })).toEqual({
      id: 'pm_cliente',
      tipo: 'payment_method',
      brand: 'mastercard',
      last4: '4444',
    })
    // Sin suscripción (la ventana del alta, antes de crearla): la del cliente.
    expect(await tarjetaQueCobraria({ customer: todos })).toMatchObject({ id: 'pm_cliente' })
    // Un método ya expandido no se vuelve a leer.
    mockPmRetrieve.mockClear()
    expect(await tarjetaQueCobraria({ customer: cliente({ invoice_settings: { default_payment_method: PMS.pm_cliente } }) })).toMatchObject(
      {
        id: 'pm_cliente',
        last4: '4444',
      },
    )
    expect(mockPmRetrieve).not.toHaveBeenCalled()
  })

  it('sin nada → null; un cliente borrado → null', async () => {
    expect(await tarjetaQueCobraria({ sub: sub(), customer: cliente() })).toBeNull()
    expect(await tarjetaQueCobraria({ customer: cliente() })).toBeNull()
    const borrado = { id: 'cus_1', object: 'customer', deleted: true } as unknown as Stripe.DeletedCustomer
    expect(await tarjetaQueCobraria({ sub: sub({ default_payment_method: 'pm_sub' }), customer: borrado })).toBeNull()
    expect(mockPmRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 b2-r9 #4: clienteDeStripeVivo → null sin id (sin llamar a Stripe), con deleted: true o con resource_missing; un 500 de Stripe sube', async () => {
    expect(await clienteDeStripeVivo(null)).toBeNull()
    expect(mockCustomerRetrieve).not.toHaveBeenCalled()

    mockCustomerRetrieve.mockResolvedValueOnce({ id: 'cus_1', object: 'customer', deleted: true })
    expect(await clienteDeStripeVivo('cus_1')).toBeNull()

    mockCustomerRetrieve.mockRejectedValueOnce(
      Object.assign(new Error('No such customer: cus_1'), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' }),
    )
    expect(await clienteDeStripeVivo('cus_1')).toBeNull()

    const vivo = cliente({ invoice_settings: { default_payment_method: 'pm_cliente' } })
    mockCustomerRetrieve.mockResolvedValueOnce(vivo)
    expect(await clienteDeStripeVivo('cus_1')).toBe(vivo)
    const [id] = mockCustomerRetrieve.mock.calls.at(-1) as [string]
    expect(id).toBe('cus_1')

    mockCustomerRetrieve.mockRejectedValueOnce(Object.assign(new Error('Stripe caído'), { type: 'StripeAPIError', statusCode: 500 }))
    await expect(clienteDeStripeVivo('cus_1')).rejects.toThrow('Stripe caído')
  })

  it('🔴 fix round 1: cada lectura de Stripe lleva el tope de 5 s sin reintentos (el cliente, el método y la fuente), como `suscripcionConTopeCorto`', async () => {
    mockCustomerRetrieve.mockResolvedValueOnce(cliente())
    await clienteDeStripeVivo('cus_1')
    expect(mockCustomerRetrieve).toHaveBeenCalledWith(
      'cus_1',
      { expand: ['invoice_settings.default_payment_method', 'default_source'] },
      TOPE,
    )

    await tarjetaQueCobraria({ sub: sub({ default_payment_method: 'pm_sub' }), customer: cliente() })
    expect(mockPmRetrieve).toHaveBeenCalledWith('pm_sub', {}, TOPE)

    await tarjetaQueCobraria({ customer: cliente({ default_source: 'card_vieja' }) })
    expect(mockRetrieveSource).toHaveBeenCalledWith('cus_1', 'card_vieja', {}, TOPE)
  })
})

describe('avisoDeLaPruebaSinTarjeta', () => {
  const FIN = Math.floor(new Date('2026-12-09T16:00:00Z').getTime() / 1000)
  const prueba = (o: Record<string, unknown> = {}) => sub({ status: 'trialing', trial_end: FIN, cancel_at_period_end: false, ...o })

  it('🔴 fix round 1: si leer la tarjeta falla o se agota su tiempo, no lanza: dice noHabraCobro y OMITE tarjetaQueCobrara («no se sabe»)', async () => {
    mockCustomerRetrieve.mockRejectedValueOnce(
      Object.assign(new Error('Request aborted due to timeout being reached (5000ms)'), { type: 'StripeConnectionError' }),
    )
    const tiempoAgotado = await avisoDeLaPruebaSinTarjeta(prueba())
    expect(tiempoAgotado).toEqual({ noHabraCobro: false })

    mockCustomerRetrieve.mockResolvedValueOnce(cliente({ invoice_settings: { default_payment_method: 'pm_cliente' } }))
    mockPmRetrieve.mockRejectedValueOnce(Object.assign(new Error('Stripe caído'), { type: 'StripeAPIError', statusCode: 500 }))
    expect(await avisoDeLaPruebaSinTarjeta(prueba({ cancel_at_period_end: true }))).toEqual({ noHabraCobro: true })
  })

  it('con el cliente y su tarjeta: { tarjetaQueCobrara: { brand, last4 }, noHabraCobro }; sin tarjeta, tarjetaQueCobrara null', async () => {
    mockCustomerRetrieve.mockResolvedValueOnce(cliente({ invoice_settings: { default_payment_method: 'pm_cliente' } }))
    expect(await avisoDeLaPruebaSinTarjeta(prueba())).toEqual({
      noHabraCobro: false,
      tarjetaQueCobrara: { brand: 'mastercard', last4: '4444' },
    })
    mockCustomerRetrieve.mockResolvedValueOnce(cliente())
    expect(await avisoDeLaPruebaSinTarjeta(prueba())).toEqual({ noHabraCobro: false, tarjetaQueCobrara: null })
  })

  it('🔴 fix round 2: nunca rechaza, ni aunque falle lo que hoy es puro (un campo que no se puede leer): devuelve lo que alcanzó a saber', async () => {
    const rara = prueba()
    Object.defineProperty(rara, 'cancel_at_period_end', {
      get() {
        throw new Error('campo ilegible')
      },
    })

    await expect(avisoDeLaPruebaSinTarjeta(rara)).resolves.toEqual({})
    expect(mockCustomerRetrieve).not.toHaveBeenCalled()
  })
})

describe('clienteDeStripeVivo — las opciones de cada camino (fix round 2, C2)', () => {
  it('por default, el tope de las lecturas que informan; una compra pasa {} (el cliente de siempre, con sus reintentos)', async () => {
    mockCustomerRetrieve.mockResolvedValue(cliente())

    await clienteDeStripeVivo('cus_1')
    await clienteDeStripeVivo('cus_1', {})

    expect(mockCustomerRetrieve.mock.calls.map((c: unknown[]) => c[2])).toEqual([TOPE, {}])
  })
})
