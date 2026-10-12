import { prismaMock } from '@tests/__helpers__/setup'
import {
  asignarPuesto,
  asignacionesVigentes,
  cambiarAsignacion,
  historialDePersona,
  terminarAsignacion,
} from '@/services/dashboard/rh/asignaciones.service'
import * as marca from '@/services/dashboard/rh/marcaBlanca'
import { BadRequestError } from '@/errors/AppError'

jest.mock('@/services/activityAudit.service', () => ({ writeLegacyActivityAuditTx: jest.fn() }))
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
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
    it('«hoy» es el día de la sede: a las 06:30 UTC del 10-oct, Tijuana sigue en el 9 y CDMX ya está en el 10', async () => {
      const real = jest.requireActual('@/services/dashboard/rh/vigencias').hoyDeLaSede
      ;(hoyDeLaSede as jest.Mock).mockImplementationOnce(real).mockImplementationOnce(real)
      jest.useFakeTimers({ now: new Date('2026-10-10T06:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] })
      try {
        prismaMock.staffAssignment.create.mockImplementation(async (args: any) => fila({ effectiveFrom: args.data.effectiveFrom }))
        prismaMock.venue.findUnique.mockResolvedValueOnce({ id: 'v1', timezone: 'America/Tijuana', organizationId: 'o1' } as any)
        const tijuana = await asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })
        prismaMock.venue.findUnique.mockResolvedValueOnce({ id: 'v1', timezone: 'America/Mexico_City', organizationId: 'o1' } as any)
        const cdmx = await asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', actorId: 'x' })
        expect(tijuana.effectiveFrom).toBe('2026-10-09')
        expect(cdmx.effectiveFrom).toBe('2026-10-10')
      } finally {
        jest.useRealTimers()
        prismaMock.staffAssignment.create.mockReset()
      }
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
      // Sin `accion`: mensaje genérico, sin «Ajustar monto en la clase».
      expect(assertFechaNoCerrada).toHaveBeenCalledWith(expect.anything(), 'o1', '2026-09-20')
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
    it('asignar hacia atrás busca el traslape del mismo puesto desde esa fecha', async () => {
      prismaMock.staffAssignment.create.mockResolvedValue(fila() as any)
      await asignarPuesto({ venueId: 'v1', staffId: 's1', positionId: 'p1', fecha: '2026-09-20', actorId: 'x' })
      expect(prismaMock.staffAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          venueId: 'v1',
          staffId: 's1',
          positionId: 'p1',
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date('2026-09-20T00:00:00.000Z') } }],
        },
        select: { id: true },
      })
    })
    it('cambiar de puesto el mismo día: reemplaza la fila (sin cerrar), revisa traslape sin contarse a sí misma y audita el antes', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(fila({ id: 'a2', supersedesId: 'a1' }) as any)
      prismaMock.staffPosition.findFirst.mockResolvedValue({ id: 'p2', venueId: 'v1', name: 'Recepción', archivedAt: null } as any)
      prismaMock.staffAssignment.update.mockResolvedValue(fila({ id: 'a2', positionId: 'p2', position: { name: 'Recepción' } }) as any)
      const a = await cambiarAsignacion({ venueId: 'v1', assignmentId: 'a2', positionId: 'p2', actorId: 'x' })
      expect(prismaMock.staffAssignment.findFirst).toHaveBeenCalledWith({
        where: {
          venueId: 'v1',
          staffId: 's1',
          positionId: 'p2',
          id: { not: 'a2' },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date('2026-10-09T00:00:00.000Z') } }],
        },
        select: { id: true },
      })
      expect(prismaMock.staffAssignment.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a2' }, data: { positionId: 'p2', relation: null } }),
      )
      expect(prismaMock.staffAssignment.create).not.toHaveBeenCalled()
      expect(writeLegacyActivityAuditTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'STAFF_ASSIGNMENT_UPDATED',
          data: expect.objectContaining({ antes: { positionId: 'p1', relation: null }, positionId: 'p2' }),
        }),
      )
      expect(a.positionName).toBe('Recepción')
    })
    it('cambiar de puesto otro día: cierra la anterior el día previo y abre la nueva con supersedesId, tras revisar traslape del puesto nuevo', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(
        fila({ id: 'a1', relation: 'ASIMILADO', effectiveFrom: new Date('2026-10-01T00:00:00Z') }) as any,
      )
      prismaMock.staffPosition.findFirst.mockResolvedValue({ id: 'p2', venueId: 'v1', name: 'Recepción', archivedAt: null } as any)
      prismaMock.staffAssignment.update.mockResolvedValue({} as any)
      prismaMock.staffAssignment.create.mockResolvedValue(fila({ id: 'a3', positionId: 'p2', supersedesId: 'a1' }) as any)
      await cambiarAsignacion({ venueId: 'v1', assignmentId: 'a1', positionId: 'p2', actorId: 'x' })
      expect(prismaMock.staffAssignment.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { effectiveTo: new Date('2026-10-08T00:00:00.000Z') },
      })
      expect(prismaMock.staffAssignment.findFirst).toHaveBeenLastCalledWith({
        where: {
          venueId: 'v1',
          staffId: 's1',
          positionId: 'p2',
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date('2026-10-09T00:00:00.000Z') } }],
        },
        select: { id: true },
      })
      expect(prismaMock.staffAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            positionId: 'p2',
            relation: 'ASIMILADO',
            supersedesId: 'a1',
            effectiveFrom: new Date('2026-10-09T00:00:00.000Z'),
          }),
        }),
      )
      const ultimaLectura = prismaMock.staffAssignment.findFirst.mock.invocationCallOrder.slice(-1)[0]
      expect(ultimaLectura).toBeLessThan(prismaMock.staffAssignment.create.mock.invocationCallOrder[0])
    })
    it('cambiar una asignación que ya terminó ⇒ 400', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(fila({ effectiveTo: new Date('2026-10-05T00:00:00Z') }) as any)
      await expect(
        cambiarAsignacion({ venueId: 'v1', assignmentId: 'a1', relation: 'ASIMILADO' as any, actorId: 'x' }),
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('ya terminó') })
    })
    it('cambiar con fecha anterior al inicio ⇒ 400', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(fila({ effectiveFrom: new Date('2026-10-05T00:00:00Z') }) as any)
      await expect(
        cambiarAsignacion({ venueId: 'v1', assignmentId: 'a1', relation: 'ASIMILADO' as any, fecha: '2026-10-03', actorId: 'x' }),
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('posterior al inicio') })
      expect(prismaMock.staffAssignment.update).not.toHaveBeenCalled()
    })
    it('id viejo (ya tiene una versión posterior) ⇒ 409 al cambiar y al terminar', async () => {
      const vieja = fila({ effectiveTo: new Date('2026-10-08T00:00:00Z'), supersededBy: { id: 'a2' } })
      const msg = 'Esta asignación cambió mientras la editabas. Recarga e inténtalo de nuevo.'
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(vieja as any)
      await expect(
        cambiarAsignacion({ venueId: 'v1', assignmentId: 'a1', relation: 'ASIMILADO' as any, actorId: 'x' }),
      ).rejects.toMatchObject({ statusCode: 409, message: msg })
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(vieja as any)
      await expect(terminarAsignacion({ venueId: 'v1', assignmentId: 'a1', actorId: 'x' })).rejects.toMatchObject({
        statusCode: 409,
        message: msg,
      })
    })
    it('cambiar sin cambiar nada (mismo puesto y relación) ⇒ devuelve la actual, sin versión ni auditoría', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(
        fila({ relation: 'ASIMILADO', effectiveFrom: new Date('2026-10-01T00:00:00Z') }) as any,
      )
      const a = await cambiarAsignacion({ venueId: 'v1', assignmentId: 'a1', positionId: 'p1', relation: 'ASIMILADO' as any, actorId: 'x' })
      expect(a).toMatchObject({ id: 'a1', relation: 'ASIMILADO', effectiveFrom: '2026-10-01', effectiveTo: null })
      expect(prismaMock.staffAssignment.update).not.toHaveBeenCalled()
      expect(prismaMock.staffAssignment.create).not.toHaveBeenCalled()
      expect(writeLegacyActivityAuditTx).not.toHaveBeenCalled()
    })
    it('terminar el último día de un mes cerrado se permite: el periodo se revisa en el día siguiente', async () => {
      // Septiembre cerrado; el 5-oct se termina con hasta = 30-sep.
      ;(assertFechaNoCerrada as jest.Mock).mockImplementationOnce(async (_db: unknown, _org: string, f: string) => {
        if (f >= '2026-09-01' && f <= '2026-09-30') throw new BadRequestError('El periodo del 2026-09-01 al 2026-09-30 ya está cerrado')
      })
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(fila({ effectiveFrom: new Date('2026-08-01T00:00:00Z') }) as any)
      prismaMock.staffAssignment.update.mockResolvedValue(fila({ effectiveTo: new Date('2026-09-30T00:00:00Z') }) as any)
      const a = await terminarAsignacion({ venueId: 'v1', assignmentId: 'a1', fecha: '2026-09-30', actorId: 'x' })
      expect(assertFechaNoCerrada).toHaveBeenCalledWith(expect.anything(), 'o1', '2026-10-01')
      expect(prismaMock.staffAssignment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { effectiveTo: new Date('2026-09-30T00:00:00.000Z') } }),
      )
      expect(a.effectiveTo).toBe('2026-09-30')
    })
    it('terminar cuando el día siguiente cae en un periodo cerrado (cierre fuera de orden) ⇒ 400', async () => {
      // Se cerró la 2a quincena de septiembre antes que la 1a: hasta = 15-sep ⇒ el 16 ya está cerrado.
      ;(assertFechaNoCerrada as jest.Mock).mockImplementationOnce(async (_db: unknown, _org: string, f: string) => {
        if (f >= '2026-09-16' && f <= '2026-09-30') throw new BadRequestError('El periodo del 2026-09-16 al 2026-09-30 ya está cerrado')
      })
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(fila({ effectiveFrom: new Date('2026-08-01T00:00:00Z') }) as any)
      await expect(terminarAsignacion({ venueId: 'v1', assignmentId: 'a1', fecha: '2026-09-15', actorId: 'x' })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('ya está cerrado'),
      })
      expect(assertFechaNoCerrada).toHaveBeenCalledWith(expect.anything(), 'o1', '2026-09-16')
      expect(prismaMock.staffAssignment.update).not.toHaveBeenCalled()
    })
    it('terminar en el futuro ⇒ 400 (se valida con hasta, no con el día siguiente)', async () => {
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(fila({ effectiveFrom: new Date('2026-10-01T00:00:00Z') }) as any)
      await expect(terminarAsignacion({ venueId: 'v1', assignmentId: 'a1', fecha: '2026-10-10', actorId: 'x' })).rejects.toThrow(
        'No se permiten fechas futuras',
      )
      prismaMock.staffAssignment.findFirst.mockResolvedValueOnce(fila({ effectiveFrom: new Date('2026-10-01T00:00:00Z') }) as any)
      prismaMock.staffAssignment.update.mockResolvedValue(fila({ effectiveTo: new Date('2026-10-09T00:00:00Z') }) as any)
      await expect(terminarAsignacion({ venueId: 'v1', assignmentId: 'a1', fecha: '2026-10-09', actorId: 'x' })).resolves.toMatchObject({
        effectiveTo: '2026-10-09',
      })
    })
    it('asignación de otra sede ⇒ 404 sin tomar candado', async () => {
      await expect(terminarAsignacion({ venueId: 'v1', assignmentId: 'aX', actorId: 'x' })).rejects.toMatchObject({ statusCode: 404 })
      expect(prismaMock.staffAssignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'aX', venueId: 'v1' } }))
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    })
  })
})
