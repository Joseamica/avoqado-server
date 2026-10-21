import prisma from '@/utils/prismaClient'
import { getTpvFleet } from '@/services/dashboard/terminal-fleet.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findMany: jest.fn(), count: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/terminals.superadmin.service', () => ({
  computeTerminalMigration: jest.fn(() => null),
  migrationCommandWhere: jest.fn(() => ({})),
}))

const db = prisma as unknown as { terminal: { findMany: jest.Mock; count: jest.Mock } }
beforeEach(() => {
  jest.clearAllMocks()
  db.terminal.findMany.mockResolvedValue([])
  db.terminal.count.mockResolvedValue(150)
})

it('pagina sólo TPVs con límite impuesto por servidor, búsqueda y orden estable', async () => {
  const result = await getTpvFleet({ page: 2, pageSize: 100000, search: 'PAX', statuses: ['ACTIVE'], types: ['TPV_ANDROID'] })
  const query = db.terminal.findMany.mock.calls[0][0]
  expect(query.take).toBe(100)
  expect(query.skip).toBe(100)
  expect(query.where.type).toEqual({ in: ['TPV_ANDROID'] })
  expect(query.where.status).toEqual({ in: ['ACTIVE'] })
  expect(query.where.OR).toContainEqual({ serialNumber: { contains: 'PAX', mode: 'insensitive' } })
  expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  expect(query.include.commandQueue.take).toBe(1)
  expect(result).toMatchObject({ data: [], total: 150, page: 2, pageSize: 100 })
})

it('mantiene totales independientes de las filas y no acepta tipos POS', async () => {
  const result = await getTpvFleet({ types: ['POS_ANDROID'] as never, pageSize: -1 })
  expect(db.terminal.findMany.mock.calls[0][0]).toMatchObject({ take: 1, skip: 0, where: { type: { in: [] } } })
  expect(result.stats.total).toBe(150)
  expect(db.terminal.count.mock.calls[1][0].where.type.in).toEqual(['TPV_ANDROID', 'TPV_IOS'])
})

it('la página inicial vacía conserva un total cero y permite filtrar conexión', async () => {
  db.terminal.count.mockResolvedValue(0)
  const result = await getTpvFleet({ connection: 'online' })
  expect(db.terminal.findMany.mock.calls[0][0].where.lastHeartbeat).toMatchObject({ gt: expect.any(Date), lte: expect.any(Date) })
  expect(result).toMatchObject({ total: 0, page: 1, pageSize: 25, stats: { total: 0 } })
})
