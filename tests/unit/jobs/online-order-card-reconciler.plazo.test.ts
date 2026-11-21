// tests/unit/jobs/online-order-card-reconciler.plazo.test.ts
/**
 * D661 (ronda 2 de codex-r3, Ruling 73): el job del conciliador con sus piezas REALES — la pasada, la visita temprana, el recorrido de
 * devoluciones y el adaptador de Stripe con el SDK real; sólo el transporte es de prueba y la base es un doble. Una devolución cuya
 * respuesta manda las cabeceras y nunca termina su cuerpo ya no retiene el `isRunning` del job: el recorrido se rinde a los 120 s, el job
 * suelta su bandera y el siguiente tick hace la pasada completa (aquí, termina un cobro CAPTURING). D661 (ronda 3 de codex-r3, Ruling 99):
 * el recorrido tiene su PROPIA bandera: mientras cuelga, la pasada del siguiente tick corre a tiempo y cobra un apartado de «Nadie».
 */
import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'

let mockProveedor: unknown = null
jest.mock('@/services/payments/provider-registry', () => ({ __esModule: true, getProvider: jest.fn(() => mockProveedor) }))
jest.mock('@/observability/jobContext', () => ({
  __esModule: true,
  scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}))
jest.mock('@/services/online-ordering/card/capture.service', () => ({
  __esModule: true,
  GraceEndedBeforeDispatch: class extends Error {},
  captureCharge: jest.fn(),
  failCapture: jest.fn(),
  finishCapture: jest.fn(async () => undefined),
}))
jest.mock('@/services/online-ordering/transitions.service', () => ({ __esModule: true, prepMinutes: jest.fn(async () => 15) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
// El candado de la orden (su SQL ya tiene sus pruebas): aquí la orden siempre es de este negocio.
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  lockExistingOrderForPayment: jest.fn(async () => true),
}))

import { captureCharge, finishCapture } from '@/services/online-ordering/card/capture.service'
import { OnlineOrderCardReconcilerJob } from '@/jobs/online-order-card-reconciler.job'

const NOW = new Date('2026-11-21T18:00:00.000Z')
const MIN = 60_000
const FOTO = { connectAccountId: 'acct_1', sandboxMode: true, providerCode: 'STRIPE_CONNECT' }
/** El cargo de la devolución (ya cobrado, de «Mi equipo»). */
const CARGO_DEVUELTO = {
  id: 'ch_dev',
  venueId: 'v1',
  ecommerceMerchantId: 'em1',
  merchantSnapshot: FOTO,
  paymentIntentId: 'pi_dev',
  onlineOrder: { orderId: 'ord_dev', requiresAcceptance: true },
}
/** Un cobro en duda (CAPTURING de más de 60 s): lo termina la pasada principal. */
const CARGO_EN_DUDA = {
  id: 'ch_cap',
  venueId: 'v1',
  status: 'CAPTURING',
  customerPhone: '+525555555555',
  ecommerceMerchantId: 'em1',
  merchantSnapshot: FOTO,
  paymentIntentId: 'pi_cap',
  amount: new Prisma.Decimal('250.00'),
  request: {},
  createdAt: new Date(NOW.getTime() - 10 * MIN),
  updatedAt: new Date(NOW.getTime() - 5 * MIN),
  checkoutExpiresAt: new Date(NOW.getTime() - 5 * MIN),
  attempts: 0,
  lastError: null,
  stuckAlertedAt: null,
  inDoubtSince: null,
  onlineOrder: { orderId: 'ord_cap' },
}
/** Ruling 99: un apartado de «Nadie» (sin teléfono) que la caja abrió a tiempo y cuya captura quedó en duda: su reintento tiene ventana. */
const CARGO_NADIE = {
  ...CARGO_EN_DUDA,
  id: 'ch_nadie',
  customerPhone: '',
  paymentIntentId: 'pi_nadie',
  onlineOrder: { orderId: 'ord_nadie' },
}

