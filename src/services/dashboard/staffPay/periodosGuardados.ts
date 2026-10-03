import { Prisma, ServicePayPeriod } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { assertPermisoEnSedes, assertPermisoEnTodasLasSedes, sedesConServicePay, sedesLegiblesDe } from './acceso'
import { dbDateComoFecha, fechaComoDbDate, hoyLocal, Periodicidad, periodoQueContiene } from './periodos'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/** Candado por organización para crear periodos y cambiar la periodicidad (spec §5.7). */
export async function lockPeriodosDeOrganizacion(tx: Tx, organizationId: string): Promise<void> {
  const key = `avoqado:service-pay-periods:v1:${organizationId}`
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`)
}

export async function periodoQueContieneFecha(db: Db, organizationId: string, fecha: string): Promise<ServicePayPeriod | null> {
  const d = fechaComoDbDate(fecha)
  return db.servicePayPeriod.findFirst({ where: { organizationId, periodStart: { lte: d }, periodEnd: { gte: d } } })
}

/** El periodo que contiene `fecha`; si no existe, se deriva de la periodicidad y se crea bajo el candado. */
export async function asegurarPeriodo(tx: Tx, organizationId: string, fecha: string): Promise<ServicePayPeriod> {
  const existente = await periodoQueContieneFecha(tx, organizationId, fecha)
  if (existente) return existente
  await lockPeriodosDeOrganizacion(tx, organizationId)
  const ganador = await periodoQueContieneFecha(tx, organizationId, fecha)
  if (ganador) return ganador
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { servicePayPeriodicity: true } })
  const p = periodoQueContiene(fecha, org.servicePayPeriodicity)
  const traslape = await tx.servicePayPeriod.findFirst({
    where: { organizationId, periodStart: { lte: fechaComoDbDate(p.end) }, periodEnd: { gte: fechaComoDbDate(p.start) } },
    select: { id: true },
  })
  if (traslape) throw new ConflictError('Ya hay un periodo guardado que se cruza con estas fechas')
  return tx.servicePayPeriod.create({
    data: {
      organizationId,
      periodStart: fechaComoDbDate(p.start),
      periodEnd: fechaComoDbDate(p.end),
      venueIds: (await sedesConServicePay(organizationId)).sort(),
    },
  })
}

/**
 * Candado de UNA clase (spec §5 paso 2), compartido por el ajuste de clase y la liquidación (Codex R1-6). El cierre NO lo
 * toma (serían 50,000 candados): el cierre se protege con el candado del periodo —o el de la organización mientras crea
 * el periodo—, que el ajuste toma ANTES que éste. Orden único: periodo (u organización) → clase.
 */
export async function lockClase(tx: Tx, classSessionId: string): Promise<void> {
  const key = `avoqado:service-pay-class:v1:${classSessionId}`
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`)
}

