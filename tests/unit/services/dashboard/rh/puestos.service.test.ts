import { prismaMock } from '@tests/__helpers__/setup'
import { crearPuesto, editarPuesto, archivarPuesto, listarPuestos, puestosSugeridos } from '@/services/dashboard/rh/puestos.service'
import { moduleService } from '@/services/modules/module.service'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'

jest.mock('@/services/activityAudit.service', () => ({ writeLegacyActivityAuditTx: jest.fn() }))

const conConteo = (p: Record<string, unknown>, assignments = 0) => ({ archivedAt: null, ...p, _count: { assignments } }) as any

describe('puestos (spec RH §3.1)', () => {
  beforeEach(() => {
    jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(false)
    // clearAllMocks (setup global) NO borra implementaciones ni colas de `Once`: cada prueba parte de un estado conocido.
    for (const fn of Object.values<jest.Mock>(prismaMock.staffPosition)) fn.mockReset()
    prismaMock.venue.findUnique.mockReset()
    prismaMock.staffPosition.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City', type: 'SALON' })
  })

  describe('feature', () => {
    it('crea un puesto sin montos y no toca roles', async () => {
      prismaMock.staffPosition.create.mockResolvedValue(
        conConteo({ id: 'p1', name: 'Coach', suggestedRole: 'WAITER', componentKinds: ['HOURLY'] }),
      )
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
      expect(p.personasVigentes).toBe(0)
    })
    it('lista con tope 100 aunque pidan más', async () => {
      prismaMock.staffPosition.count.mockResolvedValue(0)
      prismaMock.staffPosition.findMany.mockResolvedValue([])
      await listarPuestos('v1', { limit: 100000 })
      expect(prismaMock.staffPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      )
    })
    it('sugiere puestos según el giro, sin crearlos', async () => {
      prismaMock.staffPosition.findMany.mockResolvedValue([])
      const s = await puestosSugeridos('v1')
      expect(s.length).toBeGreaterThan(0)
      expect(prismaMock.staffPosition.create).not.toHaveBeenCalled()
    })
    it('sugeridos: sin nombres repetidos aunque dos roles compartan nombre (gana el primer rol)', async () => {
      prismaMock.staffPosition.findMany.mockResolvedValue([])
      const s = await puestosSugeridos('v1')
      const nombres = s.map(x => x.name)
      expect(new Set(nombres.map(n => n.toLowerCase())).size).toBe(nombres.length)
      // SERVICES: CASHIER y HOST se llaman «Recepcionista»; sale una sola vez, con el primer rol (CASHIER).
      expect(s.filter(x => x.name === 'Recepcionista')).toEqual([{ name: 'Recepcionista', suggestedRole: 'CASHIER' }])
    })
    it('sugeridos: consulta exacta y acotada, y descarta los que ya existen como puesto activo', async () => {
      prismaMock.staffPosition.findMany.mockResolvedValue([{ name: 'ESPECIALISTA' }])
      const s = await puestosSugeridos('v1')
      expect(s.map(x => x.name)).not.toContain('Especialista')
      expect(prismaMock.staffPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
          where: expect.objectContaining({
            venueId: 'v1',
            archivedAt: null,
            name: { in: expect.arrayContaining(['Especialista', 'Recepcionista']), mode: 'insensitive' },
          }),
        }),
      )
    })
    it('sugeridos: un giro sin nombres propios (comida) no consulta ni sugiere nada', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ type: 'RESTAURANT' })
      expect(await puestosSugeridos('v1')).toEqual([])
      expect(prismaMock.staffPosition.findMany).not.toHaveBeenCalled()
    })
    it('personasVigentes cuenta sólo personas activas en ESTA sede, con el mismo criterio al listar y al mutar', async () => {
      prismaMock.staffPosition.count.mockResolvedValue(1)
      prismaMock.staffPosition.findMany.mockResolvedValue([conConteo({ id: 'p1', name: 'Coach', suggestedRole: 'WAITER' }, 4)])
      const lista = await listarPuestos('v1', {})
      expect(lista.data[0].personasVigentes).toBe(4)
      const dondeLista = prismaMock.staffPosition.findMany.mock.calls[0][0].include._count.select.assignments.where
      // Cuenta global activa (Staff.active) Y activa en esta sede: una cuenta desactivada en Superadmin ya no cuenta.
      expect(dondeLista.staff).toEqual({ active: true, venues: { some: { venueId: 'v1', active: true } } })
      expect(dondeLista.venueId).toBe('v1')

      prismaMock.staffPosition.findFirst.mockResolvedValue(conConteo({ id: 'p1', venueId: 'v1' }, 4))
      prismaMock.staffPosition.update.mockResolvedValue(conConteo({ id: 'p1', name: 'Coach', suggestedRole: 'WAITER' }, 4))
      await editarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1', color: '#fff' })
      const dondeEditar = prismaMock.staffPosition.update.mock.calls[0][0].include._count.select.assignments.where
      expect(dondeEditar.staff).toEqual(dondeLista.staff)
      expect(dondeEditar.OR).toEqual(dondeLista.OR)
      expect(dondeEditar.effectiveFrom).toEqual(dondeLista.effectiveFrom)
    })
  })

  describe('regresión', () => {
    it('nombre repetido entre activos ⇒ 409 en español', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue({ id: 'otro' })
      await expect(crearPuesto({ venueId: 'v1', actorId: 'a1', name: 'Coach', suggestedRole: 'WAITER' as any })).rejects.toThrow(
        'Ya existe un puesto llamado «Coach»',
      )
    })
    it('con 100 puestos activos ⇒ 400 en español y no crea; cuenta sólo activos de esta sede', async () => {
      prismaMock.staffPosition.count.mockResolvedValue(100)
      await expect(crearPuesto({ venueId: 'v1', actorId: 'a1', name: 'Coach', suggestedRole: 'WAITER' as any })).rejects.toThrow(
        'Esta sucursal ya tiene 100 puestos activos. Archiva alguno antes de crear otro.',
      )
      expect(prismaMock.staffPosition.count).toHaveBeenCalledWith({ where: { venueId: 'v1', archivedAt: null } })
      expect(prismaMock.staffPosition.create).not.toHaveBeenCalled()
    })
    it('con 99 puestos activos todavía crea', async () => {
      prismaMock.staffPosition.count.mockResolvedValue(99)
      prismaMock.staffPosition.create.mockResolvedValue(conConteo({ id: 'p100', name: 'Coach', suggestedRole: 'WAITER' }))
      expect((await crearPuesto({ venueId: 'v1', actorId: 'a1', name: 'Coach', suggestedRole: 'WAITER' as any })).id).toBe('p100')
    })
    it('marca blanca ⇒ 403', async () => {
      ;(moduleService.isModuleEnabled as jest.Mock).mockResolvedValue(true)
      await expect(crearPuesto({ venueId: 'v1', actorId: 'a1', name: 'X', suggestedRole: 'WAITER' as any })).rejects.toThrow(
        'no está disponible en esta sucursal',
      )
    })
    it('archivar no borra', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue(conConteo({ id: 'p1', venueId: 'v1' }))
      prismaMock.staffPosition.update.mockResolvedValue(conConteo({ id: 'p1', archivedAt: new Date() }))
      await archivarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1' })
      expect(prismaMock.staffPosition.delete).not.toHaveBeenCalled()
    })
    it('archivar devuelve las personas vigentes reales, no 0', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue(conConteo({ id: 'p1', venueId: 'v1' }, 3))
      prismaMock.staffPosition.update.mockResolvedValue(conConteo({ id: 'p1', archivedAt: new Date() }, 3))
      const p = await archivarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1' })
      expect(p.personasVigentes).toBe(3)
      expect(p.archivedAt).not.toBeNull()
    })
    it('archivar un puesto ya archivado es idempotente: ni actualiza ni duplica la auditoría, y conserva el conteo', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue(conConteo({ id: 'p1', venueId: 'v1', archivedAt: new Date('2026-10-01') }, 2))
      const p = await archivarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1' })
      expect(p.archivedAt).not.toBeNull()
      expect(p.personasVigentes).toBe(2)
      expect(prismaMock.staffPosition.update).not.toHaveBeenCalled()
      expect(writeLegacyActivityAuditTx).not.toHaveBeenCalled()
    })
    it('editar audita sólo los campos que cambió, sin ids de contexto', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValueOnce(conConteo({ id: 'p1', venueId: 'v1' }))
      prismaMock.staffPosition.update.mockResolvedValue(conConteo({ id: 'p1', name: 'Coach', suggestedRole: 'WAITER' }))
      await editarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1', color: '#fff' })
      expect(writeLegacyActivityAuditTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'STAFF_POSITION_UPDATED', data: { cambios: ['color'] } }),
      )
    })
    it('crear con nombre en blanco ⇒ 400 y no escribe nada', async () => {
      await expect(crearPuesto({ venueId: 'v1', actorId: 'a1', name: '   ', suggestedRole: 'WAITER' as any })).rejects.toThrow(
        'El nombre del puesto no puede estar vacío.',
      )
      expect(prismaMock.staffPosition.create).not.toHaveBeenCalled()
    })
    it('editar con nombre en blanco ⇒ 400 (no lo ignora en silencio)', async () => {
      await expect(editarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1', name: '  ' })).rejects.toThrow(
        'El nombre del puesto no puede estar vacío.',
      )
      expect(prismaMock.staffPosition.update).not.toHaveBeenCalled()
    })
    it('editar sin tocar el nombre no lo valida ni lo revisa', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue(conConteo({ id: 'p1', venueId: 'v1' }))
      prismaMock.staffPosition.update.mockResolvedValue(conConteo({ id: 'p1', name: 'Coach', suggestedRole: 'WAITER' }))
      await editarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1', icon: 'star' })
      expect(prismaMock.staffPosition.findFirst).toHaveBeenCalledTimes(1) // sólo la lectura del puesto, sin chequeo de nombre
    })
    it('renombrar un puesto ARCHIVADO no choca con nombres de activos', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValueOnce(conConteo({ id: 'p1', venueId: 'v1', archivedAt: new Date('2026-10-01') }))
      prismaMock.staffPosition.update.mockResolvedValue(conConteo({ id: 'p1', name: 'Coach', suggestedRole: 'WAITER' }))
      await editarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1', name: 'Coach' })
      expect(prismaMock.staffPosition.findFirst).toHaveBeenCalledTimes(1) // sin nombreLibre
      expect(prismaMock.staffPosition.update).toHaveBeenCalled()
    })
    it('renombrar un puesto ACTIVO sí revisa el nombre entre activos (excluyéndose a sí mismo)', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValueOnce(conConteo({ id: 'p1', venueId: 'v1' })).mockResolvedValueOnce({ id: 'otro' })
      await expect(editarPuesto({ venueId: 'v1', actorId: 'a1', positionId: 'p1', name: 'Coach' })).rejects.toThrow(
        'Ya existe un puesto llamado «Coach»',
      )
      expect(prismaMock.staffPosition.findFirst.mock.calls[1][0].where.id).toEqual({ not: 'p1' })
    })
  })
})
