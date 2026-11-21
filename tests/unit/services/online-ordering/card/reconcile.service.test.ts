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
type Grupo = 'expired' | 'early' | 'capturing' | 'releasing' | 'authorized'
const fila = (id: string, grupo: Grupo) => ({
  id,
  venueId: 'v1',
  status: { expired: 'PENDING_AUTH', early: 'PENDING_AUTH', capturing: 'CAPTURING', releasing: 'RELEASING', authorized: 'AUTHORIZED' }[
    grupo
  ],
  customerPhone: grupo === 'early' ? '' : '+525512345678',
  checkoutSessionId: `cs_${id}`,
  checkoutExpiresAt: grupo === 'early' ? new Date(NOW.getTime() + 20 * MIN) : new Date(NOW.getTime() - MIN),
  paymentIntentId: `pi_${id}`,
  amount: '250.00',
  createdAt: new Date(NOW.getTime() - 5 * MIN),
  updatedAt: new Date(NOW.getTime() - 5 * MIN),
  onlineOrder: grupo === 'capturing' ? { orderId: `o_${id}` } : null,
  attempts: 0,
})
/** De qué grupo es cada lectura, por la forma de su `where` (así las pide `readCandidates`). */
const grupoDe = (where: any): Grupo => {
  if (where.status === 'CAPTURING') return 'capturing'
  if (where.status === 'RELEASING') return 'releasing'
  if (where.status === 'AUTHORIZED') return 'authorized'
  return where.customerPhone === '' ? 'early' : 'expired'
}

let filas: Record<Grupo, any[]>
let eventos: string[]
let reloj: number
let dateSpy: jest.SpyInstance
const buscar = (id: string) =>
  Object.values(filas)
    .flat()
    .find(r => r.id === id)

beforeEach(() => {
  filas = { expired: [], early: [], capturing: [], releasing: [], authorized: [] }
  eventos = []
  reloj = NOW.getTime()
  dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => reloj)
  prismaMock.onlineOrderCharge.findMany.mockReset()
  // Copias: la base cambia después de leer, la fila leída no.
  prismaMock.onlineOrderCharge.findMany.mockImplementation((async (a: any) => filas[grupoDe(a.where)].map(r => ({ ...r }))) as any)
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
    // Cada grupo conserva su tope y su orden de siempre.
    for (const [a] of prismaMock.onlineOrderCharge.findMany.mock.calls as any[]) {
      expect(a).toMatchObject({ take: 50, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] })
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
    // La visita sola no lee los demás grupos.
    const leidos = (prismaMock.onlineOrderCharge.findMany.mock.calls as any[]).map(([a]) => grupoDe(a.where))
    expect(leidos.filter(g => g === 'early')).toHaveLength(2) // la primera visita y la lectura de la pasada (que la salta)
  })
})

describe('D661 · A3: la alerta de «confirmación atorada» no cuenta los tropiezos de un borrador que sólo espera a la clienta', () => {
  it('un borrador con la página viva que truena no suma intentos ni alerta; uno ya vencido sí suma, como hoy', async () => {
    filas.early = [{ ...fila('vivo', 'early'), attempts: 2 }]
    filas.expired = [{ ...fila('vencido', 'expired'), attempts: 0 }]
    confirmCardAuthorization.mockRejectedValue(new Error('Stripe no contestó'))

    await expect(reconcileCardCharges(NOW, read => read())).resolves.toMatchObject({ scanned: 2, errors: 2 })
    const escrituras = prismaMock.onlineOrderCharge.updateMany.mock.calls.map(([a]: any) => a)
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
