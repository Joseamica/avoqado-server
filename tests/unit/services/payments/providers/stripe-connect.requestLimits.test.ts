// tests/unit/services/payments/providers/stripe-connect.requestLimits.test.ts
/**
 * D661 (ronda codex-r2 · B y C): el SDK de Stripe DE VERDAD con un transporte de prueba que pierde los envíos (nada sale a la red).
 * Prueba que los límites por petición que manda el adaptador sí gobiernan al SDK: con `maxNetworkRetries: 0` una captura perdida sale
 * UNA vez (sin él, el SDK la reenvía solo dos veces: el mecanismo del Codex r2 #3), y el transporte recibe el `timeout` de una
 * lectura acotada. También fija el único reenvío que el SDK hace aunque el límite sea 0: una conexión cerrada en el PRIMER envío.
 */
import Stripe from 'stripe'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'

const merchant = {
  id: 'em_1',
  providerCredentials: { connectAccountId: 'acct_x' },
  sandboxMode: true,
  provider: { code: 'STRIPE_CONNECT' },
}
const CAPTURA = { paymentIntentId: 'pi_1', amountCents: 25_000, applicationFeeCents: 290, idempotencyKey: 'online-order:o1:capture' }
/** La lectura de recuperación del adaptador: el PaymentIntent sigue apartado (no lo cobró nadie). */
const PI_APARTADO = { id: 'pi_1', object: 'payment_intent', status: 'requires_capture', amount_capturable: 25_000, amount_received: 0 }

/** Cómo se pierde un envío: se agota su tiempo (`ETIMEDOUT`) o se cierra la conexión (`ECONNRESET`, un socket viejo). */
type Perdida = 'ETIMEDOUT' | 'ECONNRESET'

/** El transporte: anota cada envío (con el límite que le llega) y pierde los de `pierde`; a los demás, el PaymentIntent apartado. */
function transporte(pierde: 'POST' | 'GET', perdida: Perdida) {
  const envios: Array<{ method: string; path: string; timeout: number }> = []
  const client = {
    getClientName: () => 'prueba-d661',
    makeRequest: async (...a: unknown[]) => {
      const [, , path, method, , , , timeout] = a as [string, number, string, string, unknown, unknown, string, number]
      envios.push({ method, path, timeout })
      if (method === pierde) throw Object.assign(new TypeError(perdida), { code: perdida })
      // Una copia por respuesta: el SDK le pega `lastResponse` (no reescribible) a cada objeto que contesta.
      return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: async () => ({ ...PI_APARTADO }) }
    },
  }
  return { envios, client }
}
/** El adaptador real con el SDK real; sólo su transporte es el de prueba. */
function adaptador(client: unknown): StripeConnectProvider {
  const p = new StripeConnectProvider('sk_test_x')
  ;(p as unknown as { stripe: Stripe }).stripe = new Stripe('sk_test_x', { httpClient: client as never })
  return p
}
const capturas = (envios: Array<{ method: string; path: string }>) => envios.filter(e => e.method === 'POST' && e.path.endsWith('/capture'))

describe('StripeConnectProvider con el SDK real: los límites por petición (D661 · B y C)', () => {
  it('C (Ruling 43): con maxNetworkRetries: 0, una captura cuyo envío se pierde sale UNA sola vez', async () => {
    const t = transporte('POST', 'ETIMEDOUT')
    await expect(adaptador(t.client).capture(merchant as never, CAPTURA, { maxNetworkRetries: 0 })).rejects.toMatchObject({
      type: 'StripeConnectionError',
    })
    expect(capturas(t.envios)).toHaveLength(1)
  })

  it('control: sin el límite, el MISMO envío perdido lo reenvía el SDK por su cuenta (dos reintentos más)', async () => {
    const t = transporte('POST', 'ETIMEDOUT')
    await expect(adaptador(t.client).capture(merchant as never, CAPTURA)).rejects.toMatchObject({ type: 'StripeConnectionError' })
    expect(capturas(t.envios)).toHaveLength(3)
  })

  it('C (Ruling 52): la captura de la caja (60 s y un reintento) sale a lo más dos veces, cada una con su límite de 60 s, y su relectura también', async () => {
    const t = transporte('POST', 'ETIMEDOUT')
    await expect(
      adaptador(t.client).capture(merchant as never, CAPTURA, { timeoutMs: 60_000, maxNetworkRetries: 1 }),
    ).rejects.toMatchObject({ type: 'StripeConnectionError' })
    expect(t.envios).toEqual([
      { method: 'POST', path: expect.stringContaining('/v1/payment_intents/pi_1/capture'), timeout: 60_000 },
      { method: 'POST', path: expect.stringContaining('/v1/payment_intents/pi_1/capture'), timeout: 60_000 },
      { method: 'GET', path: expect.stringContaining('/v1/payment_intents/pi_1'), timeout: 60_000 },
    ])
  })

  it('límite del SDK (no del adaptador): una conexión CERRADA en el primer envío se reenvía una vez aunque maxNetworkRetries sea 0', async () => {
    const t = transporte('POST', 'ECONNRESET')
    await expect(adaptador(t.client).capture(merchant as never, CAPTURA, { maxNetworkRetries: 0 })).rejects.toMatchObject({
      type: 'StripeConnectionError',
    })
    expect(capturas(t.envios)).toHaveLength(2)
  })

  it('B (Ruling 51): una liberación acotada cuyo envío se pierde sale una vez con su límite de 10 s, y la relectura con que se recupera también', async () => {
    const t = transporte('POST', 'ETIMEDOUT')
    const params = { paymentIntentId: 'pi_1', idempotencyKey: 'online-order-charge:ch1:release' }
    await expect(
      adaptador(t.client).voidAuthorization(merchant as never, params, { timeoutMs: 10_000, maxNetworkRetries: 0 }),
    ).rejects.toMatchObject({ type: 'StripeConnectionError' })
    expect(t.envios).toEqual([
      { method: 'POST', path: expect.stringContaining('/v1/payment_intents/pi_1/cancel'), timeout: 10_000 },
      { method: 'GET', path: expect.stringContaining('/v1/payment_intents/pi_1'), timeout: 10_000 },
    ])
  })

  it('B (Ruling 42): una lectura acotada que se pierde sale una vez y el transporte recibe su límite de 10 s', async () => {
    const t = transporte('GET', 'ETIMEDOUT')
    await expect(
      adaptador(t.client).getAuthorization(merchant as never, { checkoutSessionId: 'cs_1' }, { timeoutMs: 10_000, maxNetworkRetries: 0 }),
    ).rejects.toMatchObject({ type: 'StripeConnectionError' })
    expect(t.envios).toEqual([{ method: 'GET', path: expect.stringContaining('/v1/checkout/sessions/cs_1'), timeout: 10_000 }])
  })
})
