import { releaseTableIfSettled } from '@/services/tpv/table.tpv.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => {
  const client = {
    order: { findFirst: jest.fn(), findMany: jest.fn() },
    table: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn(),
  }
  return { __esModule: true, default: { ...client, $transaction: jest.fn(fn => fn(client)) } }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => ({ broadcastToVenue: jest.fn() })) },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn(),
}))

const mockedOrderExists = prisma.order.findFirst as jest.Mock
const mockedTableFindFirst = prisma.table.findFirst as jest.Mock
const mockedTableUpdate = prisma.table.update as jest.Mock

const VENUE = 'venue_1'
const TABLE = 'table_m9'
let tableFixture: { id: string; number: string; status: string; currentOrderId: string | null } | null
let liveFixture: { id: string } | null

/**
 * Mesa M9 (encontrada en hardware el 2026-08-03): `Table.status = OCCUPIED`
 * con CERO órdenes abiertas. El plano la pintaba ocupada, tocarla no hacía
 * nada (cada acción muere en `primaryCheck ?: return`) y "anular" no tenía qué
 * anular — una mesa perdida del salón, permanentemente.
 *
 * Causa: liberar la mesa tras cobrar era trabajo del CLIENTE
 * (`finishTableAfterPayment` → HTTP directo, no intent). Sin red, con la app
 * matada, o cobrando desde otro dispositivo, esa llamada se perdía y nadie más
 * regresaba el status. Ahora lo hace el server al saldarse la última cuenta.
 */
describe('releaseTableIfSettled — la mesa se libera sola al saldarse la última cuenta', () => {
  beforeEach(() => {
    ;[mockedOrderExists, mockedTableFindFirst, mockedTableUpdate].forEach(m => m.mockReset())
    mockedTableUpdate.mockResolvedValue({})
    tableFixture = { id: TABLE, number: 'M9', status: 'OCCUPIED', currentOrderId: null }
    liveFixture = null
    mockedTableFindFirst.mockImplementation(async args => (args.where.id === TABLE && args.where.venueId === VENUE ? tableFixture : null))
    mockedOrderExists.mockImplementation(async args => (args.where.tableId === TABLE && args.where.venueId === VENUE ? liveFixture : null))
    ;(prisma.table.findMany as jest.Mock).mockImplementation(async args =>
      args.where.venueId === VENUE && args.where.id.in.includes(TABLE) && tableFixture ? [tableFixture] : [],
    )
    ;(prisma.order.findMany as jest.Mock).mockImplementation(async args => {
      if (args.where.venueId !== VENUE) return []
      const rows = [
        ...(tableFixture?.currentOrderId
          ? [{ id: tableFixture.currentOrderId, tableId: TABLE, status: 'COMPLETED', paymentStatus: 'PAID', createdAt: new Date(0) }]
          : []),
        ...(liveFixture ? [{ ...liveFixture, tableId: TABLE, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date(1) }] : []),
      ]
      return rows.filter(row =>
        args.where.id?.in
          ? args.where.id.in.includes(row.id)
          : args.where.tableId.in.includes(row.tableId) && !args.where.status.notIn.includes(row.status),
      )
    })
    ;(prisma.$queryRaw as jest.Mock).mockImplementation(async (query, ...values) => {
      const sql = Array.isArray(query) ? query.join('?') : query.sql
      if (sql.includes('FROM "Venue"') && sql.includes('FOR KEY SHARE')) return [{ id: VENUE }]
      if (sql.includes('FROM "Order"') && sql.includes('FOR UPDATE')) return values[1].map((id: string) => ({ id }))
      if (sql.includes('FROM "Table"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: TABLE }]
      throw new Error(`Unexpected raw statement: ${sql}`)
    })
  })

  it('libera una mesa OCCUPIED que ya no tiene cuentas abiertas (el caso M9)', async () => {
    liveFixture = null
    tableFixture = { id: TABLE, number: 'M9', status: 'OCCUPIED', currentOrderId: 'order_viejo' }

    const released = await releaseTableIfSettled(VENUE, TABLE)

    expect(released).toBe(true)
    expect(mockedTableUpdate).toHaveBeenCalledWith({
      where: { id: TABLE },
      data: { status: 'AVAILABLE', currentOrderId: null },
    })
  })

  it('limpia el puntero currentOrderId aunque el status ya dijera AVAILABLE (deriva inversa)', async () => {
    // La otra dirección de la deriva: status correcto pero puntero colgado a
    // una orden ya cerrada. Dejarlo hace que el POS abra una cuenta muerta.
    liveFixture = null
    tableFixture = { id: TABLE, number: 'M2', status: 'AVAILABLE', currentOrderId: 'order_pagada' }

    const released = await releaseTableIfSettled(VENUE, TABLE)

    expect(released).toBe(true)
    expect(mockedTableUpdate).toHaveBeenCalled()
  })

  it('NO libera si queda otra cuenta abierta en la mesa (multi-cheque)', async () => {
    // Cobrar la cuenta A no libera la mesa si la cuenta B sigue viva. Liberarla
    // dejaría la B huérfana: nadie la cobra y el mesero sienta gente nueva.
    liveFixture = { id: 'live-sibling' }

    const released = await releaseTableIfSettled(VENUE, TABLE)

    expect(released).toBe(false)
    expect(mockedTableUpdate).not.toHaveBeenCalled()
    expect(mockedTableFindFirst).toHaveBeenCalledWith({ where: { id: TABLE, venueId: VENUE }, select: { id: true } })
  })

  it('NO pisa una mesa RESERVED sin cuentas (una reserva viva no es una fuga)', async () => {
    liveFixture = null
    tableFixture = { id: TABLE, number: 'M4', status: 'RESERVED', currentOrderId: null }

    const released = await releaseTableIfSettled(VENUE, TABLE)

    expect(released).toBe(false)
    expect(mockedTableUpdate).not.toHaveBeenCalled()
  })

  it('es idempotente: una mesa ya libre no se vuelve a escribir ni re-emite evento', async () => {
    // El cliente puede ganar la carrera con su propio clearTable. Eso está bien
    // y no debe producir un segundo TABLE_STATUS_CHANGE ni un log de auditoría.
    liveFixture = null
    tableFixture = { id: TABLE, number: 'M7', status: 'AVAILABLE', currentOrderId: null }

    const released = await releaseTableIfSettled(VENUE, TABLE)

    expect(released).toBe(false)
    expect(mockedTableUpdate).not.toHaveBeenCalled()
  })

  it('no truena si la mesa ya no existe', async () => {
    liveFixture = null
    tableFixture = null

    await expect(releaseTableIfSettled(VENUE, TABLE)).resolves.toBe(false)
    expect(mockedTableUpdate).not.toHaveBeenCalled()
  })

  it('sólo cuenta órdenes vivas — COMPLETED/CANCELLED/DELETED no retienen la mesa', async () => {
    liveFixture = null
    tableFixture = { id: TABLE, number: 'M9', status: 'OCCUPIED', currentOrderId: null }

    await releaseTableIfSettled(VENUE, TABLE)

    expect(mockedOrderExists).toHaveBeenCalledWith({
      where: { venueId: VENUE, tableId: TABLE, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
      select: { id: true },
    })
  })
})
