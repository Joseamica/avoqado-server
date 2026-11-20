/**
 * D17 (founder, 20-nov-2026; Flautas): pantalla de cocina con tiempos.
 *  (1) la comanda sale del tablero cuando la COCINA termina (READY de v1), sin cambiar su estado para la caja;
 *  (2) lo de un día del negocio terminado con la cuenta cerrada se archiva (sólo `archivedAt`);
 *  (3) interruptor «La cocina puede liberar tiempos desde su pantalla».
 * Promesa y auditorías: docs/audit/2026-11-20-cocina-con-tiempos/ (workspace).
 */
import { prismaMock } from '../../../__helpers__/setup'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import {
  applyKitchenPreparation,
  laCocinaPuedeLiberar,
  preparationCapabilities,
  recallPreparationTicket,
} from '@/services/kds/kitchenPreparation.service'
import {
  cocinaTermino,
  initialPreparation,
  preparationTicketStatus,
  recalculoDeComanda,
  regresarListoAPreparando,
  type PreparationCounts,
} from '@/services/kds/kitchenPreparation'
import { listKdsOrders, countKdsOrders, listRecentKdsOrders, recallKdsOrder } from '@/services/mobile/kds.mobile.service'
import { liberacionDesdeLaCocina, permisosParaReproducir, requiredPermissionsForIntent } from '@/services/mobile/sync.mobile.service'
import { archivarComandas, comandasPorArchivar } from '@/services/kds/kdsArchive.service'

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
  venuesWithFeatureAccess: jest.fn(),
  organizationHasFeatureAccess: jest.fn(),
}))

const c = (over: Partial<PreparationCounts>): PreparationCounts => ({
  HELD: 0,
  PENDING: 0,
  PREPARING: 0,
  READY: 0,
  DELIVERED: 0,
  CANCELLED: 0,
  ...over,
})

describe('D17 · reglas puras', () => {
  it('la cocina terminó sólo cuando no queda nada retenido, pendiente ni preparando', () => {
    expect(cocinaTermino([c({ READY: 2 }), c({ DELIVERED: 1 })])).toBe(true)
    expect(cocinaTermino([c({ READY: 1 }), c({ HELD: 1 })])).toBe(false) // el Segundo tiempo retenido la deja en la pantalla
    expect(cocinaTermino([c({ READY: 1, PENDING: 1 })])).toBe(false)
    expect(cocinaTermino([c({ PREPARING: 1 })])).toBe(false)
    expect(cocinaTermino([])).toBe(false)
  })

  it('el estado NO cambia de significado: READY sigue siendo «falta entregar» (de eso vive «En servicio» de la caja)', () => {
    expect(preparationTicketStatus([c({ READY: 1 })])).toBe('READY')
    expect(preparationTicketStatus([c({ DELIVERED: 1 })])).toBe('COMPLETED')
    expect(preparationTicketStatus([c({ READY: 1, HELD: 1 })])).toBe('NEW')
  })

  it('kitchenDoneAt guarda la PRIMERA vez que la cocina terminó y se borra si vuelve a tener trabajo', () => {
    const t0 = new Date('2026-11-20T20:00:00Z')
    const t1 = new Date('2026-11-20T20:05:00Z')
    expect(recalculoDeComanda([c({ READY: 1 })], { kitchenDoneAt: null }, t0)).toEqual({
      status: 'READY',
      completedAt: null,
      kitchenDoneAt: t0,
      archivedAt: null, // recién terminada: si el archivado se le adelantó, entra a «Recientes» (Codex r8 #4)
    })
    // la caja entrega después: sigue la hora de cuando la cocina terminó
    expect(recalculoDeComanda([c({ DELIVERED: 1 })], { kitchenDoneAt: t0 }, t1)).toEqual({
      status: 'COMPLETED',
      completedAt: t1,
      kitchenDoneAt: t0,
    })
    expect(recalculoDeComanda([c({ READY: 1, PENDING: 1 })], { kitchenDoneAt: t0 }, t1).kitchenDoneAt).toBeNull()
  })

  it('una archivada que la cocina termina AHORA vuelve a «Recientes» su hora (Codex r8 #4); una ya terminada no', () => {
    const t0 = new Date('2026-11-21T10:00:00Z')
    expect(recalculoDeComanda([c({ READY: 1 })], { kitchenDoneAt: null }, t0)).toMatchObject({ archivedAt: null, kitchenDoneAt: t0 })
    expect(recalculoDeComanda([c({ DELIVERED: 1 })], { kitchenDoneAt: t0 }, t0)).not.toHaveProperty('archivedAt')
  })

  it('«Deshacer» regresa lo Listo a Preparando y no toca lo entregado ni lo cancelado', () => {
    expect(regresarListoAPreparando(c({ READY: 2, DELIVERED: 1, CANCELLED: 1, PREPARING: 1 }))).toEqual(
      c({ PREPARING: 3, DELIVERED: 1, CANCELLED: 1 }),
    )
  })
})

