const mockPrisma: any = {
  venue: { findUnique: jest.fn() },
  printer: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  printStation: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  printGateway: { findUnique: jest.fn(), upsert: jest.fn() },
  menuCategory: { findMany: jest.fn(), updateMany: jest.fn() },
  product: { findMany: jest.fn(), updateMany: jest.fn() },
}
mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma))

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../../../src/services/printing/printConfig.service', () => ({
  buildPrintConfig: jest.fn(),
  routingConfigFrom: jest.fn(),
}))

import * as svc from '../../../../src/services/dashboard/printStation.dashboard.service'
import { buildPrintConfig, routingConfigFrom } from '../../../../src/services/printing/printConfig.service'

const VENUE = 'venue_1'
const COCINA = 'st_cocina'
const BARRA = 'st_barra'

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.venue.findUnique.mockResolvedValue({ id: VENUE })
})

describe('printStation.dashboard.service', () => {
  // ── NEW FEATURE: printer creation ──────────────────────────────────
  describe('createPrinter', () => {
    it('rejects a non-NETWORK printer in v1 (BadRequest, Spanish)', async () => {
      await expect(svc.createPrinter(VENUE, { name: 'BT', connectionType: 'BLUETOOTH' } as any)).rejects.toThrow(/red \(NETWORK\)/)
      expect(mockPrisma.printer.create).not.toHaveBeenCalled()
    })

    it('creates a NETWORK printer with defaults (80mm, CP858)', async () => {
      mockPrisma.printer.create.mockResolvedValue({ id: 'pr_1', name: 'Cocina', connectionType: 'NETWORK', address: '192.168.1.50:9100' })
      await svc.createPrinter(VENUE, { name: 'Cocina', address: '192.168.1.50:9100' } as any, 'staff_1')
      const arg = mockPrisma.printer.create.mock.calls[0][0].data
      expect(arg).toMatchObject({ venueId: VENUE, connectionType: 'NETWORK', paperWidthMm: 80, charset: 'CP858' })
    })

    it('throws NotFound when the venue does not exist', async () => {
      mockPrisma.venue.findUnique.mockResolvedValue(null)
      await expect(svc.createPrinter(VENUE, { name: 'X' } as any)).rejects.toThrow(/Venue no encontrado/)
    })
  })

  // ── NEW FEATURE: single-default enforcement (I9) ───────────────────
  describe('createStation (I9 default enforcement)', () => {
    it('clears the previous default in the same transaction when creating a new default', async () => {
      mockPrisma.printStation.create.mockResolvedValue({ id: COCINA, name: 'Cocina', printerId: null, isDefault: true })
      await svc.createStation(VENUE, { name: 'Cocina', isDefault: true } as any, 'staff_1')
      expect(mockPrisma.$transaction).toHaveBeenCalled()
      expect(mockPrisma.printStation.updateMany).toHaveBeenCalledWith({
        where: { venueId: VENUE, isDefault: true },
        data: { isDefault: false },
      })
    })

    it('does NOT clear defaults when the new station is not default', async () => {
      mockPrisma.printStation.create.mockResolvedValue({ id: BARRA, name: 'Barra', printerId: null, isDefault: false })
      await svc.createStation(VENUE, { name: 'Barra' } as any)
      expect(mockPrisma.printStation.updateMany).not.toHaveBeenCalled()
    })

    it('validates the printer belongs to the venue', async () => {
      mockPrisma.printer.findFirst.mockResolvedValue(null) // printer not in venue
      await expect(svc.createStation(VENUE, { name: 'Cocina', printerId: 'pr_foreign' } as any)).rejects.toThrow(
        /no pertenece a este venue/,
      )
    })
  })

  // ── NEW FEATURE: routing assignment tenant safety ──────────────────
  describe('assignRouting', () => {
    it('rejects a target station that does not belong to the venue', async () => {
      mockPrisma.printStation.findMany.mockResolvedValue([]) // no matching stations in venue
      await expect(svc.assignRouting(VENUE, { categories: [{ id: 'cat_1', printStationId: 'st_foreign' }] } as any)).rejects.toThrow(
        /no pertenecen a este venue/,
      )
    })

    it('updates categories/products scoped by venueId and returns counts', async () => {
      mockPrisma.printStation.findMany.mockResolvedValue([{ id: COCINA }])
      mockPrisma.menuCategory.updateMany.mockResolvedValue({ count: 1 })
      mockPrisma.product.updateMany.mockResolvedValue({ count: 1 })
      const res = await svc.assignRouting(
        VENUE,
        { categories: [{ id: 'cat_1', printStationId: COCINA }], products: [{ id: 'p_1', printStationId: null }] } as any,
        'staff_1',
      )
      expect(res).toEqual({ categoriesUpdated: 1, productsUpdated: 1 })
      // tenant isolation: every updateMany carries venueId
      expect(mockPrisma.menuCategory.updateMany).toHaveBeenCalledWith({
        where: { id: 'cat_1', venueId: VENUE },
        data: { printStationId: COCINA },
      })
    })
  })

  // ── NEW FEATURE: preview delegates to the real engine ──────────────
  describe('previewRouting', () => {
    it('resolves products through the routing engine and labels stations (barra vs cocina)', async () => {
      ;(buildPrintConfig as jest.Mock).mockResolvedValue({
        stations: [
          { id: COCINA, name: 'Cocina' },
          { id: BARRA, name: 'Barra' },
        ],
      })
      ;(routingConfigFrom as jest.Mock).mockReturnValue({ defaultStationId: null, activeStationIds: new Set([COCINA, BARRA]) })
      mockPrisma.product.findMany.mockResolvedValue([
        { id: 'p_taco', name: 'Taco', printStationId: null, category: { printStationId: COCINA } },
        { id: 'p_cerveza', name: 'Cerveza', printStationId: BARRA, category: { printStationId: null } },
      ])

      const res = await svc.previewRouting(VENUE, {
        items: [
          { productId: 'p_taco', quantity: 2 },
          { productId: 'p_cerveza', quantity: 1 },
        ],
      })

      const cocina = res.plans.find(p => p.stationId === COCINA)!
      const barra = res.plans.find(p => p.stationId === BARRA)!
      expect(cocina.stationName).toBe('Cocina')
      expect(cocina.lines).toEqual([{ productName: 'Taco', quantity: 2 }])
      expect(barra.stationName).toBe('Barra')
      expect(barra.lines).toEqual([{ productName: 'Cerveza', quantity: 1 }])
      expect(res.unrouted).toBe(false)
    })

    it('rejects a product that does not belong to the venue', async () => {
      ;(buildPrintConfig as jest.Mock).mockResolvedValue({ stations: [] })
      ;(routingConfigFrom as jest.Mock).mockReturnValue({ defaultStationId: null, activeStationIds: new Set() })
      mockPrisma.product.findMany.mockResolvedValue([]) // product not found in venue
      await expect(svc.previewRouting(VENUE, { items: [{ productId: 'p_foreign', quantity: 1 }] })).rejects.toThrow(
        /no pertenecen a este venue/,
      )
    })
  })
})
