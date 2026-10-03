import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { assertPermisoEnTodasLasSedes, sedesConServicePay } from './acceso'
import { contarClasesQueCambian } from './efecto'
import { dbDateComoFecha, fechaComoDbDate } from './periodos'

export async function listarNiveles(organizationId: string) {
  return prisma.staffPayLevel.findMany({
    where: { organizationId },
    select: { id: true, name: true, sortOrder: true, archivedAt: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    take: 100,
  })
}

export async function crearNivel(input: { organizationId: string; name: string; actorId: string; venueId: string }) {
  await assertPermisoEnTodasLasSedes(input.actorId, input.organizationId, 'staffpay:manage')
  const name = input.name.trim()
  try {
    return await withSerializableRetry(async tx => {
      const sortOrder = await tx.staffPayLevel.count({ where: { organizationId: input.organizationId } })
      const nivel = await tx.staffPayLevel.create({
        data: { organizationId: input.organizationId, name, sortOrder },
        select: { id: true, name: true },
      })
      await writeLegacyActivityAuditTx(tx, {
        staffId: input.actorId,
        venueId: input.venueId,
        action: 'STAFF_PAY_LEVEL_CREATED',
        entity: 'StaffPayLevel',
        entityId: nivel.id,
        data: { name },
      })
      return nivel
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new ConflictError(`Ya existe un nivel llamado «${name}»`)
    throw e
  }
}

export async function editarNivel(input: {
  organizationId: string
  levelId: string
  name?: string
  sortOrder?: number
  archived?: boolean
  actorId: string
  venueId: string
}) {
  await assertPermisoEnTodasLasSedes(input.actorId, input.organizationId, 'staffpay:manage')
  try {
    return await editarNivelTx(input)
  } catch (e) {
    // Mismo mensaje que crearNivel (spec §5.1): nombre único por organización, nunca un 500 anónimo.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictError(`Ya existe un nivel llamado «${input.name?.trim() ?? ''}»`)
    }
    throw e
  }
}

function editarNivelTx(input: {
  organizationId: string
  levelId: string
  name?: string
  sortOrder?: number
  archived?: boolean
  actorId: string
  venueId: string
}) {
  return withSerializableRetry(async tx => {
    const actual = await tx.staffPayLevel.findFirst({ where: { id: input.levelId, organizationId: input.organizationId } })
    if (!actual) throw new NotFoundError('Nivel no encontrado')
    const data: Prisma.StaffPayLevelUpdateInput = {}
    if (input.name !== undefined) data.name = input.name.trim()
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder
    if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null
    const n = await tx.staffPayLevel.update({ where: { id: actual.id }, data, select: { id: true } })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_PAY_LEVEL_UPDATED',
      entity: 'StaffPayLevel',
      entityId: n.id,
      data: {
        antes: { name: actual.name, sortOrder: actual.sortOrder, archived: !!actual.archivedAt },
        cambios: { name: input.name, sortOrder: input.sortOrder, archived: input.archived },
      },
    })
    return n
  })
}

async function insertarAsignacion(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; staffId: string; payLevelId: string; effectiveFrom: string; actorId: string },
) {
  const nivel = await tx.staffPayLevel.findFirst({ where: { id: input.payLevelId, organizationId: input.organizationId } })
  if (!nivel) throw new NotFoundError('Nivel no encontrado')
  if (nivel.archivedAt) throw new BadRequestError('Ese nivel está archivado; elige otro')
  const miembro = await tx.staffVenue.findFirst({
    where: { staffId: input.staffId, venue: { organizationId: input.organizationId } },
    select: { id: true },
  })
  if (!miembro) throw new BadRequestError('Esa persona no pertenece a esta organización')
  const effectiveFrom = fechaComoDbDate(input.effectiveFrom)
  const ultima = await tx.staffPayLevelAssignment.findFirst({
    where: { organizationId: input.organizationId, staffId: input.staffId, effectiveFrom },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  })
  return tx.staffPayLevelAssignment.create({
    data: {
      organizationId: input.organizationId,
      staffId: input.staffId,
      payLevelId: input.payLevelId,
      effectiveFrom,
      revision: (ultima?.revision ?? 0) + 1,
      createdById: input.actorId,
    },
    select: { id: true, revision: true },
  })
}

export async function asignarNivel(input: {
  organizationId: string
  staffId: string
  payLevelId: string
  effectiveFrom: string
  actorId: string
  venueId: string
  soloSimular: boolean
}) {
  await assertPermisoEnTodasLasSedes(input.actorId, input.organizationId, 'staffpay:manage')
  // Fase 2: aquí se rechaza un effectiveFrom dentro de un periodo cerrado (spec §5.2). En la fase 1 no existen.
  const sedes = await sedesConServicePay(input.organizationId)
  const clasesQueCambian = await contarClasesQueCambian(input.organizationId, sedes, async tx => {
    await insertarAsignacion(tx, input)
  })
  if (input.soloSimular) return { clasesQueCambian }
  const creada = await withSerializableRetry(async tx => {
    const a = await insertarAsignacion(tx, input)
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'STAFF_PAY_LEVEL_ASSIGNED',
      entity: 'StaffPayLevelAssignment',
      entityId: a.id,
      data: {
        staffId: input.staffId,
        payLevelId: input.payLevelId,
        effectiveFrom: input.effectiveFrom,
        revision: a.revision,
        clasesQueCambian,
      },
    })
    return a
  })
  return { clasesQueCambian, asignacionId: creada.id }
}

export async function historialDeNivel(organizationId: string, staffId: string) {
  const rows = await prisma.staffPayLevelAssignment.findMany({
    where: { organizationId, staffId },
    select: { payLevelId: true, effectiveFrom: true, revision: true, payLevel: { select: { name: true } } },
    orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
    take: 100,
  })
  return rows.map(r => ({
    payLevelId: r.payLevelId,
    payLevelName: r.payLevel.name,
    effectiveFrom: dbDateComoFecha(r.effectiveFrom),
    revision: r.revision,
  }))
}

export async function nivelesVigentes(organizationId: string, fecha: string) {
  // La fecha viaja como TEXTO y Postgres la convierte a date: es un día civil, no un instante (guarda rawSqlDateBind).
  const rows = await prisma.$queryRaw<Array<{ staffId: string; payLevelId: string; payLevelName: string; effectiveFrom: Date }>>`
    SELECT DISTINCT ON (a."staffId") a."staffId", a."payLevelId", l.name AS "payLevelName", a."effectiveFrom"
    FROM "StaffPayLevelAssignment" a JOIN "StaffPayLevel" l ON l.id = a."payLevelId"
    WHERE a."organizationId" = ${organizationId} AND a."effectiveFrom" <= ${fecha}::date
    ORDER BY a."staffId", a."effectiveFrom" DESC, a.revision DESC
    LIMIT 2000`
  return rows.map(r => ({ ...r, effectiveFrom: dbDateComoFecha(r.effectiveFrom) }))
}
