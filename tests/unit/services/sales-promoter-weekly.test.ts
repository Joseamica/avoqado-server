const mockQueryRaw = jest.fn()
const mockStaffVenueFindMany = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // Desde 2026-08-04 esta agregación agrupa en Postgres en vez de recorrer filas en JS
    // (incidente del event loop: la pantalla retenía el hilo ~9 s por endpoint).
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...(a as [])),
    saleVerification: { findMany: jest.fn() },
    staffVenue: { findMany: (...a: unknown[]) => mockStaffVenueFindMany(...(a as [])) },
  },
}))
jest.mock('@/services/dashboard/sale-verification.dashboard.service', () => ({ reviewSaleVerification: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: {}, MODULE_CODES: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { emit: jest.fn() } }))
jest.mock('@/communication/sockets/types', () => ({ SocketEventType: {} }))

import { getSalesByPromoterWeekly } from '../../../src/services/dashboard/sale-verification.org.dashboard.service'

beforeEach(() => jest.clearAllMocks())

it('buckets a promoter by ISO week and attributes venue + supervisor', async () => {
  // Postgres ya devuelve agrupado: la misma promotora, la misma tienda, dos semanas.
  mockQueryRaw.mockResolvedValue([
    { staff_id: 'p1', first_name: 'Ana', last_name: 'León', venue_id: 'v1', venue_name: 'BAE Uno', week: 'W18', count: BigInt(1) },
    { staff_id: 'p1', first_name: 'Ana', last_name: 'León', venue_id: 'v1', venue_name: 'BAE Uno', week: 'W19', count: BigInt(1) },
  ])
  mockStaffVenueFindMany.mockResolvedValue([{ venueId: 'v1', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Hugo', lastName: 'G' } }])

  const rows = await getSalesByPromoterWeekly('o1', { from: new Date('2026-04-01'), to: new Date('2026-06-01') } as never)

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    staffId: 'p1',
    venueId: 'v1',
    venueName: 'BAE Uno',
    supervisorId: 'sup1',
    supervisorName: 'Hugo G',
    total: 2,
  })
  expect(Object.values(rows[0].byWeek).reduce((a, b) => a + b, 0)).toBe(2)
})
