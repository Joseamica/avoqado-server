import { prismaMock } from '@tests/__helpers__/setup'
import { crearPuesto, editarPuesto, archivarPuesto, listarPuestos, puestosSugeridos } from '@/services/dashboard/rh/puestos.service'
import { moduleService } from '@/services/modules/module.service'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'

jest.mock('@/services/activityAudit.service', () => ({ writeLegacyActivityAuditTx: jest.fn() }))

describe('puestos (spec RH §3.1)', () => {
  beforeEach(() => {
    jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(false)
  })
  describe('feature', () => {
    it('crea un puesto sin montos y no toca roles', async () => {
      prismaMock.staffPosition.create.mockResolvedValue({
        id: 'p1',
        name: 'Coach',
        suggestedRole: 'WAITER',
        componentKinds: ['HOURLY'],
        archivedAt: null,
      } as any)
      const p = await crearPuesto({
        venueId: 'v1',
        actorId: 'a1',
        name: '  Coach ',
        suggestedRole: 'WAITER' as any,
        componentKinds: ['HOURLY'] as any,
      })
      expect(prismaMock.staffPosition.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Coach', venueId: 'v1' }) }),
      )
      expect(prismaMock.staffVenue.update).not.toHaveBeenCalled()
      expect(p.id).toBe('p1')
    })
    it('lista con tope 100 aunque pidan más', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
      prismaMock.staffPosition.count.mockResolvedValue(0)
      prismaMock.staffPosition.findMany.mockResolvedValue([])
      await listarPuestos('v1', { limit: 100000 })
      expect(prismaMock.staffPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      )
    })
    it('sugiere puestos según el giro, sin crearlos', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ type: 'SALON' } as any)
      prismaMock.staffPosition.findMany.mockResolvedValue([])
      const s = await puestosSugeridos('v1')
      expect(s.length).toBeGreaterThan(0)
      expect(prismaMock.staffPosition.create).not.toHaveBeenCalled()
    })
  })
  describe('regresión', () => {
    it('nombre repetido entre activos ⇒ 409 en español', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue({ id: 'otro' } as any)
      await expect(crearPuesto({ venueId: 'v1', actorId: 'a1', name: 'Coach', suggestedRole: 'WAITER' as any })).rejects.toThrow(
        'Ya existe un puesto llamado «Coach»',
      )
    })
    it('marca blanca ⇒ 403', async () => {
      ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(true)
      await expect(crearPuesto({ venueId: 'v1', actorId: 'a1', name: 'X', suggestedRole: 'WAITER' as any })).rejects.toThrow(
        'no está disponible en esta sucursal',
      )
    })
    it('archivar no borra', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue({ id: 'p1', venueId: 'v1', archivedAt: null } as any)
      prismaMock.staffPosition.update.mockResolvedValue({ id: 'p1', archivedAt: new Date() } as any)
      await archivarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1' })
      expect(prismaMock.staffPosition.delete).not.toHaveBeenCalled()
    })
    it('archivar un puesto ya archivado es idempotente: ni actualiza ni duplica la auditoría', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue({ id: 'p1', venueId: 'v1', archivedAt: new Date('2026-10-01') } as any)
      const p = await archivarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1' })
      expect(p.archivedAt).not.toBeNull()
      expect(prismaMock.staffPosition.update).not.toHaveBeenCalled()
      expect(writeLegacyActivityAuditTx).not.toHaveBeenCalled()
    })
    it('editar audita sólo los campos que cambió, sin ids de contexto', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValueOnce({ id: 'p1', venueId: 'v1', archivedAt: null } as any)
      prismaMock.staffPosition.update.mockResolvedValue({ id: 'p1', name: 'Coach', suggestedRole: 'WAITER', archivedAt: null } as any)
      await editarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1', color: '#fff' })
      expect(writeLegacyActivityAuditTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'STAFF_POSITION_UPDATED', data: { cambios: ['color'] } }),
      )
    })
  })
})
