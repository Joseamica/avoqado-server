import { Prisma, ServicePayPeriod } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { assertPermisoEnSedes, sedesConServicePay, tienePermisoEn } from './acceso'
import { ampliarAlcance, asegurarPeriodo, bloquearPeriodo, periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, PeriodoCanonico, periodoQueContiene, venuePeriodRange } from './periodos'
import { ClaseValorada, contarPorEstado, FiltroValoracion, valorarClases } from './valoracion'
import { Huella } from './huella'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/** Medido en la Tarea A13 con 50,000 clases. No se baja sin volver a medir (spec §6.3 punto 3). */
export const TIMEOUT_CIERRE_MS = 120_000
export const LOTE_CIERRE = 500
const TZ_DEFAULT = 'America/Mexico_City'

export type Bloqueo =
  | { codigo: 'NO_HA_TERMINADO'; hasta: string }
  | { codigo: 'CLASES_EN_CURSO'; n: number }
  | { codigo: 'EXCEPCIONES'; n: number }
  | { codigo: 'SIN_PERMISO' }
  | { codigo: 'YA_CERRADO' }

export interface PreviewCierre {
  periodo: { id: string | null; start: string; end: string; venueIds: string[] }
  puedeCerrar: boolean
  bloqueos: Bloqueo[]
  clases: number
  excluidas: number
  personas: number
  totalServicios: string
  totalAjustes: string
  total: string
  huerfanas: number
  huella: string
}

export interface ResultadoCierre {
  periodId: string
  start: string
  end: string
  venueIds: string[]
  personas: number
  total: string
  huella: string
  yaCerrado: boolean
}

interface Sede {
  venueId: string
  tz: string
  nombre: string
}
interface Alcance {
  organizationId: string
  periodo: PeriodoCanonico
  periodId: string | null
  estado: 'OPEN' | 'CLOSED'
  venueIds: string[]
  sedes: Sede[]
}

/** Sedes en el orden de `[...venueIds].sort()`: el mismo para la cabecera de la huella y para el recorrido. */
async function sedesDe(db: Db, organizationId: string, venueIds: string[]): Promise<Sede[]> {
  if (!venueIds.length) return []
  const vs = await db.venue.findMany({
    where: { id: { in: venueIds }, organizationId },
    select: { id: true, timezone: true, name: true },
    take: venueIds.length,
  })
  const porId = new Map(vs.map(v => [v.id, v]))
  return [...venueIds].sort().flatMap(id => {
    const v = porId.get(id)
    return v ? [{ venueId: v.id, tz: v.timezone || TZ_DEFAULT, nombre: v.name }] : []
  })
}

/** Alcance de un periodo sin tomar candados (preview). Anticipa el crecimiento de D2 para que la huella coincida. */
async function alcanceSinCandado(organizationId: string, fecha: string): Promise<Alcance> {
  const fila = await periodoQueContieneFecha(prisma, organizationId, fecha)
  const activas = await sedesConServicePay(organizationId)
  if (fila) {
    const venueIds = fila.status === 'OPEN' ? [...new Set([...fila.venueIds, ...activas])].sort() : [...fila.venueIds].sort()
    return {
      organizationId,
      periodo: { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd) },
      periodId: fila.id,
      estado: fila.status,
      venueIds,
      sedes: await sedesDe(prisma, organizationId, venueIds),
    }
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { servicePayPeriodicity: true } })
  const venueIds = [...activas].sort()
  return {
    organizationId,
    periodo: periodoQueContiene(fecha, org.servicePayPeriodicity),
    periodId: null,
    estado: 'OPEN',
    venueIds,
    sedes: await sedesDe(prisma, organizationId, venueIds),
  }
}

async function alcanceDe(tx: Tx, p: ServicePayPeriod): Promise<Alcance> {
  const venueIds = [...p.venueIds].sort()
  return {
    organizationId: p.organizationId,
    periodo: { start: dbDateComoFecha(p.periodStart), end: dbDateComoFecha(p.periodEnd) },
    periodId: p.id,
    estado: p.status,
    venueIds,
    sedes: await sedesDe(tx, p.organizationId, venueIds),
  }
}

