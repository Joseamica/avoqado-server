import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WorkRelation } from '@prisma/client'
import { z } from 'zod'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { asignarPuesto, terminarAsignacion, type AsignacionDto } from '@/services/dashboard/rh/asignaciones.service'
import { asegurarSedeNoMarcaBlanca } from '@/services/dashboard/rh/marcaBlanca'
import { hoyDeLaSede } from '@/services/dashboard/rh/vigencias'
import { archivarPuesto, crearPuesto, listarPuestos, type PuestoDto } from '@/services/dashboard/rh/puestos.service'
import { auditMcpWrite } from '../audit'
import { createGuard } from '../guard'
import type { McpScope } from '../scope'
import { text } from '../respond'

// RH fase 1a (spec RH §6-7): puestos y asignaciones. Gratis (sin candado de plan). Asignar un puesto NUNCA cambia el rol
// ni los permisos de nadie. Relación vacía = «Sin definir».
const SIN_DEFINIR = 'Sin definir'
// SUPERADMIN fuera a propósito: un agente nunca propone ese rol (igual que invite_staff).
const ROLES_SUGERIBLES = ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST', 'VIEWER'] as const

// Cada campo se crea aparte: reusar la MISMA instancia de Zod en dos parámetros sale como `$ref` y el portal del directorio lo rechaza.
const venueIdZ = () => z.string().describe('Sucursal (debe estar dentro de tu alcance)')
const confirmZ = () => z.boolean().optional().describe('Debe ser true para ejecutar de verdad; sin él sólo ves la vista previa')
const relacionZ = (que: string) =>
  z.nativeEnum(WorkRelation).nullable().optional().describe(`${que} Vacía = «${SIN_DEFINIR}» (no se ha indicado)`)