describe('D17 · el tablero y «Recientes» (SERVIDOR)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.printStation.findMany.mockResolvedValue([])
    prismaMock.kdsOrder.findMany.mockResolvedValue([])
    prismaMock.kdsOrder.count.mockResolvedValue(0)
    prismaMock.order.findMany.mockResolvedValue([])
  })

  it('el tablero excluye lo que la cocina terminó (v1 READY) y lo archivado; el conteo usa el mismo filtro', async () => {
    await listKdsOrders('venue-a')
    await countKdsOrders('venue-a')
    const filtro = expect.objectContaining({
      venueId: 'venue-a',
      AND: expect.arrayContaining([{ archivedAt: null }, { NOT: { preparationVersion: 1, status: 'READY' } }]),
    })
    expect(prismaMock.kdsOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: filtro }))
    expect(prismaMock.kdsOrder.count).toHaveBeenCalledWith({ where: filtro })
  })

  it('cada platillo por tiempos dice en cuántas estaciones se prepara (la cocina no libera uno de varias, Codex r6 #1)', async () => {
    prismaMock.kdsOrder.findMany.mockResolvedValue([
      {
        id: 't1',
        orderId: null,
        orderNumber: 'Mesa 4',
        orderType: 'DINE_IN',
        status: 'NEW',
        preparationVersion: 1,
        createdAt: new Date(),
        items: [{ id: 'i1', productName: 'Pozole', quantity: 1, orderItemId: 'oi-1', modifiers: null }],
      },
    ])
    prismaMock.kdsOrderItem.groupBy.mockResolvedValue([{ orderItemId: 'oi-1', _count: { _all: 2 } }])
    const [comanda] = await listKdsOrders('venue-a')
    expect(comanda.items[0].stationCount).toBe(2)
    expect(prismaMock.kdsOrderItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderItemId: { in: ['oi-1'] }, kdsOrder: { venueId: 'venue-a', preparationVersion: 1 } } }),
    )
  })

  it('la página con urgencias conserva el venue y suma el filtro (las tablets nuevas)', async () => {
    await listKdsOrders('venue-a', undefined, undefined, { urgencyVersion: 1, offset: 0, limit: 100 })
    expect(prismaMock.kdsOrder.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        venueId: 'venue-a',
        AND: expect.arrayContaining([expect.objectContaining({ AND: expect.arrayContaining([{ archivedAt: null }]) })]),
      }),
    })
  })

  it('«Recientes» junta las de un solo Listo (completedAt) y las de tiempos (kitchenDoneAt), sin archivadas, la más nueva primero', async () => {
    const hace = (min: number) => new Date(Date.now() - min * 60_000)
    const vieja = {
      id: 'v0',
      orderId: null,
      preparationVersion: 0,
      status: 'COMPLETED',
      completedAt: hace(30),
      kitchenDoneAt: null,
      createdAt: hace(90),
      items: [],
    }
    const conTiempos = {
      id: 'v1',
      orderId: null,
      preparationVersion: 1,
      status: 'READY',
      completedAt: null,
      kitchenDoneAt: hace(20),
      createdAt: hace(90),
      items: [],
    }
    // Codex r8 #5 / r9 #1: lista o entregada por la versión anterior en la ventana del despliegue (sin kitchenDoneAt)
    const delDespliegue = {
      id: 'v1b',
      orderId: null,
      preparationVersion: 1,
      status: 'READY',
      completedAt: null,
      kitchenDoneAt: null,
      updatedAt: hace(10),
      createdAt: hace(90),
      items: [],
    }
    prismaMock.kdsOrder.findMany.mockResolvedValueOnce([vieja]).mockResolvedValueOnce([conTiempos]).mockResolvedValueOnce([delDespliegue])
    const recientes = await listRecentKdsOrders('venue-a', undefined, true)
    expect(recientes.map(r => r.id)).toEqual(['v1b', 'v1', 'v0'])
    // la hora que la tablet manda de regreso al «Deshacer»
    expect(recientes[1].completedAt).toBe(conTiempos.kitchenDoneAt.toISOString())
    expect(recientes[0].completedAt).toBe(delDespliegue.updatedAt.toISOString())
    const [primera, segunda, tercera] = prismaMock.kdsOrder.findMany.mock.calls
    expect(primera[0].where).toEqual(expect.objectContaining({ preparationVersion: 0 }))
    expect(primera[0].where).not.toHaveProperty('archivedAt') // Codex r4 A4: un Listo v0 justo después del archivado se deshace
    expect(segunda[0].where).toEqual(
      expect.objectContaining({ preparationVersion: 1, archivedAt: null, items: { some: {} }, kitchenDoneAt: { gte: expect.any(Date) } }),
    )
    expect(tercera[0].where).toEqual(expect.objectContaining({ preparationVersion: 1, archivedAt: null, kitchenDoneAt: null }))
    expect(tercera[0].where.OR).toEqual([
      { status: 'COMPLETED', completedAt: { gte: expect.any(Date) } },
      { status: 'READY', updatedAt: { gte: expect.any(Date) } },
    ])
    expect(primera[0].take).toBe(20)
    expect(segunda[0].take).toBe(100) // su propia lista: no le quita lugar a las de un solo Listo
    expect(tercera[0].take).toBe(100)
  })

  it('el tope de 100 se corta por la hora de terminada, no por la columna con nulos (Codex r9 #3)', async () => {
    const hace = (min: number) => new Date(Date.now() - min * 60_000)
    const conHora = Array.from({ length: 100 }, (_, i) => ({
      id: `h${String(i).padStart(3, '0')}`,
      orderId: null,
      preparationVersion: 1,
      status: 'READY',
      completedAt: null,
      kitchenDoneAt: hace(1 + i * 0.3),
      createdAt: hace(90),
      items: [],
    }))
    const sinHora = [
      {
        id: 'vieja',
        orderId: null,
        preparationVersion: 1,
        status: 'COMPLETED',
        completedAt: hace(50),
        kitchenDoneAt: null,
        createdAt: hace(90),
        items: [],
      },
    ]
    prismaMock.kdsOrder.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(conHora).mockResolvedValueOnce(sinHora)
    const recientes = await listRecentKdsOrders('venue-a', undefined, true)
    expect(recientes).toHaveLength(100)
    expect(recientes.map(r => r.id)).not.toContain('vieja') // la de hace 50 min es la que sobra, no una más nueva
  })

  it('la tablet vieja (sin kitchenDoneVersion) no recibe las de tiempos: no vería un «Deshacer» que falla', async () => {
    prismaMock.kdsOrder.findMany.mockResolvedValue([])
    await listRecentKdsOrders('venue-a')
    expect(prismaMock.kdsOrder.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.kdsOrder.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ preparationVersion: 0 }))
  })
})