/**
 * Modo 'vivo' a propósito, en el preview y en el cierre: un periodo OPEN no tiene clases ancladas (sólo se ancla al
 * cerrar o al liquidar contra un periodo ya cerrado), y el preview puede no tener `periodId`. Una clase CANCELADA no se
 * valora ni se ancla: si después se reactiva, aparece como diferencia de su periodo (spec §6.4).
 */
const filtroDe = (a: Alcance, s: Sede, ahora: Date): FiltroValoracion => {
  const { from, to } = venuePeriodRange(a.periodo, s.tz)
  return { venueId: s.venueId, organizationId: a.organizationId, tz: s.tz, desde: from, hasta: to, ahora }
}

async function bloqueosDe(db: Db, a: Alcance, ahora: Date): Promise<Bloqueo[]> {
  const bloqueos: Bloqueo[] = []
  if (a.estado === 'CLOSED') return [{ codigo: 'YA_CERRADO' }]
  if (a.sedes.some(s => ahora < venuePeriodRange(a.periodo, s.tz).to)) bloqueos.push({ codigo: 'NO_HA_TERMINADO', hasta: a.periodo.end })
  let enCurso = 0
  let excepciones = 0
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    enCurso += await db.classSession.count({
      where: { venueId: s.venueId, startsAt: { gte: f.desde, lt: f.hasta }, endsAt: { gt: ahora }, status: { not: 'CANCELLED' } },
    })
    excepciones += (await contarPorEstado(db, f)).excepciones
  }
  if (enCurso) bloqueos.push({ codigo: 'CLASES_EN_CURSO', n: enCurso })
  if (excepciones) bloqueos.push({ codigo: 'EXCEPCIONES', n: excepciones })
  return bloqueos
}