const fechaZ = (que: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe ser AAAA-MM-DD')
    .optional()
    .describe(`${que} Formato AAAA-MM-DD, hoy o anterior; vacía = hoy`)

const puestoVista = (p: PuestoDto) => ({
  positionId: p.id,
  nombre: p.name,
  rolSugerido: p.suggestedRole,
  relacionSugerida: p.suggestedRelation ?? SIN_DEFINIR,
  checaAsistencia: p.tracksAttendanceDefault,
  personasVigentes: p.personasVigentes,
  archivado: p.archivedAt !== null,
})
const asignacionVista = (a: AsignacionDto) => ({ ...a, relation: a.relation ?? SIN_DEFINIR })
const nombreDe = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim()

/**
 * «Hoy» en la fecha civil de la sede (AAAA-MM-DD). La vista previa la devuelve en el nivel de arriba (`fecha`) para que la
 * confirmación firmada ate el día que la persona VIO, aunque el reintento pase la medianoche (mismo patrón que Pago al personal).
 */
async function hoyDeLaSedeCivil(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return hoyDeLaSede(venue?.timezone ?? 'America/Mexico_City')
}

/** Un rechazo de negocio del servicio (español, escrito para el operador) vuelve como respuesta; lo inesperado sube y lo sanea instrument.ts. */
function rechazo(err: unknown) {
  if (err instanceof AppError && err.isOperational) return text({ ok: false, error: err.message })
  throw err
}

export function registerRhTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  /** Vista previa y escritura comparten la puerta: alcance, permiso de escribir y sede que no sea de marca blanca (403). */
  const puertaDeEscritura = async (venueId: string) => {
    guard.venueFilter(venueId)
    guard.requirePermission('teams:update', venueId)
    await asegurarSedeNoMarcaBlanca(venueId)
  }

  server.tool(
    'list_positions',
    'Puestos de trabajo de una sucursal (por ejemplo Mesero, Coach, Barbero): su rol sugerido, su relación sugerida («Sin definir» si no se ha indicado), si checa asistencia y cuántas personas lo tienen hoy. Los archivados sólo salen si lo pides. Pagina con limit y offset (máximo 100 por página). Sólo lee. Pasa venueId.',
    {
      venueId: venueIdZ(),
      includeArchived: z.boolean().optional().describe('Incluir también los puestos archivados'),
      limit: z.number().int().min(1).max(100).optional().describe('Máximo de puestos por página (por defecto 50)'),
      offset: z.number().int().min(0).optional().describe('Desde qué puesto continuar'),
    },
    async ({ venueId, includeArchived, limit, offset = 0 }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('teams:read', venueId)
      await asegurarSedeNoMarcaBlanca(venueId) // marca blanca ⇒ 403 también en la lectura
      const r = await listarPuestos(venueId, { incluirArchivados: includeArchived, limit, offset })
      return text({
        venueId,
        count: r.data.length,
        total: r.total,
        hasMore: r.hasMore,
        nextOffset: r.hasMore ? offset + r.data.length : null,
        puestos: r.data.map(puestoVista),
      })
    },
  )

  server.tool(
    'create_position',
    'Crea un puesto de trabajo en la sucursal (por ejemplo Coach, Barbero, Recepcionista) con su rol sugerido y, si se quiere, su relación sugerida. Un puesto sólo es una etiqueta: no cambia el rol ni los permisos de nadie. Pide confirmación: sin confirm sólo muestra la vista previa. Requiere permiso para editar el equipo.',
    {
      venueId: venueIdZ(),
      name: z.string().trim().min(1).max(60).describe('Nombre del puesto (máximo 60 caracteres, único entre los activos)'),
      suggestedRole: z
        .enum(ROLES_SUGERIBLES)
        .describe('Rol que se sugiere al invitar a alguien con este puesto (no se puede sugerir SUPERADMIN)'),
      suggestedRelation: relacionZ('Relación que se sugiere para este puesto.'),
      tracksAttendanceDefault: z
        .boolean()
        .optional()
        .describe('Si por defecto las personas con este puesto checan asistencia (por defecto sí)'),
      confirm: confirmZ(),
    },
    async ({ venueId, name, suggestedRole, suggestedRelation, tracksAttendanceDefault, confirm }) => {
      await puertaDeEscritura(venueId)
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            nombre: name,
            rolSugerido: suggestedRole,
            relacionSugerida: suggestedRelation ?? SIN_DEFINIR,
            checaAsistencia: tracksAttendanceDefault ?? true,
          },
          message: `Esto CREARÁ el puesto «${name}» en esta sucursal. No cambia el rol ni los permisos de nadie. Vuelve a llamar con confirm:true para crearlo.`,
        })
      }
      let p: PuestoDto
      try {
        p = await crearPuesto({
          venueId,
          actorId: scope.staffId,
          name,
          suggestedRole,
          suggestedRelation: suggestedRelation ?? null,
          tracksAttendanceDefault,
        })
      } catch (err) {
        return rechazo(err)
      }
      await auditMcpWrite(scope, {
        action: 'STAFF_POSITION_CREATED',
        entity: 'StaffPosition',
        entityId: p.id,
        venueId,
        data: { name: p.name, suggestedRole, suggestedRelation: suggestedRelation ?? null },
      })
      return text({ ok: true, puesto: puestoVista(p) })
    },
  )

  server.tool(
    'archive_position',
    'Archiva un puesto de la sucursal: deja de poder asignarse a nadie más. Las asignaciones que ya existen no se tocan. No borra nada. Pide confirmación: sin confirm sólo muestra la vista previa. Requiere permiso para editar el equipo. Pasa venueId y positionId (de list_positions).',
    {
      venueId: venueIdZ(),
      positionId: z.string().describe('Puesto a archivar (positionId de list_positions)'),
      confirm: confirmZ(),
    },
    async ({ venueId, positionId, confirm }) => {
      await puertaDeEscritura(venueId)
      if (!confirm) {
        const puesto = await prisma.staffPosition.findFirst({
          where: { id: positionId, venueId },
          select: { name: true, archivedAt: true },
        })
        if (!puesto) return text({ ok: false, error: 'Ese puesto no existe en esta sucursal.' })
        if (puesto.archivedAt) return text({ ok: false, error: `El puesto «${puesto.name}» ya está archivado.` })
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { puesto: puesto.name },
          message: `Esto ARCHIVARÁ el puesto «${puesto.name}»: ya no se podrá asignar a nadie más. Las asignaciones que ya existen no se tocan. Vuelve a llamar con confirm:true para archivarlo.`,
        })
      }
      let p: PuestoDto
      const antes = Date.now()
      try {
        p = await archivarPuesto({ venueId, actorId: scope.staffId, positionId })
      } catch (err) {
        return rechazo(err)
      }
      // Ya estaba archivado (otra persona lo archivó entre la vista previa y ahora): el servicio devuelve su archivedAt de antes
      // y no cambió nada, así que no se escribe una auditoría que diga que esta conexión lo archivó.
      if (p.archivedAt && new Date(p.archivedAt).getTime() < antes) return text({ ok: true, puesto: puestoVista(p) })
      await auditMcpWrite(scope, {
        action: 'STAFF_POSITION_ARCHIVED',
        entity: 'StaffPosition',
        entityId: p.id,
        venueId,
        data: { name: p.name },
      })
      return text({ ok: true, puesto: puestoVista(p) })
    },
  )

  server.tool(
    'assign_staff_position',
    'Asigna a una persona un puesto de la sucursal, con su relación opcional (vacía = sin definir). Desde hoy o desde una fecha pasada. No cambia su rol ni sus permisos. Pide confirmación: sin confirm sólo muestra la vista previa. Requiere permiso para editar el equipo. Pasa venueId, staffId (de list_staff) y positionId (de list_positions).',
    {
      venueId: venueIdZ(),
      staffId: z.string().describe('Persona (staffId de list_staff)'),
      positionId: z.string().describe('Puesto (positionId de list_positions)'),
      relation: relacionZ('Relación de trabajo de esta persona en este puesto.'),
      fecha: fechaZ('Desde cuándo tiene el puesto.'),
      confirm: confirmZ(),
    },
    async ({ venueId, staffId, positionId, relation, fecha, confirm }) => {
      await puertaDeEscritura(venueId)
      if (!confirm) {
        const [persona, puesto] = await Promise.all([
          prisma.staffVenue.findUnique({
            where: { staffId_venueId: { staffId, venueId } },
            select: { active: true, staff: { select: { firstName: true, lastName: true } } },
          }),
          prisma.staffPosition.findFirst({ where: { id: positionId, venueId }, select: { name: true, archivedAt: true } }),
        ])
        if (!persona) return text({ ok: false, error: 'Esa persona no trabaja en esta sucursal.' })
        if (!persona.active) return text({ ok: false, error: 'Esa persona no está activa en este negocio.' })
        if (!puesto) return text({ ok: false, error: 'Ese puesto no existe en esta sucursal.' })
        if (puesto.archivedAt) return text({ ok: false, error: `El puesto «${puesto.name}» está archivado. Elige otro.` })
        const desde = fecha ?? (await hoyDeLaSedeCivil(venueId))
        return text({
          ok: false,
          requiresConfirmation: true,
          fecha: desde, // arriba, no sólo en `preview`: así la firma de la confirmación ata este día
          preview: { persona: nombreDe(persona.staff), puesto: puesto.name, relacion: relation ?? SIN_DEFINIR, fecha: desde },
          message: `Esto ASIGNARÁ el puesto «${puesto.name}» a ${nombreDe(persona.staff)} (relación: ${relation ?? SIN_DEFINIR}, desde ${desde}). No cambia su rol ni sus permisos. Vuelve a llamar con confirm:true para asignarlo.`,
        })
      }
      let a: AsignacionDto
      try {
        a = await asignarPuesto({ venueId, staffId, positionId, relation: relation ?? null, fecha, actorId: scope.staffId })
      } catch (err) {
        return rechazo(err)
      }
      await auditMcpWrite(scope, {
        action: 'STAFF_ASSIGNMENT_CREATED',
        entity: 'StaffAssignment',
        entityId: a.id,
        venueId,
        data: { staffId, positionId, relation: relation ?? null, desde: a.effectiveFrom },
      })
      return text({ ok: true, asignacion: asignacionVista(a) })
    },
  )

  server.tool(
    'end_staff_assignment',
    'Termina el puesto vigente de una persona (la asignación): la fecha es el último día con ese puesto. No borra el historial ni cambia su rol o sus permisos. Pide confirmación: sin confirm sólo muestra la vista previa. Requiere permiso para editar el equipo. Pasa venueId y assignmentId (de los puestos que trae list_staff o staff_detail).',
    {
      venueId: venueIdZ(),
      assignmentId: z.string().describe('Asignación a terminar (assignmentId de los puestos de list_staff o staff_detail)'),
      fecha: fechaZ('Último día con el puesto.'),
      confirm: confirmZ(),
    },
    async ({ venueId, assignmentId, fecha, confirm }) => {
      await puertaDeEscritura(venueId)
      if (!confirm) {
        const actual = await prisma.staffAssignment.findFirst({
          where: { id: assignmentId, venueId },
          select: { effectiveTo: true, position: { select: { name: true } }, staff: { select: { firstName: true, lastName: true } } },
        })
        if (!actual) return text({ ok: false, error: 'Esa asignación no existe en esta sucursal.' })
        if (actual.effectiveTo) return text({ ok: false, error: 'Esa asignación ya terminó.' })
        const ultimoDia = fecha ?? (await hoyDeLaSedeCivil(venueId))
        return text({
          ok: false,
          requiresConfirmation: true,
          fecha: ultimoDia, // arriba, no sólo en `preview`: así la firma de la confirmación ata este día
          preview: { persona: nombreDe(actual.staff), puesto: actual.position.name, ultimoDia },
          message: `Esto TERMINARÁ el puesto «${actual.position.name}» de ${nombreDe(actual.staff)} (último día: ${ultimoDia}). No cambia su rol ni sus permisos. Vuelve a llamar con confirm:true para terminarlo.`,
        })
      }
      let a: AsignacionDto
      try {
        a = await terminarAsignacion({ venueId, assignmentId, fecha, actorId: scope.staffId })
      } catch (err) {
        return rechazo(err)
      }
      await auditMcpWrite(scope, {
        action: 'STAFF_ASSIGNMENT_ENDED',
        entity: 'StaffAssignment',
        entityId: a.id,
        venueId,
        data: { staffId: a.staffId, positionId: a.positionId, hasta: a.effectiveTo },
      })
      return text({ ok: true, asignacion: asignacionVista(a) })
    },
  )
}
