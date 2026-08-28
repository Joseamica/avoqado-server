/**
 * Turnos ROTATIVOS de trabajo — fase 1 del checador "como Sesame" (2026-08-27).
 *
 * Un cliente pidió "turnos personalizados: en cafeterías hay 3 turnos (abre, inter, cierre) y
 * todos rotan". Sesame lo resuelve con dos cosas que CONVIVEN con la jornada fija: plantillas de
 * turno (nombre, abreviatura, color, horario) y un cuadrante semanal persona×día que se arma en
 * borrador y se PUBLICA. Aquí es igual, con tres reglas que salieron de la revisión con Codex:
 *
 *   1. Interruptor explícito por venue (`VenueSettings.rotatingShiftsEnabled`), apagado de fábrica.
 *      Crear una plantilla puede ser una prueba; no cambia en silencio la fuente de retardos y
 *      comisiones.
 *   2. Tabla PROPIA (`WorkShiftAssignment`), no `StaffWorkScheduleException`: el endpoint del
 *      cuadrante borra y recrea todas las excepciones de la persona en cada guardado.
 *   3. La asignación guarda COPIA de las horas: cambiar "Abre" mañana no reescribe semanas publicadas.
 *
 * Precedencia (en `resolveExpectedDay`): excepción manual → asignación PUBLICADA → jornada fija → nada.
 */
import { DateTime } from 'luxon'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from './activity-log.service'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** `2026-02-31` pasa el regex; Luxon dice si el día existe (Codex P3). */
const isValidIsoDate = (d: string) => ISO_DATE.test(d) && DateTime.fromISO(d).isValid
export const MAX_ASSIGNMENT_DAYS = 31
export const MAX_ASSIGNMENT_ITEMS = 600

export interface TemplateInput {
  name: string
  abbreviation: string
  color?: string
  startTime: string
  endTime: string
  sortOrder?: number
}

function validateTemplateHours(startTime?: string, endTime?: string) {
  if (startTime !== undefined && !HHMM.test(startTime)) throw new BadRequestError('Hora de entrada inválida (HH:mm)')
  if (endTime !== undefined && !HHMM.test(endTime)) throw new BadRequestError('Hora de salida inválida (HH:mm)')
  // endTime < startTime es un turno nocturno (cruza la medianoche) y es válido; iguales no es un turno.
  if (startTime !== undefined && endTime !== undefined && startTime === endTime) {
    throw new BadRequestError('Un turno no puede empezar y terminar a la misma hora')
  }
}

export async function listTemplates(venueId: string, includeInactive = false) {
  return prisma.workShiftTemplate.findMany({
    where: { venueId, ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }, { name: 'asc' }],
  })
}

export async function createTemplate(venueId: string, input: TemplateInput, actorId: string) {
  validateTemplateHours(input.startTime, input.endTime)
  const name = input.name.trim()
  const abbreviation = input.abbreviation.trim().toUpperCase().slice(0, 4)
  if (!name) throw new BadRequestError('El turno necesita un nombre')
  if (!abbreviation) throw new BadRequestError('El turno necesita una abreviatura')
  const template = await prisma.workShiftTemplate.create({
    data: {
      venueId,
      name,
      abbreviation,
      color: input.color ?? '#7ADD2C',
      startTime: input.startTime,
      endTime: input.endTime,
      sortOrder: input.sortOrder ?? 0,
    },
  })
  logAction({
    staffId: actorId,
    venueId,
    action: 'WORK_SHIFT_TEMPLATE_CREATED',
    entity: 'WorkShiftTemplate',
    entityId: template.id,
    data: { name, startTime: input.startTime, endTime: input.endTime },
  })
  return template
}

export async function updateTemplate(
  venueId: string,
  templateId: string,
  input: Partial<TemplateInput> & { active?: boolean },
  actorId: string,
) {
  const existing = await prisma.workShiftTemplate.findFirst({ where: { id: templateId, venueId } })
  if (!existing) throw new NotFoundError('Ese turno no existe en este negocio')
  const startTime = input.startTime ?? existing.startTime
  const endTime = input.endTime ?? existing.endTime
  validateTemplateHours(startTime, endTime)
  const template = await prisma.workShiftTemplate.update({
    where: { id: templateId },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.abbreviation !== undefined && { abbreviation: input.abbreviation.trim().toUpperCase().slice(0, 4) }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.startTime !== undefined && { startTime: input.startTime }),
      ...(input.endTime !== undefined && { endTime: input.endTime }),
      ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      ...(input.active !== undefined && { active: input.active }),
    },
  })
  logAction({
    staffId: actorId,
    venueId,
    action: 'WORK_SHIFT_TEMPLATE_UPDATED',
    entity: 'WorkShiftTemplate',
    entityId: templateId,
    data: input,
  })
  return template
}

