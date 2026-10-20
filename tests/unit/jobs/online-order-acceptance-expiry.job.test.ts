// tests/unit/jobs/online-order-acceptance-expiry.job.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/online-ordering/notifications.service', () => ({
  __esModule: true,
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn() },
}))

import { notifyOrderEvent } from '@/services/online-ordering/notifications.service'
import { OnlineOrderAcceptanceExpiryJob } from '@/jobs/online-order-acceptance-expiry.job'
import { DATABASE_JOB_SCHEDULES } from '@/jobs/jobSchedules'

const NOW = new Date('2026-10-14T18:30:10.000Z')
const CANDIDATES = [
  { orderId: 'ord1', venueId: 'v1' },
  { orderId: 'ord2', venueId: 'v2' },
]

async function retryOnce<T>(operation: () => Promise<T>, options: { shouldRetry?: (e: unknown) => boolean }): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!options.shouldRetry?.(error)) throw error
    return operation()
  }
}

function harness(
  o: {
    candidates?: typeof CANDIDATES
    expireOrder?: jest.Mock
    findMany?: jest.Mock
    syncCancelled?: jest.Mock
    syncPaidPickups?: jest.Mock
  } = {},
) {
  const cron = { start: jest.fn(), stop: jest.fn() }
  const findMany = o.findMany ?? jest.fn().mockResolvedValue(o.candidates ?? CANDIDATES)
  const expireOrder = o.expireOrder ?? jest.fn().mockResolvedValue({ outcome: 'OK', status: 'EXPIRED' })
  const syncCancelled = o.syncCancelled ?? jest.fn().mockResolvedValue(0)
  const syncPaidPickups = o.syncPaidPickups ?? jest.fn().mockResolvedValue(0)
  const now = jest.fn(() => NOW)
  const job = new OnlineOrderAcceptanceExpiryJob({
    prisma: { onlineOrder: { findMany } } as never,
    cron: cron as never,
    expireOrder,
    retryEntry: retryOnce as never,
    syncCancelled,
    syncPaidPickups,
    now,
  })
  return { job, cron, findMany, expireOrder, syncCancelled, syncPaidPickups, now }
}