describe('D17 · «Deshacer» de una comanda con tiempos', () => {
  const hecho = new Date(Date.now() - 10 * 60 * 1000)
  const fila = (id: string, prep: PreparationCounts, revision = 3) => ({
    id,
    orderItemId: `oi-${id}`,
    quantity: Object.values(prep).reduce((n: number, v) => n + (typeof v === 'number' ? v : 0), 0),
    preparation: prep,
    preparationRevision: revision,
  })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'venue-a' }])
    prismaMock.kdsOrder.findFirst
      .mockResolvedValueOnce({ orderId: 'order-a' })
      .mockResolvedValueOnce({ id: 'ticket-a', status: 'READY', kitchenDoneAt: hecho, archivedAt: null })
    prismaMock.order.findFirst.mockResolvedValue({ status: 'PENDING' })
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([
      fila('a', c({ READY: 2 })),
      fila('b', c({ DELIVERED: 1 })),
      fila('c', c({ READY: 1, CANCELLED: 1 })),
    ])
    prismaMock.kdsOrderItem.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.kdsOrder.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.activityLog.create.mockResolvedValue({ id: 'log' })
  })

  it('regresa lo Listo a Preparando con CAS por revisión, recalcula la comanda y deja KITCHEN_RECALL en la bitácora', async () => {
    await expect(recallPreparationTicket('venue-a', 'ticket-a', 'staff-k', hecho.toISOString())).resolves.toEqual({
      kdsOrderId: 'ticket-a',
      orderId: 'order-a',
      items: 2,
    })
    expect(prismaMock.kdsOrderItem.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.kdsOrderItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'a', preparationRevision: 3 }),
        data: expect.objectContaining({ preparation: c({ PREPARING: 2 }), preparationRevision: { increment: 1 } }),
      }),
    )
    expect(prismaMock.kdsOrder.updateMany).toHaveBeenCalledWith(
      // si el archivado le ganó por un instante, «Deshacer» la regresa al tablero (Codex r2 #2)
      expect.objectContaining({ data: expect.objectContaining({ status: 'PREPARING', kitchenDoneAt: null, archivedAt: null }) }),
    )
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'KITCHEN_RECALL', staffId: 'staff-k', venueId: 'venue-a' }) }),
    )
  })

  it('un «Deshacer» viejo (otra hora de terminado) no deshace un Listo nuevo', async () => {
    await expect(
      recallPreparationTicket('venue-a', 'ticket-a', 'staff-k', new Date('2026-11-20T20:00:00Z').toISOString()),
    ).rejects.toMatchObject({ code: 'KDS_RECALL_STALE', statusCode: 409 })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })

  it('una hoja de «Recientes» que se quedó abierta más de una hora ya no regresa nada (Codex r5 #6)', async () => {
    const viejo = new Date(Date.now() - 61 * 60 * 1000)
    prismaMock.kdsOrder.findFirst.mockReset()
    prismaMock.kdsOrder.findFirst
      .mockResolvedValueOnce({ orderId: 'order-a' })
      .mockResolvedValueOnce({ id: 'ticket-a', status: 'READY', kitchenDoneAt: viejo, archivedAt: null })
    await expect(recallPreparationTicket('venue-a', 'ticket-a', 'staff-k', viejo.toISOString())).rejects.toMatchObject({
      code: 'KDS_RECALL_EXPIRED',
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })

  it('la app vieja (sin la hora que vio) recibe un 409 que le dice que actualice, sin mover nada', async () => {
    await expect(recallPreparationTicket('venue-a', 'ticket-a', 'staff-k', null)).rejects.toMatchObject({
      code: 'KDS_RECALL_NEEDS_UPDATE',
      statusCode: 409,
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('sin nada Listo (todo entregado) contesta por qué y no escribe', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([fila('b', c({ DELIVERED: 1 }))])
    await expect(recallPreparationTicket('venue-a', 'ticket-a', 'staff-k', hecho.toISOString())).rejects.toMatchObject({
      code: 'KDS_RECALL_NOTHING_READY',
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('una comanda archivada o de una cuenta anulada no regresa', async () => {
    prismaMock.kdsOrder.findFirst.mockReset()
    prismaMock.kdsOrder.findFirst
      .mockResolvedValueOnce({ orderId: 'order-a' })
      .mockResolvedValueOnce({ id: 'ticket-a', status: 'READY', kitchenDoneAt: hecho, archivedAt: new Date() })
    await expect(recallPreparationTicket('venue-a', 'ticket-a', null, hecho.toISOString())).rejects.toMatchObject({ statusCode: 404 })
    prismaMock.kdsOrder.findFirst
      .mockResolvedValueOnce({ orderId: 'order-a' })
      .mockResolvedValueOnce({ id: 'ticket-a', status: 'READY', kitchenDoneAt: hecho, archivedAt: null })
    prismaMock.order.findFirst.mockResolvedValue({ status: 'CANCELLED' })
    await expect(recallPreparationTicket('venue-a', 'ticket-a', null, hecho.toISOString())).rejects.toMatchObject({
      code: 'PREPARATION_ORDER_CANCELLED',
    })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })

  it('la ruta de siempre manda las v1 a este camino (ya no las rechaza) con la hora que vio la tablet', async () => {
    prismaMock.kdsOrder.findFirst.mockReset()
    prismaMock.kdsOrder.findFirst
      .mockResolvedValueOnce({ preparationVersion: 1 })
      .mockResolvedValueOnce({ orderId: 'order-a' })
      .mockResolvedValueOnce({ id: 'ticket-a', status: 'READY', kitchenDoneAt: hecho, archivedAt: null })
    prismaMock.kdsOrder.findUniqueOrThrow.mockResolvedValue({
      id: 'ticket-a',
      orderId: null,
      orderNumber: '12',
      items: [],
      createdAt: new Date(),
    })
    prismaMock.order.findMany.mockResolvedValue([])
    await recallKdsOrder('venue-a', 'ticket-a', 'staff-k', hecho.toISOString())
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'KITCHEN_RECALL' }) }),
    )
  })
})

describe('D17 · liberar desde la cocina (permiso al reproducir)', () => {
  const release = (createdAtLocal?: number) => ({
    id: 'intent-1',
    type: 'KDS_ITEM_PROGRESS' as const,
    payload: { action: 'RELEASE', items: [] },
    ...(createdAtLocal !== undefined ? { createdAtLocal } : {}),
  })
  beforeEach(() => jest.clearAllMocks())

  const caja = () => true
  const cocina = (_i: unknown, permiso: string) => permiso === 'orders:update'

  it('«Liberar» de la caja pide lo de siempre; desde la cocina (rol o marca de la pantalla) sólo orders:update, sin leer la base', () => {
    expect(permisosParaReproducir(release(), caja)).toEqual(['orders:update', 'orders:create'])
    expect(permisosParaReproducir(release(), cocina)).toEqual(['orders:update'])
    // Codex r5 #4: un gerente que libera desde la pantalla de cocina también pasa por el interruptor
    const desdeLaCocina = { ...release(), payload: { action: 'RELEASE', items: [], origen: 'COCINA' } }
    expect(permisosParaReproducir(desdeLaCocina, caja)).toEqual(['orders:update'])
    expect(liberacionDesdeLaCocina(desdeLaCocina, caja)).toBe(true)
    expect(liberacionDesdeLaCocina(release(), caja)).toBe(false)
    // Codex r5 #7: decidirlo no lee la base (una lectura fallida dejaba la acción en revisión)
    expect(prismaMock.venueSettings.findUnique).not.toHaveBeenCalled()
  })

  it('las demás acciones piden lo de siempre', () => {
    const start = { id: 'i', type: 'KDS_ITEM_PROGRESS' as const, payload: { action: 'START', items: [] } }
    expect(permisosParaReproducir(start, cocina)).toEqual(requiredPermissionsForIntent(start))
  })

  it('el interruptor se lee para las capacidades', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ kitchenCanReleaseCourses: true })
    await expect(laCocinaPuedeLiberar('venue-a')).resolves.toBe(true)
  })

  it('la tablet sabe del interruptor y de la versión de «terminado» por sus capacidades', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ kitchenCanReleaseCourses: true })
    await expect(preparationCapabilities('venue-a')).resolves.toMatchObject({ kitchenCanRelease: true, kitchenDoneVersion: 1 })
  })

  it('apagado mientras la acción esperaba: se vuelve a medir dentro de la operación y no se aplica', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'venue-a' }]).mockResolvedValueOnce([{ kitchenCanReleaseCourses: false }])
    await expect(
      applyKitchenPreparation(
        'venue-a',
        'order-a',
        { action: 'RELEASE', items: [{ id: 'line-a', expectedRevision: 0, quantity: 1 }] },
        'staff-k',
        'intent-1',
        true,
      ),
    ).rejects.toMatchObject({ code: 'KITCHEN_RELEASE_DISABLED', statusCode: 403 })
    expect(prismaMock.kdsOrderItem.updateMany).not.toHaveBeenCalled()
  })

  it('una acción de cocina escribe kitchenDoneAt al dejar todo en Listo', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'venue-a' }])
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-a', status: 'PENDING' })
    const line = {
      id: 'line-a',
      kdsOrderId: 'ticket-a',
      orderItemId: 'item-a',
      externalLineId: 'sync:r:0',
      quantity: 1,
      preparation: c({ PREPARING: 1 }),
      preparationRevision: 2,
      kdsOrder: { id: 'ticket-a', printStationId: null, preparationVersion: 1, kitchenDoneAt: null, archivedAt: null },
    }
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([line])
    prismaMock.kdsOrderItem.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.kdsOrder.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.activityLog.create.mockResolvedValue({ id: 'log' })
    await applyKitchenPreparation(
      'venue-a',
      'order-a',
      {
        action: 'READY',
        items: [{ id: 'line-a', expectedRevision: 2, quantity: 1 }],
      },
      'staff-k',
    )
    expect(prismaMock.kdsOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'READY', kitchenDoneAt: expect.any(Date) }) }),
    )
    void initialPreparation
  })
})

