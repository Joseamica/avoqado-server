import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { sedesLegibles } from './acceso'
import { ClaseValorada, contarPorEstado, FiltroValoracion, llegoAlTopePersonas, resumenPorPersona, valorarClases } from './valoracion'
import { hoyLocal, periodoQueContiene, PeriodoCanonico, venuePeriodRange } from './periodos'
import { nivelesVigentes } from './niveles.service'

export type ClaseValoradaDto = Omit<ClaseValorada, 'monto'> & { monto: string | null }
const dto = (c: ClaseValorada): ClaseValoradaDto => ({ ...c, monto: c.monto ? new Prisma.Decimal(c.monto).toFixed(2) : null })

interface Contexto {
  organizationId: string
  periodicidad: 'MONTHLY' | 'SEMIMONTHLY'
  periodo: PeriodoCanonico
  venueIds: string[]
  parcial: boolean
  filtros: FiltroValoracion[]
}

/**
 * Alcance del reporte: las sedes con el módulo que el usuario puede leer (spec §9.2) y, si pidió `sede` (filtro de sede,
 * spec §7.3), sólo la intersección con esa sede. Una sede no legible o sin el módulo da alcance VACÍO, nunca otras sedes,
 * y entonces `parcial` es true: el usuario no está viendo lo que pidió.
 */
async function contexto(userId: string, venueId: string, fecha?: string, sede?: string): Promise<Contexto> {
  const v = await prisma.venue.findUniqueOrThrow({
    where: { id: venueId },
    select: { organizationId: true, timezone: true, organization: { select: { servicePayPeriodicity: true } } },
  })
  const tzBase = v.timezone || 'America/Mexico_City'
  const periodicidad = v.organization.servicePayPeriodicity
  const periodo = periodoQueContiene(fecha ?? hoyLocal(tzBase), periodicidad)
  const legibles = await sedesLegibles(userId, v.organizationId)
  const venueIds = sede ? legibles.venueIds.filter(id => id === sede) : legibles.venueIds
  const parcial = legibles.parcial || (sede !== undefined && venueIds.length === 0)
  const venues = venueIds.length
    ? await prisma.venue.findMany({
        where: { id: { in: venueIds }, organizationId: v.organizationId },
        select: { id: true, timezone: true },
        take: venueIds.length,
      })
    : []
  const tzDe = new Map(venues.map(x => [x.id, x.timezone || 'America/Mexico_City']))
  const ahora = new Date()
  const filtros = venueIds.map(id => {
    const tz = tzDe.get(id)!
    const { from, to } = venuePeriodRange(periodo, tz)
    return { venueId: id, organizationId: v.organizationId, tz, desde: from, hasta: to, ahora }
  })
  return { organizationId: v.organizationId, periodicidad, periodo, venueIds, parcial, filtros }
}

export async function reportePeriodo(input: {
  userId: string
  venueId: string
  fecha?: string
  sede?: string
  offset: number
  limit: number
}) {
  const c = await contexto(input.userId, input.venueId, input.fecha, input.sede)
  // El MCP llama sin la validación de la ruta: el offset se acota aquí también.
  const offset = Math.max(0, Math.trunc(input.offset) || 0)
  let truncado = false
  let total = new Prisma.Decimal(0)
  let clases = 0,
    excepciones = 0,
    excluidas = 0
  const porPersona = new Map<
    string,
    { staffId: string; staffName: string; venueIds: string[]; clases: number; sumaLugares: number; total: Prisma.Decimal }
  >()
  for (const f of c.filtros) {
    const e = await contarPorEstado(prisma, f)
    total = total.plus(e.total)
    clases += e.ok
    excepciones += e.excepciones
    excluidas += e.excluidas
    const resumen = await resumenPorPersona(prisma, f)
    if (llegoAlTopePersonas(resumen.length)) truncado = true
    for (const r of resumen) {
      const p = porPersona.get(r.staffId) ?? {
        staffId: r.staffId,
        staffName: r.staffName,
        venueIds: [],
        clases: 0,
        sumaLugares: 0,
        total: new Prisma.Decimal(0),
      }
      p.venueIds.push(f.venueId)
      p.clases += r.clases
      p.sumaLugares += r.sumaLugares
      p.total = p.total.plus(r.total)
      porPersona.set(r.staffId, p)
    }
  }
  const niveles = new Map(
    porPersona.size ? (await nivelesVigentes(c.organizationId, c.periodo.end)).map(n => [n.staffId, n.payLevelName]) : [],
  )
  const todas = [...porPersona.values()].sort((a, b) => b.total.comparedTo(a.total) || a.staffId.localeCompare(b.staffId))
  const limit = Math.min(Math.max(input.limit, 1), 100)
  const items = todas.slice(offset, offset + limit).map(p => ({
    staffId: p.staffId,
    staffName: p.staffName,
    payLevelName: niveles.get(p.staffId) ?? null,
    venueIds: p.venueIds,
    clases: p.clases,
    promedioLugares: p.clases ? Math.round((p.sumaLugares / p.clases) * 10) / 10 : 0,
    total: p.total.toFixed(2),
  }))
  return {
    periodo: { ...c.periodo, periodicidad: c.periodicidad },
    parcial: c.parcial,
    venueIds: c.venueIds,
    truncado,
    tarjetas: { total: total.toFixed(2), clases, personas: porPersona.size, excepciones, excluidas },
    personas: { items, total: todas.length, offset, limit },
    huerfanas: await contarHuerfanas(c),
  }
}

