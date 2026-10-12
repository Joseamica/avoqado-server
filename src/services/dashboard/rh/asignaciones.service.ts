import { Prisma, WorkRelation } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { fechaComoDbDate, dbDateComoFecha, sumarDias } from '../staffPay/periodos'
import { assertFechaNoCerrada } from '../staffPay/periodosGuardados'
import { asegurarSedeNoMarcaBlanca } from './marcaBlanca'
import { tomarCandadoPersona } from './candado'
import { Fecha, diaAnterior, hoyDeLaSede, validarFechaDeCambio } from './vigencias'

/*
 * Concurrencia (spec RH §3.2). 🔴 INVARIANTE: todo escritor de StaffAssignment corre en SERIALIZABLE
 * (`withSerializableRetry`). El candado de la persona sólo forma la fila; la corrección la da SSI de Postgres. En
 * SERIALIZABLE la foto de la base se toma en la PRIMERA sentencia (incluida la del candado), así que quien esperó el
 * candado lee una foto vieja: releer no sirve. Si otra solicitud escribió mientras tanto, Postgres aborta ésta con 40001
 * y `withSerializableRetry` la repite con foto nueva, que ya ve lo escrito (tests/integration/rh/asignaciones.concurrencia
 * .test.ts). Un escritor fuera de SERIALIZABLE (aunque tome el candado) rompe la garantía: SSI sólo vigila transacciones
 * SERIALIZABLE, y quien esperó el candado valida sobre una foto vieja.
 */

export interface AsignacionDto {
  id: string
  staffId: string
  positionId: string
  positionName: string
  relation: WorkRelation | null
  effectiveFrom: Fecha
  effectiveTo: Fecha | null
  tracksAttendance: boolean
  supersedesId: string | null
}

const TOPE = 100
const LOTE_VIGENTES = 500
const CON_PUESTO = { position: { select: { name: true } } } as const
type Tx = Prisma.TransactionClient
type Fila = {
  id: string
  staffId: string
  positionId: string
  relation: WorkRelation | null
  effectiveFrom: Date
  effectiveTo: Date | null
  tracksAttendance: boolean
  supersedesId: string | null
  position?: { name: string } | null
}

function aDto(a: Fila): AsignacionDto {
  return {
    id: a.id,
    staffId: a.staffId,
    positionId: a.positionId,
    positionName: a.position?.name ?? '',
    relation: a.relation ?? null,
    effectiveFrom: dbDateComoFecha(a.effectiveFrom),
    effectiveTo: a.effectiveTo ? dbDateComoFecha(a.effectiveTo) : null,
    tracksAttendance: a.tracksAttendance,
    supersedesId: a.supersedesId ?? null,
  }
}

/**
 * «Hoy» es el día civil de la sede; `fecha` sólo puede ser hoy o pasado. El periodo cerrado se revisa en el PRIMER DÍA
 * QUE CAMBIA (`primerDiaQueCambia`): al asignar o cambiar es la propia fecha; al terminar, el día siguiente.
 */
async function contextoDeFecha(
  tx: Tx,
  venueId: string,
  fecha: Fecha | undefined,
  primerDiaQueCambia: (f: Fecha) => Fecha = f => f,
): Promise<Fecha> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { timezone: true, organizationId: true } })
  if (!venue) throw new NotFoundError('Sucursal no encontrada')
  const hoy = hoyDeLaSede(venue.timezone)
  const f = fecha ?? hoy
  validarFechaDeCambio(f, hoy)
  // Consulta el periodo que CONTIENE ese día (aguanta cierres fuera de orden, cierre.service.ts:169). Sin `accion`: el
  // mensaje con acción habla de clases y «Ajustar monto», que no aplica a RH.
  await assertFechaNoCerrada(tx, venue.organizationId, primerDiaQueCambia(f))
  return f
}

async function validarPersonaYPuesto(tx: Tx, venueId: string, staffId: string, positionId: string) {
  const sv = await tx.staffVenue.findUnique({ where: { staffId_venueId: { staffId, venueId } }, select: { active: true } })
  if (!sv || !sv.active) throw new BadRequestError('Esa persona no está activa en este negocio.')
  const puesto = await tx.staffPosition.findFirst({ where: { id: positionId, venueId } })
  if (!puesto) throw new NotFoundError('Ese puesto no existe en esta sucursal.')
  if (puesto.archivedAt) throw new BadRequestError(`El puesto «${puesto.name}» está archivado. Elige otro o restáuralo.`)
  return puesto
}

