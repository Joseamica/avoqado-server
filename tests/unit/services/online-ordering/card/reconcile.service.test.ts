// tests/unit/services/online-ordering/card/reconcile.service.test.ts
/**
 * D661 (ola final, A2 y A3): el orden y el presupuesto de la pasada del conciliador, en aislamiento (Stripe y los escritores van
 * espiados). Con Postgres real y Stripe con demora controlada: `tarjetaEnNadieConciliador.integration.test.ts`.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const getAuthorization = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ getAuthorization, createAuthorizationCheckout: jest.fn() })),
}))
const confirmCardAuthorization = jest.fn()
jest.mock('@/services/online-ordering/card/confirm.service', () => ({
  __esModule: true,
  confirmCardAuthorization: (...a: unknown[]) => confirmCardAuthorization(...a),
}))
const finishCapture = jest.fn()
jest.mock('@/services/online-ordering/card/capture.service', () => ({
  __esModule: true,
  GraceEndedBeforeDispatch: class extends Error {},
  captureCharge: jest.fn(),
  failCapture: jest.fn(),
  finishCapture: (...a: unknown[]) => finishCapture(...a),
}))
jest.mock('@/services/online-ordering/card/release.service', () => ({
  __esModule: true,
  releaseCharge: jest.fn(async () => 'RELEASED'),
  voidOrReadOutcome: jest.fn(),
}))
jest.mock('@/services/online-ordering/card/draft.service', () => ({
  __esModule: true,
  checkoutParams: jest.fn(),
  expiresAtRejected: jest.fn(() => false),
}))
jest.mock('@/services/online-ordering/card/merchant', () => ({ __esModule: true, chargeMerchant: jest.fn(() => ({})) }))
jest.mock('@/services/online-ordering/transitions.service', () => ({ __esModule: true, prepMinutes: jest.fn(async () => 15) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

import { reconcileCardCharges, visitEarlyNadieDrafts } from '@/services/online-ordering/card/reconcile.service'

const MIN = 60_000
const NOW = new Date('2026-11-20T18:00:00.000Z')
/** `urgent` (Ruling 74): los borradores de «Nadie» con su cierre cerca, que la visita lee aparte y sin el filtro de edad. */
type Grupo = 'expired' | 'early' | 'urgent' | 'capturing' | 'releasing' | 'authorized'
const esTemprano = (grupo: Grupo) => grupo === 'early' || grupo === 'urgent'
const fila = (id: string, grupo: Grupo) => ({
  id,
  venueId: 'v1',
  status: {
    expired: 'PENDING_AUTH',
    early: 'PENDING_AUTH',
    urgent: 'PENDING_AUTH',
    capturing: 'CAPTURING',
    releasing: 'RELEASING',
    authorized: 'AUTHORIZED',
  }[grupo],
  customerPhone: esTemprano(grupo) ? '' : '+525512345678',
  checkoutSessionId: `cs_${id}`,
  checkoutExpiresAt: esTemprano(grupo) ? new Date(NOW.getTime() + 20 * MIN) : new Date(NOW.getTime() - MIN),
  paymentIntentId: `pi_${id}`,
  amount: '250.00',
  createdAt: new Date(NOW.getTime() - 5 * MIN),
  updatedAt: new Date(NOW.getTime() - 5 * MIN),
  onlineOrder: grupo === 'capturing' ? { orderId: `o_${id}` } : null,
  attempts: 0,
})
/** De qué grupo es cada lectura, por la forma de su `where` (así las pide `readCandidates`; la de los urgentes trae su `AND` de cierre). */
const grupoDe = (where: any): Grupo => {
  if (where.status === 'CAPTURING') return 'capturing'
  if (where.status === 'RELEASING') return 'releasing'
  if (where.status === 'AUTHORIZED') return 'authorized'
  if (where.AND) return 'urgent'
  return where.customerPhone === '' ? 'early' : 'expired'
}
/** Las horas del `where` que deciden el grupo de un borrador (la página y la edad); lo demás lo decide el grupo. */
const cumpleHoras = (r: any, where: any) =>
  (where.checkoutExpiresAt?.gt === undefined || r.checkoutExpiresAt > where.checkoutExpiresAt.gt) &&
  (where.checkoutExpiresAt?.lte === undefined || r.checkoutExpiresAt <= where.checkoutExpiresAt.lte) &&
  (where.createdAt?.lte === undefined || r.createdAt <= where.createdAt.lte)

