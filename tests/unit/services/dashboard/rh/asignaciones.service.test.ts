import { prismaMock } from '@tests/__helpers__/setup'
import {
  asignarPuesto,
  asignacionesVigentes,
  cambiarAsignacion,
  historialDePersona,
  terminarAsignacion,
} from '@/services/dashboard/rh/asignaciones.service'
import * as marca from '@/services/dashboard/rh/marcaBlanca'

jest.mock('@/services/activityAudit.service', () => ({ writeLegacyActivityAuditTx: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/periodosGuardados', () => ({ assertFechaNoCerrada: jest.fn().mockResolvedValue(undefined) }))
import { assertFechaNoCerrada } from '@/services/dashboard/staffPay/periodosGuardados'
jest.mock('@/services/dashboard/rh/vigencias', () => ({
  ...jest.requireActual('@/services/dashboard/rh/vigencias'),
  hoyDeLaSede: jest.fn(() => '2026-10-09'),
}))
import { hoyDeLaSede } from '@/services/dashboard/rh/vigencias'

const base = () => {
  jest.spyOn(marca, 'asegurarSedeNoMarcaBlanca').mockResolvedValue()
  prismaMock.$queryRaw.mockResolvedValue([] as any)
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v1', timezone: 'America/Mexico_City', organizationId: 'o1' } as any)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ active: true } as any)
  prismaMock.staffPosition.findFirst.mockResolvedValue({
    id: 'p1',
    venueId: 'v1',
    archivedAt: null,
    name: 'Coach',
    tracksAttendanceDefault: false,
  } as any)
  prismaMock.staffAssignment.findFirst.mockResolvedValue(null)
}

const fila = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  staffId: 's1',
  positionId: 'p1',
  relation: null,
  effectiveFrom: new Date('2026-10-09T00:00:00Z'),
  effectiveTo: null,
  tracksAttendance: false,
  supersedesId: null,
  position: { name: 'Coach' },
  ...over,
})

describe('asignaciones (spec RH §3.2)', () => {
  beforeEach(base)
  describe('feature', () => {
    it('asigna con relación «Sin definir» (null) y no cambia el rol', async () => {
      prismaMock.staffAssignment.create.mockResolvedValue(fila() as any)
      const a = await asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })
      expect(a.relation).toBeNull()
      expect(a.effectiveFrom).toBe('2026-10-09')
      expect(prismaMock.staffVenue.update).not.toHaveBeenCalled()
    })
    it('toma el candado de la persona antes de leer nada', async () => {
      prismaMock.staffAssignment.create.mockResolvedValue(fila() as any)
      await asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })
      const candado = prismaMock.$queryRaw.mock.invocationCallOrder[0]
      expect(candado).toBeLessThan(prismaMock.venue.findUnique.mock.invocationCallOrder[0])
      expect(candado).toBeLessThan(prismaMock.staffAssignment.findFirst.mock.invocationCallOrder[0])
      expect(JSON.stringify(prismaMock.$queryRaw.mock.calls[0][0])).toContain('avoqado:rh-asignacion:v1:v1:s1')
    })
    it('«hoy» es el día de la sede (America/Tijuana), no el del servidor', async () => {
      prismaMock.venue.findUnique.mockResolvedValue({ id: 'v1', timezone: 'America/Tijuana', organizationId: 'o1' } as any)
      prismaMock.staffAssignment.create.mockResolvedValue(fila() as any)
      await asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })
      expect(hoyDeLaSede).toHaveBeenCalledWith('America/Tijuana')
      expect(prismaMock.staffAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ effectiveFrom: new Date('2026-10-09T00:00:00.000Z') }) }),
      )
    })
    it('cambiar relación cierra la versión el día anterior y abre otra con supersedesId', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValue({
        id: 'a1',
        staffId: 's1',
        venueId: 'v1',
        positionId: 'p1',
        relation: null,
        effectiveFrom: new Date('2026-10-01T00:00:00Z'),
        effectiveTo: null,
        tracksAttendance: true,
      } as any)
      prismaMock.staffAssignment.update.mockResolvedValue({} as any)
      prismaMock.staffAssignment.create.mockResolvedValue(
        fila({ id: 'a2', relation: 'EMPLEADO_NOMINA', tracksAttendance: true, supersedesId: 'a1' }) as any,
      )
      await cambiarAsignacion({ venueId: 'v1', assignmentId: 'a1', relation: 'EMPLEADO_NOMINA' as any, actorId: 'x' })
      expect(prismaMock.staffAssignment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { effectiveTo: new Date('2026-10-08T00:00:00.000Z') } }),
      )
      expect(prismaMock.staffAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ supersedesId: 'a1', relation: 'EMPLEADO_NOMINA' }) }),
      )
    })
    it('dos cambios el mismo día: el segundo reemplaza la versión abierta ese día', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValue({
        id: 'a2',
        staffId: 's1',
        venueId: 'v1',
        positionId: 'p1',
        relation: 'EMPLEADO_NOMINA',
        effectiveFrom: new Date('2026-10-09T00:00:00Z'),
        effectiveTo: null,
        tracksAttendance: true,
        supersedesId: 'a1',
      } as any)
      prismaMock.staffAssignment.update.mockResolvedValue(
        fila({ id: 'a2', relation: 'ASIMILADO', tracksAttendance: true, supersedesId: 'a1' }) as any,
      )
      await cambiarAsignacion({ venueId: 'v1', assignmentId: 'a2', relation: 'ASIMILADO' as any, actorId: 'x' })
      expect(prismaMock.staffAssignment.create).not.toHaveBeenCalled()
    })
    it('historial: el servidor impone el tope de 100 y dice si hay más', async () => {
      prismaMock.staffAssignment.count.mockResolvedValue(150)
      prismaMock.staffAssignment.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => fila({ id: `a${i}` })) as any)
      const r = await historialDePersona('v1', 's1', { limit: 100000 })
      expect(prismaMock.staffAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'v1', staffId: 's1' },
          take: 100,
          orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
        }),
      )
      expect(r).toMatchObject({ total: 150, hasMore: true })
      expect(r.data).toHaveLength(100)
    })
    it('vigentes: pagina las asignaciones sin cortar en silencio', async () => {
      prismaMock.staffAssignment.findMany
        .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => fila({ id: `a${String(i).padStart(3, '0')}` })) as any)
        .mockResolvedValueOnce([fila({ id: 'b1', staffId: 's2' })] as any)
      const m = await asignacionesVigentes('v1', ['s1', 's2'], '2026-10-09')
      expect(prismaMock.staffAssignment.findMany).toHaveBeenCalledTimes(2)
      expect(prismaMock.staffAssignment.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: 'a499' }, skip: 1 })
      expect(m.get('s1')).toHaveLength(500)
      expect(m.get('s2')).toHaveLength(1)
    })
  })
  describe('regresión', () => {
    it('traslape del mismo puesto ⇒ 409', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce({ id: 'a0' } as any)
      await expect(asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })).rejects.toMatchObject({
        statusCode: 409,
        message: 'Ya tiene ese puesto en esas fechas.',
      })
      expect(prismaMock.staffAssignment.create).not.toHaveBeenCalled()
    })
    it('persona inactiva ⇒ 400', async () => {
      prismaMock.staffVenue.findUnique.mockResolvedValue({ active: false } as any)
      await expect(asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('no está activa en este negocio'),
      })
    })
    it('puesto archivado ⇒ 400', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue({ id: 'p1', venueId: 'v1', name: 'Coach', archivedAt: new Date() } as any)
      await expect(asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('archivado'),
      })
    })
    it('puesto de otra sede ⇒ 404', async () => {
      prismaMock.staffPosition.findFirst.mockResolvedValue(null)
      await expect(asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'pX', actorId: 'x' })).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('Ese puesto no existe en esta sucursal'),
      })
      expect(prismaMock.staffPosition.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pX', venueId: 'v1' } }))
    })
    it('fecha futura ⇒ 400', async () => {
      await expect(asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', fecha: '2026-10-10', actorId: 'x' })).rejects.toThrow(
        'No se permiten fechas futuras',
      )
    })
    it('fecha dentro de un periodo cerrado ⇒ se propaga el 400 de assertFechaNoCerrada', async () => {
      ;(assertFechaNoCerrada as jest.Mock).mockRejectedValueOnce(new Error('periodo cerrado'))
      await expect(asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', fecha: '2026-09-20', actorId: 'x' })).rejects.toThrow(
        'periodo cerrado',
      )
      expect(assertFechaNoCerrada).toHaveBeenCalledWith(expect.anything(), 'o1', '2026-09-20', expect.any(String))
    })
    it('terminar antes del inicio ⇒ 400', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValue({
        id: 'a1',
        staffId: 's1',
        venueId: 'v1',
        effectiveFrom: new Date('2026-10-09T00:00:00Z'),
        effectiveTo: null,
      } as any)
      await expect(terminarAsignacion({ venueId: 'v1', assignmentId: 'a1', fecha: '2026-10-08', actorId: 'x' })).rejects.toThrow(
        'antes de que empezara',
      )
    })
    it('asignación de otra sede ⇒ 404 sin tomar candado', async () => {
      await expect(terminarAsignacion({ venueId: 'v1', assignmentId: 'aX', actorId: 'x' })).rejects.toMatchObject({ statusCode: 404 })
      expect(prismaMock.staffAssignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'aX', venueId: 'v1' } }))
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    })
  })
})
