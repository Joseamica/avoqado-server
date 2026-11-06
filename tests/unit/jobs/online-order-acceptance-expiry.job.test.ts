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
const AT = new Date('2026-10-14T18:00:00.000Z')
const CANDIDATES = [
  { id: 'oo1', orderId: 'ord1', venueId: 'v1', acceptDeadlineAt: AT },
  { id: 'oo2', orderId: 'ord2', venueId: 'v2', acceptDeadlineAt: AT },
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
    leerVencidos?: jest.Mock
    leerAbonosDevueltos?: jest.Mock
    syncCancelled?: jest.Mock
    syncPaidPickups?: jest.Mock
    syncPaidFolios?: jest.Mock
    syncPaidClosedFolios?: jest.Mock
    cerrarFoliosDelDia?: jest.Mock
  } = {},
) {
  const cron = { start: jest.fn(), stop: jest.fn() }
  const leerVencidos = o.leerVencidos ?? jest.fn().mockResolvedValue(o.candidates ?? CANDIDATES)
  const expireOrder = o.expireOrder ?? jest.fn().mockResolvedValue({ outcome: 'OK', status: 'EXPIRED' })
  const syncCancelled = o.syncCancelled ?? jest.fn().mockResolvedValue(0)
  const syncPaidPickups = o.syncPaidPickups ?? jest.fn().mockResolvedValue(0)
  const syncPaidFolios = o.syncPaidFolios ?? jest.fn().mockResolvedValue(0)
  const syncPaidClosedFolios = o.syncPaidClosedFolios ?? jest.fn().mockResolvedValue(0)
  const cerrarFoliosDelDia = o.cerrarFoliosDelDia ?? jest.fn().mockResolvedValue(0)
  const leerAbonosDevueltos = o.leerAbonosDevueltos ?? jest.fn().mockResolvedValue([])
  const now = jest.fn(() => NOW)
  const job = new OnlineOrderAcceptanceExpiryJob({
    cron: cron as never,
    expireOrder,
    retryEntry: retryOnce as never,
    syncCancelled,
    syncPaidPickups,
    syncPaidFolios,
    syncPaidClosedFolios,
    cerrarFoliosDelDia,
    leerVencidos,
    leerAbonosDevueltos,
    now,
  })
  return {
    job,
    cron,
    leerVencidos,
    leerAbonosDevueltos,
    expireOrder,
    syncCancelled,
    syncPaidPickups,
    syncPaidFolios,
    syncPaidClosedFolios,
    cerrarFoliosDelDia,
    now,
  }
}

beforeEach(() => {
  // Con sus dependencias reales, R2 cierra cada candidato en su transacción bajo el candado de la orden (R12).
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (_sql: unknown, orderId: string) => [{ id: orderId }])
})