/** Busca UNA fila que choque, con el intervalo en el WHERE (sin traer historial: correcto con cualquier número de versiones). */
async function sinTraslape(tx: Tx, venueId: string, staffId: string, positionId: string, desde: Fecha, exceptoId?: string) {
  const choca = await tx.staffAssignment.findFirst({
    where: {
      venueId,
      staffId,
      positionId,
      ...(exceptoId ? { id: { not: exceptoId } } : {}),
      // La nueva va de `desde` en adelante (abierta): choca toda vigencia que siga viva en o después de `desde`.
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: fechaComoDbDate(desde) } }],
    },
    select: { id: true },
  })
  if (choca) throw new ConflictError('Ya tiene ese puesto en esas fechas.')
}

/** Lee la asignación de ESTA sede y toma el candado de su persona (el staffId de una asignación nunca cambia). */
async function asignacionConCandado(tx: Tx, venueId: string, assignmentId: string) {
  const actual = await tx.staffAssignment.findFirst({
    where: { id: assignmentId, venueId },
    include: { ...CON_PUESTO, supersededBy: { select: { id: true } } },
  })
  if (!actual) throw new NotFoundError('Esa asignación no existe en esta sucursal.')
  await tomarCandadoPersona(tx, venueId, actual.staffId)
  // Id viejo: ya existe una versión posterior (quien edita vio la pantalla antes de otro cambio).
  if (actual.supersededBy) throw new ConflictError('Esta asignación cambió mientras la editabas. Recarga e inténtalo de nuevo.')
  return actual
}

export async function asignarPuesto(input: {
  venueId: string
  staffId: string
  positionId: string
  relation?: WorkRelation | null
  fecha?: Fecha
  tracksAttendance?: boolean
  actorId: string
}): Promise<AsignacionDto> {
  await asegurarSedeNoMarcaBlanca(input.venueId)
  return withSerializableRetry(async tx => {
    await tomarCandadoPersona(tx, input.venueId, input.staffId)
    const desde = await contextoDeFecha(tx, input.venueId, input.fecha)
    const puesto = await validarPersonaYPuesto(tx, input.venueId, input.staffId, input.positionId)
    await sinTraslape(tx, input.venueId, input.staffId, input.positionId, desde)
    const a = await tx.staffAssignment.create({
      data: {
        staffId: input.staffId,
        venueId: input.venueId,
        positionId: input.positionId,
        relation: input.relation ?? null,
        effectiveFrom: fechaComoDbDate(desde),
        tracksAttendance: input.tracksAttendance ?? puesto.tracksAttendanceDefault,
        createdById: input.actorId,
      },
      include: CON_PUESTO,
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_ASSIGNMENT_CREATED',
      entity: 'StaffAssignment',
      entityId: a.id,
      data: { staffId: input.staffId, positionId: input.positionId, relation: input.relation ?? null, desde },
    })
    return aDto(a)
  })
}

export async function cambiarAsignacion(input: {
  venueId: string
  assignmentId: string
  positionId?: string
  relation?: WorkRelation | null
  fecha?: Fecha
  actorId: string
}): Promise<AsignacionDto> {
  await asegurarSedeNoMarcaBlanca(input.venueId)
  return withSerializableRetry(async tx => {
    const actual = await asignacionConCandado(tx, input.venueId, input.assignmentId)
    if (actual.effectiveTo) throw new BadRequestError('Esa asignación ya terminó. Crea una nueva.')
    const positionId = input.positionId ?? actual.positionId
    const relation = input.relation !== undefined ? input.relation : actual.relation
    const cambiaPuesto = positionId !== actual.positionId
    // Nada cambia: ni versión nueva ni auditoría.
    if (!cambiaPuesto && relation === actual.relation) return aDto(actual)
    const desde = await contextoDeFecha(tx, input.venueId, input.fecha)
    if (cambiaPuesto) await validarPersonaYPuesto(tx, input.venueId, actual.staffId, positionId)

    // Mismo día: reemplaza la versión abierta ese día (spec RH §3.2), sin crear una de un día.
    if (dbDateComoFecha(actual.effectiveFrom) === desde) {
      if (cambiaPuesto) await sinTraslape(tx, input.venueId, actual.staffId, positionId, desde, actual.id)
      const a = await tx.staffAssignment.update({ where: { id: actual.id }, data: { positionId, relation }, include: CON_PUESTO })
      await writeLegacyActivityAuditTx(tx, {
        staffId: input.actorId,
        venueId: input.venueId,
        action: 'STAFF_ASSIGNMENT_UPDATED',
        entity: 'StaffAssignment',
        entityId: a.id,
        data: { antes: { positionId: actual.positionId, relation: actual.relation }, positionId, relation, desde, mismoDia: true },
      })
      return aDto(a)
    }
    if (desde < dbDateComoFecha(actual.effectiveFrom)) {
      throw new BadRequestError('La fecha del cambio debe ser posterior al inicio de la asignación.')
    }
    await tx.staffAssignment.update({ where: { id: actual.id }, data: { effectiveTo: fechaComoDbDate(diaAnterior(desde)) } })
    if (cambiaPuesto) await sinTraslape(tx, input.venueId, actual.staffId, positionId, desde)
    const a = await tx.staffAssignment.create({
      data: {
        staffId: actual.staffId,
        venueId: input.venueId,
        positionId,
        relation,
        effectiveFrom: fechaComoDbDate(desde),
        tracksAttendance: actual.tracksAttendance,
        supersedesId: actual.id,
        createdById: input.actorId,
      },
      include: CON_PUESTO,
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_ASSIGNMENT_VERSIONED',
      entity: 'StaffAssignment',
      entityId: a.id,
      data: { anterior: actual.id, positionId, relation, desde },
    })
    return aDto(a)
  })
}