/** Baja suave: las asignaciones ya hechas conservan su copia de horas; sólo deja de ofrecerse. */
export async function deactivateTemplate(venueId: string, templateId: string, actorId: string) {
  return updateTemplate(venueId, templateId, { active: false }, actorId)
}

export interface AssignmentItem {
  staffVenueId: string
  date: string
  templateId: string | null
}

function assertRange(from: string, to: string) {
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) throw new BadRequestError('Fechas inválidas (YYYY-MM-DD)')
  if (from > to) throw new BadRequestError('El rango termina antes de empezar')
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000
  if (days > MAX_ASSIGNMENT_DAYS - 1) throw new BadRequestError(`El rango máximo es de ${MAX_ASSIGNMENT_DAYS} días`)
}

export async function getAssignments(venueId: string, from: string, to: string) {
  assertRange(from, to)
  return prisma.workShiftAssignment.findMany({
    where: { venueId, date: { gte: from, lte: to } },
    select: {
      id: true,
      staffVenueId: true,
      date: true,
      templateId: true,
      templateName: true,
      startTime: true,
      endTime: true,
      status: true,
    },
    orderBy: [{ date: 'asc' }],
  })
}

/**
 * Guarda celdas del cuadrante como BORRADOR — en filas APARTE de lo publicado (Codex, 2ª auditoría):
 * editar una celda publicada no la despublica; asistencia, nómina y comisiones siguen leyendo la fila
 * PUBLISHED hasta que alguien pulsa "Publicar". `templateId: null` = "vaciar al publicar" (un DRAFT sin
 * plantilla). Sólo se escribe dentro de [from, to] — una fecha fuera se rechaza entera.
 */
export async function replaceAssignments(venueId: string, input: { from: string; to: string; items: AssignmentItem[] }, actorId: string) {
  assertRange(input.from, input.to)
  const items = input.items ?? []
  if (items.length > MAX_ASSIGNMENT_ITEMS) throw new BadRequestError(`Máximo ${MAX_ASSIGNMENT_ITEMS} celdas por guardado`)
  for (const it of items) {
    if (!isValidIsoDate(it.date) || it.date < input.from || it.date > input.to) {
      throw new BadRequestError(`La fecha ${it.date} está fuera de la semana que se está editando`)
    }
  }
  const staffVenueIds = [...new Set(items.map(i => i.staffVenueId))]
  const templateIds = [...new Set(items.map(i => i.templateId).filter((x): x is string => !!x))]
  const [members, templates] = await Promise.all([
    staffVenueIds.length ? prisma.staffVenue.findMany({ where: { id: { in: staffVenueIds }, venueId }, select: { id: true } }) : Promise.resolve([] as Array<{ id: string }>),
    templateIds.length ? prisma.workShiftTemplate.findMany({ where: { id: { in: templateIds }, venueId, active: true } }) : Promise.resolve([]),
  ])
  const memberSet = new Set(members.map(m => m.id))
  const templateById = new Map(templates.map(t => [t.id, t]))
  for (const id of staffVenueIds) if (!memberSet.has(id)) throw new BadRequestError('Ese empleado no pertenece a este negocio')
  for (const id of templateIds) if (!templateById.has(id)) throw new BadRequestError('Ese turno no existe en este negocio o está dado de baja')

  await prisma.$transaction(async tx => {
    for (const it of items) {
      const t = it.templateId ? templateById.get(it.templateId)! : null
      // DRAFT sin plantilla = "vaciar al publicar". Copia de horas cuando sí hay plantilla.
      const snapshot = t
        ? { templateId: t.id, templateName: t.name, startTime: t.startTime, endTime: t.endTime }
        : { templateId: null, templateName: '', startTime: '', endTime: '' }
      await tx.workShiftAssignment.upsert({
        where: { staffVenueId_date_status: { staffVenueId: it.staffVenueId, date: it.date, status: 'DRAFT' } },
        create: { venueId, staffVenueId: it.staffVenueId, date: it.date, status: 'DRAFT', ...snapshot },
        update: snapshot,
      })
    }
  })
  logAction({ staffId: actorId, venueId, action: 'WORK_SHIFT_ASSIGNMENTS_UPDATED', entity: 'WorkShiftAssignment', entityId: `${input.from}..${input.to}`, data: { cells: items.length } })
  return getAssignments(venueId, input.from, input.to)
}