describe('online-order-acceptance-expiry.job', () => {
  it('primero sincroniza las cuentas canceladas por otra vía, luego lo pagado al recoger, y luego lee lo vencido (su SQL —sin dinero, cuenta ABIERTA, R1/A13/R50— se prueba en folios.service.test)', async () => {
    const h = harness({ candidates: [] })
    await h.job.checkNow()
    // A10: cada sincronización recibe el envoltorio de reintento SÓLO para su lectura de candidatos.
    // R52: R2 escribe bajo el candado: recibe el RELOJ, no la hora de la pasada. Lo pagado al recoger (de «Mi equipo», como hoy), la hora.
    expect(h.syncCancelled).toHaveBeenCalledWith(h.now, expect.any(Function))
    expect(h.syncPaidPickups).toHaveBeenCalledWith(NOW, expect.any(Function))
    expect(h.syncCancelled.mock.invocationCallOrder[0]).toBeLessThan(h.syncPaidPickups.mock.invocationCallOrder[0])
    expect(h.syncPaidPickups.mock.invocationCallOrder[0]).toBeLessThan(h.leerVencidos.mock.invocationCallOrder[0])
    expect(h.leerVencidos).toHaveBeenCalledWith(NOW, null) // la primera página, sin cursor
  })

  it('tienda híbrida (decisión 18): después de lo pagado al recoger y ANTES de vencer, pasa los folios pagados y los cerrados ya saldados a «Por entregar»', async () => {
    const h = harness({ syncPaidFolios: jest.fn().mockResolvedValue(2), syncPaidClosedFolios: jest.fn().mockResolvedValue(1) })
    await expect(h.job.checkNow()).resolves.toMatchObject({ porEntregar: 3, expired: 2 })
    // R52: escriben `acceptedAt` bajo el candado: reciben el reloj.
    expect(h.syncPaidFolios).toHaveBeenCalledWith(h.now, expect.any(Function))
    expect(h.syncPaidClosedFolios).toHaveBeenCalledWith(h.now, expect.any(Function))
    const orden = (m: jest.Mock) => m.mock.invocationCallOrder[0]
    expect(orden(h.syncPaidPickups)).toBeLessThan(orden(h.syncPaidFolios))
    expect(orden(h.syncPaidFolios)).toBeLessThan(orden(h.syncPaidClosedFolios))
    // R38: el fin del día va DESPUÉS de lo que mete folios a la lista y ANTES de vencer.
    expect(h.cerrarFoliosDelDia).toHaveBeenCalledWith(h.now, expect.any(Function)) // R52: decide el día con el reloj de su lectura
    expect(orden(h.syncPaidClosedFolios)).toBeLessThan(orden(h.cerrarFoliosDelDia))
    expect(orden(h.cerrarFoliosDelDia)).toBeLessThan(orden(h.leerVencidos))
  })

  it('un fallo al pasar folios a «Por entregar» no detiene la otra pasada ni el vencimiento', async () => {
    const h = harness({
      syncPaidFolios: jest.fn().mockRejectedValue(new Error('db')),
      syncPaidClosedFolios: jest.fn().mockResolvedValue(1),
    })
    await expect(h.job.checkNow()).resolves.toMatchObject({ porEntregar: 1, expired: 2, errors: 0 })
    const h3 = harness({ cerrarFoliosDelDia: jest.fn().mockRejectedValue(new Error('db')) })
    await expect(h3.job.checkNow()).resolves.toMatchObject({ expired: 2, errors: 0 })
    const h2 = harness({ syncPaidClosedFolios: jest.fn().mockRejectedValue(new Error('db')) })
    await expect(h2.job.checkNow()).resolves.toMatchObject({ porEntregar: 0, expired: 2, errors: 0 })
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
    const leerVencidos = jest.fn().mockResolvedValueOnce(bloqueados).mockResolvedValueOnce([vencible])
    const expireOrder = jest.fn(async (i: { orderId: string }) =>
      i.orderId === 'ord-ok' ? { outcome: 'OK', status: 'EXPIRED' } : { outcome: 'HAS_PAYMENTS' },
    )
    const h = harness({ leerVencidos, expireOrder: expireOrder as unknown as jest.Mock })

    await expect(h.job.checkNow()).resolves.toEqual({
      scanned: 101,
      expired: 1,
      noop: 100,
      errors: 0,
      synced: 0,
      collected: 0,
      porEntregar: 0,
    })
    expect(expireOrder).toHaveBeenCalledWith({ venueId: 'v2', orderId: 'ord-ok', reloj: h.now })
    // la segunda página arranca DESPUÉS del último leído, no otra vez desde el principio
    expect(leerVencidos).toHaveBeenNthCalledWith(2, NOW, { at, id: 'oo-099' })
    expect(leerVencidos).toHaveBeenCalledTimes(2) // la segunda página vino incompleta: la pasada termina
  })

  it('R49: la pasada aparte vence lo que su consulta (neto 0 en SQL) devuelve, con el mismo vencer bajo candado; su lectura va con reintento y su fallo no detiene el barrido', async () => {
    const leerAbonosDevueltos = jest.fn().mockResolvedValue([
      { id: 'oo-d1', orderId: 'devuelto1', venueId: 'v3', acceptDeadlineAt: AT },
      { id: 'oo-d2', orderId: 'devuelto2', venueId: 'v4', acceptDeadlineAt: AT },
    ])
    const expireOrder = jest.fn(async (i: { orderId: string }) =>
      i.orderId === 'devuelto2' ? { outcome: 'HAS_PAYMENTS' } : { outcome: 'OK', status: 'EXPIRED' },
    )
    const h = harness({ leerAbonosDevueltos, expireOrder })
    await expect(h.job.checkNow()).resolves.toMatchObject({ scanned: 4, expired: 3, noop: 1, errors: 0 })
    expect(leerAbonosDevueltos).toHaveBeenCalledWith(NOW, null)
    expect(expireOrder).toHaveBeenCalledWith({ venueId: 'v3', orderId: 'devuelto1', reloj: h.now })
    expect(expireOrder).toHaveBeenCalledWith({ venueId: 'v4', orderId: 'devuelto2', reloj: h.now })

    const h2 = harness({ leerAbonosDevueltos: jest.fn().mockRejectedValue(new Error('db')) })
    await expect(h2.job.checkNow()).resolves.toMatchObject({ scanned: 2, expired: 2, errors: 0 })
  })

  it('elige los candidatos con UN solo instante por pasada (R52: vencer lee el reloj bajo su candado) y vence cada candidato en su venue', async () => {
    const h = harness({ syncCancelled: jest.fn().mockResolvedValue(1), syncPaidPickups: jest.fn().mockResolvedValue(3) })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 2, noop: 0, errors: 0, synced: 1, collected: 3, porEntregar: 0 })
    expect(h.now).toHaveBeenCalledTimes(1)
    expect(h.expireOrder).toHaveBeenNthCalledWith(1, { venueId: 'v1', orderId: 'ord1', reloj: h.now })
    expect(h.expireOrder).toHaveBeenNthCalledWith(2, { venueId: 'v2', orderId: 'ord2', reloj: h.now })
  })

  it('un candidato que ya cambió (STALE) o que ya tiene dinero (HAS_PAYMENTS) cuenta como noop, no como error', async () => {
    const expireOrder = jest
      .fn()
      .mockResolvedValueOnce({ outcome: 'STALE', status: 'ACCEPTED' })
      .mockResolvedValueOnce({ outcome: 'HAS_PAYMENTS' })
    const h = harness({ expireOrder })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 0, noop: 2, errors: 0, synced: 0, collected: 0, porEntregar: 0 })
  })

  it('un fallo en un candidato no detiene a los demás', async () => {
    const expireOrder = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ outcome: 'OK', status: 'EXPIRED' })
    const h = harness({ expireOrder })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 1, noop: 0, errors: 1, synced: 0, collected: 0, porEntregar: 0 })
  })

  it('un fallo al sincronizar no detiene la otra sincronización ni el vencimiento', async () => {
    const h = harness({ syncCancelled: jest.fn().mockRejectedValue(new Error('db')), syncPaidPickups: jest.fn().mockResolvedValue(1) })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 2, noop: 0, errors: 0, synced: 0, collected: 1, porEntregar: 0 })
    const h2 = harness({ syncPaidPickups: jest.fn().mockRejectedValue(new Error('db')) })
    await expect(h2.job.checkNow()).resolves.toEqual({
      scanned: 2,
      expired: 2,
      noop: 0,
      errors: 0,
      synced: 0,
      collected: 0,
      porEntregar: 0,
    })
  })

  it('I-1 y opción 1: con sus dependencias reales, la pasada AVISA lo que cada sincronización cerró (sólo las ganadoras)', async () => {
    // La base simulada distingue las tres lecturas de la pasada por su filtro.
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) => {
      if (a.where.paymentMode) return [{ id: 'oo-P', orderId: 'ord-P', venueId: 'v2', status: 'READY', order: { orderNumber: 'WP' } }]
      // R2 lee cuentas CANCELADAS (`order.status.in`); las lecturas de vencer van inyectadas.
      if (a.where.order?.status?.in?.includes('CANCELLED')) {
        return [{ id: 'oo-C', orderId: 'ord-C', venueId: 'v1', order: { orderNumber: 'WC', status: 'CANCELLED' } }]
      }
      return []
    }) as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
    const job = new OnlineOrderAcceptanceExpiryJob({
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
      leerVencidos: jest.fn().mockResolvedValue([]), // las lecturas de vencer tienen su propia prueba
      leerAbonosDevueltos: jest.fn().mockResolvedValue([]),
    })

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
      cerrarFoliosDelDia: jest.fn().mockResolvedValue(0), // el fin del día (T9b) tiene su propia prueba
      leerVencidos: jest.fn().mockResolvedValue([]),
      leerAbonosDevueltos: jest.fn().mockResolvedValue([]),
    })

    await expect(job.checkNow()).resolves.toMatchObject({ synced: 0, collected: 1, errors: 0 })
    expect(lecturasR2).toBe(2)
    expect(lecturasPagado).toBe(2)
    const cas = prismaMock.onlineOrder.updateMany.mock.calls.map((c: any[]) => c[0].where.id)
    expect(cas).toEqual(['oo-C', 'oo-P'])
    for (const [, opciones] of retryEntry.mock.calls as any[]) expect(opciones.shouldRetry(caida)).toBe(true)
  })

  it('R52 (Codex f1 r4): la pasada empieza a las 03:59:50 y el folio se salda y revive a las 04:00:05 ⇒ `acceptedAt` 04:00:05, no la hora de la pasada', async () => {
    const PASADA = new Date('2026-11-06T09:59:50.000Z') // 03:59:50 en México
    const DESPUES = new Date('2026-11-06T10:00:05.000Z') // 04:00:05
    const now = jest.fn().mockReturnValueOnce(PASADA).mockReturnValue(DESPUES)
    // Con su dependencia real: la lectura de folios cerrados ya saldados encuentra el folio que la cajera acaba de saldar.
    prismaMock.onlineOrder.findMany.mockImplementation((async (a: any) =>
      a.where.requiresAcceptance === false && a.where.status?.in
        ? [{ id: 'oo-F', orderId: 'ord-F', venueId: 'v1', status: 'EXPIRED', order: { orderNumber: 'F-1' } }]
        : []) as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
    const expireOrder = jest.fn().mockResolvedValue({ outcome: 'OK', status: 'EXPIRED' })
    const leerVencidos = jest.fn().mockResolvedValue([CANDIDATES[0]])
    const job = new OnlineOrderAcceptanceExpiryJob({
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now,
      expireOrder,
      leerVencidos,
      leerAbonosDevueltos: jest.fn().mockResolvedValue([]),
      syncCancelled: jest.fn().mockResolvedValue(0),
      syncPaidPickups: jest.fn().mockResolvedValue(0),
      syncPaidFolios: jest.fn().mockResolvedValue(0),
      cerrarFoliosDelDia: jest.fn().mockResolvedValue(0),
    })

    await expect(job.checkNow()).resolves.toMatchObject({ porEntregar: 1 })

    const revivir = (prismaMock.onlineOrder.updateMany.mock.calls as any[][]).map(c => c[0]).find(a => a.where.id === 'oo-F')
    expect(revivir.data).toEqual({ status: 'ACCEPTED', acceptedAt: DESPUES }) // entra hoy: sale mañana a las 04:00 (R38)
    expect(leerVencidos).toHaveBeenCalledWith(PASADA, null) // la hora de la pasada sólo elige candidatos
    expect(expireOrder).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', reloj: now }) // vencer lee el reloj bajo su candado
  })

  it('un tick encimado se salta y suelta el candado al terminar', async () => {
    let release!: (rows: typeof CANDIDATES) => void
    const leerVencidos = jest.fn().mockReturnValue(new Promise(r => (release = r)))
    const h = harness({ leerVencidos })
    const first = h.job.checkNow()
    await expect(h.job.checkNow()).resolves.toEqual({
      scanned: 0,
      expired: 0,
      noop: 0,
      errors: 0,
      synced: 0,
      collected: 0,
      porEntregar: 0,
      skipped: true,
    })
    release([])
    await first
    leerVencidos.mockResolvedValue([])
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 0, expired: 0, noop: 0, errors: 0, synced: 0, collected: 0, porEntregar: 0 })
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