async function recorrer(
  c: Contexto,
  extra: Partial<FiltroValoracion>,
  despuesDe: string | undefined,
  limit: number,
  soloExcepciones = false,
) {
  const lim = Math.min(Math.max(limit, 1), 100)
  // Cursor "<venueId>:<classSessionId>": se recorre sede por sede en el orden de venueIds.
  const [venueCursor, claseDelCursor] = despuesDe ? despuesDe.split(':') : [undefined, undefined]
  let claseCursor: string | undefined = claseDelCursor
  const items: ClaseValoradaDto[] = []
  let idx = venueCursor ? c.filtros.findIndex(f => f.venueId === venueCursor) : 0
  if (idx < 0) {
    // La sede del cursor ya no es legible (o el cursor es basura): se arranca de cero, sin heredar la clase.
    idx = 0
    claseCursor = undefined
  }
  for (; idx < c.filtros.length && items.length < lim; idx++) {
    const f = { ...c.filtros[idx], ...extra }
    const page = await valorarClases(prisma, f, { despuesDe: claseCursor, limite: lim - items.length, soloExcepciones })
    items.push(...page.map(dto))
    claseCursor = undefined
    if (items.length >= lim) {
      const last = items[items.length - 1]
      return { items, nextCursor: `${last.venueId}:${last.classSessionId}` }
    }
  }
  return { items, nextCursor: null }
}

export async function detallePersona(input: {
  userId: string
  venueId: string
  staffId: string
  fecha?: string
  sede?: string
  despuesDe?: string
  limit: number
}) {
  return recorrer(
    await contexto(input.userId, input.venueId, input.fecha, input.sede),
    { staffId: input.staffId },
    input.despuesDe,
    input.limit,
  )
}

export async function excepcionesPeriodo(input: {
  userId: string
  venueId: string
  fecha?: string
  sede?: string
  despuesDe?: string
  limit: number
}) {
  return recorrer(await contexto(input.userId, input.venueId, input.fecha, input.sede), {}, input.despuesDe, input.limit, true)
}

function whereHuerfanas(c: Contexto): Prisma.ReservationWhereInput {
  return {
    OR: c.filtros.map(f => ({ venueId: f.venueId, startsAt: { gte: f.desde, lt: f.hasta } })),
    classSessionId: null,
    status: { notIn: ['CANCELLED', 'PENDING'] },
    product: { type: 'CLASS' },
  }
}

async function contarHuerfanas(c: Contexto): Promise<number> {
  if (!c.filtros.length) return 0
  return prisma.reservation.count({ where: whereHuerfanas(c) })
}

export async function huerfanasPeriodo(input: {
  userId: string
  venueId: string
  fecha?: string
  sede?: string
  offset: number
  limit: number
}) {
  const c = await contexto(input.userId, input.venueId, input.fecha, input.sede)
  if (!c.filtros.length) return { items: [], total: 0 }
  const where = whereHuerfanas(c)
  const [rows, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      select: {
        id: true,
        startsAt: true,
        guestName: true,
        venueId: true,
        product: { select: { name: true } },
        customer: { select: { firstName: true, lastName: true } },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      skip: Math.max(0, Math.trunc(input.offset) || 0),
      take: Math.min(Math.max(input.limit, 1), 100),
    }),
    prisma.reservation.count({ where }),
  ])
  return {
    items: rows.map(r => ({
      reservationId: r.id,
      startsAt: r.startsAt,
      venueId: r.venueId,
      productName: r.product?.name ?? null,
      guestName: r.guestName ?? ([r.customer?.firstName, r.customer?.lastName].filter(Boolean).join(' ') || null),
    })),
    total,
  }
}
