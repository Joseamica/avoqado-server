/**
 * Turnos rotativos (fase 1): plantillas + asignaciones persona×día con COPIA de las horas y
 * borrador/publicado. Lo que protege cada prueba está en su nombre.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import {
  createTemplate,
  replaceAssignments,
  publishAssignments,
  updateTemplate,
  getAssignments,
} from '@/services/dashboard/workShift.service'
import { PublishWorkShiftAssignmentsSchema } from '@/schemas/dashboard/attendance.schema'
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
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
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
  it('🔴 guarda una COPIA de las horas en una fila DRAFT aparte: la PUBLISHED de la celda no se toca hasta publicar', async () => {
    await replaceAssignments(
      VENUE,
      { from: '2026-08-24', to: '2026-08-30', items: [{ staffVenueId: 'sv-1', date: '2026-08-25', templateId: 'tpl-abre' }] },
      ACTOR,
    )
    const call = (prismaMock as any).workShiftAssignment.upsert.mock.calls[0][0]
    expect(call.where).toEqual({ staffVenueId_date_status: { staffVenueId: 'sv-1', date: '2026-08-25', status: 'DRAFT' } })
    expect(call.create).toMatchObject({
      venueId: VENUE,
      templateId: 'tpl-abre',
      templateName: 'Abre',
      startTime: '08:00',
      endTime: '16:00',
      status: 'DRAFT',
    })
    expect(call.update).toMatchObject({ templateName: 'Abre', startTime: '08:00', endTime: '16:00' })
    expect((prismaMock as any).workShiftAssignment.deleteMany).not.toHaveBeenCalled()
  })
  it('🔴 templateId null es un BORRADOR de "vaciar": la celda publicada sigue viva hasta publicar', async () => {
    await replaceAssignments(
      VENUE,
      { from: '2026-08-24', to: '2026-08-30', items: [{ staffVenueId: 'sv-1', date: '2026-08-25', templateId: null }] },
      ACTOR,
    )
    const call = (prismaMock as any).workShiftAssignment.upsert.mock.calls[0][0]
    expect(call.create).toMatchObject({ status: 'DRAFT', templateId: null, templateName: '' })
    expect((prismaMock as any).workShiftAssignment.deleteMany).not.toHaveBeenCalled()
  })
  it('🔴 una fecha que no existe (2026-02-31) se rechaza aunque tenga forma de fecha', async () => {
    await expect(
      replaceAssignments(
        VENUE,
        { from: '2026-02-01', to: '2026-02-28', items: [{ staffVenueId: 'sv-1', date: '2026-02-31', templateId: 'tpl-abre' }] },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
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
  it('🔴 publicar SÓLO lo revisado, con su revisión: el borrador de otro gerente que no viste queda en borrador (skipped)', async () => {
    const t = new Date('2026-08-27T10:00:00.000Z')
    ;(prismaMock as any).workShiftAssignment.findMany.mockResolvedValue([
      { id: 'd-1', staffVenueId: 'sv-1', date: '2026-08-25', templateId: 'tpl-abre', updatedAt: t },
      { id: 'd-2', staffVenueId: 'sv-2', date: '2026-08-26', templateId: 'tpl-abre', updatedAt: t }, // el de otro gerente
      { id: 'd-3', staffVenueId: 'sv-1', date: '2026-08-27', templateId: null, updatedAt: t }, // vaciar
    ])
    ;(prismaMock as any).workShiftAssignment.updateMany.mockResolvedValue({ count: 1 })
    const r = await publishAssignments(
      VENUE,
      {
        from: '2026-08-24',
        to: '2026-08-30',
        drafts: [
          { id: 'd-1', updatedAt: t.toISOString() },
          { id: 'd-3', updatedAt: t.toISOString() },
        ],
      },
      ACTOR,
    )
    expect(r).toEqual({ published: 1, cleared: 1, skipped: 1 })
    expect((prismaMock as any).workShiftAssignment.deleteMany).toHaveBeenCalledWith({
      where: { staffVenueId: 'sv-1', date: '2026-08-25', status: 'PUBLISHED' },
    })
    expect((prismaMock as any).workShiftAssignment.update).toHaveBeenCalledWith({ where: { id: 'd-1' }, data: { status: 'PUBLISHED' } })
    expect((prismaMock as any).workShiftAssignment.delete).toHaveBeenCalledWith({ where: { id: 'd-3' } })
  })
  it('🔴 si un borrador que tengo enfrente CAMBIÓ por debajo (otro gerente), NO se publica nada: 409 con la celda', async () => {
    const t = new Date('2026-08-27T10:00:00.000Z')
    ;(prismaMock as any).workShiftAssignment.findMany.mockResolvedValue([
      { id: 'd-1', staffVenueId: 'sv-1', date: '2026-08-25', templateId: 'tpl-abre', updatedAt: new Date('2026-08-27T10:05:00.000Z') },
      { id: 'd-4', staffVenueId: 'sv-2', date: '2026-08-25', templateId: 'tpl-abre', updatedAt: t },
    ])
    await expect(
      publishAssignments(
        VENUE,
        {
          from: '2026-08-24',
          to: '2026-08-30',
          drafts: [
            { id: 'd-1', updatedAt: t.toISOString() },
            { id: 'd-4', updatedAt: t.toISOString() },
          ],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'WORK_SHIFT_DRAFT_CONFLICT',
      details: { conflicts: [{ id: 'd-1', reason: 'CHANGED' }] },
    })
    expect((prismaMock as any).workShiftAssignment.update).not.toHaveBeenCalled()
    expect((prismaMock as any).workShiftAssignment.deleteMany).not.toHaveBeenCalled()
  })
  it('un borrador que ya no existe (GONE) también es conflicto', async () => {
    ;(prismaMock as any).workShiftAssignment.findMany.mockResolvedValue([])
    await expect(
      publishAssignments(
        VENUE,
        { from: '2026-08-24', to: '2026-08-30', drafts: [{ id: 'd-x', updatedAt: '2026-08-27T10:00:00.000Z' }] },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  // 🔴 Prueba la FORMA de la consulta, no el resultado del mock: un mock devuelve el campo
  // gratis aunque el `select` real no lo pida. `publishAssignments` exige `updatedAt` en
  // cada borrador (Zod, `z.string().datetime()`) y el dashboard arma ese payload con lo que
  // devuelve esta consulta — sin el campo, `JSON.stringify` descarta la clave y publicar la
  // semana responde 400 SIEMPRE: las asignaciones se quedan en DRAFT y no cuentan para
  // asistencia ni comisiones. TypeScript no lo caza porque un `select` más estrecho es
  // igual de válido para el compilador.
  it('🔴 getAssignments pide updatedAt: sin él, publicar la semana es imposible', async () => {
    ;(prismaMock as any).workShiftAssignment.findMany = jest.fn().mockResolvedValue([])
    await getAssignments(VENUE, '2026-08-24', '2026-08-30')
    const consulta = (prismaMock as any).workShiftAssignment.findMany.mock.calls[0][0]
    expect(consulta.select.updatedAt).toBe(true)
  })

  // 🔴 El VIAJE COMPLETO, no la forma de la consulta: Prisma devuelve un `Date`, Express lo
  // serializa con JSON y el dashboard reenvía ESO tal cual al publicar. Esta prueba recorre
  // esos tres pasos y valida el resultado con el Zod REAL de publicar, así que falla tanto si
  // el campo desaparece del `select` como si algún día deja de serializarse a un ISO que
  // `z.string().datetime()` acepte — que es lo que la prueba de forma no puede ver.
  it('🔴 lo que devuelve getAssignments sobrevive a JSON y lo acepta el Zod de publicar', async () => {
    const idBorrador = 'clx0000000000000000000000'
    ;(prismaMock as any).workShiftAssignment.findMany = jest.fn().mockResolvedValue([
      {
        id: idBorrador,
        staffVenueId: 'sv-1',
        date: '2026-08-27',
        templateId: 'tpl-abre',
        templateName: 'Abre',
        startTime: '08:00',
        endTime: '16:00',
        status: 'DRAFT',
        updatedAt: new Date('2026-08-27T18:30:00.000Z'),
      },
    ])

    const filas = await getAssignments(VENUE, '2026-08-24', '2026-08-30')
    const viajadas = JSON.parse(JSON.stringify(filas)) // lo que de verdad sale por el cable

    const payload = {
      params: { venueId: 'clx1111111111111111111111' },
      body: {
        from: '2026-08-24',
        to: '2026-08-30',
        drafts: viajadas.map((a: any) => ({ id: a.id, updatedAt: a.updatedAt })),
      },
    }

    const r = PublishWorkShiftAssignmentsSchema.safeParse(payload)
    expect(r.success).toBe(true)
    expect(payload.body.drafts[0].updatedAt).toBe('2026-08-27T18:30:00.000Z')
  })
})