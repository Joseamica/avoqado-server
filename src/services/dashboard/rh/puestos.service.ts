import { PayComponentKind, Prisma, StaffPosition, StaffRole, WorkRelation } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { SECTOR_ROLE_DEFAULTS } from '../../../utils/roleDisplay'
import { categoryOfVenueType } from '../../../utils/venueTypeCategory'
import { asegurarSedeNoMarcaBlanca } from './marcaBlanca'
import { checaPorDefault } from './checaAsistencia'
import { fechaComoDbDate } from '../staffPay/periodos'
import { hoyDeLaSede } from './vigencias'

export interface PuestoDto {
  id: string
  name: string
  color: string | null
  icon: string | null
  suggestedRole: StaffRole
  suggestedRelation: WorkRelation | null
  tracksAttendanceDefault: boolean
  componentKinds: PayComponentKind[]
  archivedAt: string | null
  personasVigentes: number
}
export interface CrearPuestoInput {
  venueId: string
  actorId: string
  name: string
  suggestedRole: StaffRole
  suggestedRelation?: WorkRelation | null
  tracksAttendanceDefault?: boolean
  componentKinds?: PayComponentKind[]
  color?: string | null
  icon?: string | null
}

const TOPE = 100
const limpiar = (s: string) => s.trim().replace(/\s+/g, ' ')

type PuestoConConteo = StaffPosition & { _count: { assignments: number } }

function aDto(p: PuestoConConteo): PuestoDto {
  return {
    id: p.id,
    name: p.name,
    color: p.color ?? null,
    icon: p.icon ?? null,
    suggestedRole: p.suggestedRole,
    suggestedRelation: p.suggestedRelation ?? null,
    tracksAttendanceDefault: p.tracksAttendanceDefault ?? true,
    componentKinds: p.componentKinds ?? [],
    archivedAt: p.archivedAt ? new Date(p.archivedAt).toISOString() : null,
    personasVigentes: p._count.assignments,
  }
}

/** Hoy en la zona de la sede, como valor de columna @db.Date. */
async function hoyDeLaSedeDb(venueId: string): Promise<Date> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return fechaComoDbDate(hoyDeLaSede(venue?.timezone ?? 'America/Mexico_City'))
}

/**
 * ÚNICA definición de «persona vigente en el puesto» (listado y respuestas de crear/editar/archivar): la asignación está
 * vigente HOY (fin inclusivo, mismo criterio que asignacionesVigentes) y la persona sigue activa (su cuenta y en ESTA sucursal).
 */
function conConteoVigentes(venueId: string, hoy: Date) {
  return {
    _count: {
      select: {
        assignments: {
          where: {
            venueId,
            effectiveFrom: { lte: hoy },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: hoy } }],
            // Cuenta global activa (Superadmin la desactiva sin tocar StaffVenue) y activa en ESTA sucursal.
            staff: { active: true, venues: { some: { venueId, active: true } } },
          },
        },
      },
    },
  } satisfies Prisma.StaffPositionInclude
}

/** Nombre limpio y no vacío (el servicio no confía en que la ruta ya lo validó). */
function nombreValido(crudo: string): string {
  const name = limpiar(crudo)
  if (!name) throw new BadRequestError('El nombre del puesto no puede estar vacío.')
  return name
}

async function nombreLibre(tx: Prisma.TransactionClient | typeof prisma, venueId: string, name: string, exceptoId?: string) {
  const otro = await tx.staffPosition.findFirst({
    where: { venueId, archivedAt: null, name: { equals: name, mode: 'insensitive' }, ...(exceptoId ? { id: { not: exceptoId } } : {}) },
    select: { id: true },
  })
  if (otro) throw new ConflictError(`Ya existe un puesto llamado «${name}» en esta sucursal.`)
}

export async function listarPuestos(venueId: string, opts: { incluirArchivados?: boolean; limit?: number; offset?: number }) {
  const limite = Math.min(Math.max(opts.limit ?? 50, 1), TOPE)
  const skip = Math.max(opts.offset ?? 0, 0)
  const where: Prisma.StaffPositionWhereInput = { venueId, ...(opts.incluirArchivados ? {} : { archivedAt: null }) }
  const hoy = await hoyDeLaSedeDb(venueId)
  const [total, rows] = await Promise.all([
    prisma.staffPosition.count({ where }),
    prisma.staffPosition.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limite,
      skip,
      include: conConteoVigentes(venueId, hoy),
    }),
  ])
  return { data: rows.map(aDto), total, hasMore: skip + rows.length < total }
}