describe('online-order-acceptance-expiry.job', () => {
  it('primero sincroniza las cuentas canceladas por otra vía, luego lo pagado al recoger, y luego lee sólo lo vencido SIN dinero y con la cuenta ABIERTA (R1, R2, A13)', async () => {
    const h = harness({ candidates: [] })
    await h.job.checkNow()
    // A10: cada sincronización recibe el envoltorio de reintento SÓLO para su lectura de candidatos.
    expect(h.syncCancelled).toHaveBeenCalledWith(NOW, expect.any(Function))
    expect(h.syncPaidPickups).toHaveBeenCalledWith(NOW, expect.any(Function))
    expect(h.syncCancelled.mock.invocationCallOrder[0]).toBeLessThan(h.syncPaidPickups.mock.invocationCallOrder[0])
    expect(h.syncPaidPickups.mock.invocationCallOrder[0]).toBeLessThan(h.findMany.mock.invocationCallOrder[0])
    expect(h.findMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING_ACCEPTANCE',
        acceptDeadlineAt: { lte: NOW },
        // A13: una cuenta ya cerrada sin dinero (cortesía, COMPLETED) no se vuelve a intentar vencer en cada pasada.
        order: { paymentStatus: 'PENDING', status: { in: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY'] } },
      },
      select: { id: true, orderId: true, venueId: true, acceptDeadlineAt: true },
      orderBy: [{ acceptDeadlineAt: 'asc' }, { id: 'asc' }],
      take: 100,
    })
  })

  it('H7: 100 bloqueados delante no tapan a uno vencible detrás: avanza por llave estable (acceptDeadlineAt, id)', async () => {
    const at = new Date('2026-10-14T18:00:00.000Z')
    const bloqueados = Array.from({ length: 100 }, (_, i) => ({
      id: `oo-${String(i).padStart(3, '0')}`,
      orderId: `bloq${i}`,
      venueId: 'v1',
      acceptDeadlineAt: at,
    }))
    const vencible = { id: 'oo-999', orderId: 'ord-ok', venueId: 'v2', acceptDeadlineAt: at }
    const findMany = jest.fn().mockResolvedValueOnce(bloqueados).mockResolvedValueOnce([vencible])
    const expireOrder = jest.fn(async (i: { orderId: string }) =>
      i.orderId === 'ord-ok' ? { outcome: 'OK', status: 'EXPIRED' } : { outcome: 'HAS_PAYMENTS' },
    )
    const h = harness({ findMany, expireOrder: expireOrder as unknown as jest.Mock })

    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 101, expired: 1, noop: 100, errors: 0, synced: 0, collected: 0 })
    expect(expireOrder).toHaveBeenCalledWith({ venueId: 'v2', orderId: 'ord-ok', now: NOW })
    // la segunda página arranca DESPUÉS del último leído, no otra vez desde el principio
    const segunda = findMany.mock.calls[1][0]
    expect(segunda.where.OR).toEqual([{ acceptDeadlineAt: { gt: at } }, { acceptDeadlineAt: at, id: { gt: 'oo-099' } }])
    expect(findMany).toHaveBeenCalledTimes(2) // la segunda página vino incompleta: la pasada termina
  })

  it('usa UN solo instante por pasada y vence cada candidato en su venue', async () => {
    const h = harness({ syncCancelled: jest.fn().mockResolvedValue(1), syncPaidPickups: jest.fn().mockResolvedValue(3) })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 2, noop: 0, errors: 0, synced: 1, collected: 3 })
    expect(h.now).toHaveBeenCalledTimes(1)
    expect(h.expireOrder).toHaveBeenNthCalledWith(1, { venueId: 'v1', orderId: 'ord1', now: NOW })
    expect(h.expireOrder).toHaveBeenNthCalledWith(2, { venueId: 'v2', orderId: 'ord2', now: NOW })
  })

  it('un candidato que ya cambió (STALE) o que ya tiene dinero (HAS_PAYMENTS) cuenta como noop, no como error', async () => {
    const expireOrder = jest
      .fn()
      .mockResolvedValueOnce({ outcome: 'STALE', status: 'ACCEPTED' })
      .mockResolvedValueOnce({ outcome: 'HAS_PAYMENTS' })
    const h = harness({ expireOrder })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 0, noop: 2, errors: 0, synced: 0, collected: 0 })
  })

  it('un fallo en un candidato no detiene a los demás', async () => {
    const expireOrder = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ outcome: 'OK', status: 'EXPIRED' })
    const h = harness({ expireOrder })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 1, noop: 0, errors: 1, synced: 0, collected: 0 })
  })

  it('un fallo al sincronizar no detiene la otra sincronización ni el vencimiento', async () => {
    const h = harness({ syncCancelled: jest.fn().mockRejectedValue(new Error('db')), syncPaidPickups: jest.fn().mockResolvedValue(1) })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 2, noop: 0, errors: 0, synced: 0, collected: 1 })
    const h2 = harness({ syncPaidPickups: jest.fn().mockRejectedValue(new Error('db')) })
    await expect(h2.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 2, noop: 0, errors: 0, synced: 0, collected: 0 })
  })

  it('I-1 y opción 1: con sus dependencias reales, la pasada AVISA lo que cada sincronización cerró (sólo las ganadoras)', async () => {
    // La base simulada distingue las tres lecturas de la pasada por su filtro.
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
      if (a.where.paymentMode) return [{ id: 'oo-P', orderId: 'ord-P', venueId: 'v2', status: 'READY', order: { orderNumber: 'WP' } }]
      // R2 lee cuentas CANCELADAS; el vencimiento lee cuentas ABIERTAS (A13): las dos llevan `order.status.in`.
      if (a.where.order?.status?.in?.includes('CANCELLED')) {
        return [{ id: 'oo-C', orderId: 'ord-C', venueId: 'v1', order: { orderNumber: 'WC', status: 'CANCELLED' } }]
      }
      return []
    }) as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
    const job = new OnlineOrderAcceptanceExpiryJob({ cron: { start: jest.fn(), stop: jest.fn() } as never, now: () => NOW })

    await expect(job.checkNow()).resolves.toMatchObject({ synced: 1, collected: 1, scanned: 0 })
    expect(notifyOrderEvent).toHaveBeenCalledTimes(1)
    expect(notifyOrderEvent).toHaveBeenCalledWith('ord-C', 'CANCELLED')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CANCELLED_BY_STAFF', entityId: 'oo-C' }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ONLINE_ORDER_COLLECTED', entityId: 'oo-P', data: { orderNumber: 'WP', automatic: true } }),
    )
  })

  it('A10: con sus dependencias reales, la lectura de candidatos de cada sincronización se reintenta por conexión; el CAS nunca', async () => {
    const caida = Object.assign(new Error("Can't reach database server"), { code: 'P1001' })
    let lecturasR2 = 0
    let lecturasPagado = 0
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
      if (a.where.paymentMode) {
        if (++lecturasPagado === 1) throw caida
        return [{ id: 'oo-P', orderId: 'ord-P', venueId: 'v2', status: 'READY', order: { orderNumber: 'WP' } }]
      }
      if (a.where.order?.status?.in?.includes('CANCELLED')) {
        if (++lecturasR2 === 1) throw caida
        return [{ id: 'oo-C', orderId: 'ord-C', venueId: 'v1', order: { orderNumber: 'WC', status: 'CANCELLED' } }]
      }
      return []
    }) as any)
    // El CAS de R2 se cae por conexión: NO se repite (es una escritura); el de «pagado» sí confirma.
    prismaMock.onlineOrder.updateMany.mockImplementation((async (a: any) => {
      if (a.where.id === 'oo-C') throw caida
      return { count: 1 }
    }) as any)
    const retryEntry = jest.fn(retryOnce)
    const job = new OnlineOrderAcceptanceExpiryJob({
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
      retryEntry: retryEntry as never,
    })

    await expect(job.checkNow()).resolves.toMatchObject({ synced: 0, collected: 1, errors: 0 })
    expect(lecturasR2).toBe(2)
    expect(lecturasPagado).toBe(2)
    const cas = prismaMock.onlineOrder.updateMany.mock.calls.map((c: any[]) => c[0].where.id)
    expect(cas).toEqual(['oo-C', 'oo-P'])
    for (const [, opciones] of retryEntry.mock.calls as any[]) expect(opciones.shouldRetry(caida)).toBe(true)
  })

  it('un tick encimado se salta y suelta el candado al terminar', async () => {
    let release!: (rows: typeof CANDIDATES) => void
    const findMany = jest.fn().mockReturnValue(new Promise(r => (release = r)))
    const h = harness({ findMany })
    const first = h.job.checkNow()
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 0, expired: 0, noop: 0, errors: 0, synced: 0, collected: 0, skipped: true })
    release([])
    await first
    findMany.mockResolvedValue([])
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 0, expired: 0, noop: 0, errors: 0, synced: 0, collected: 0 })
  })

  it('arranca y para el cron', () => {
    const h = harness()
    h.job.start()
    h.job.stop()
    expect(h.cron.start).toHaveBeenCalledTimes(1)
    expect(h.cron.stop).toHaveBeenCalledTimes(1)
  })
})

describe('jobSchedules', () => {
  it('el vencimiento corre cada 30 s en los segundos 10 y 40, y ningún job de cada minuto usa esos segundos', () => {
    expect(DATABASE_JOB_SCHEDULES.onlineOrderAcceptanceExpiry).toBe('10,40 * * * * *')
    const seconds = (cron: string): string[] => cron.split(' ')[0].split(',')
    const clashes = Object.entries(DATABASE_JOB_SCHEDULES)
      .filter(([name]) => name !== 'onlineOrderAcceptanceExpiry')
      .filter(([, cron]) => cron.split(' ')[1] === '*')
      .filter(([, cron]) => seconds(cron).some(s => s === '10' || s === '40'))
    expect(clashes).toEqual([])
  })
})