describe('D17 · una comanda archivada vuelve sólo si la cocina tiene trabajo nuevo (Codex r2 #2)', () => {
  const ticket = { id: 'ticket-a', printStationId: null, preparationVersion: 1, kitchenDoneAt: new Date(), archivedAt: new Date() }
  const linea = (preparation: PreparationCounts) => ({
    id: 'line-a',
    kdsOrderId: 'ticket-a',
    orderItemId: 'item-a',
    externalLineId: 'sync:r:0',
    quantity: 2,
    preparation,
    preparationRevision: 4,
    kdsOrder: ticket,
  })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'venue-a' }])
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-a', status: 'COMPLETED' })
    prismaMock.kdsOrderItem.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.kdsOrder.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.activityLog.create.mockResolvedValue({ id: 'log' })
  })
  it('la caja corrige un platillo listo a pendiente: la comanda deja de estar archivada', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([linea(c({ READY: 2 }))])
    await applyKitchenPreparation(
      'venue-a',
      'order-a',
      { action: 'REOPEN', reason: 'faltó salsa', items: [{ id: 'line-a', expectedRevision: 4, quantity: 1, from: 'READY' }] },
      'staff-caja',
    )
    expect(prismaMock.kdsOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'NEW', archivedAt: null }) }),
    )
  })
  it('entregar o cancelar en una archivada no la regresa a la pantalla', async () => {
    prismaMock.kdsOrderItem.findMany.mockResolvedValue([linea(c({ READY: 1, HELD: 1 }))])
    await applyKitchenPreparation(
      'venue-a',
      'order-a',
      { action: 'DELIVER', items: [{ id: 'line-a', expectedRevision: 4, quantity: 1 }] },
      'staff-caja',
    )
    const data = prismaMock.kdsOrder.updateMany.mock.calls[0][0].data
    expect(data).not.toHaveProperty('archivedAt')
  })
})