/** IDs de las reservas de clase sin horario del periodo (spec §5.5), en orden fijo: sede → id. */
async function idsHuerfanas(db: Db, a: Alcance, ahora: Date): Promise<string[]> {
  const ids: string[] = []
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    let despuesDe: string | undefined
    for (;;) {
      const page = await db.reservation.findMany({
        where: {
          venueId: s.venueId,
          startsAt: { gte: f.desde, lt: f.hasta },
          classSessionId: null,
          status: { notIn: ['CANCELLED', 'PENDING'] },
          product: { type: 'CLASS' },
          ...(despuesDe ? { id: { gt: despuesDe } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 1000,
      })
      if (!page.length) break
      ids.push(...page.map(r => r.id))
      despuesDe = page[page.length - 1].id
    }
  }
  return ids
}

type AjusteGuardado = { id: string; staffId: string; venueId: string; amount: Prisma.Decimal }

/** TODOS los ajustes del periodo, por páginas con cursor: un tope de página nunca es un tope contable (Codex R1-3). */
async function ajustesDelPeriodo(db: Db, periodId: string | null): Promise<AjusteGuardado[]> {
  if (!periodId) return []
  const todos: AjusteGuardado[] = []
  let despuesDe: string | undefined
  for (;;) {
    const page = await db.serviceEarning.findMany({
      where: { periodId, concept: { in: ['RECONCILE', 'MANUAL'] }, ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: { id: true, staffId: true, venueId: true, amount: true },
      orderBy: { id: 'asc' },
      take: 1000,
    })
    if (!page.length) return todos
    todos.push(...page)
    despuesDe = page[page.length - 1].id
  }
}

export function descriptorDeClase(c: ClaseValorada, sede: { nombre: string; tz: string }): Prisma.InputJsonObject {
  return {
    clase: c.productName,
    fecha: c.fechaLocal,
    hora: formatInTimeZone(c.startsAt, sede.tz, 'HH:mm'),
    sede: sede.nombre,
    coach: c.staffName,
  }
}

/** Ancla de una vez (spec §5.4): nunca pisa un ancla existente. `updatedAt` en UTC, como lo escribe Prisma. */
export async function anclarClases(
  tx: Tx,
  periodId: string,
  filas: Array<{ classSessionId: string; fechaValoracion: string; tableVersionId: string | null }>,
): Promise<void> {
  if (!filas.length) return
  await tx.$executeRaw`
    INSERT INTO "ClassSessionPayState" ("classSessionId", "originPeriodId", "valuationDate", "valuationVersionId", "payExcluded", "updatedAt")
    SELECT x.cid, ${periodId}, x.fecha::date, x.ver, false, (NOW() AT TIME ZONE 'UTC')
    FROM unnest(${filas.map(f => f.classSessionId)}::text[], ${filas.map(f => f.fechaValoracion)}::text[],
                ${filas.map(f => f.tableVersionId)}::text[]) AS x(cid, fecha, ver)
    ON CONFLICT ("classSessionId") DO UPDATE SET
      "originPeriodId" = EXCLUDED."originPeriodId",
      "valuationDate" = EXCLUDED."valuationDate",
      "valuationVersionId" = EXCLUDED."valuationVersionId",
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "ClassSessionPayState"."originPeriodId" IS NULL`
}

interface Recorrido {
  clases: number
  excluidas: number
  personas: Set<string>
  totalServicios: Prisma.Decimal
  totalAjustes: Prisma.Decimal
  huella: string
}

/**
 * El ÚNICO recorrido de la huella (spec §6.3 puntos 2 y 4), el mismo para el preview y el cierre: cabecera → clases
 * (sede → clase, por lotes con cursor `classSessionId > último`) → ajustes por id → huérfanas por id. Cada lote pasa
 * por la huella ANTES de `alLote` (que en el cierre escribe sus SERVICE y sus anclas). Todo nace dentro de cada llamada:
 * un reintento de `withSerializableRetry` empieza de cero. `digest()` se llama una sola vez.
 */
async function recorrer(
  db: Db,
  a: Alcance,
  ahora: Date,
  o: {
    tamLote: number
    ajustes: AjusteGuardado[]
    huerfanas: string[]
    alLote?: (lote: ClaseValorada[], sede: Sede) => Promise<void>
  },
): Promise<Recorrido> {
  const huella = new Huella()
  huella.cabecera({ organizationId: a.organizationId, ...a.periodo, venueIds: a.venueIds })
  const r = {
    clases: 0,
    excluidas: 0,
    personas: new Set<string>(),
    totalServicios: new Prisma.Decimal(0),
    totalAjustes: new Prisma.Decimal(0),
  }
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    let despuesDe: string | undefined
    for (;;) {
      const lote = await valorarClases(db, f, { despuesDe, limite: o.tamLote })
      if (!lote.length) break
      for (const c of lote) {
        huella.clase(c)
        if (c.estado === 'OK' && c.staffId && c.monto !== null) {
          r.clases++
          r.personas.add(c.staffId)
          r.totalServicios = r.totalServicios.plus(c.monto)
        } else if (c.estado === 'EXCLUIDA') r.excluidas++
      }
      if (o.alLote) await o.alLote(lote, s)
      despuesDe = lote[lote.length - 1].classSessionId
    }
  }
  for (const aj of o.ajustes) {
    huella.ajuste(aj)
    r.totalAjustes = r.totalAjustes.plus(aj.amount)
    r.personas.add(aj.staffId)
  }
  for (const id of o.huerfanas) huella.huerfana(id)
  return { ...r, huella: huella.digest() }
}

async function organizacionDe(venueId: string): Promise<string> {
  return (await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })).organizationId
}