type Fila = Record<string, any>
let devolucion: Fila
/** El cobro en duda que la pasada lee (ninguno al empezar). */
let enDuda: Fila | null

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
  devolucion = {
    id: 'cr1',
    venueId: 'v1',
    chargeId: 'ch_dev',
    status: 'REQUESTED',
    amountCents: 10_000,
    reason: 'OTHER',
    staffId: 's1',
    stripeRefundId: null,
    feeRefundedCents: null,
    stampReversedAt: null,
    recordedAt: null,
    alertedAt: null,
    lastSentAt: null,
    lastError: null,
    createdAt: NOW,
    nextCheckAt: NOW,
  }
  enDuda = null
  let vencida = true // el recorrido la encuentra una vez; después, ya no le toca
  ;(prismaMock as any).onlineOrderCardRefund = {
    findMany: jest.fn(async (a: any) => {
      if (!a.where?.nextCheckAt || !vencida) return [] // el barrido de cierres «Devuelto»: nada que cerrar
      vencida = false
      return [{ id: devolucion.id, status: devolucion.status }]
    }),
    findUnique: jest.fn(async () => ({ ...devolucion })),
    updateMany: jest.fn(async (a: any) => {
      if (a.where.status !== undefined && a.where.status !== devolucion.status) return { count: 0 }
      Object.assign(devolucion, a.data)
      return { count: 1 }
    }),
  }
  prismaMock.onlineOrderCharge.findMany.mockReset()
  prismaMock.onlineOrderCharge.findMany.mockImplementation((async (a: any) =>
    enDuda && a.where?.status === 'CAPTURING' ? [{ ...enDuda }] : []) as any)
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockImplementation((async (a: any) => {
    if (a.where.id === CARGO_DEVUELTO.id) return { ...CARGO_DEVUELTO }
    if (a.where.id === enDuda?.id) return { status: 'CAPTURING', lastError: null, attempts: 0, stuckAlertedAt: null, inDoubtSince: null }
    return null
  }) as any)
  prismaMock.onlineOrderCharge.updateMany.mockReset()
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.payment.findFirst.mockResolvedValue({ feeAmount: new Prisma.Decimal('2.90') } as any)
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
})

/**
 * El adaptador REAL con el SDK real; sólo el transporte es de prueba: la devolución manda cabeceras y nunca su cuerpo, y el PaymentIntent
 * se lee con `piStatus`. Deja listo el User-Agent del SDK (`uname -a`, un proceso de verdad fuera del reloj de prueba) con una lectura.
 */
async function adaptadorReal(piStatus: 'succeeded' | 'requires_capture'): Promise<string[]> {
  const envios: string[] = []
  const client = {
    getClientName: () => 'prueba-d661',
    makeRequest: async (...a: unknown[]) => {
      const [, , path, method] = a as [string, number, string, string]
      envios.push(`${method} ${path.split('?')[0]}`)
      const pi = path.split('?')[0].split('/').pop()
      const cuerpo =
        method === 'POST' && path.startsWith('/v1/refunds')
          ? () => new Promise(() => {})
          : async () => ({
              id: pi,
              object: 'payment_intent',
              status: piStatus,
              amount: 25_000,
              amount_received: piStatus === 'succeeded' ? 25_000 : 0,
              amount_capturable: piStatus === 'succeeded' ? 0 : 25_000,
              application_fee_amount: 290,
              latest_charge: null,
            })
      return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: cuerpo }
    },
  }
  const real = new StripeConnectProvider('sk_test_x')
  ;(real as unknown as { stripe: Stripe }).stripe = new Stripe('sk_test_x', { httpClient: client as never })
  mockProveedor = real
  const cuenta = { id: 'em1', providerCredentials: { connectAccountId: 'acct_1' }, sandboxMode: true, provider: { code: 'STRIPE_CONNECT' } }
  await real.getAuthorization(cuenta, { paymentIntentId: 'pi_cap' })
  envios.length = 0
  return envios
}
const nuevoJob = () =>
  new OnlineOrderCardReconcilerJob({
    cron: { start: jest.fn(), stop: jest.fn() } as never,
    now: () => new Date(),
    retryEntry: (async (op: () => Promise<unknown>) => op()) as never,
  })

afterEach(() => {
  jest.useRealTimers()
  mockProveedor = null
})