describe('D17 · archivado al cerrar el día', () => {
  const ahora = new Date('2026-11-21T10:30:00Z') // 04:30 en CDMX
  const db = { $queryRawUnsafe: jest.fn(), activityLog: { createMany: jest.fn() } }
  beforeEach(() => jest.clearAllMocks())

  it('lee con las condiciones de la promesa: sin archivar, cuenta cerrada, ningún platillo en una cuenta abierta, día terminado', async () => {
    db.$queryRawUnsafe.mockResolvedValue([])
    await comandasPorArchivar(db as any, ahora)
    const sql = String(db.$queryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('k."archivedAt" IS NULL')
    expect(sql).toContain(`o.status IN ('COMPLETED', 'CANCELLED', 'DELETED')`)
    expect(sql).toContain(`o2.status NOT IN ('COMPLETED', 'CANCELLED', 'DELETED')`)
    // Codex r2 #1: sin margen de horas; ventana de 45 días hacia atrás
    expect(sql).toContain(`k."createdAt" < TIMESTAMP '2026-11-21 10:30:00.000'\n`)
    expect(sql).not.toContain('days') // r3 #5: sin ventana de días
    expect(sql).toContain('GREATEST(k."createdAt", k."updatedAt")') // r3 #1 y #7: el día de su último cambio
    expect(sql).toMatch(/- INTERVAL '4 hours'\)::date/) // el corte de las 04:00 de la caja (día del negocio)
    expect(sql).toContain('ORDER BY k."createdAt", k.id')
    expect(sql).toContain('LIMIT 500')
    // archivar no toca el estado: nada en el SQL escribe status
    expect(sql).not.toMatch(/SET\s+status/i)
  })

  it('el lote es acotado', async () => {
    await expect(comandasPorArchivar(db as any, ahora, 501)).rejects.toThrow(/lote inválido/)
  })

  it('archiva sólo con archivedAt (ni status ni completedAt) y deja UN renglón de bitácora por negocio', async () => {
    db.$queryRawUnsafe.mockResolvedValue([
      { id: 'k1', venueId: 'venue-a', orderNumber: '10', status: 'READY' },
      { id: 'k2', venueId: 'venue-a', orderNumber: '11', status: 'NEW' },
      { id: 'k3', venueId: 'venue-b', orderNumber: '7', status: 'PREPARING' },
    ])
    db.activityLog.createMany.mockResolvedValue({ count: 2 })
    const archivadas = await archivarComandas(db as any, ['k1', 'k2', 'k3'], ahora)
    expect(archivadas).toHaveLength(3)
    const sql = String(db.$queryRawUnsafe.mock.calls[0][0])
    expect(sql).toMatch(/SET "archivedAt" = TIMESTAMP '2026-11-21 10:30:00.000'/)
    const set = sql.slice(sql.indexOf('SET'), sql.indexOf('FROM'))
    expect(set).not.toMatch(/status|completedAt|updatedAt/) // sólo archivedAt: ni estado ni la hora que leen otros
    expect(sql).toContain('k."archivedAt" IS NULL') // repetirlo no hace nada
    const log = db.activityLog.createMany.mock.calls[0][0].data
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ venueId: 'venue-a', action: 'KDS_ORDERS_ARCHIVED', data: { total: 2 } })
  })

  it('sin candidatas no escribe nada', async () => {
    await expect(archivarComandas(db as any, [], ahora)).resolves.toEqual([])
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled()
    expect(db.activityLog.createMany).not.toHaveBeenCalled()
  })
})
