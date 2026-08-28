/**
 * Turnos rotativos (fase 1): plantillas + asignaciones persona×día con COPIA de las horas y
 * borrador/publicado. Lo que protege cada prueba está en su nombre.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { createTemplate, replaceAssignments, publishAssignments, updateTemplate } from '@/services/dashboard/workShift.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const ACTOR = 'owner-1'
const abre = {
  id: 'tpl-abre',
  venueId: VENUE,
  name: 'Abre',
  abbreviation: 'AB',
  color: '#7ADD2C',
  startTime: '08:00',
  endTime: '16:00',
  active: true,
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).workShiftTemplate = {
    create: jest.fn(async ({ data }: any) => ({ id: 'tpl-new', ...data })),
    findMany: jest.fn().mockResolvedValue([abre]),
    findFirst: jest.fn().mockResolvedValue(abre),
    update: jest.fn(async ({ data }: any) => ({ ...abre, ...data })),
  }
  ;(prismaMock as any).workShiftAssignment = {
    upsert: jest.fn(async ({ create }: any) => ({ id: 'asg', ...create })),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    findMany: jest.fn().mockResolvedValue([]),
  }
  ;(prismaMock as any).staffVenue = { findMany: jest.fn().mockResolvedValue([{ id: 'sv-1' }, { id: 'sv-2' }]) }
  ;(prismaMock as any).$transaction = jest.fn((fn: any) => (typeof fn === 'function' ? fn(prismaMock) : Promise.all(fn)))
})

describe('plantillas', () => {
  it('crea una plantilla con nombre, abreviatura, color y horario', async () => {
    const t = await createTemplate(
      VENUE,
      { name: 'Cierre', abbreviation: 'CI', color: '#123456', startTime: '11:00', endTime: '19:00' },
      ACTOR,
    )
    expect((prismaMock as any).workShiftTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venueId: VENUE, name: 'Cierre', startTime: '11:00', endTime: '19:00' }),
    })
    expect(t.name).toBe('Cierre')
  })
  it('🔴 empezar y terminar a la misma hora NO es un turno', async () => {
    await expect(
      createTemplate(VENUE, { name: 'X', abbreviation: 'X', startTime: '09:00', endTime: '09:00' }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
  it('un turno nocturno (termina antes de empezar) SÍ es válido', async () => {
    await expect(
      createTemplate(VENUE, { name: 'Noche', abbreviation: 'NO', startTime: '22:00', endTime: '06:00' }, ACTOR),
    ).resolves.toBeTruthy()
  })
  it('🔴 no se edita una plantilla de OTRO venue', async () => {
    ;(prismaMock as any).workShiftTemplate.findFirst.mockResolvedValue(null)
    await expect(updateTemplate(VENUE, 'tpl-ajeno', { name: 'Hack' }, ACTOR)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('asignaciones', () => {
  it('🔴 guarda una COPIA de las horas de la plantilla (cambiarla mañana no reescribe la semana)', async () => {
    await replaceAssignments(
      VENUE,
      { from: '2026-08-24', to: '2026-08-30', items: [{ staffVenueId: 'sv-1', date: '2026-08-25', templateId: 'tpl-abre' }] },
      ACTOR,
    )
    const call = (prismaMock as any).workShiftAssignment.upsert.mock.calls[0][0]
    expect(call.where).toEqual({ staffVenueId_date: { staffVenueId: 'sv-1', date: '2026-08-25' } })
    expect(call.create).toMatchObject({
      venueId: VENUE,
      templateId: 'tpl-abre',
      templateName: 'Abre',
      startTime: '08:00',
      endTime: '16:00',
      status: 'DRAFT',
    })
    expect(call.update).toMatchObject({ templateName: 'Abre', startTime: '08:00', endTime: '16:00', status: 'DRAFT' })
  })
  it('templateId null BORRA la asignación de esa celda', async () => {
    await replaceAssignments(
      VENUE,
      { from: '2026-08-24', to: '2026-08-30', items: [{ staffVenueId: 'sv-1', date: '2026-08-25', templateId: null }] },
      ACTOR,
    )
    expect((prismaMock as any).workShiftAssignment.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE, staffVenueId: 'sv-1', date: '2026-08-25' },
    })
    expect((prismaMock as any).workShiftAssignment.upsert).not.toHaveBeenCalled()
  })
  it('🔴 una fecha fuera de la ventana pedida se rechaza (no se escribe nada de otra semana por accidente)', async () => {
    await expect(
      replaceAssignments(
        VENUE,
        { from: '2026-08-24', to: '2026-08-30', items: [{ staffVenueId: 'sv-1', date: '2026-09-02', templateId: 'tpl-abre' }] },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
  it('🔴 una plantilla de OTRO venue (o inactiva) se rechaza', async () => {
    ;(prismaMock as any).workShiftTemplate.findMany.mockResolvedValue([])
    await expect(
      replaceAssignments(
        VENUE,
        { from: '2026-08-24', to: '2026-08-30', items: [{ staffVenueId: 'sv-1', date: '2026-08-25', templateId: 'tpl-ajeno' }] },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
  it('🔴 un empleado que no es de este venue se rechaza', async () => {
    await expect(
      replaceAssignments(
        VENUE,
        { from: '2026-08-24', to: '2026-08-30', items: [{ staffVenueId: 'sv-otro', date: '2026-08-25', templateId: 'tpl-abre' }] },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
  it('publicar pasa a PUBLISHED sólo los borradores del rango, del venue', async () => {
    const r = await publishAssignments(VENUE, { from: '2026-08-24', to: '2026-08-30' }, ACTOR)
    expect((prismaMock as any).workShiftAssignment.updateMany).toHaveBeenCalledWith({
      where: { venueId: VENUE, date: { gte: '2026-08-24', lte: '2026-08-30' }, status: 'DRAFT' },
      data: { status: 'PUBLISHED' },
    })
    expect(r.published).toBe(3)
  })
})
