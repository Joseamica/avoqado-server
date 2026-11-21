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

import { captureCharge, failCapture, finishCapture } from '@/services/online-ordering/card/capture.service'
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
/** Los cobros en duda que la pasada lee, en su orden (ninguno al empezar). */
let enDuda: Fila[]

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
  enDuda = []
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
    a.where?.status === 'CAPTURING' ? enDuda.map(c => ({ ...c })) : []) as any)
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockImplementation((async (a: any) => {
    if (a.where.id === CARGO_DEVUELTO.id) return { ...CARGO_DEVUELTO }
    if (enDuda.some(c => c.id === a.where.id))
      return { status: 'CAPTURING', lastError: null, attempts: 0, stuckAlertedAt: null, inDoubtSince: null }
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
    enDuda = [CARGO_EN_DUDA]
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
    enDuda = [{ ...CARGO_NADIE, onlineOrder: { orderId: 'ord_nadie', acceptDeadlineAt: plazo } }] // como lo trae la lectura real
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

/**
 * D661 (Codex r4 · Ruling 110, forma del Ruling 117): el plazo de 120 s de la lectura no puede tirar la ÚLTIMA oportunidad de cobrar un
 * «Nadie» que la caja abrió a tiempo (el servidor se reinició antes de mandar la captura). La primera lectura sigue con 120 s; si se
 * agota y todavía hay margen, se relee en la MISMA pasada con una petición NUEVA cuyo plazo es lo que falta hasta el límite del
 * reintento, el límite más cercano primero. Reloj controlado; el Stripe de prueba decide cada petición: muerta (la conexión nunca
 * termina su cuerpo), rápida o «contesta desde» cierto momento.
 */
describe('D661 (Ruling 117): una lectura agotada de un «Nadie» se relee en la misma pasada, el límite más cercano primero', () => {
  const LIMITE_MS = 140_000 // desde NOW: el último instante para EMPEZAR el reintento de captura
  type Conducta = 'muerta' | 'rapida' | { desde: number }
  let envios: Array<{ en: number; envio: string }>
  let capturas: Array<{ id: string; en: number }>
  /** El plazo de cada pedido, para que su límite (plazo + 5 min de gracia − 90 s de margen) caiga a `limiteMs` de NOW. */
  let plazos: Record<string, Date>
  const conLimite = (orderId: string, limiteMs: number) => (plazos[orderId] = new Date(NOW.getTime() + limiteMs - 5 * MIN + 90_000))
  const cargoNadie = (sufijo: string, hace: number): Fila => ({
    ...CARGO_NADIE,
    id: `ch_${sufijo}`,
    paymentIntentId: `pi_${sufijo}`,
    onlineOrder: { orderId: `ord_${sufijo}`, acceptDeadlineAt: plazos[`ord_${sufijo}`] }, // como lo trae la lectura real (Ruling 119)
    updatedAt: new Date(NOW.getTime() - hace),
  })

  /** El adaptador real; cada petición de lectura de un PaymentIntent sigue su conducta (la última se repite); la cancelación, en seguida. */
  async function stripePorPeticion(conductas: Record<string, Conducta[]>): Promise<void> {
    envios = []
    const vistas: Record<string, number> = {}
    const client = {
      getClientName: () => 'prueba-d661',
      makeRequest: async (...a: unknown[]) => {
        const [, , path, method] = a as [string, number, string, string]
        const ruta = path.split('?')[0]
        envios.push({ en: Date.now() - NOW.getTime(), envio: `${method} ${ruta}` })
        const id = ruta.split('/')[3] ?? 'pi_cap' // /v1/payment_intents/<id>[/cancel]
        const pi = (estado: string) => ({
          id,
          object: 'payment_intent',
          status: estado,
          amount: 25_000,
          amount_received: 0,
          amount_capturable: estado === 'requires_capture' ? 25_000 : 0,
          application_fee_amount: 290,
          latest_charge: null,
        })
        const lista = conductas[id]
        const conducta: Conducta | undefined = lista?.[Math.min((vistas[id] = (vistas[id] ?? -1) + 1), lista.length - 1)]
        const cuerpo =
          method === 'POST'
            ? async () => pi('canceled')
            : conducta === undefined
              ? async () => pi('succeeded')
              : conducta === 'muerta'
                ? () => new Promise(() => {})
                : conducta === 'rapida'
                  ? async () => pi('requires_capture')
                  : () =>
                      new Promise(r =>
                        setTimeout(() => r(pi('requires_capture')), Math.max(0, NOW.getTime() + conducta.desde - Date.now())),
                      )
        return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: cuerpo }
      },
    }
    const real = new StripeConnectProvider('sk_test_x')
    ;(real as unknown as { stripe: Stripe }).stripe = new Stripe('sk_test_x', { httpClient: client as never })
    mockProveedor = real
    const cuenta = {
      id: 'em1',
      providerCredentials: { connectAccountId: 'acct_1' },
      sandboxMode: true,
      provider: { code: 'STRIPE_CONNECT' },
    }
    await real.getAuthorization(cuenta, { paymentIntentId: 'pi_cap' }) // el User-Agent del SDK (`uname -a`), fuera del reloj de prueba
    envios.length = 0
  }

  beforeEach(() => {
    ;(prismaMock as any).onlineOrderCardRefund.findMany = jest.fn(async () => []) // sin devoluciones: sólo la pasada
    plazos = {}
    conLimite('ord_nadie', LIMITE_MS)
    prismaMock.onlineOrder.findFirst.mockImplementation((async (a: any) => ({
      acceptDeadlineAt: plazos[a.where.orderId],
      charge: { status: 'CAPTURING' },
    })) as any)
    enDuda = [cargoNadie('nadie', 5 * MIN)] // CARGO_NADIE con el plazo de su pedido, como lo trae la lectura real (Ruling 120)
    capturas = []
    jest.mocked(captureCharge).mockImplementation((async (charge: Fila) => {
      capturas.push({ id: charge.id, en: Date.now() - NOW.getTime() })
      enDuda = enDuda.filter(c => c.id !== charge.id) // cobrado: deja de estar en duda
    }) as any)
  })

  it('(c) Stripe contesta desde los 125 s y el límite es a los 140 s: la primera lectura se corta a los 120 s y la NUEVA cobra a los 125 s; cero cancelaciones, nada después del límite', async () => {
    await stripePorPeticion({ pi_nadie: [{ desde: 125_000 }] })
    const job = nuevoJob()
    const tick1 = job.checkNow()
    await jest.advanceTimersByTimeAsync(125_000)
    await tick1
    // Siguiente pasada, ya pasado el límite: no queda nada en duda.
    await jest.advanceTimersByTimeAsync(55_000)
    const tick2 = job.checkNow()
    await jest.advanceTimersByTimeAsync(1_000)
    await tick2

    expect(capturas).toEqual([{ id: 'ch_nadie', en: 125_000 }])
    expect(captureCharge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch_nadie' }),
      'ord_nadie',
      expect.objectContaining({ captureBefore: NOW.getTime() + LIMITE_MS }),
    )
    // Dos lecturas: la primera (cortada a los 120 s) y la nueva, que sale a los 120 s.
    expect(envios.filter(e => e.envio === 'GET /v1/payment_intents/pi_nadie').map(e => e.en)).toEqual([0, 120_000])
    expect(envios.filter(e => e.envio.startsWith('POST'))).toEqual([]) // ninguna cancelación (la captura la manda captureCharge)
    expect(failCapture).not.toHaveBeenCalled()
  })

  it('(c) Stripe no contesta antes del límite: la pasada relee hasta el límite y se rinde sin mandar nada; la pasada siguiente suelta como hoy', async () => {
    await stripePorPeticion({ pi_nadie: [{ desde: 150_000 }] })
    const job = nuevoJob()
    let termino = false
    const tick1 = job.checkNow().then(r => {
      termino = true
      return r
    })
    await jest.advanceTimersByTimeAsync(LIMITE_MS - 1)
    expect(termino).toBe(false) // la nueva lectura sigue esperando: todavía hay margen para empezar el reintento
    await jest.advanceTimersByTimeAsync(1)
    await expect(tick1).resolves.toMatchObject({ errors: 2 }) // la primera lectura (120 s) y la nueva (el límite), sin mandar nada
    expect(capturas).toEqual([])

    // La pasada siguiente, con Stripe ya contestando: pasó el límite → se suelta (como hoy), nunca se cobra.
    await jest.advanceTimersByTimeAsync(40_000)
    const tick2 = job.checkNow()
    await jest.advanceTimersByTimeAsync(1_000)
    await tick2
    expect(capturas).toEqual([])
    expect(captureCharge).not.toHaveBeenCalled()
    const posts = envios.filter(e => e.envio.startsWith('POST'))
    expect(posts.map(e => e.envio)).toEqual(['POST /v1/payment_intents/pi_nadie/cancel'])
    expect(posts[0].en).toBeGreaterThanOrEqual(LIMITE_MS)
    expect(failCapture).toHaveBeenCalledWith('ch_nadie', expect.objectContaining({ reason: 'RELEASED_AFTER_GRACE' }))
  })

  it('(a) A va primero con el límite lejos y su primera petición queda muerta; B tiene el límite cerca y Stripe le contesta en seguida: B se cobra antes de su límite y A en la relectura', async () => {
    conLimite('ord_a', 600_000)
    conLimite('ord_b', 180_000)
    enDuda = [cargoNadie('a', 10 * MIN), cargoNadie('b', 5 * MIN)] // A antes que B (`updatedAt`)
    await stripePorPeticion({ pi_a: ['muerta', 'rapida'], pi_b: ['rapida'] })
    const job = nuevoJob()
    const tick = job.checkNow()
    await jest.advanceTimersByTimeAsync(121_000)
    await tick

    expect(capturas).toEqual([
      { id: 'ch_b', en: 0 }, // Ruling 119: va primero (su límite es el más cercano), sin esperar la lectura muerta de A
      { id: 'ch_a', en: 120_000 }, // la relectura: una petición NUEVA
    ])
    expect(captureCharge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch_b' }),
      'ord_b',
      expect.objectContaining({ captureBefore: NOW.getTime() + 180_000 }),
    )
    expect(captureCharge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ch_a' }),
      'ord_a',
      expect.objectContaining({ captureBefore: NOW.getTime() + 600_000 }),
    )
    expect(envios.filter(e => e.envio === 'GET /v1/payment_intents/pi_a').map(e => e.en)).toEqual([0, 120_000])
    expect(envios.filter(e => e.envio.startsWith('POST'))).toEqual([])
    expect(failCapture).not.toHaveBeenCalled()
  })

  it('(b) A solo, con 690 s de ventana: su primera petición queda muerta y una petición NUEVA contesta en seguida → A se cobra (no se gasta toda la ventana en la conexión muerta)', async () => {
    conLimite('ord_a', 690_000)
    enDuda = [cargoNadie('a', 10 * MIN)]
    await stripePorPeticion({ pi_a: ['muerta', 'rapida'] })
    const job = nuevoJob()
    const tick = job.checkNow()
    await jest.advanceTimersByTimeAsync(121_000)
    await tick

    expect(capturas).toEqual([{ id: 'ch_a', en: 120_000 }])
    expect(envios.filter(e => e.envio === 'GET /v1/payment_intents/pi_a').map(e => e.en)).toEqual([0, 120_000])
    expect(envios.filter(e => e.envio.startsWith('POST'))).toEqual([])
    // Ruling 120: el límite de la relectura sale de la fila; el pedido sólo se lee bajo el candado (`captureRetryStep`), dentro del `try`.
    expect(prismaMock.onlineOrder.findFirst).toHaveBeenCalledTimes(1)
  })

  it('Ruling 119: B tiene su límite a 90 s (dentro de los primeros 120 s de la pasada) y A, más viejo, el límite lejos y su primera petición muerta: el dinero en duda va por límite, así que B se cobra antes de su límite y A en la relectura', async () => {
    conLimite('ord_a', 600_000)
    conLimite('ord_b', 90_000)
    enDuda = [cargoNadie('a', 10 * MIN), cargoNadie('b', 5 * MIN)] // por `updatedAt`, A iría primero
    await stripePorPeticion({ pi_a: ['muerta', 'rapida'], pi_b: ['rapida'] })
    const job = nuevoJob()
    const tick = job.checkNow()
    await jest.advanceTimersByTimeAsync(121_000)
    await tick

    expect(capturas).toEqual([
      { id: 'ch_b', en: 0 },
      { id: 'ch_a', en: 120_000 },
    ])
    expect(capturas[0].en).toBeLessThan(90_000)
    expect(envios.filter(e => e.envio.startsWith('POST'))).toEqual([]) // B no se soltó
    expect(failCapture).not.toHaveBeenCalled()
  })

  it('Ruling 120: E, de «Nadie», ya pasó su límite y su lectura cuelga; B tiene su límite a 90 s y Stripe le contesta en seguida: E va después de los vivos, así que B se cobra antes de su límite', async () => {
    conLimite('ord_e', -60_000) // ya no tiene qué salvar: soltarlo puede tardar lectura + cancelación + relectura
    conLimite('ord_b', 90_000)
    enDuda = [cargoNadie('e', 10 * MIN), cargoNadie('b', 5 * MIN)]
    await stripePorPeticion({ pi_e: ['muerta'], pi_b: ['rapida'] })
    const job = nuevoJob()
    const tick = job.checkNow()
    await jest.advanceTimersByTimeAsync(121_000)
    await tick

    expect(capturas).toEqual([{ id: 'ch_b', en: 0 }])
    expect(envios.filter(e => e.envio.startsWith('POST'))).toEqual([]) // B no se soltó
    // E se lee después de B; su lectura se agota y no se relee (su límite ya pasó). La pasada siguiente lo suelta, como hoy.
    expect(envios.filter(e => e.envio === 'GET /v1/payment_intents/pi_e').map(e => e.en)).toEqual([0])
    expect(failCapture).not.toHaveBeenCalled()
  })

  it('Ruling 120: la lectura agotada de un «Mi equipo» no se relee (no tiene límite): una sola lectura, nada se manda y lo retoma la pasada siguiente', async () => {
    enDuda = [{ ...CARGO_EN_DUDA, id: 'ch_eq', paymentIntentId: 'pi_eq', onlineOrder: { orderId: 'ord_eq' } }]
    await stripePorPeticion({ pi_eq: ['muerta', 'rapida'] })
    const job = nuevoJob()
    const tick = job.checkNow()
    await jest.advanceTimersByTimeAsync(121_000)
    await expect(tick).resolves.toMatchObject({ errors: 1 })

    expect(envios.filter(e => e.envio.includes('pi_eq')).map(e => e.en)).toEqual([0])
    expect(capturas).toEqual([])
    expect(failCapture).not.toHaveBeenCalled()
  })

  it('Ruling 120: un «Nadie» cuya lectura se agotó y cuyo límite pasó durante el ciclo (a los 100 s) no se relee: no se manda nada', async () => {
    conLimite('ord_a', 100_000)
    enDuda = [cargoNadie('a', 10 * MIN)]
    await stripePorPeticion({ pi_a: ['muerta', 'rapida'] })
    const job = nuevoJob()
    const tick = job.checkNow()
    await jest.advanceTimersByTimeAsync(121_000)
    await expect(tick).resolves.toMatchObject({ errors: 1 })

    expect(envios.filter(e => e.envio.includes('pi_a')).map(e => e.en)).toEqual([0]) // ni relectura ni cancelación
    expect(capturas).toEqual([])
    expect(failCapture).not.toHaveBeenCalled()
  })
})
