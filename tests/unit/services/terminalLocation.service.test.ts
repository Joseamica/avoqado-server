import { prismaMock } from '../../__helpers__/setup'
import { getSupervisorTerminalLocations, getOrgTerminalLocations } from '@/services/promoters/terminalLocation.service'

describe('terminalLocation.service', () => {
  describe('getSupervisorTerminalLocations', () => {
    beforeEach(() => {
      prismaMock.venueSettings.findUnique.mockResolvedValue({ trackPromoterLocation: true })
    })

    it('MANAGER: solo terminales cuyos pings son de sus promotores de custodia', async () => {
      // supervisor sup1 tiene SIMs PROMOTER_HELD con prom A
      prismaMock.serializedItem.findMany.mockResolvedValue([{ assignedPromoterId: 'promA' }])
      // La DB filtra por staffId: { in: ['promA'] } → solo debe devolver el ping de promA.
      // (el mock no aplica el where, así que lo simulamos devolviendo ya el resultado filtrado)
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([
        {
          terminalId: 't1',
          staffId: 'promA',
          latitude: 1,
          longitude: 2,
          accuracy: 10,
          capturedAt: new Date('2026-07-08T18:00:00Z'),
          source: 'PERIODIC',
          terminal: { serialNumber: 'AVQD-1' },
          venue: { id: 'v1', name: 'BAE 1' },
          staff: { id: 'promA', firstName: 'Ana', lastName: 'X' },
        },
      ])

      const res = await getSupervisorTerminalLocations({ venueId: 'v1', requesterStaffId: 'sup1', requesterRole: 'MANAGER' })

      expect(res.trackingEnabled).toBe(true)
      expect(res.terminals.map(r => r.terminalId)).toEqual(['t1']) // promB excluido
      expect(res.terminals[0].promoter).toEqual({ staffId: 'promA', name: 'Ana X' })
      expect(res.terminals[0].serialNumber).toBe('AVQD-1')
      expect(prismaMock.promoterLocationPing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ staffId: { in: ['promA'] } }) }),
      )
    })

    it('MANAGER con cero promotores de custodia', async () => {
      prismaMock.serializedItem.findMany.mockResolvedValue([])

      const res = await getSupervisorTerminalLocations({ venueId: 'v1', requesterStaffId: 'sup1', requesterRole: 'MANAGER' })

      expect(res).toEqual({ terminals: [], trackingEnabled: true })
      expect(prismaMock.promoterLocationPing.findMany).not.toHaveBeenCalled()
    })

    it('ADMIN: todas las terminales del venue (sin filtro de custodia)', async () => {
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([
        {
          terminalId: 't1',
          staffId: 'promA',
          latitude: 1,
          longitude: 2,
          accuracy: 10,
          capturedAt: new Date('2026-07-08T18:00:00Z'),
          source: 'PERIODIC',
          terminal: { serialNumber: 'AVQD-1' },
          venue: { id: 'v1', name: 'BAE 1' },
          staff: { id: 'promA', firstName: 'Ana', lastName: 'X' },
        },
        {
          terminalId: 't2',
          staffId: 'promB',
          latitude: 3,
          longitude: 4,
          accuracy: 10,
          capturedAt: new Date('2026-07-08T18:00:00Z'),
          source: 'PERIODIC',
          terminal: { serialNumber: 'AVQD-2' },
          venue: { id: 'v1', name: 'BAE 1' },
          staff: { id: 'promB', firstName: 'Beto', lastName: 'Y' },
        },
      ])

      const res = await getSupervisorTerminalLocations({ venueId: 'v1', requesterStaffId: 'adm1', requesterRole: 'ADMIN' })

      expect(res.terminals.map(r => r.terminalId).sort()).toEqual(['t1', 't2'])
      expect(prismaMock.serializedItem.findMany).not.toHaveBeenCalled()
    })

    it('mantiene solo el ping más reciente por terminal', async () => {
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([
        {
          terminalId: 't1',
          staffId: 'promA',
          latitude: 9,
          longitude: 9,
          accuracy: 5,
          capturedAt: new Date('2026-07-08T19:00:00Z'),
          source: 'PERIODIC',
          terminal: { serialNumber: 'AVQD-1' },
          venue: { id: 'v1', name: 'BAE 1' },
          staff: { id: 'promA', firstName: 'Ana', lastName: 'X' },
        },
        {
          terminalId: 't1',
          staffId: 'promA',
          latitude: 1,
          longitude: 1,
          accuracy: 5,
          capturedAt: new Date('2026-07-08T11:00:00Z'),
          source: 'PERIODIC',
          terminal: { serialNumber: 'AVQD-1' },
          venue: { id: 'v1', name: 'BAE 1' },
          staff: { id: 'promA', firstName: 'Ana', lastName: 'X' },
        },
      ])

      const res = await getSupervisorTerminalLocations({ venueId: 'v1', requesterStaffId: 'adm1', requesterRole: 'ADMIN' })

      expect(res.terminals).toHaveLength(1)
      expect(res.terminals[0].latest?.latitude).toBe(9) // el más reciente
    })
  })

  describe('getOrgTerminalLocations', () => {
    it('org: agrupa último ping por terminal a través de los venues de la org', async () => {
      prismaMock.venue.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
      prismaMock.promoterLocationPing.findMany.mockResolvedValue([
        {
          terminalId: 't1',
          staffId: 'promA',
          latitude: 1,
          longitude: 2,
          accuracy: 10,
          capturedAt: new Date('2026-07-08T19:00:00Z'),
          source: 'PERIODIC',
          terminal: { serialNumber: 'AVQD-1' },
          venue: { id: 'v1', name: 'BAE 1' },
          staff: { id: 'promA', firstName: 'Ana', lastName: 'X' },
        },
        {
          terminalId: 't9',
          staffId: 'promZ',
          latitude: 5,
          longitude: 6,
          accuracy: 10,
          capturedAt: new Date('2026-07-08T18:00:00Z'),
          source: 'PERIODIC',
          terminal: { serialNumber: 'AVQD-9' },
          venue: { id: 'v2', name: 'BAE 2' },
          staff: { id: 'promZ', firstName: 'Zoe', lastName: 'W' },
        },
      ])

      const res = await getOrgTerminalLocations({ orgId: 'org1' })

      expect(res.terminals.map(r => r.terminalId).sort()).toEqual(['t1', 't9'])
      const t9 = res.terminals.find(r => r.terminalId === 't9')!
      expect(t9.venue).toEqual({ id: 'v2', name: 'BAE 2' })
      expect(t9.promoter).toEqual({ staffId: 'promZ', name: 'Zoe W' })
      expect(prismaMock.venue.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org1' } }))
      expect(prismaMock.promoterLocationPing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ venueId: { in: ['v1', 'v2'] } }) }),
      )
    })

    it('org: sin venues en la organización devuelve lista vacía sin consultar pings', async () => {
      prismaMock.venue.findMany.mockResolvedValue([])

      const res = await getOrgTerminalLocations({ orgId: 'org-empty' })

      expect(res).toEqual({ terminals: [] })
      expect(prismaMock.promoterLocationPing.findMany).not.toHaveBeenCalled()
    })
  })
})