/** Candado del periodo (spec §5 paso 2). Sólo bloquea: ampliar el alcance es `ampliarAlcance`, con permiso (Codex R1-9). */
export async function bloquearPeriodo(tx: Tx, periodId: string): Promise<ServicePayPeriod> {
  const filas = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "ServicePayPeriod" WHERE id = ${periodId} FOR UPDATE`)
  if (!filas.length) throw new NotFoundError('Periodo no encontrado')
  return tx.servicePayPeriod.findUniqueOrThrow({ where: { id: periodId } })
}

/**
 * Amplía el alcance de un periodo OPEN ya bloqueado (spec §5.6, §5.7; D2). Exige `staffpay:close` del actor en TODA la
 * unión —las sedes que el periodo ya tiene más las nuevas—, no sólo en las nuevas (Codex R2-R1-9): con permiso sólo en
 * BSF nadie amplía un periodo de PN a PN+BSF. `exigirModulo` (default true) pide que la sede tenga hoy el módulo; la
 * liquidación lo apaga para que la deuda de una sede que se desactivó tenga dónde caer (spec §5.6).
 */
export async function ampliarAlcance(
  tx: Tx,
  p: ServicePayPeriod,
  venueIds: string[],
  userId: string,
  o: { exigirModulo?: boolean } = {},
): Promise<ServicePayPeriod> {
  const nuevas = [...new Set(venueIds)].filter(v => !p.venueIds.includes(v)).sort()
  if (!nuevas.length) return p
  if (p.status !== 'OPEN') throw new ConflictError('Ese periodo ya está cerrado: su alcance no cambia', 'PERIODO_CERRADO')
  const deLaOrg = await tx.venue.count({ where: { id: { in: nuevas }, organizationId: p.organizationId } })
  if (deLaOrg !== nuevas.length) throw new NotFoundError('Sede no encontrada')
  if (o.exigirModulo !== false) {
    const activas = await sedesConServicePay(p.organizationId)
    if (nuevas.some(v => !activas.includes(v))) throw new BadRequestError('Esa sede no tiene Pago por servicio activo', 'SEDE_SIN_MODULO')
  }
  const union = [...p.venueIds, ...nuevas].sort()
  await assertPermisoEnSedes(
    userId,
    union,
    'staffpay:close',
    'Para sumar una sede al periodo necesitas el permiso de cerrar periodos en todas sus sedes',
  )
  return tx.servicePayPeriod.update({ where: { id: p.id }, data: { venueIds: union } })
}

/**
 * Alcance LEGIBLE de un periodo, el MISMO para el reporte y el recibo (Codex R1-1, R3-Nuevo 2): uno CERRADO se lee sobre
 * SU alcance guardado; uno ABIERTO (o aún sin guardar) sobre sus sedes guardadas ∪ las que hoy tienen el módulo —así una
 * diferencia liquidada desde una sede que ya lo apagó no desaparece del reporte—. Siempre filtrado por el permiso de
 * quien lee y, si viene, por `sede` (si no es legible: vacío y `parcial`).
 */
export async function alcanceLegibleDelPeriodo(
  userId: string,
  organizationId: string,
  fila: { status: string; venueIds: string[] } | null,
  sede?: string,
): Promise<{ venueIds: string[]; parcial: boolean }> {
  const alcance =
    fila?.status === 'CLOSED' ? fila.venueIds : [...new Set([...(fila?.venueIds ?? []), ...(await sedesConServicePay(organizationId))])]
  const legibles = await sedesLegiblesDe(userId, alcance)
  const venueIds = sede ? legibles.venueIds.filter(id => id === sede) : legibles.venueIds
  return { venueIds, parcial: legibles.parcial || (sede !== undefined && venueIds.length === 0) }
}

/** Spec §5.2 y §5.3: una vigencia (o un archivo) dentro de un periodo cerrado no se acepta. */
export async function assertFechaNoCerrada(db: Db, organizationId: string, fecha: string): Promise<void> {
  const p = await periodoQueContieneFecha(db, organizationId, fecha)
  if (p?.status === 'CLOSED') {
    throw new BadRequestError(
      `El periodo del ${dbDateComoFecha(p.periodStart)} al ${dbDateComoFecha(p.periodEnd)} ya está cerrado: elige una fecha posterior`,
    )
  }
}

export interface PeriodoListado {
  id: string | null
  start: string
  end: string
  estado: 'OPEN' | 'CLOSED'
  personas: number
  pagadas: number
  total: string
}
export interface ListaPeriodos {
  periodicidad: Periodicidad
  puedeCambiarPeriodicidad: boolean
  items: PeriodoListado[]
  /** Para «Cargar más» del historial guardado: periodos que empiezan antes de esta fecha. */
  antesDe: string | null
}

const PERIODOS_CANONICOS = 12

/** Los últimos N periodos canónicos hasta el actual (D1: no hace falta guardarlos para poder cerrarlos — Codex R1-16). */
function canonicosHastaHoy(hoy: string, periodicidad: Periodicidad, n: number) {
  const out = [periodoQueContiene(hoy, periodicidad)]
  while (out.length < n) {
    const previo = new Date(`${out[out.length - 1].start}T12:00:00Z`)
    previo.setUTCDate(previo.getUTCDate() - 1)
    out.push(periodoQueContiene(previo.toISOString().slice(0, 10), periodicidad))
  }
  return out
}

/**
 * Lista de periodos (spec §7.3). La primera página mezcla los últimos 12 periodos canónicos (aunque no estén guardados:
 * septiembre se puede cerrar el 1 de octubre sin que nadie lo haya «creado») con los guardados; las siguientes traen
 * sólo guardados más viejos. Los números salen de las sedes del alcance de cada periodo que el usuario puede leer.
 */
export async function listarPeriodos(input: { userId: string; venueId: string; antesDe?: string; limit: number }): Promise<ListaPeriodos> {
  const v = await prisma.venue.findUniqueOrThrow({
    where: { id: input.venueId },
    select: { organizationId: true, timezone: true, organization: { select: { servicePayPeriodicity: true } } },
  })
  const limit = Math.min(Math.max(input.limit, 1), 60)
  const periodicidad = v.organization.servicePayPeriodicity
  const filas = await prisma.servicePayPeriod.findMany({
    where: { organizationId: v.organizationId, ...(input.antesDe ? { periodStart: { lt: fechaComoDbDate(input.antesDe) } } : {}) },
    orderBy: { periodStart: 'desc' },
    take: limit + 1,
  })
  const hayMas = filas.length > limit
  const guardados = filas.slice(0, limit)
  const alcance = [...new Set(guardados.flatMap(f => f.venueIds))]
  const { venueIds } = await sedesLegiblesDe(input.userId, alcance)
  const resumen =
    guardados.length && venueIds.length
      ? await prisma.$queryRaw<Array<{ periodId: string; personas: number; pagadas: number; total: Prisma.Decimal | null }>>`
        SELECT e."periodId", COUNT(DISTINCT e."staffId")::int AS personas,
               COUNT(DISTINCT e."staffId") FILTER (WHERE st."paidAt" IS NOT NULL)::int AS pagadas,
               SUM(e.amount) AS total
        FROM "ServiceEarning" e
        LEFT JOIN "StaffPayStatement" st ON st."periodId" = e."periodId" AND st."staffId" = e."staffId"
        WHERE e."periodId" IN (${Prisma.join(guardados.map(f => f.id))}) AND e."venueId" IN (${Prisma.join(venueIds)})
        GROUP BY e."periodId"`
      : []
  const porId = new Map(resumen.map(r => [r.periodId, r]))
  const items: PeriodoListado[] = guardados.map(f => ({
    id: f.id,
    start: dbDateComoFecha(f.periodStart),
    end: dbDateComoFecha(f.periodEnd),
    estado: f.status,
    personas: porId.get(f.id)?.personas ?? 0,
    pagadas: porId.get(f.id)?.pagadas ?? 0,
    total: (porId.get(f.id)?.total ?? new Prisma.Decimal(0)).toFixed(2),
  }))
  if (!input.antesDe) {
    for (const c of canonicosHastaHoy(hoyLocal(v.timezone || 'America/Mexico_City'), periodicidad, PERIODOS_CANONICOS)) {
      const cubierto = guardados.some(f => dbDateComoFecha(f.periodStart) <= c.end && dbDateComoFecha(f.periodEnd) >= c.start)
      if (!cubierto) items.push({ id: null, start: c.start, end: c.end, estado: 'OPEN', personas: 0, pagadas: 0, total: '0.00' })
    }
    items.sort((x, y) => y.start.localeCompare(x.start))
  }
  const totalGuardados = input.antesDe ? 1 : await prisma.servicePayPeriod.count({ where: { organizationId: v.organizationId } })
  return {
    periodicidad,
    puedeCambiarPeriodicidad: !input.antesDe && totalGuardados === 0,
    items,
    antesDe: hayMas ? dbDateComoFecha(guardados[guardados.length - 1].periodStart) : null,
  }
}

/** D3: mensual o quincenal, sólo mientras no haya ningún periodo guardado (spec §5.7). */
export async function cambiarPeriodicidad(input: { userId: string; venueId: string; periodicidad: Periodicidad }) {
  if (input.periodicidad !== 'MONTHLY' && input.periodicidad !== 'SEMIMONTHLY') throw new BadRequestError('Periodicidad inválida')
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  await assertPermisoEnTodasLasSedes(input.userId, v.organizationId, 'staffpay:close')
  return withSerializableRetry(async tx => {
    await lockPeriodosDeOrganizacion(tx, v.organizationId)
    if ((await tx.servicePayPeriod.count({ where: { organizationId: v.organizationId } })) > 0) {
      throw new ConflictError('La periodicidad ya no se puede cambiar: ya hay periodos guardados')
    }
    const antes = await tx.organization.findUniqueOrThrow({ where: { id: v.organizationId }, select: { servicePayPeriodicity: true } })
    await tx.organization.update({ where: { id: v.organizationId }, data: { servicePayPeriodicity: input.periodicidad } })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.userId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_PERIODICITY_SET',
      entity: 'Organization',
      entityId: v.organizationId,
      data: { antes: antes.servicePayPeriodicity, despues: input.periodicidad },
    })
    return { periodicidad: input.periodicidad }
  })
}