export async function previewCierre(input: {
  userId: string
  venueId: string
  fecha: string
  ahora?: Date
  tamLote?: number
}): Promise<PreviewCierre> {
  const ahora = input.ahora ?? new Date()
  const a = await alcanceSinCandado(await organizacionDe(input.venueId), input.fecha)
  // Permiso ANTES de calcular nada (Codex R1-8): quien no puede cerrar todo el alcance no recibe ni un número de él.
  for (const v of a.venueIds) {
    if (!(await tienePermisoEn(input.userId, v, 'staffpay:close'))) {
      return {
        periodo: { id: a.periodId, start: a.periodo.start, end: a.periodo.end, venueIds: [] },
        puedeCerrar: false,
        bloqueos: [{ codigo: 'SIN_PERMISO' }],
        clases: 0,
        excluidas: 0,
        personas: 0,
        totalServicios: '0.00',
        totalAjustes: '0.00',
        total: '0.00',
        huerfanas: 0,
        huella: '',
      }
    }
  }
  const bloqueos = await bloqueosDe(prisma, a, ahora)
  const ajustes = await ajustesDelPeriodo(prisma, a.periodId)
  const huerfanas = await idsHuerfanas(prisma, a, ahora)
  const r = await recorrer(prisma, a, ahora, { tamLote: input.tamLote ?? LOTE_CIERRE, ajustes, huerfanas })
  return {
    periodo: { id: a.periodId, start: a.periodo.start, end: a.periodo.end, venueIds: a.venueIds },
    puedeCerrar: bloqueos.length === 0,
    bloqueos,
    clases: r.clases,
    excluidas: r.excluidas,
    personas: r.personas.size,
    totalServicios: r.totalServicios.toFixed(2),
    totalAjustes: r.totalAjustes.toFixed(2),
    total: r.totalServicios.plus(r.totalAjustes).toFixed(2),
    huerfanas: huerfanas.length,
    huella: r.huella,
  }
}

async function resultadoGuardado(db: Db, p: ServicePayPeriod, yaCerrado: boolean): Promise<ResultadoCierre> {
  const agg = await db.staffPayStatement.aggregate({ where: { periodId: p.id }, _count: { _all: true }, _sum: { total: true } })
  return {
    periodId: p.id,
    start: dbDateComoFecha(p.periodStart),
    end: dbDateComoFecha(p.periodEnd),
    venueIds: p.venueIds,
    personas: agg._count._all,
    total: (agg._sum.total ?? new Prisma.Decimal(0)).toFixed(2),
    huella: p.closeFingerprint ?? '',
    yaCerrado,
  }
}

