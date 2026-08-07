import { createReservation } from '@/services/dashboard/reservation.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { Prisma } from '@prisma/client'

jest.mock('@/services/reservation/resolveModifierSelections', () => ({
  resolveModifierSelections: jest.fn(),
}))
import { resolveModifierSelections } from '@/services/reservation/resolveModifierSelections'

/**
 * Regresión del bloque corto en Google Calendar (Amaena, 2026-08-05).
 *
 * La reserva de Diana Aguilar decía "Duración: 2 h 5 min" en la descripción y
 * el evento ocupaba 12:45–13:20 (35 min) en el calendario. Dos servicios:
 * "Manicure + Pedicure Spa + Gel" (90 min) + "Retiro de Geles Duros" (35 min).
 * El widget suma las duraciones en el navegador y mandó la ventana de UN solo
 * servicio; el servidor guardaba su propia `duration` (correcta) junto al
 * `endsAt` del cliente (corto). Resultado: el calendario apartaba 35 min para
 * una cita de 2 h 5 min y la disponibilidad ofrecía encima al siguiente cliente
 * — la misma familia de bug que RES-PY45XU (2026-07-20).
 */
describe('createReservation — la ventana de la cita la manda el catálogo', () => {
  const venueId = 'cven0000000000000000000001'
  const manicureId = 'cprod00000000000000000001' // Manicure + Pedicure Spa + Gel — 90 min
  const retiroId = 'cprod00000000000000000002' // Retiro de Geles Duros — 35 min

  const startsAt = new Date('2026-08-06T18:45:00Z') // 12:45 CDMX

  const service = (id: string, duration: number | null, durationMinutes: number | null = null) => ({
    id,
    name: `Servicio ${id}`,
    price: new Prisma.Decimal('575'),
    type: 'APPOINTMENTS_SERVICE',
    duration,
    durationMinutes,
    active: true,
    venueId,
    eventCapacity: null,
  })

  const createdReservation = {
    id: 'cres000000000000000000001',
    venueId,
    productId: manicureId,
    productIds: [manicureId, retiroId],
    confirmationCode: 'RES-XXXX',
    cancelSecret: 'secret-uuid',
    status: 'CONFIRMED',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 125 * 60_000),
    channel: 'ONLINE',
    duration: 125,
    customerId: null,
    guestName: 'Diana Alejandra Aguilar Argueta',
    guestPhone: '5531498795',
    guestEmail: null,
    partySize: 1,
    tableId: null,
    assignedStaffId: null,
    tags: [],
    statusLog: [],
    createdAt: startsAt,
    updatedAt: startsAt,
    customer: null,
    table: null,
    product: { id: manicureId, name: 'Manicure + Pedicure Spa + Gel', price: new Prisma.Decimal('575') },
    assignedStaff: null,
    createdBy: null,
  }

  /** Lo que realmente quedó guardado en la fila. */
  const persisted = () => (prismaMock.reservation.create as jest.Mock).mock.calls[0][0].data

  const book = (overrides: Record<string, unknown>) =>
    createReservation(
      venueId,
      {
        startsAt,
        guestName: 'Diana Alejandra Aguilar Argueta',
        guestPhone: '5531498795',
        partySize: 1,
        ...overrides,
      } as any,
      { writeOrigin: 'PUBLIC' },
    )

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-01T00:00:00.000Z').getTime())
    prismaMock.$transaction.mockImplementation(async (fn: any) => (typeof fn === 'function' ? fn(prismaMock) : fn))
    ;(prismaMock as any).$executeRaw = jest.fn().mockResolvedValue(0)
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.reservationSettings.findUnique.mockResolvedValue(null) // defaults: defaultDurationMin 60
    prismaMock.product.findFirst.mockResolvedValue(service(manicureId, 90) as any)
    prismaMock.product.findMany.mockResolvedValue([service(manicureId, 90), service(retiroId, 35)] as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.table.findFirst.mockResolvedValue(null)
    prismaMock.reservation.findUnique.mockResolvedValue(null)
    prismaMock.reservation.count.mockResolvedValue(0)
    prismaMock.slotHold.findMany.mockResolvedValue([] as any)
    prismaMock.reservation.create.mockResolvedValue(createdReservation as any)
    prismaMock.reservation.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [],
      totalDelta: new Prisma.Decimal('0'),
      totalDurationDelta: 0,
    })
  })

  // ── EL BUG ────────────────────────────────────────────────────────────────
  it('estira el bloque a los 125 min guardados aunque el cliente mandara una ventana de 35', async () => {
    // La forma exacta que llegaba del widget: el controller público ya había
    // corregido `duration` sumando el catálogo (90 + 35), pero `endsAt` seguía
    // siendo el del único servicio que el navegador supo sumar.
    await book({
      endsAt: new Date(startsAt.getTime() + 35 * 60_000),
      duration: 125,
      productId: manicureId,
      productIds: [manicureId, retiroId],
    })

    const row = persisted()
    expect(row.duration).toBe(125)
    expect(row.endsAt).toEqual(new Date(startsAt.getTime() + 125 * 60_000)) // 12:45 → 14:50, NO 13:20
  })

  it('nunca guarda un bloque más corto que la `duration` de la cita', async () => {
    await book({
      endsAt: new Date(startsAt.getTime() + 35 * 60_000),
      duration: 125,
      productId: manicureId,
      productIds: [manicureId, retiroId],
    })

    const row = persisted()
    const intervaloMin = (row.endsAt.getTime() - row.startsAt.getTime()) / 60_000
    expect(intervaloMin).toBeGreaterThanOrEqual(row.duration)
  })

  it('suma la duración de los modificadores encima de la duración guardada', async () => {
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [],
      totalDelta: new Prisma.Decimal('150'),
      totalDurationDelta: 15,
    })

    await book({
      endsAt: new Date(startsAt.getTime() + 35 * 60_000),
      duration: 125,
      productId: manicureId,
      productIds: [manicureId, retiroId],
    })

    const row = persisted()
    expect(row.duration).toBe(140) // 90 + 35 + 15
    expect(row.endsAt).toEqual(new Date(startsAt.getTime() + 140 * 60_000))
  })

  // ── REGRESIÓN: lo que ya funcionaba no se toca ────────────────────────────
  it('deja intacta una reserva cuya ventana ya coincide con el catálogo', async () => {
    prismaMock.product.findMany.mockResolvedValue([service(manicureId, 90)] as any)

    await book({
      endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      duration: 90,
      productId: manicureId,
      productIds: [manicureId],
    })

    const row = persisted()
    expect(row.duration).toBe(90)
    expect(row.endsAt).toEqual(new Date(startsAt.getTime() + 90 * 60_000))
  })

  it('respeta una ventana MÁS LARGA pedida a propósito — sólo alarga, nunca acorta', async () => {
    prismaMock.product.findMany.mockResolvedValue([service(manicureId, 90)] as any)

    // Recepción aparta 2 h para un servicio de 90 min (cliente lenta, limpieza…).
    await book({
      endsAt: new Date(startsAt.getTime() + 120 * 60_000),
      duration: 120,
      productId: manicureId,
      productIds: [manicureId],
    })

    const row = persisted()
    expect(row.duration).toBe(120)
    expect(row.endsAt).toEqual(new Date(startsAt.getTime() + 120 * 60_000))
  })

  it('conserva un intervalo crudo MÁS LARGO que la duración declarada', async () => {
    prismaMock.product.findMany.mockResolvedValue([service(manicureId, 60)] as any)

    // Recepción aparta 75 min de calendario para un servicio de 60: el bloque
    // largo se respeta y `duration` sigue siendo la del servicio.
    await book({
      endsAt: new Date(startsAt.getTime() + 75 * 60_000),
      duration: 60,
      productId: manicureId,
      productIds: [manicureId],
    })

    const row = persisted()
    expect(row.duration).toBe(60)
    expect(row.endsAt).toEqual(new Date(startsAt.getTime() + 75 * 60_000))
  })

  it('no toca las reservas que no son de cita (mesa/evento)', async () => {
    const table = { id: 'ctab00000000000000000001', venueId, capacity: 4, active: true }
    prismaMock.table.findFirst.mockResolvedValue(table as any)
    prismaMock.product.findFirst.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([] as any)

    await book({
      endsAt: new Date(startsAt.getTime() + 120 * 60_000),
      duration: 120,
      tableId: table.id,
      partySize: 4,
    })

    const row = persisted()
    expect(row.duration).toBe(120)
    expect(row.endsAt).toEqual(new Date(startsAt.getTime() + 120 * 60_000))
  })
})
