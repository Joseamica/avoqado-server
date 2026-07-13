const mockPrisma: any = {
  printStation: { findMany: jest.fn() },
  printer: { findMany: jest.fn(), updateMany: jest.fn() },
  printJob: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  printGateway: { findUnique: jest.fn(), update: jest.fn() },
}
const mockBs = { broadcastToVenue: jest.fn(), broadcastToRole: jest.fn(), broadcastPrinterStatus: jest.fn() }

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => mockBs } }))

import * as svc from '../../../../src/services/mobile/print.mobile.service'

const VENUE = 'venue_1'
const COCINA = 'st_cocina'
const PR1 = 'pr_1'

const job = (o: any = {}) => ({
  id: o.id ?? 'j_1',
  eventId: o.eventId ?? 'ev_1',
  reason: o.reason ?? 'ORIGINAL',
  seq: o.seq ?? 1,
  type: o.type ?? 'KITCHEN_TICKET',
  status: o.status ?? 'DONE',
  stationId: o.stationId,
  printerId: o.printerId,
  orderItemIds: o.orderItemIds,
  ...o,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.printStation.findMany.mockResolvedValue([{ id: COCINA }])
  mockPrisma.printer.findMany.mockResolvedValue([{ id: PR1 }])
  mockPrisma.printJob.findFirst.mockResolvedValue(null) // default: no existing → create path
  mockPrisma.printJob.create.mockResolvedValue({})
  mockPrisma.printJob.update.mockResolvedValue({})
})

describe('print.mobile.service', () => {
  describe('syncPrintJobs (outbox replica + tenant-scoped dedupe)', () => {
    it('resolves scoped by venueId (findFirst) and nulls foreign station/printer ids on create', async () => {
      const res = await svc.syncPrintJobs(VENUE, { jobs: [job({ stationId: COCINA, printerId: 'pr_foreign' })] } as any)
      expect(res).toMatchObject({ upserted: 1, errors: 0 })
      // dedupe resolve is ALWAYS venue-scoped → never touches another venue's job
      expect(mockPrisma.printJob.findFirst).toHaveBeenCalledWith({
        where: { venueId: VENUE, eventId: 'ev_1', reason: 'ORIGINAL', seq: 1 },
        select: { id: true, status: true },
      })
      const created = mockPrisma.printJob.create.mock.calls[0][0].data
      expect(created.venueId).toBe(VENUE)
      expect(created.stationId).toBe(COCINA) // valid → kept
      expect(created.printerId).toBeNull() // foreign → nulled
    })

    it('updates (not creates) an existing job by its own id, never by the causal key', async () => {
      mockPrisma.printJob.findFirst.mockResolvedValue({ id: 'existing_id', status: 'SENT' })
      await svc.syncPrintJobs(VENUE, { jobs: [job({ status: 'DONE' })] } as any)
      expect(mockPrisma.printJob.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'existing_id' } }))
      expect(mockPrisma.printJob.create).not.toHaveBeenCalled()
    })

    it('alerts ADMIN + MANAGER when a job newly transitions to FAILED', async () => {
      await svc.syncPrintJobs(VENUE, { jobs: [job({ status: 'FAILED', error: 'sin papel' })] } as any)
      expect(mockBs.broadcastToVenue).toHaveBeenCalled()
      const roles = mockBs.broadcastToRole.mock.calls.map((c: any[]) => c[0])
      expect(roles).toEqual(expect.arrayContaining(['ADMIN', 'MANAGER']))
    })

    it('does NOT re-alert an ALREADY-failed job on a later re-sync (no alert spam)', async () => {
      mockPrisma.printJob.findFirst.mockResolvedValue({ id: 'x', status: 'FAILED' }) // already failed
      const res = await svc.syncPrintJobs(VENUE, { jobs: [job({ status: 'FAILED' })] } as any)
      expect(res.newlyFailed).toBe(0)
      expect(mockBs.broadcastToRole).not.toHaveBeenCalled()
    })

    it('does NOT alert when all jobs succeeded', async () => {
      await svc.syncPrintJobs(VENUE, {
        jobs: [job({ status: 'DONE' }), job({ id: 'j_2', eventId: 'ev_2', status: 'OPERATOR_CONFIRMED' })],
      } as any)
      expect(mockBs.broadcastToRole).not.toHaveBeenCalled()
    })

    it('a single bad job does NOT abort the whole batch (per-job try/catch)', async () => {
      mockPrisma.printJob.create.mockRejectedValueOnce(new Error('PK collision')).mockResolvedValue({})
      const res = await svc.syncPrintJobs(VENUE, {
        jobs: [job({ id: 'bad', eventId: 'ev_bad' }), job({ id: 'good', eventId: 'ev_good' })],
      } as any)
      expect(res.errors).toBe(1)
      expect(res.upserted).toBe(1)
    })
  })

  describe('gatewayHeartbeat', () => {
    it('updates lastHeartbeat only when the reporting device is the registered gateway', async () => {
      mockPrisma.printGateway.findUnique.mockResolvedValue({ venueId: VENUE, terminalId: 'device_A' })
      const res = await svc.gatewayHeartbeat(VENUE, { terminalId: 'device_A' } as any)
      expect(res.registered).toBe(true)
      expect(mockPrisma.printGateway.update).toHaveBeenCalled()
    })

    it('does NOT update when a non-designated device reports (registered:false)', async () => {
      mockPrisma.printGateway.findUnique.mockResolvedValue({ venueId: VENUE, terminalId: 'device_A' })
      const res = await svc.gatewayHeartbeat(VENUE, { terminalId: 'device_IMPOSTOR' } as any)
      expect(res.registered).toBe(false)
      expect(mockPrisma.printGateway.update).not.toHaveBeenCalled()
    })

    it('updates printer status + broadcasts telemetry ONLY when the caller is the registered gateway', async () => {
      mockPrisma.printGateway.findUnique.mockResolvedValue({ venueId: VENUE, terminalId: 'device_A' })
      mockPrisma.printer.updateMany.mockResolvedValue({ count: 1 })
      const res = await svc.gatewayHeartbeat(VENUE, {
        terminalId: 'device_A',
        printers: [{ printerId: PR1, status: 'PAPER_OUT' }],
      } as any)
      expect(res.printersUpdated).toBe(1)
      expect(mockPrisma.printer.updateMany).toHaveBeenCalledWith({
        where: { id: PR1, venueId: VENUE },
        data: { lastStatus: 'PAPER_OUT', lastSeenAt: expect.any(Date) },
      })
      expect(mockBs.broadcastPrinterStatus).toHaveBeenCalled()
    })

    it('a non-registered device CANNOT spoof printer-status updates/alerts', async () => {
      mockPrisma.printGateway.findUnique.mockResolvedValue({ venueId: VENUE, terminalId: 'device_A' })
      const res = await svc.gatewayHeartbeat(VENUE, {
        terminalId: 'device_IMPOSTOR',
        printers: [{ printerId: PR1, status: 'ERROR' }],
      } as any)
      expect(res.printersUpdated).toBe(0)
      expect(mockPrisma.printer.updateMany).not.toHaveBeenCalled()
      expect(mockBs.broadcastPrinterStatus).not.toHaveBeenCalled()
    })
  })
})