let filas: Record<Grupo, any[]>
let eventos: string[]
let reloj: number
let dateSpy: jest.SpyInstance
const buscar = (id: string) =>
  Object.values(filas)
    .flat()
    .find(r => r.id === id)

beforeEach(() => {
  filas = { expired: [], early: [], urgent: [], capturing: [], releasing: [], authorized: [] }
  eventos = []
  reloj = NOW.getTime()
  dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => reloj)
  prismaMock.onlineOrderCharge.findMany.mockReset()
  // Copias: la base cambia después de leer, la fila leída no.
  prismaMock.onlineOrderCharge.findMany.mockImplementation((async (a: any) =>
    filas[grupoDe(a.where)].filter(r => cumpleHoras(r, a.where)).map(r => ({ ...r }))) as any)
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockImplementation((async (a: any) => {
    const f = buscar(a.where.id)
    return { status: f.status, lastError: null, attempts: f.attempts, stuckAlertedAt: null, inDoubtSince: null }
  }) as any)
  prismaMock.onlineOrderCharge.updateMany.mockReset()
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 })
  confirmCardAuthorization.mockReset()
  confirmCardAuthorization.mockImplementation(async (id: string) => {
    eventos.push(`leer borrador ${id}`)
    return 'NOT_YET'
  })
  getAuthorization.mockReset()
  getAuthorization.mockImplementation(async (_m: unknown, ref: any) => {
    eventos.push(`leer cobro ${ref.paymentIntentId}`)
    return { piStatus: 'succeeded', amountReceivedCents: 25_000 }
  })
  finishCapture.mockReset()
  finishCapture.mockImplementation(async (id: string) => {
    eventos.push(`anotar cobro ${id}`)
    buscar(id).status = 'CAPTURED'
  })
})

afterEach(() => dateSpy.mockRestore())

/** Lo que la pasada tocó (la escritura de `settle` de cada cargo procesado). */
const tocados = () => prismaMock.onlineOrderCharge.updateMany.mock.calls.map(([a]: any) => a.where.id)

