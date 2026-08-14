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
 */
describe('syncEvents — idempotencia del cajón', () => {
  const sesion = { id: 'session-1', venueId: VENUE, status: 'OPEN' }

  const evento = (localId: string | undefined, amount: number, type: 'CASH_SALE' | 'PAY_OUT' = 'CASH_SALE') => ({
    localId,
    type,
    amount,
    staffId: 'staff-1',
    staffName: 'Cajero',
  })

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(sesion) }
    ;(prismaMock as any).cashDrawerEvent = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
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
    await syncEvents(VENUE, [evento(undefined, 50)] as any)

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data[0].localId).toBeNull()
    expect(args.data[0].amount).toBeDefined()
  })

  it('inserta todos los eventos distintos de un mismo lote', async () => {
    ;(prismaMock as any).cashDrawerEvent.createMany.mockResolvedValue({ count: 2 })

    await syncEvents(VENUE, [evento('evt-1', 50), evento('evt-2', 30, 'PAY_OUT')] as any)

    const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
    expect(args.data).toHaveLength(2)
    expect(args.data.map((e: any) => e.localId)).toEqual(['evt-1', 'evt-2'])
  })
})
