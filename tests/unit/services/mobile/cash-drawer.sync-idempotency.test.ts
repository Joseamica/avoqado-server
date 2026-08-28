import { syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const VENUE = 'venue-1'

/**
 * 🔴 Un reintento del push NO puede inventar efectivo.
 *
 * Las apps mandan los eventos del cajón en lote a `/sync`, fire-and-forget y sin cola de
 * reintento: si la respuesta se pierde, el MISMO lote se vuelve a enviar. `syncEvents` hacía
 * un `create` ciego por evento, así que ese reintento creaba las filas otra vez y el cajón
 * quedaba con dinero que nunca existió — y el arqueo lo daba por bueno.
 *
 * La llave ya existía del lado del cliente: Android guarda cada evento en Room con un UUID
 * estable como llave primaria (`CashDrawerEventEntity.id`), sólo no se mandaba. Ahora viaja
 * como `localId` y el server deduplica contra `@@unique([venueId, localId])`.
 *
 * ADITIVO: una app vieja que no manda `localId` sigue funcionando igual que antes (Postgres
 * permite varios NULL en un índice único) — simplemente no gana la protección.
 *
 * NOTA (2026-08-16): los ejemplos de este archivo usaban `CASH_SALE` como tipo por defecto.
 * Ya no sirve como muestra: desde que el servidor crea el movimiento de la venta al cobrar
 * (`services/shared/cashDrawerPosting.ts`), `syncEvents` DESCARTA los `CASH_SALE` del cliente
 * para no contar la misma venta dos veces (ver `cash-drawer.arqueo.test.ts`). El sujeto de
 * estas pruebas —la idempotencia del lote por `localId`— no cambió: sólo el tipo de evento,
 * ahora PAY_IN/PAY_OUT, que siguen siendo del cliente.
 */
describe('syncEvents — idempotencia del cajón', () => {
  const sesion = { id: 'session-1', venueId: VENUE, status: 'OPEN' }

  const evento = (localId: string | undefined, amount: number, type: 'PAY_IN' | 'PAY_OUT' = 'PAY_IN') => ({
    localId,
    type,
    amount,
    staffId: 'staff-1',
    staffName: 'Cajero',
  })

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(sesion),
    }
    ;(prismaMock as any).cashDrawerEvent = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async (args: any) => ({
        id: 'evt-db-1',
        ...args.data,
        createdAt: args.data.createdAt ?? new Date(),
      })),
    }
  })

  it('manda el localId del cliente al insertar, para que el reintento choque', async () => {
    await syncEvents(VENUE, [evento('evt-local-1', 50)] as any)

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data[0]).toMatchObject({ localId: 'evt-local-1', venueId: VENUE, sessionId: 'session-1' })
  })

  it('🔴 pide a Postgres saltar duplicados: un reintento del mismo lote NO inventa efectivo', async () => {
    await syncEvents(VENUE, [evento('evt-local-1', 50)] as any)

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.skipDuplicates).toBe(true)
  })

  it('reporta cuántos entraron DE VERDAD, no cuántos se mandaron', async () => {
    // El lote trae 2 eventos pero uno ya existía: sólo se insertó 1.
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 1 })

    const res = await syncEvents(VENUE, [evento('evt-1', 50), evento('evt-2', 30)] as any)

    expect(res.syncedCount).toBe(1)
  })

  it('una app vieja sin localId sigue sincronizando (aditivo, no rompe)', async () => {
    const res = await syncEvents(VENUE, [evento(undefined, 50)] as any)

    // Sin llave no hay dedupe posible: el evento se inserta con `create`
    // individual (el comportamiento que esas apps siempre tuvieron).
    expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    const createArgs = (prismaMock as any).cashDrawerEvent.create.mock.calls[0][0]
    expect(createArgs.data.localId).toBeNull()
    expect(createArgs.data.amount).toBeDefined()
    expect(res.syncedCount).toBe(1)
  })

  // 🔴 Contrato /mobile (auditoría 2026-08-13): la respuesta DEBE traer los
  // eventos creados también para apps sin localId. Reconstruirla releyendo solo
  // por localId devolvía `events: []` a las apps viejas — su outbox nunca se
  // marcaba como sincronizado y re-mandaban el lote entero en cada sync, que
  // sin llave el índice único NO puede deduplicar: efectivo inventado causado
  // por el propio cambio de forma de la respuesta.
  it('🔴 la respuesta incluye los eventos de apps viejas (sin localId), no events:[]', async () => {
    const res = await syncEvents(VENUE, [evento(undefined, 50)] as any)

    expect(res.events).toHaveLength(1)
    expect(res.events[0]).toMatchObject({ id: 'evt-db-1', type: 'PAY_IN', amount: 50 })
  })

  it('🔴 TODO el lote va en UNA transacción (un fallo a media lista no deja filas commiteadas)', async () => {
    // Sin la tx envolvente, un create sin llave que falla a la mitad dejaba los
    // anteriores commiteados aunque el request regresara error — y el reintento
    // del cliente los reinsertaba (sin llave no hay dedupe): efectivo inventado.
    await syncEvents(VENUE, [evento('evt-1', 30), evento(undefined, 50)] as any)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('lote MIXTO: los con llave van por createMany y los sin llave se devuelven igual', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 1 })
    ;(prismaMock as any).cashDrawerEvent.findMany.mockResolvedValue([
      {
        id: 'evt-db-keyed',
        sessionId: 'session-1',
        type: 'PAY_IN',
        amount: 30,
        note: null,
        staffId: 'staff-1',
        staffName: 'Cajero',
        orderId: null,
        localId: 'evt-1',
        createdAt: new Date('2026-08-13T10:00:00.000Z'),
      },
    ])

    const res = await syncEvents(VENUE, [evento('evt-1', 30), evento(undefined, 50)] as any)

    // 1 insert del createMany (con llave) + 1 create individual (sin llave).
    expect(res.syncedCount).toBe(2)
    expect(res.events).toHaveLength(2)
    const ids = res.events.map((e: any) => e.id)
    expect(ids).toContain('evt-db-keyed')
    expect(ids).toContain('evt-db-1')
  })

  it('inserta todos los eventos distintos de un mismo lote', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 2 })

    await syncEvents(VENUE, [evento('evt-1', 50), evento('evt-2', 30, 'PAY_OUT')] as any)

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data).toHaveLength(2)
    expect(args.data.map((e: any) => e.localId)).toEqual(['evt-1', 'evt-2'])
  })
})
