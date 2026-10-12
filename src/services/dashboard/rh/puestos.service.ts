import { PayComponentKind, Prisma, StaffRole, WorkRelation } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { SECTOR_ROLE_DEFAULTS } from '../../../utils/roleDisplay'
import { getBusinessCategory } from '../../../utils/businessCategory'
import { asegurarSedeNoMarcaBlanca } from './marcaBlanca'
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

function aDto(p: any, personasVigentes = 0): PuestoDto {
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
    personasVigentes,
  }
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
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const hoyDb = fechaComoDbDate(hoyDeLaSede(venue?.timezone ?? 'America/Mexico_City'))
  const [total, rows] = await Promise.all([
    prisma.staffPosition.count({ where }),
    prisma.staffPosition.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limite,
      skip,
      // Mismo criterio que asignacionesVigentes: vigente HOY, con fin inclusivo.
      include: {
        _count: {
          select: {
            assignments: { where: { effectiveFrom: { lte: hoyDb }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: hoyDb } }] } },
          },
        },
      },
    }),
  ])
  return { data: rows.map(r => aDto(r, (r as any)._count?.assignments ?? 0)), total, hasMore: skip + rows.length < total }
}

export async function crearPuesto(input: CrearPuestoInput): Promise<PuestoDto> {
  await asegurarSedeNoMarcaBlanca(input.venueId)
  const name = limpiar(input.name)
  return withSerializableRetry(async tx => {
    await nombreLibre(tx, input.venueId, name)
    const p = await tx.staffPosition.create({
      data: {
        venueId: input.venueId,
        name,
        suggestedRole: input.suggestedRole,
        suggestedRelation: input.suggestedRelation ?? null,
        tracksAttendanceDefault: input.tracksAttendanceDefault ?? true,
        componentKinds: input.componentKinds ?? [],
        color: input.color ?? null,
        icon: input.icon ?? null,
      },
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
  return withSerializableRetry(async tx => {
    const actual = await tx.staffPosition.findFirst({ where: { id: input.positionId, venueId: input.venueId } })
    if (!actual) throw new NotFoundError('Ese puesto no existe en esta sucursal.')
    const name = input.name !== undefined ? limpiar(input.name) : undefined
    if (name) await nombreLibre(tx, input.venueId, name, actual.id)
    const data: Prisma.StaffPositionUpdateInput = {
      ...(name ? { name } : {}),
      ...(input.suggestedRole ? { suggestedRole: input.suggestedRole } : {}),
      ...(input.suggestedRelation !== undefined ? { suggestedRelation: input.suggestedRelation } : {}),
      ...(input.tracksAttendanceDefault !== undefined ? { tracksAttendanceDefault: input.tracksAttendanceDefault } : {}),
      ...(input.componentKinds ? { componentKinds: input.componentKinds } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    }
    const p = await tx.staffPosition.update({ where: { id: actual.id }, data })
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
  return withSerializableRetry(async tx => {
    const actual = await tx.staffPosition.findFirst({ where: { id: input.positionId, venueId: input.venueId } })
    if (!actual) throw new NotFoundError('Ese puesto no existe en esta sucursal.')
    if (actual.archivedAt) return aDto(actual) // ya estaba archivado: idempotente, sin segunda fila de auditoría
    const p = await tx.staffPosition.update({ where: { id: actual.id }, data: { archivedAt: new Date() } })
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
  const nombres = SECTOR_ROLE_DEFAULTS[getBusinessCategory(venue.type as never)]?.es ?? {}
  const existentes = await prisma.staffPosition.findMany({ where: { venueId, archivedAt: null }, select: { name: true }, take: TOPE })
  const usados = new Set(existentes.map(e => e.name.toLowerCase()))
  return (Object.entries(nombres) as Array<[StaffRole, string]>)
    .filter(([, n]) => !usados.has(n.toLowerCase()))
    .map(([role, name]) => ({ name, suggestedRole: role }))
}