export async function crearPuesto(input: CrearPuestoInput): Promise<PuestoDto> {
  await asegurarSedeNoMarcaBlanca(input.venueId)
  const name = nombreValido(input.name)
  const hoy = await hoyDeLaSedeDb(input.venueId)
  return withSerializableRetry(async tx => {
    await nombreLibre(tx, input.venueId, name)
    // Tope de puestos ACTIVOS por sucursal, dentro de la misma transacción serializable (dos altas a la vez no lo rebasan).
    if ((await tx.staffPosition.count({ where: { venueId: input.venueId, archivedAt: null } })) >= TOPE) {
      throw new BadRequestError('Esta sucursal ya tiene 100 puestos activos. Archiva alguno antes de crear otro.')
    }
    const p = await tx.staffPosition.create({
      data: {
        venueId: input.venueId,
        name,
        suggestedRole: input.suggestedRole,
        suggestedRelation: input.suggestedRelation ?? null,
        tracksAttendanceDefault: input.tracksAttendanceDefault ?? checaPorDefault(input.suggestedRole),
        componentKinds: input.componentKinds ?? [],
        color: input.color ?? null,
        icon: input.icon ?? null,
      },
      include: conConteoVigentes(input.venueId, hoy),
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_POSITION_CREATED',
      entity: 'StaffPosition',
      entityId: p.id,
      data: { name },
    })
    return aDto(p)
  })
}

export async function editarPuesto(
  input: { venueId: string; actorId: string; positionId: string } & Partial<Omit<CrearPuestoInput, 'venueId' | 'actorId'>>,
): Promise<PuestoDto> {
  await asegurarSedeNoMarcaBlanca(input.venueId)
  const name = input.name !== undefined ? nombreValido(input.name) : undefined
  const hoy = await hoyDeLaSedeDb(input.venueId)
  return withSerializableRetry(async tx => {
    const actual = await tx.staffPosition.findFirst({ where: { id: input.positionId, venueId: input.venueId } })
    if (!actual) throw new NotFoundError('Ese puesto no existe en esta sucursal.')
    // El nombre sólo debe ser único entre ACTIVOS: a un puesto archivado se le puede cambiar sin chocar.
    if (name !== undefined && !actual.archivedAt) await nombreLibre(tx, input.venueId, name, actual.id)
    const data: Prisma.StaffPositionUpdateInput = {
      ...(name !== undefined ? { name } : {}),
      ...(input.suggestedRole ? { suggestedRole: input.suggestedRole } : {}),
      ...(input.suggestedRelation !== undefined ? { suggestedRelation: input.suggestedRelation } : {}),
      ...(input.tracksAttendanceDefault !== undefined ? { tracksAttendanceDefault: input.tracksAttendanceDefault } : {}),
      ...(input.componentKinds ? { componentKinds: input.componentKinds } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    }
    const p = await tx.staffPosition.update({ where: { id: actual.id }, data, include: conConteoVigentes(input.venueId, hoy) })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_POSITION_UPDATED',
      entity: 'StaffPosition',
      entityId: p.id,
      data: { cambios: Object.keys(data) },
    })
    return aDto(p)
  })
}

export async function archivarPuesto(input: { venueId: string; actorId: string; positionId: string }): Promise<PuestoDto> {
  await asegurarSedeNoMarcaBlanca(input.venueId)
  const hoy = await hoyDeLaSedeDb(input.venueId)
  return withSerializableRetry(async tx => {
    const actual = await tx.staffPosition.findFirst({
      where: { id: input.positionId, venueId: input.venueId },
      include: conConteoVigentes(input.venueId, hoy),
    })
    if (!actual) throw new NotFoundError('Ese puesto no existe en esta sucursal.')
    if (actual.archivedAt) return aDto(actual) // ya estaba archivado: idempotente, sin segunda fila de auditoría
    const p = await tx.staffPosition.update({
      where: { id: actual.id },
      data: { archivedAt: new Date() },
      include: conConteoVigentes(input.venueId, hoy),
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_POSITION_ARCHIVED',
      entity: 'StaffPosition',
      entityId: p.id,
      data: {},
    })
    return aDto(p)
  })
}

/** Chips «+ Agregar»: nombres del giro que todavía no existen como puesto activo. Nunca crea nada. */
export async function puestosSugeridos(venueId: string): Promise<Array<{ name: string; suggestedRole: StaffRole }>> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { type: true } })
  if (!venue) throw new NotFoundError('Sucursal no encontrada')
  const porRol = SECTOR_ROLE_DEFAULTS[categoryOfVenueType(venue.type)]?.es ?? {}
  // Dos roles pueden compartir nombre (en SERVICES, CASHIER y HOST son «Recepcionista»): un chip por nombre, gana el primer rol.
  const candidatos = new Map<string, { name: string; suggestedRole: StaffRole }>()
  for (const [role, name] of Object.entries(porRol) as Array<[StaffRole, string]>) {
    if (!candidatos.has(name.toLowerCase())) candidatos.set(name.toLowerCase(), { name, suggestedRole: role })
  }
  if (candidatos.size === 0) return []
  // Consulta exacta y acotada: sólo los nombres del giro que ya existen como puesto activo (a lo sumo uno por candidato).
  const existentes = await prisma.staffPosition.findMany({
    where: { venueId, archivedAt: null, name: { in: [...candidatos.values()].map(c => c.name), mode: 'insensitive' } },
    select: { name: true },
    take: TOPE,
  })
  const usados = new Set(existentes.map(e => e.name.toLowerCase()))
  return [...candidatos.values()].filter(c => !usados.has(c.name.toLowerCase()))
}