describe('D661 · A2: el dinero en duda primero, y la visita temprana con su propio presupuesto', () => {
  it('un CAPTURING en duda se termina antes de leer cualquier borrador temprano; después los tempranos, y al final lo demás', async () => {
    filas.expired = [fila('vencido1', 'expired')]
    filas.early = [fila('temprano1', 'early'), fila('temprano2', 'early')]
    filas.capturing = [fila('cobrando1', 'capturing')]
    filas.authorized = [fila('suelto1', 'authorized')]

    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 5, errors: 0 })
    expect(eventos.slice(0, 2)).toEqual(['leer cobro pi_cobrando1', 'anotar cobro cobrando1'])
    expect(eventos.slice(2, 4).sort()).toEqual(['leer borrador temprano1', 'leer borrador temprano2'])
    expect(eventos[4]).toBe('leer borrador vencido1')
    // Cada grupo conserva su tope y su orden de siempre (los urgentes del Ruling 74 se ordenan por su plazo, aparte).
    for (const [a] of prismaMock.onlineOrderCharge.findMany.mock.calls as any[]) {
      if (grupoDe(a.where) === 'urgent') expect(a).toMatchObject({ take: 50 })
      else expect(a).toMatchObject({ take: 50, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] })
    }
  })

  it('a lo más 5 borradores a la vez y ninguno nuevo después del presupuesto: los demás no se tocan y quedan primero para el siguiente minuto', async () => {
    filas.early = Array.from({ length: 12 }, (_, i) => fila(`t${String(i).padStart(2, '0')}`, 'early'))
    let enVuelo = 0
    let maximo = 0
    confirmCardAuthorization.mockImplementation(async (id: string) => {
      eventos.push(id)
      maximo = Math.max(maximo, ++enVuelo)
      await Promise.resolve()
      reloj += 31_000 // cada lectura de Stripe tarda más que todo el presupuesto
      enVuelo--
      return 'NOT_YET'
    })

    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 5, errors: 0 })
    expect(maximo).toBe(5)
    expect(eventos).toEqual(['t00', 't01', 't02', 't03', 't04']) // en su orden: el menos reciente primero
    expect(tocados().sort()).toEqual(['t00', 't01', 't02', 't03', 't04'])
  })

  it('con lecturas rápidas, los 50 del grupo se visitan en la misma pasada', async () => {
    filas.early = Array.from({ length: 50 }, (_, i) => fila(`r${i}`, 'early'))
    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 50 })
  })

  it('el job puede correr sólo la visita temprana; nunca dos visitas tempranas a la vez en el proceso', async () => {
    filas.early = [fila('t1', 'early')]
    filas.capturing = [fila('cobrando1', 'capturing')]
    let soltar!: () => void
    confirmCardAuthorization.mockImplementationOnce(
      () =>
        new Promise(r => {
          soltar = () => r('NOT_YET')
        }),
    )
    const primera = visitEarlyNadieDrafts(NOW, read => read())
    await new Promise(r => setImmediate(r))
    // Mientras tanto, otra visita (sola o dentro de una pasada) no lee ni toca borradores tempranos.
    await expect(visitEarlyNadieDrafts(NOW, read => read())).resolves.toMatchObject({ scanned: 0 })
    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 1, finished: 1 })
    expect(confirmCardAuthorization).toHaveBeenCalledTimes(1)
    soltar()
    await expect(primera).resolves.toMatchObject({ scanned: 1 })
    // La visita sola no lee los demás grupos. D661 (B, Ruling 42): la pasada lee la lista temprana al ENTRAR al carril; con el carril
    // ocupado ni la lee: la única lectura es la de la primera visita.
    const leidos = (prismaMock.onlineOrderCharge.findMany.mock.calls as any[]).map(([a]) => grupoDe(a.where))
    expect(leidos.filter(g => g === 'early')).toHaveLength(1)
  })
})

describe('D661 · B (Ruling 42): la visita temprana acota cada lectura de Stripe y lee su lista al empezar', () => {
  const LECTURA_TEMPRANA = { timeoutMs: 10_000, maxNetworkRetries: 0 }
  const llamadaDe = (id: string) => confirmCardAuthorization.mock.calls.find(([c]) => c === id)!

  it('la visita temprana pasa a la lectura su límite (10 s, sin reintentos del SDK); un borrador vencido (lo demás de la pasada) se lee como hoy', async () => {
    filas.early = [fila('temprano1', 'early')]
    filas.expired = [fila('vencido1', 'expired')]
    await reconcileCardCharges(NOW, read => read())
    expect(llamadaDe('temprano1')[2]).toEqual(LECTURA_TEMPRANA)
    expect(llamadaDe('vencido1')[2]).toBeUndefined()
    // La visita sola (el minuto en que la pasada anterior sigue corriendo), igual.
    confirmCardAuthorization.mockClear()
    await visitEarlyNadieDrafts(NOW, read => read())
    expect(llamadaDe('temprano1')[2]).toEqual(LECTURA_TEMPRANA)
  })

  it('la pasada lee la lista temprana al ENTRAR al carril: un borrador que se vuelve visitable mientras atiende el dinero en duda se visita en esa misma pasada', async () => {
    filas.capturing = [fila('cobrando1', 'capturing')]
    getAuthorization.mockImplementation(async (_m: unknown, ref: any) => {
      eventos.push(`leer cobro ${ref.paymentIntentId}`)
      // Mientras la pasada atiende el cobro en duda, un borrador cumple sus 2 min.
      filas.early = [fila('recien', 'early')]
      return { piStatus: 'succeeded', amountReceivedCents: 25_000 }
    })
    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 2, errors: 0 })
    expect(eventos).toEqual(['leer cobro pi_cobrando1', 'anotar cobro cobrando1', 'leer borrador recien'])
  })
})

