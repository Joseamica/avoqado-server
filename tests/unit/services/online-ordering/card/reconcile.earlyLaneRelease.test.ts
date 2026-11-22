// tests/unit/services/online-ordering/card/reconcile.earlyLaneRelease.test.ts
/**
 * D661 (ronda codex-r2 · parte B, Ruling 51): la visita temprana con la cadena REAL (conciliador → confirmación → liberación) y un
 * Stripe doble con temporizadores. Una liberación cuya cancelación cuelga se rinde a su límite, el borrador sano de atrás se visita
 * dentro del presupuesto más un límite, el cargo queda RELEASING y la siguiente pasada lo termina con la misma llave. La base es una
 * tabla en memoria con CAS por estado (Postgres real: `tarjetaEnNadieConciliador.integration.test.ts`). D661 (codex-r3, Ruling 73): con
 * el adaptador REAL y el SDK real, una respuesta cuyo cuerpo nunca termina ya no retiene el carril.
 */
import Stripe from 'stripe'
import { prismaMock } from '@tests/__helpers__/setup'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'

const getAuthorization = jest.fn()
const voidAuthorization = jest.fn()
/** Ruling 73: una prueba pone aquí el adaptador REAL (SDK real, transporte de prueba) en lugar de los dobles. */
let mockProveedor: unknown = null
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => mockProveedor ?? { getAuthorization, voidAuthorization, createAuthorizationCheckout: jest.fn() }),
}))
jest.mock('@/services/online-ordering/order.service', () => ({
  __esModule: true,
  TX_OPTIONS: {},
  emitOnlineOrderCreated: jest.fn(),
  fromQuoteSnapshot: jest.fn(),
  lockAdmission: jest.fn(),
  pickOrderNumber: jest.fn(async () => '0001'),
  writeOnlineOrderInTx: jest.fn(),
}))
jest.mock('@/services/online-ordering/card/capture.service', () => ({
  __esModule: true,
  GraceEndedBeforeDispatch: class extends Error {},
  captureCharge: jest.fn(),
  failCapture: jest.fn(),
  finishCapture: jest.fn(),
}))
jest.mock('@/services/online-ordering/card/draft.service', () => ({
  __esModule: true,
  checkoutParams: jest.fn(),
  expiresAtRejected: jest.fn(() => false),
}))
jest.mock('@/services/online-ordering/transitions.service', () => ({ __esModule: true, prepMinutes: jest.fn(async () => 15) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

import { reconcileCardCharges, visitEarlyNadieDrafts } from '@/services/online-ordering/card/reconcile.service'

const MIN = 60_000
const NOW = new Date('2026-11-21T18:00:00.000Z')
/** La visita temprana: 10 s, sin reintentos del SDK y (Ruling 73) nuestro plazo duro de 10 + 5 s. */
const LIMITE = { timeoutMs: 10_000, maxNetworkRetries: 0, plazoMs: 15_000 }
/** Ruling 73: la pasada principal no pone límite por petición, sólo nuestro plazo duro de 120 s. */
const PLAZO_DE_LA_PASADA = { plazoMs: 120_000 }
/** Sin límite, una llamada colgada dura lo que el cliente de Stripe del proveedor: 80 s por intento y dos reintentos. */
const SIN_LIMITE_MS = 3 * 80_000 + 1_500

type Fila = Record<string, any>
let tabla: Map<string, Fila>
/** Un borrador de «Nadie» con su página viva y más de 2 min: lo visita la visita temprana. */
const borrador = (id: string): Fila => ({
  id,
  venueId: 'v1',
  status: 'PENDING_AUTH',
  customerPhone: '',
  checkoutSessionId: `cs_${id}`,
  checkoutExpiresAt: new Date(NOW.getTime() + 20 * MIN),
  createdAt: new Date(NOW.getTime() - 5 * MIN),
  updatedAt: new Date(NOW.getTime() - 5 * MIN),
  paymentIntentId: null,
  onlineOrderId: null,
  ecommerceMerchantId: 'em1',
  merchantSnapshot: { connectAccountId: 'acct_1', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
  amount: '250.00',
  request: {},
  lastError: null,
  attempts: 0,
  stuckAlertedAt: null,
  inDoubtSince: null,
})
/** Una condición sobre un campo del JSON `request` (Ruling 74: el cierre de la franja, en ISO), como la compara Postgres: texto. */
const cumpleJson = (v: unknown, c: { gt?: string; lte?: string }) =>
  typeof v === 'string' && (c.gt === undefined || v > c.gt) && (c.lte === undefined || v <= c.lte)
/** Lo que filtran las lecturas y los CAS de esta cadena (estado, modo, página, edad y cierre); lo demás del `where` no cambia nada aquí. */
const cumple = (f: Fila, w: any): boolean =>
  (w.id === undefined || f.id === w.id) &&
  (w.status === undefined || f.status === w.status) &&
  (w.customerPhone === undefined || f.customerPhone === w.customerPhone) &&
  (w.checkoutExpiresAt?.gt === undefined || f.checkoutExpiresAt > w.checkoutExpiresAt.gt) &&
  (w.checkoutExpiresAt?.lte === undefined || f.checkoutExpiresAt <= w.checkoutExpiresAt.lte) &&
  (w.createdAt?.lte === undefined || f.createdAt <= w.createdAt.lte) &&
  (w.updatedAt?.lte === undefined || f.updatedAt <= w.updatedAt.lte) &&
  (w.AND === undefined || w.AND.every((c: any) => cumple(f, c))) &&
  (w.request === undefined || cumpleJson(f.request?.[w.request.path[0]], w.request))

let visitaDelSano: number | null

beforeEach(() => {
  tabla = new Map()
  visitaDelSano = null
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.onlineOrderCharge.findMany.mockReset()
  prismaMock.onlineOrderCharge.findMany.mockImplementation((async (a: any) =>
    [...tabla.values()].filter(f => cumple(f, a.where)).map(f => ({ ...f, onlineOrder: null }))) as any)
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockImplementation((async (a: any) => {
    const f = tabla.get(a.where.id)
    return f ? { ...f, onlineOrder: null } : null
  }) as any)
  prismaMock.onlineOrderCharge.updateMany.mockReset()
  prismaMock.onlineOrderCharge.updateMany.mockImplementation((async (a: any) => {
    const f = tabla.get(a.where.id)
    if (!f || !cumple(f, a.where)) return { count: 0 }
    for (const [k, v] of Object.entries(a.data)) if (v === null || v instanceof Date || typeof v !== 'object') f[k] = v
    return { count: 1 }
  }) as any)

  getAuthorization.mockReset()
  getAuthorization.mockImplementation(async (_m: unknown, ref: any) => {
    if (ref.checkoutSessionId === 'cs_sano') {
      visitaDelSano = Date.now() - NOW.getTime()
      return { sessionStatus: 'open', piStatus: null, paymentIntentId: null, amountCapturableCents: 0 } // todavía pagando
    }
    if (ref.checkoutSessionId) {
      // Stripe apartó OTRO monto: el apartado no se vuelve pedido y se libera (AMOUNT_MISMATCH).
      const pi = ref.checkoutSessionId.replace('cs_', 'pi_')
      return { sessionStatus: 'complete', piStatus: 'requires_capture', paymentIntentId: pi, amountCapturableCents: 100 }
    }
    return { piStatus: 'requires_capture', paymentIntentId: ref.paymentIntentId } // la relectura: Stripe contesta, sigue apartada
  })
  // La cancelación no contesta: cuelga hasta su límite (el SDK se rinde) o, sin él, lo que tarda el cliente del proveedor.
  voidAuthorization.mockReset()
  voidAuthorization.mockImplementation(
    (_m: unknown, _p: unknown, limite?: { timeoutMs?: number }) =>
      new Promise((_r, rechazar) =>
        setTimeout(
          () => rechazar(Object.assign(new Error('Stripe no contestó a tiempo'), { type: 'StripeConnectionError' })),
          limite?.timeoutMs ?? SIN_LIMITE_MS,
        ),
      ),
  )
})

afterEach(() => jest.useRealTimers())

describe('D661 · B (Ruling 51): toda llamada a Stripe de la visita temprana va acotada, también la liberación', () => {
  it('una cancelación colgada se rinde a su límite; el borrador sano de atrás se visita dentro del presupuesto más un límite; el cargo queda RELEASING y la siguiente pasada lo termina con la MISMA llave', async () => {
    for (let i = 0; i < 10; i++) tabla.set(`colgado${i}`, borrador(`colgado${i}`))
    tabla.set('sano', borrador('sano')) // el último de la fila

    const pasada = reconcileCardCharges(NOW, read => read())
    await jest.advanceTimersByTimeAsync(5 * MIN)
    await expect(pasada).resolves.toMatchObject({ scanned: 11, errors: 10 })
    expect(visitaDelSano).not.toBeNull()
    expect(visitaDelSano!).toBeLessThanOrEqual(30_000 + 10_000)
    for (let i = 0; i < 10; i++) {
      const id = `colgado${i}`
      const llave = { paymentIntentId: `pi_${id}`, idempotencyKey: `online-order-charge:${id}:release` }
      expect(voidAuthorization).toHaveBeenCalledWith(expect.anything(), llave, LIMITE)
      expect(getAuthorization).toHaveBeenCalledWith(expect.anything(), { paymentIntentId: `pi_${id}` }, LIMITE)
      expect(tabla.get(id)).toMatchObject({ status: 'RELEASING', lastError: 'Stripe no contestó a tiempo' })
    }

    // La siguiente pasada, con Stripe ya contestando: la liberación sin límite por petición (Ruling 73: sólo nuestro plazo de 120 s), con
    // la MISMA llave, los termina.
    voidAuthorization.mockClear()
    voidAuthorization.mockImplementation(async (_m: unknown, p: any) => ({ piStatus: 'canceled', paymentIntentId: p.paymentIntentId }))
    const siguiente = reconcileCardCharges(new Date(NOW.getTime() + MIN), read => read())
    await jest.advanceTimersByTimeAsync(MIN)
    await expect(siguiente).resolves.toMatchObject({ released: 10, errors: 0 })
    for (let i = 0; i < 10; i++) {
      const id = `colgado${i}`
      expect(tabla.get(id)).toMatchObject({ status: 'RELEASED' })
      expect(voidAuthorization).toHaveBeenCalledWith(
        expect.anything(),
        { paymentIntentId: `pi_${id}`, idempotencyKey: `online-order-charge:${id}:release` },
        PLAZO_DE_LA_PASADA,
      )
    }
    expect(voidAuthorization.mock.calls.every(llamada => llamada[2] === undefined || llamada[2].timeoutMs === undefined)).toBe(true)
  })
})

describe('D661 · B (Ruling 73): ninguna llamada a Stripe del conciliador puede colgarse para siempre', () => {
  afterEach(() => {
    mockProveedor = null
  })

  it('Stripe manda las cabeceras y el cuerpo nunca termina: la visita se rinde a su plazo (10 s + 5 s) y el siguiente tick visita un borrador sano que llegó después', async () => {
    // El adaptador REAL con el SDK real; sólo el transporte es de prueba: la sesión de «colgado» manda cabeceras y nunca su cuerpo.
    const envios: string[] = []
    const client = {
      getClientName: () => 'prueba-d661',
      makeRequest: async (...a: unknown[]) => {
        const path = a[2] as string
        envios.push(path)
        const cuerpo = path.includes('/cs_colgado')
          ? () => new Promise(() => {})
          : async () => ({ id: 'cs_sano', object: 'checkout.session', status: 'open', payment_intent: null })
        return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: cuerpo }
      },
    }
    const real = new StripeConnectProvider('sk_test_x')
    ;(real as unknown as { stripe: Stripe }).stripe = new Stripe('sk_test_x', { httpClient: client as never })
    mockProveedor = real
    // El SDK arma su User-Agent con `uname -a` (un proceso de verdad, fuera del reloj de prueba): una primera llamada lo deja listo, o el
    // plazo de prueba podría cumplirse antes que ese proceso.
    const cuenta = {
      id: 'em1',
      providerCredentials: { connectAccountId: 'acct_1' },
      sandboxMode: true,
      provider: { code: 'STRIPE_CONNECT' },
    }
    await real.getAuthorization(cuenta, { checkoutSessionId: 'cs_sano' }, LIMITE)
    envios.length = 0
    tabla.set('colgado', borrador('colgado'))

    let termino = false
    const tick1 = visitEarlyNadieDrafts(NOW, read => read()).then(r => {
      termino = true
      return r
    })
    await jest.advanceTimersByTimeAsync(14_999)
    expect(termino).toBe(false) // todavía esperando a Stripe
    await jest.advanceTimersByTimeAsync(1)
    expect(termino).toBe(true)
    await expect(tick1).resolves.toMatchObject({ scanned: 1, errors: 1 })
    expect(tabla.get('colgado')).toMatchObject({ status: 'PENDING_AUTH' }) // sigue igual: otra visita lo reintenta

    // El siguiente tick, con un borrador sano que llegó después: el carril ya no está ocupado y lo visita.
    tabla.set('sano', borrador('sano'))
    const tick2 = visitEarlyNadieDrafts(new Date(NOW.getTime() + MIN), read => read())
    await jest.advanceTimersByTimeAsync(20_000)
    await expect(tick2).resolves.toMatchObject({ scanned: 2, errors: 1 })
    expect(envios.filter(p => p.includes('/v1/checkout/sessions/cs_sano'))).toHaveLength(1)
  })
})
