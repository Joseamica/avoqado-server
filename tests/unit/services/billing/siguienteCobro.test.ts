/**
 * `montoDelSiguienteCobro`: lo que Stripe cobrará en la próxima factura.
 *
 * 🔴 Prueba con Stripe de pruebas (26-nov): Stripe NO da vista previa de una prueba sin método con
 * `missing_payment_method: cancel` (`invoice_upcoming_none`), así que el monto de la prueba sin tarjeta siempre salía `null` y
 * «Tu plan» nunca enseñaba «Poner mi tarjeta». Para esa prueba, el monto es la vista previa de una suscripción nueva con los mismos
 * renglones y el mismo cliente (con su saldo y sus cupones): lo que se cobrará en cuanto ponga la tarjeta.
 */
import type Stripe from 'stripe'
import { montoDelSiguienteCobro } from '@/services/billing/siguienteCobro'

const sinRecibo = () =>
  Object.assign(new Error('The subscription will cancel at the end of the trial instead of generating an invoice…'), {
    type: 'StripeInvalidRequestError',
    code: 'invoice_upcoming_none',
  })

/** Fin de la prueba: en 60 días (segundos, como Stripe). */
const FIN = Math.floor(Date.now() / 1000) + 60 * 86400

const pruebaSinMetodo = (o: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  trial_end: FIN,
  customer: 'cus_1',
  status: 'trialing',
  cancel_at_period_end: false,
  cancel_at: null,
  pause_collection: null,
  trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
  metadata: { sinTarjeta: 'true' },
  discounts: [],
  items: { data: [{ price: { id: 'price_v8' }, quantity: 1 }] },
  ...o,
})

function stripeFalso(sub: Record<string, unknown>) {
  const createPreview = jest.fn().mockImplementation(async (params: Record<string, unknown>) => {
    if (params.subscription) throw sinRecibo()
    return { amount_due: 81084 }
  })
  const retrieve = jest.fn().mockResolvedValue(sub)
  return { createPreview, retrieve, stripe: { invoices: { createPreview }, subscriptions: { retrieve } } as unknown as Stripe }
}