export async function cerrarPeriodo(input: {
  userId: string
  venueId: string
  fecha: string
  huellaEsperada: string
  confirmarHuerfanas: boolean
  ahora?: Date
  tamLote?: number
  alTerminarLote?: (n: number) => void
}): Promise<ResultadoCierre> {
  const organizationId = await organizacionDe(input.venueId)
  const ahora = input.ahora ?? new Date()
  const tamLote = input.tamLote ?? LOTE_CIERRE
  return withSerializableRetry(
    async tx => {
      const fila = await asegurarPeriodo(tx, organizationId, input.fecha)
      let p = await bloquearPeriodo(tx, fila.id)
      const sinPermiso = 'Para cerrar necesitas el permiso de cerrar periodos en todas las sedes del periodo'
      // Permiso también ANTES del retorno idempotente (Codex R1-8): un «ya estaba cerrado» no regala los totales.
      if (p.status === 'CLOSED') {
        await assertPermisoEnSedes(input.userId, p.venueIds, 'staffpay:close', sinPermiso)
        return resultadoGuardado(tx, p, true)
      }
      // D2: el cierre suma las sedes que hoy tienen el módulo, con permiso en cada una (`ampliarAlcance`).
      p = await ampliarAlcance(tx, p, await sedesConServicePay(organizationId), input.userId)
      await assertPermisoEnSedes(input.userId, p.venueIds, 'staffpay:close', sinPermiso)
      const a = await alcanceDe(tx, p)
      const bloqueos = await bloqueosDe(tx, a, ahora)
      const b = (codigo: Bloqueo['codigo']) => bloqueos.find(x => x.codigo === codigo)
      if (b('NO_HA_TERMINADO'))
        throw new BadRequestError(`El periodo termina el ${a.periodo.end}: todavía no se puede cerrar`, 'PERIODO_NO_TERMINA')
      const enCurso = b('CLASES_EN_CURSO') as { n: number } | undefined
      if (enCurso) throw new BadRequestError(`Hay ${enCurso.n} clase(s) en curso: espera a que terminen`, 'CLASES_EN_CURSO')
      const exc = b('EXCEPCIONES') as { n: number } | undefined
      if (exc)
        throw new BadRequestError(`Quedan ${exc.n} clase(s) que no se pueden pagar todavía: resuélvelas antes de cerrar`, 'HAY_EXCEPCIONES')
      const huerfanas = await idsHuerfanas(tx, a, ahora)
      if (huerfanas.length && !input.confirmarHuerfanas) {
        throw new BadRequestError(
          `Confirma que las ${huerfanas.length} reserva(s) de clase sin horario no cuentan para ningún pago`,
          'HUERFANAS_SIN_CONFIRMAR',
        )
      }

      // Los ajustes se LEEN antes de escribir los SERVICE y se hashean después de las clases, igual que en el preview.
      const ajustes = await ajustesDelPeriodo(tx, p.id)
      let lotes = 0
      const r = await recorrer(tx, a, ahora, {
        tamLote,
        ajustes,
        huerfanas,
        alLote: async (lote, sede) => {
          const pagables = lote.filter(c => c.estado === 'OK' && c.staffId && c.monto !== null)
          if (pagables.length) {
            await tx.serviceEarning.createMany({
              data: pagables.map(c => ({
                organizationId,
                venueId: c.venueId,
                periodId: p.id,
                staffId: c.staffId!,
                concept: 'SERVICE' as const,
                sourceType: 'CLASS_SESSION' as const,
                sourceId: c.classSessionId,
                occurredAt: c.startsAt,
                payLevelId: c.payLevelId,
                payLevelName: c.payLevelName,
                tableVersionId: c.tableVersionId,
                countMode: c.countMode,
                count: c.conteo,
                amount: new Prisma.Decimal(c.monto!),
                descriptor: descriptorDeClase(c, sede),
                createdById: input.userId,
              })),
            })
          }
          await anclarClases(tx, p.id, lote)
          input.alTerminarLote?.(++lotes)
        },
      })
      if (r.huella !== input.huellaEsperada) {
        // El preview nuevo corre con el cliente global (fuera de esta transacción, que se va a revertir): muestra el
        // estado real de la base, que es lo que el usuario tiene que volver a revisar.
        throw new ConflictError('Los números cambiaron desde que los revisaste: revisa el cierre de nuevo', 'HUELLA_CAMBIO', {
          preview: await previewCierre({ userId: input.userId, venueId: input.venueId, fecha: input.fecha, ahora, tamLote }),
        })
      }

      // Recibos: suma de lo YA ESCRITO del periodo (servicios y ajustes), uno por persona — quien sólo tiene un bono también.
      const sumas = await tx.serviceEarning.groupBy({ by: ['staffId'], where: { periodId: p.id }, _sum: { amount: true } })
      if (sumas.length) {
        await tx.staffPayStatement.createMany({
          data: sumas.map(s => ({ periodId: p.id, staffId: s.staffId, total: s._sum.amount ?? new Prisma.Decimal(0) })),
        })
      }
      const cerrado = await tx.servicePayPeriod.updateMany({
        where: { id: p.id, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: new Date(), closedById: input.userId, closeFingerprint: r.huella },
      })
      if (cerrado.count !== 1) throw new ConflictError('El periodo cambió mientras se cerraba: revisa de nuevo')
      const total = sumas.reduce((acc, s) => acc.plus(s._sum.amount ?? 0), new Prisma.Decimal(0))
      await writeLegacyActivityAuditTx(tx, {
        staffId: input.userId,
        venueId: input.venueId,
        action: 'SERVICE_PAY_PERIOD_CLOSED',
        entity: 'ServicePayPeriod',
        entityId: p.id,
        data: {
          periodo: { start: a.periodo.start, end: a.periodo.end },
          venueIds: a.venueIds,
          clases: r.clases,
          excluidas: r.excluidas,
          personas: sumas.length,
          total: total.toFixed(2),
          huella: r.huella,
          huerfanas,
        },
      })
      return {
        periodId: p.id,
        start: a.periodo.start,
        end: a.periodo.end,
        venueIds: a.venueIds,
        personas: sumas.length,
        total: total.toFixed(2),
        huella: r.huella,
        yaCerrado: false,
      }
    },
    { timeoutMs: TIMEOUT_CIERRE_MS },
  )
}
