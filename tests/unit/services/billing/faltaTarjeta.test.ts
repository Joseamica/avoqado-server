/**
 * Planes editables B2, Task 7 (§17, §18, b2-r6 #5): ¿a la prueba sin tarjeta le falta la tarjeta?
 *
 * `true` sólo si la suscripción sigue `trialing`, termina cancelándose sin método (`missing_payment_method: 'cancel'`) y la
 * jerarquía de Stripe (`tarjetaQueCobraria`, Task 6) no encuentra una tarjeta. El cliente se lee sólo si la suscripción no trae
 * método propio: una suscripción de hoy (con tarjeta) nunca lo lee.
 *
 * Stripe simulado; el ayudante y la jerarquía son los reales.
 */
const mockPmRetrieve = jest.fn()
const mockRetrieveSource = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    paymentMethods: { retrieve: mockPmRetrieve },
    customers: { retrieveSource: mockRetrieveSource },
  })),
)

import type Stripe from 'stripe'
import { faltaTarjeta } from '@/services/billing/faltaTarjeta'

const tarjeta = (id: string, brand: string, last4: string) => ({ id, object: 'payment_method', type: 'card', card: { brand, last4 } })
const cliente = (o: Record<string, unknown> = {}) =>
  ({
    id: 'cus_1',
    object: 'customer',
    invoice_settings: { default_payment_method: null },
    default_source: null,
    ...o,
  }) as unknown as Stripe.Customer
/** La prueba del alta sin tarjeta: `trialing`, sin método propio y con `missing_payment_method: 'cancel'`. */
const pruebaSinTarjeta = (o: Record<string, unknown> = {}) =>
  ({
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'trialing',
    default_payment_method: null,
    default_source: null,
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    metadata: { sinTarjeta: 'true' },
    ...o,
  }) as unknown as Stripe.Subscription

beforeEach(() => {
  jest.clearAllMocks()
  mockPmRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (id === 'pm_oxxo') return { id, object: 'payment_method', type: 'oxxo' }
    if (id === 'pm_de_hoy') return tarjeta(id, 'visa', '1111')
    throw Object.assign(new Error('No such payment_method'), { code: 'resource_missing', statusCode: 404 })
  })
  mockRetrieveSource.mockReset()
})

describe('faltaTarjeta', () => {
  it('trialing, end_behavior cancel y tarjetaQueCobraria null → true; con la predeterminada del cliente (lo que deja el portal) o con un default_source → false; una de hoy → false sin leer el cliente', async () => {
    // Sin tarjeta en ningún lado de la jerarquía: le falta.
    const leer = jest.fn().mockResolvedValue(cliente())
    expect(await faltaTarjeta(pruebaSinTarjeta(), leer)).toBe(true)
    expect(leer).toHaveBeenCalledWith('cus_1')

    // Un cliente borrado (`clienteDeStripeVivo` da null) no tiene tarjeta.
    expect(await faltaTarjeta(pruebaSinTarjeta(), jest.fn().mockResolvedValue(null))).toBe(true)

    // Lo que deja el portal (`payment_method_update`): la predeterminada del cliente, ya expandida.
    const conPortal = jest
      .fn()
      .mockResolvedValue(cliente({ invoice_settings: { default_payment_method: tarjeta('pm_portal', 'visa', '4242') } }))
    expect(await faltaTarjeta(pruebaSinTarjeta(), conPortal)).toBe(false)

    // b2-r6 #5: una tarjeta vieja del cliente (`default_source`) también cobra.
    const conFuente = jest
      .fn()
      .mockResolvedValue(cliente({ default_source: { id: 'card_1', object: 'card', brand: 'Visa', last4: '1881' } }))
    expect(await faltaTarjeta(pruebaSinTarjeta(), conFuente)).toBe(false)

    // b2-r7 #3: la predeterminada del cliente que no es tarjeta no cuenta.
    const conOxxo = jest.fn().mockResolvedValue(cliente({ invoice_settings: { default_payment_method: 'pm_oxxo' } }))
    expect(await faltaTarjeta(pruebaSinTarjeta(), conOxxo)).toBe(true)

    // Con método propio decide la suscripción: el cliente no se lee.
    const noSeLee = jest.fn()
    expect(await faltaTarjeta(pruebaSinTarjeta({ default_payment_method: 'pm_de_hoy' }), noSeLee)).toBe(false)
    expect(noSeLee).not.toHaveBeenCalled()

    // Una suscripción de hoy (con tarjeta, sin `missing_payment_method: 'cancel'`), en prueba o activa: false, sin leer nada.
    mockPmRetrieve.mockClear()
    const deHoy = jest.fn()
    const hoy = (status: string) =>
      pruebaSinTarjeta({
        status,
        default_payment_method: 'pm_de_hoy',
        trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
        metadata: {},
      })
    expect(await faltaTarjeta(hoy('trialing'), deHoy)).toBe(false)
    expect(await faltaTarjeta(hoy('active'), deHoy)).toBe(false)
    expect(deHoy).not.toHaveBeenCalled()
    expect(mockPmRetrieve).not.toHaveBeenCalled()

    // La prueba que ya terminó (`canceled`) o que pasó a cobrarse (`past_due`) ya no espera una tarjeta.
    const nada = jest.fn()
    expect(await faltaTarjeta(pruebaSinTarjeta({ status: 'canceled' }), nada)).toBe(false)
    expect(await faltaTarjeta(pruebaSinTarjeta({ status: 'past_due' }), nada)).toBe(false)
    expect(nada).not.toHaveBeenCalled()
  })
})