describe('montoDelSiguienteCobro', () => {
  it('con vista previa de la suscripción, su amount_due', async () => {
    const createPreview = jest.fn().mockResolvedValue({ amount_due: 1000 })
    const stripe = { invoices: { createPreview } } as unknown as Stripe
    await expect(montoDelSiguienteCobro(stripe, 'sub_1')).resolves.toBe(1000)
  })

  it('🔴 prueba sin método (invoice_upcoming_none): la vista previa de una suscripción nueva con sus renglones y su cliente', async () => {
    const f = stripeFalso(pruebaSinMetodo())
    await expect(montoDelSiguienteCobro(f.stripe, 'sub_1')).resolves.toBe(81084)
    expect(f.createPreview).toHaveBeenLastCalledWith({
      customer: 'cus_1',
      subscription_details: { items: [{ price: 'price_v8', quantity: 1 }] },
    })
  })

  it('con las opciones de la lectura, las tres llamadas las llevan', async () => {
    const f = stripeFalso(pruebaSinMetodo())
    const tope = { timeout: 5_000, maxNetworkRetries: 0 }
    await montoDelSiguienteCobro(f.stripe, 'sub_1', tope)
    expect(f.retrieve).toHaveBeenCalledTimes(2)
    expect(f.retrieve).toHaveBeenCalledWith('sub_1', { expand: ['discounts'] }, tope)
    expect(f.createPreview.mock.calls.map((c: unknown[]) => c[1])).toEqual([tope, tope])
  })

  it.each([
    ['ya cancelada', { status: 'canceled' }],
    ['con cancelación programada', { cancel_at_period_end: true }],
    ['con fecha de cancelación antes del fin', { cancel_at: 1 }],
    ['con la cobranza en pausa sin fecha', { pause_collection: { behavior: 'void' } }],
    ['con la cobranza en pausa hasta después del fin', { pause_collection: { behavior: 'void', resumes_at: FIN + 86400 } }],
    ['que al terminar crea el recibo (no se cancela)', { trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } } }],
    // Codex b2-mac r1 #3: una prueba clásica que soporte configuró para cancelarse sin tarjeta no es la prueba sin tarjeta de B2.
    ['sin la marca de la prueba sin tarjeta del alta', { metadata: {} }],
  ])('sin recibo próximo y una suscripción %s → null (no se inventa un cobro)', async (_que, cambio) => {
    const f = stripeFalso(pruebaSinMetodo(cambio))
    await expect(montoDelSiguienteCobro(f.stripe, 'sub_1')).resolves.toBeNull()
    expect(f.createPreview).toHaveBeenCalledTimes(1)
  })

  it('🔴 Codex b2-mac r2 #1: una pausa que se reanuda ANTES del fin de la prueba sí se cobra → hay monto', async () => {
    const f = stripeFalso(pruebaSinMetodo({ pause_collection: { behavior: 'void', resumes_at: FIN - 30 * 86400 } }))
    await expect(montoDelSiguienteCobro(f.stripe, 'sub_1')).resolves.toBe(81084)
  })

  it('🔴 Codex b2-mac r1 #2 y r2 #3: los descuentos propios de la suscripción van como CUPÓN (Stripe rechaza el di_… de otra suscripción)', async () => {
    const f = stripeFalso(
      pruebaSinMetodo({
        discounts: [
          { id: 'di_clover', source: { type: 'coupon', coupon: 'RETENCION30' } },
          { id: 'di_viejo', coupon: { id: 'VIEJO10' } },
        ],
      }),
    )
    await montoDelSiguienteCobro(f.stripe, 'sub_1')
    expect(f.retrieve).toHaveBeenCalledWith('sub_1', { expand: ['discounts'] })
    expect(f.createPreview).toHaveBeenLastCalledWith({
      customer: 'cus_1',
      subscription_details: { items: [{ price: 'price_v8', quantity: 1 }] },
      discounts: [{ coupon: 'RETENCION30' }, { coupon: 'VIEJO10' }],
    })
  })

  it('un descuento que no se puede leer (sin expandir) → null: nunca el precio sin el descuento', async () => {
    const f = stripeFalso(pruebaSinMetodo({ discounts: ['di_sin_expandir'] }))
    await expect(montoDelSiguienteCobro(f.stripe, 'sub_1')).resolves.toBeNull()
    expect(f.createPreview).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['la cancelan', { cancel_at_period_end: true }],
    ['termina cancelada', { status: 'canceled' }],
    ['le cambian el descuento', { discounts: [{ id: 'di_nuevo', source: { type: 'coupon', coupon: 'OTRO' } }] }],
    ['le mueven el fin de la prueba', { trial_end: FIN + 86400 }],
  ])('🔴 Codex b2-mac r1 #4 y r2 #2: si mientras se calcula %s, el monto no vale → null', async (_que, cambio) => {
    const f = stripeFalso(pruebaSinMetodo())
    f.retrieve.mockReset().mockResolvedValueOnce(pruebaSinMetodo()).mockResolvedValueOnce(pruebaSinMetodo(cambio))
    await expect(montoDelSiguienteCobro(f.stripe, 'sub_1')).resolves.toBeNull()
    expect(f.createPreview).toHaveBeenCalledTimes(2)
  })

  it('otro error de la vista previa → null, sin leer la suscripción', async () => {
    const createPreview = jest.fn().mockRejectedValue(Object.assign(new Error('Stripe caído'), { code: 'api_error' }))
    const retrieve = jest.fn()
    const stripe = { invoices: { createPreview }, subscriptions: { retrieve } } as unknown as Stripe
    await expect(montoDelSiguienteCobro(stripe, 'sub_1')).resolves.toBeNull()
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('si la vista previa de respaldo también falla → null', async () => {
    const f = stripeFalso(pruebaSinMetodo())
    f.createPreview.mockImplementation(async () => {
      throw sinRecibo()
    })
    await expect(montoDelSiguienteCobro(f.stripe, 'sub_1')).resolves.toBeNull()
  })
})