describe('D661 · B (Ruling 42): diez lecturas colgadas hasta su límite no impiden visitar a tiempo un borrador sano', () => {
  // Reloj de la prueba: las lecturas cuelgan de verdad (temporizadores) y corren a la vez, cinco por tanda, como en el carril.
  beforeEach(() => {
    dateSpy.mockRestore()
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
  })
  afterEach(() => jest.useRealTimers())

  it('con el reloj del carril, el borrador sano (el 11.º) se visita dentro del presupuesto más un límite de lectura', async () => {
    filas.early = [...Array.from({ length: 10 }, (_, i) => fila(`colgado${i}`, 'early')), fila('sano', 'early')]
    // Sin límite, una lectura colgada dura lo que el cliente de Stripe del proveedor: 80 s por intento y dos reintentos.
    const SIN_LIMITE_MS = 3 * 80_000 + 1_500
    let visitaDelSano: number | null = null
    confirmCardAuthorization.mockImplementation(async (id: string, _now: unknown, limite?: { timeoutMs?: number }) => {
      if (id === 'sano') {
        visitaDelSano = Date.now() - NOW.getTime()
        return 'NOT_YET'
      }
      await new Promise(r => setTimeout(r, limite?.timeoutMs ?? SIN_LIMITE_MS))
      throw new Error('Stripe no contestó a tiempo')
    })

    const pasada = reconcileCardCharges(NOW, read => read())
    await jest.advanceTimersByTimeAsync(5 * 60_000)
    await expect(pasada).resolves.toMatchObject({ scanned: 11, errors: 10 })
    expect(visitaDelSano).not.toBeNull()
    expect(visitaDelSano!).toBeLessThanOrEqual(30_000 + 10_000)
  })
})

describe('D661 · addendum r3: en la pasada, la visita mide la página viva desde el INICIO de la pasada', () => {
  it('un borrador cuya página vence mientras se atiende el dinero en duda se visita en esa misma pasada (ya no queda sin grupo hasta la siguiente); la edad, con la hora del carril', async () => {
    filas.capturing = [fila('cobrando1', 'capturing')]
    // Su página vence 1 s después del inicio de la pasada: no está entre los vencidos (leídos al empezar, ≤ inicio).
    filas.early = [{ ...fila('borde', 'early'), checkoutExpiresAt: new Date(NOW.getTime() + 1_000) }]
    getAuthorization.mockImplementation(async (_m: unknown, ref: any) => {
      eventos.push(`leer cobro ${ref.paymentIntentId}`)
      reloj += 2_000 // el cobro en duda tarda 2 s: el carril empieza en inicio + 2 s
      return { piStatus: 'succeeded', amountReceivedCents: 25_000 }
    })
    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 2, errors: 0 })
    expect(eventos).toEqual(['leer cobro pi_cobrando1', 'anotar cobro cobrando1', 'leer borrador borde'])
    const temprana = (prismaMock.onlineOrderCharge.findMany.mock.calls as any[]).map(([a]) => a).find(a => grupoDe(a.where) === 'early')
    expect(temprana.where).toMatchObject({
      checkoutExpiresAt: { gt: NOW },
      createdAt: { lte: new Date(NOW.getTime() + 2_000 - 2 * MIN) },
    })
  })
})

describe('D661 · A3: la alerta de «confirmación atorada» no cuenta los tropiezos de un borrador que sólo espera a la clienta', () => {
  it('un borrador con la página viva que truena no suma intentos ni alerta; uno ya vencido sí suma, como hoy', async () => {
    filas.early = [{ ...fila('vivo', 'early'), attempts: 2 }]
    filas.expired = [{ ...fila('vencido', 'expired'), attempts: 0 }]
    confirmCardAuthorization.mockRejectedValue(new Error('Stripe no contestó'))

    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 2, errors: 2 })
    const escrituras: any[] = prismaMock.onlineOrderCharge.updateMany.mock.calls.map(([a]: any) => a)
    const deVivo = escrituras.filter(e => e.where.id === 'vivo')
    expect(deVivo).toHaveLength(1) // sólo se toca para rotar; con 2 intentos previos, uno más ya habría alertado
    expect(deVivo[0].data).toEqual({ updatedAt: NOW })
    expect(escrituras.find(e => e.where.id === 'vencido').data).toEqual({
      updatedAt: NOW,
      attempts: { increment: 1 },
      lastError: 'Stripe no contestó',
    })
    expect(escrituras.some(e => e.data.stuckAlertedAt)).toBe(false)
  })
})