export async function terminarAsignacion(input: {
  venueId: string
  assignmentId: string
  fecha?: Fecha
  actorId: string
}): Promise<AsignacionDto> {
  await asegurarSedeNoMarcaBlanca(input.venueId)
  return withSerializableRetry(async tx => {
    const actual = await asignacionConCandado(tx, input.venueId, input.assignmentId)
    if (actual.effectiveTo) throw new BadRequestError('Esa asignación ya terminó.')
    // `hasta` es el último día con el puesto: lo que cambia empieza al día siguiente (con septiembre cerrado, terminar el
    // 30-sep sí se puede).
    const hasta = await contextoDeFecha(tx, input.venueId, input.fecha, f => sumarDias(f, 1))
    if (hasta < dbDateComoFecha(actual.effectiveFrom)) throw new BadRequestError('No puede terminar antes de que empezara.')
    const a = await tx.staffAssignment.update({
      where: { id: actual.id },
      data: { effectiveTo: fechaComoDbDate(hasta) },
      include: CON_PUESTO,
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_ASSIGNMENT_ENDED',
      entity: 'StaffAssignment',
      entityId: a.id,
      data: { hasta },
    })
    return aDto(a)
  })
}

export async function historialDePersona(
  venueId: string,
  staffId: string,
  opts: { limit?: number; offset?: number },
): Promise<{ data: AsignacionDto[]; total: number; hasMore: boolean }> {
  const limite = Math.min(Math.max(opts.limit ?? 50, 1), TOPE)
  const skip = Math.max(opts.offset ?? 0, 0)
  const where = { venueId, staffId }
  const [total, rows] = await Promise.all([
    prisma.staffAssignment.count({ where }),
    prisma.staffAssignment.findMany({
      where,
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      take: limite,
      skip,
      include: CON_PUESTO,
    }),
  ])
  return { data: rows.map(aDto), total, hasMore: skip + rows.length < total }
}

/** Puestos vigentes HOY de una lista de personas. Procesa por lotes de 100 y pagina las asignaciones: nunca corta en silencio. */
export async function asignacionesVigentes(venueId: string, staffIds: string[], hoy: Fecha): Promise<Map<string, AsignacionDto[]>> {
  const d = fechaComoDbDate(hoy)
  const m = new Map<string, AsignacionDto[]>()
  for (let i = 0; i < staffIds.length; i += TOPE) {
    const lote = staffIds.slice(i, i + TOPE)
    let cursor: string | undefined
    for (;;) {
      const rows = await prisma.staffAssignment.findMany({
        where: { venueId, staffId: { in: lote }, effectiveFrom: { lte: d }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }] },
        orderBy: { id: 'asc' },
        take: LOTE_VIGENTES,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        include: CON_PUESTO,
      })
      for (const r of rows) {
        const lista = m.get(r.staffId) ?? []
        lista.push(aDto(r))
        m.set(r.staffId, lista)
      }
      if (rows.length < LOTE_VIGENTES) break
      cursor = rows[rows.length - 1].id
    }
  }
  return m
}