describe('D661 (ronda 2 de codex-r3, Ruling 73): una devolución colgada ya no retiene el job del conciliador', () => {
  it('Stripe manda las cabeceras de la devolución y nunca su cuerpo: el recorrido se rinde a los 120 s, el job suelta su bandera y el siguiente tick termina un cobro CAPTURING', async () => {
    const envios = await adaptadorReal('succeeded')
    const job = nuevoJob()

    // Tick 1: la pasada no tiene nada; el recorrido manda la devolución y Stripe nunca termina su respuesta.
    let termino = false
    const tick1 = job.checkNow().then(r => {
      termino = true
      return r
    })
    await jest.advanceTimersByTimeAsync(119_999)
    expect(termino).toBe(false) // el recorrido todavía espera a Stripe
    await jest.advanceTimersByTimeAsync(1)
    expect(termino).toBe(true) // se rindió a su plazo: el job suelta su bandera
    await expect(tick1).resolves.toMatchObject({ refunds: { scanned: 1, errors: 1 } })
    expect(envios).toEqual(['POST /v1/refunds'])
    // La devolución sigue en duda con la MISMA llave para la siguiente pasada (la busca en Stripe y, si no está, la reenvía).
    expect(devolucion).toMatchObject({ status: 'SENDING', stripeRefundId: null, lastError: expect.stringContaining('120000 ms') })

    // Tick 2: llega un cobro en duda. Con la bandera libre corre la pasada completa (no sólo la visita temprana) y lo termina.
    enDuda = CARGO_EN_DUDA
    const tick2 = job.checkNow()
    await jest.advanceTimersByTimeAsync(5_000)
    const r2 = await tick2
    expect(r2.skipped).toBeUndefined()
    expect(r2).toMatchObject({ scanned: 1 })
    expect(finishCapture).toHaveBeenCalledWith('ch_cap', expect.objectContaining({ piStatus: 'succeeded' }), expect.anything())
    expect(envios).toContain('GET /v1/payment_intents/pi_cap')
  })
})

describe('D661 (ronda 3 de codex-r3, Ruling 99): el recorrido de devoluciones nunca retrasa la pasada', () => {
  it('la devolución cuelga y su recorrido se queda esperando, pero la pasada del siguiente tick corre completa a tiempo y COBRA un apartado de «Nadie» dentro de su ventana', async () => {
    const envios = await adaptadorReal('requires_capture')
    const job = nuevoJob()

    // Tick 1: la pasada no tiene nada; el recorrido se queda colgado en la devolución (su plazo de 120 s todavía no se cumple).
    let termino = false
    const tick1 = job.checkNow().then(r => {
      termino = true
      return r
    })
    await jest.advanceTimersByTimeAsync(60_000)
    expect(termino).toBe(false)
    expect(envios).toEqual(['POST /v1/refunds'])

    // Tick 2, un minuto después: un CAPTURING de «Nadie» cuyo plazo venció hace 30 s. Su reintento cierra en plazo + 5 min − 90 s.
    const plazo = new Date(Date.now() - 30_000)
    const cierraElReintento = plazo.getTime() + 5 * MIN - 90_000
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ acceptDeadlineAt: plazo, charge: { status: 'CAPTURING' } } as any)
    enDuda = CARGO_NADIE
    const tick2 = job.checkNow()
    await jest.advanceTimersByTimeAsync(1_000)
    const r2 = await tick2
    expect(r2.skipped).toBeUndefined() // la pasada completa, no sólo la visita temprana
    expect(r2.refunds).toBeUndefined() // su recorrido se saltó: el anterior sigue colgado
    expect(captureCharge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch_nadie' }),
      'ord_nadie',
      expect.objectContaining({ captureBefore: cierraElReintento }),
    )
    expect(Date.now()).toBeLessThan(cierraElReintento)
    expect(envios).toContain('GET /v1/payment_intents/pi_nadie')

    // El recorrido colgado se rinde a su plazo y el tick 1 termina.
    await jest.advanceTimersByTimeAsync(60_000)
    await expect(tick1).resolves.toMatchObject({ refunds: { scanned: 1, errors: 1 } })
  })
})
