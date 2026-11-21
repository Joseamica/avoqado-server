// tests/unit/services/payments/providers/stripe-connect.requestLimits.test.ts
/**
 * D661 (ronda codex-r2 · B y C): el SDK de Stripe DE VERDAD con un transporte de prueba que pierde los envíos (nada sale a la red).
 * Prueba que los límites por petición que manda el adaptador sí gobiernan al SDK: con `maxNetworkRetries: 0` una captura perdida sale
 * UNA vez (sin él, el SDK la reenvía solo dos veces: el mecanismo del Codex r2 #3), y el transporte recibe el `timeout` de una
 * lectura acotada. También fija el único reenvío que el SDK hace aunque el límite sea 0: una conexión cerrada en el PRIMER envío.
 */
import Stripe from 'stripe'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { PlazoAgotado } from '@/utils/conPlazo'

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
  it('C (Ruling 43 y la enmienda del 52): el reintento del conciliador (40 s, sin reintentos) cuyo envío se pierde sale UNA sola vez, con su límite de 40 s', async () => {
    const t = transporte('POST', 'ETIMEDOUT')
    await expect(
      adaptador(t.client).capture(merchant as never, CAPTURA, { timeoutMs: 40_000, maxNetworkRetries: 0 }),
    ).rejects.toMatchObject({ type: 'StripeConnectionError' })
    expect(capturas(t.envios)).toEqual([
      { method: 'POST', path: expect.stringContaining('/v1/payment_intents/pi_1/capture'), timeout: 40_000 },
    ])
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

/**
 * D661 (Ruling 73): Stripe manda las cabeceras y la conexión muere a medio cuerpo. stripe-node 19.1.0 ya resolvió la petición HTTP y su
 * lector del cuerpo espera `end` sin manejar el cierre incompleto: aquí, un `toJSON` que nunca termina.
 */
function transporteQueCuelga() {
  const envios: Array<{ method: string; path: string; timeout: number }> = []
  const client = {
    getClientName: () => 'prueba-d661',
    makeRequest: async (...a: unknown[]) => {
      const [, , path, method, , , , timeout] = a as [string, number, string, string, unknown, unknown, string, number]
      envios.push({ method, path, timeout })
      return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: () => new Promise(() => {}) }
    },
  }
  return { envios, client }
}
/** Lo que una promesa contestó hasta ahora, sin esperarla. */
const desenlaceDe = (p: Promise<unknown>) => {
  const d: { v: unknown } = { v: 'pendiente' }
  p.then(
    r => (d.v = r),
    e => (d.v = e),
  )
  return d
}
/** Los límites de la visita temprana con su plazo (10 s + 5 s) y los de la pasada principal (sólo el plazo, 120 s). */
const ACOTADA = { timeoutMs: 10_000, maxNetworkRetries: 0, plazoMs: 15_000 }
const SOLO_PLAZO = { plazoMs: 120_000 }
const SESION = {
  amountCents: 25_000,
  currency: 'MXN' as const,
  description: 'Pedido en línea',
  successUrl: 'https://pedidos.test/flautas/pedido/T?pago=1',
  cancelUrl: 'https://pedidos.test/flautas/pedido/T?pago=cancelado',
  expiresAt: new Date('2026-11-21T19:00:00.000Z'),
  metadata: { type: 'online_order', chargeId: 'ch1', venueId: 'v1' },
  idempotencyKey: 'online-order-charge:ch1:checkout:1',
}

describe('StripeConnectProvider con el SDK real: nuestro plazo duro (D661 · B, Ruling 73)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }))
  afterEach(() => jest.useRealTimers())

  it('con plazo, la lectura, la cancelación y la captura cuyo cuerpo nunca termina se rinden a los 15 s con PlazoAgotado (sin relectura); sin plazo, el SDK sigue esperando', async () => {
    const t = transporteQueCuelga()
    const a = adaptador(t.client)
    const lectura = desenlaceDe(a.getAuthorization(merchant as never, { checkoutSessionId: 'cs_1' }, ACOTADA))
    const cancelacion = desenlaceDe(
      a.voidAuthorization(merchant as never, { paymentIntentId: 'pi_1', idempotencyKey: 'online-order-charge:ch1:release' }, ACOTADA),
    )
    const captura = desenlaceDe(a.capture(merchant as never, CAPTURA, ACOTADA))
    const sinPlazo = desenlaceDe(
      a.getAuthorization(merchant as never, { checkoutSessionId: 'cs_2' }, { timeoutMs: 10_000, maxNetworkRetries: 0 }),
    )
    await jest.advanceTimersByTimeAsync(14_999)
    for (const d of [lectura, cancelacion, captura]) expect(d.v).toBe('pendiente')
    await jest.advanceTimersByTimeAsync(1)
    for (const d of [lectura, cancelacion, captura]) expect(d.v).toBeInstanceOf(PlazoAgotado)
    await jest.advanceTimersByTimeAsync(10 * 60_000)
    expect(sinPlazo.v).toBe('pendiente') // el SDK solo no se rinde: el cuerpo nunca termina
    // El plazo es nuestro: al SDK le llegan las opciones de siempre (10 s) y no sale nada más (ninguna relectura tras el plazo).
    expect(t.envios.map(e => e.timeout)).toEqual([10_000, 10_000, 10_000, 10_000])
  })

  it('con SÓLO el plazo (la pasada principal) la petición no cambia (el transporte recibe los 80 s del cliente) y la llamada se rinde a los 120 s, también la sesión que se repite', async () => {
    const t = transporteQueCuelga()
    const a = adaptador(t.client)
    const lectura = desenlaceDe(a.getAuthorization(merchant as never, { paymentIntentId: 'pi_1' }, SOLO_PLAZO))
    const sesion = desenlaceDe(a.createAuthorizationCheckout(merchant as never, SESION, SOLO_PLAZO))
    await jest.advanceTimersByTimeAsync(119_999)
    for (const d of [lectura, sesion]) expect(d.v).toBe('pendiente')
    await jest.advanceTimersByTimeAsync(1)
    for (const d of [lectura, sesion]) expect(d.v).toBeInstanceOf(PlazoAgotado)
    expect(t.envios.map(e => e.timeout)).toEqual([80_000, 80_000])
  })

  it('ronda 3 de codex-r3: la comisión devuelta lleva los límites de la llamada a SUS DOS lecturas (el cobro y, con la llave de la plataforma, la comisión)', async () => {
    const envios: Array<{ method: string; path: string; timeout: number }> = []
    const client = {
      getClientName: () => 'prueba-d661',
      makeRequest: async (...a: unknown[]) => {
        const [, , path, method, , , , timeout] = a as [string, number, string, string, unknown, unknown, string, number]
        envios.push({ method, path: path.split('?')[0], timeout })
        const cuerpo = path.startsWith('/v1/application_fees/')
          ? { id: 'fee_1', object: 'application_fee', amount_refunded: 290 }
          : { id: 'pi_1', object: 'payment_intent', latest_charge: { id: 'ch_1', object: 'charge', application_fee: 'fee_1' } }
        return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: async () => cuerpo }
      },
    }
    const a = adaptador(client)
    const lectura = a.getApplicationFeeRefundedCents(merchant as never, 'pi_1', ACOTADA)
    await jest.advanceTimersByTimeAsync(0)
    await expect(lectura).resolves.toBe(290)
    expect(envios).toEqual([
      { method: 'GET', path: '/v1/payment_intents/pi_1', timeout: 10_000 },
      { method: 'GET', path: '/v1/application_fees/fee_1', timeout: 10_000 },
    ])
  })

  it('ronda 2 de codex-r3: las llamadas del recorrido de devoluciones (crear la devolución, leerla, listarlas y la comisión devuelta) con SÓLO el plazo se rinden a los 120 s y la petición no cambia; sin plazo, el SDK sigue esperando', async () => {
    const t = transporteQueCuelga()
    const a = adaptador(t.client)
    const DEVOLUCION = {
      paymentIntentId: 'pi_1',
      amount: 25_000,
      refundApplicationFee: true,
      idempotencyKey: 'online-order:o1:refund:cr1',
      metadata: { cardRefundId: 'cr1' },
    }
    const llamadas = [
      desenlaceDe(a.refund(merchant as never, DEVOLUCION, SOLO_PLAZO)),
      desenlaceDe(a.getRefund(merchant as never, 're_1', SOLO_PLAZO)),
      desenlaceDe(a.listRefunds(merchant as never, 'pi_1', SOLO_PLAZO)),
      desenlaceDe(a.getApplicationFeeRefundedCents(merchant as never, 'pi_1', SOLO_PLAZO)),
    ]
    const sinPlazo = desenlaceDe(a.getRefund(merchant as never, 're_2'))
    await jest.advanceTimersByTimeAsync(119_999)
    for (const d of llamadas) expect(d.v).toBe('pendiente')
    await jest.advanceTimersByTimeAsync(1)
    for (const d of llamadas) expect(d.v).toBeInstanceOf(PlazoAgotado)
    await jest.advanceTimersByTimeAsync(10 * 60_000)
    expect(sinPlazo.v).toBe('pendiente')
    // El plazo es nuestro: cada petición sale como siempre (los 80 s del cliente), una sola vez: la devolución y cuatro lecturas.
    expect(t.envios.filter(e => e.method === 'POST').map(e => [e.path, e.timeout])).toEqual([['/v1/refunds', 80_000]])
    expect(t.envios.filter(e => e.method === 'GET').map(e => e.timeout)).toEqual([80_000, 80_000, 80_000, 80_000])
  })
})

describe('StripeConnectProvider.getChargeRefunds: la lista acotada (D668, Codex r1 #3)', () => {
  const conLista = (n: number) => {
    const p = new StripeConnectProvider('sk_test_x')
    ;(p as unknown as { retrievePaymentIntent: () => Promise<unknown> }).retrievePaymentIntent = async () => ({
      latest_charge: { amount_refunded: 0 },
    })
    const una = { refundId: 're_x', status: 'FAILED' as const, amountCents: 1, failureReason: null, metadata: {} }
    jest.spyOn(p, 'listRefunds').mockResolvedValue(Array.from({ length: n }, () => una))
    return p
  }

  it('con 999 devoluciones contesta; al llegar al tope de 1,000 (puede venir recortada) falla, y quien llama no devuelve a ciegas', async () => {
    await expect(conLista(999).getChargeRefunds(merchant as never, 'pi_1')).resolves.toMatchObject({ amountRefundedCents: 0 })
    await expect(conLista(1000).getChargeRefunds(merchant as never, 'pi_1')).rejects.toThrow('puede venir recortada')
  })
})