/**
 * Publicar = "esta semana va". Desde aquí las asignaciones cuentan para asistencia y comisiones.
 *
 * 🔴 CAS por revisión, TODO-O-NADA (Codex, 3ª auditoría): el gerente manda `{id, updatedAt}` de cada borrador
 * que tiene ENFRENTE. Si alguno cambió por debajo (otro gerente lo editó) o dejó de existir, no se publica
 * NADA y se contesta 409 con las celdas en conflicto — la pantalla las recarga y el gerente las ve antes
 * de volver a publicar. Los borradores del rango que no vengan en la lista se dejan en borrador (`skipped`).
 * Cada borrador reemplaza la fila PUBLISHED de su celda; un DRAFT sin plantilla la vacía.
 */
export async function publishAssignments(
  venueId: string,
  input: { from: string; to: string; drafts: Array<{ id: string; updatedAt: string }> },
  actorId: string,
) {
  assertRange(input.from, input.to)
  const wanted = new Map((input.drafts ?? []).map(d => [d.id, d.updatedAt]))
  const drafts = await prisma.workShiftAssignment.findMany({
    where: { venueId, date: { gte: input.from, lte: input.to }, status: 'DRAFT' },
    select: { id: true, staffVenueId: true, date: true, templateId: true, updatedAt: true },
  })
  const byId = new Map(drafts.map(d => [d.id, d]))
  const conflicts: Array<{ id: string; staffVenueId?: string; date?: string; reason: 'CHANGED' | 'GONE' }> = []
  for (const [id, sentUpdatedAt] of wanted) {
    const current = byId.get(id)
    if (!current) conflicts.push({ id, reason: 'GONE' })
    else if (current.updatedAt.toISOString() !== new Date(sentUpdatedAt).toISOString()) conflicts.push({ id, staffVenueId: current.staffVenueId, date: current.date, reason: 'CHANGED' })
  }
  if (conflicts.length) {
    throw new ConflictError('Alguien más cambió borradores de esta semana: revísalos antes de publicar', 'WORK_SHIFT_DRAFT_CONFLICT', { conflicts })
  }
  const toPublish = drafts.filter(d => wanted.has(d.id))
  const skipped = drafts.length - toPublish.length
  let published = 0
  let cleared = 0
  await prisma.$transaction(async tx => {
    for (const d of toPublish) {
      // el CAS se repite DENTRO de la transacción: si cambió entre la lectura y aquí, se aborta entera
      const cas = await tx.workShiftAssignment.updateMany({ where: { id: d.id, status: 'DRAFT', updatedAt: d.updatedAt }, data: { updatedAt: d.updatedAt } })
      if (cas.count !== 1) throw new ConflictError('Alguien más cambió borradores de esta semana: revísalos antes de publicar', 'WORK_SHIFT_DRAFT_CONFLICT', { conflicts: [{ id: d.id, staffVenueId: d.staffVenueId, date: d.date, reason: 'CHANGED' }] })
      await tx.workShiftAssignment.deleteMany({ where: { staffVenueId: d.staffVenueId, date: d.date, status: 'PUBLISHED' } })
      if (d.templateId) {
        await tx.workShiftAssignment.update({ where: { id: d.id }, data: { status: 'PUBLISHED' } })
        published++
      } else {
        await tx.workShiftAssignment.delete({ where: { id: d.id } })
        cleared++
      }
    }
  })
  logAction({ staffId: actorId, venueId, action: 'WORK_SHIFT_ASSIGNMENTS_PUBLISHED', entity: 'WorkShiftAssignment', entityId: `${input.from}..${input.to}`, data: { published, cleared, skipped } })
  return { published, cleared, skipped }
}
