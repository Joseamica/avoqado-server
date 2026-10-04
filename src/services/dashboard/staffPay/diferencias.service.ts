import { Prisma, ServicePayPeriod } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { NotFoundError } from '../../../errors/AppError'
import { utcTs } from '../../../utils/sqlDates'
import { venueDayKey } from '../../../utils/venueDateKeys'
import { sedesLegiblesDe } from './acceso'
import { periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, venuePeriodRange } from './periodos'
import { FiltroValoracion, MotivoExcepcion, valoracionCte } from './valoracion'

type Db = Prisma.TransactionClient | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'
/** Clases valoradas por lote al recorrer un periodo (el mismo tamaño que el cierre, A13). */
export const LOTE_DIFERENCIAS = 500
const TOPE_PAGINA = 100
/** Ids «sin ancla» que se cargan de una vez por sede y página (casi siempre unas cuantas). */
const TOPE_SIN_ANCLA = 5000

export interface FilaDiferencia {
  classSessionId: string
  venueId: string
  productName: string
  startsAt: Date
  fechaLocal: string
  fechaValoracion: string
  periodoOrigenId: string | null
  /** null: la clase está en excepción y no hay nadie a quien atribuirla (sin coach y sin líneas) — Codex R1-17. */
  persona: string | null
  personaNombre: string | null
  coachActual: string | null
  estadoClase: 'OK' | 'EXCLUIDA' | 'EXCEPCION'
  motivo: MotivoExcepcion | null
  corresponde: string | null
  congelado: string
  conciliado: string
  /** null: la clase está en excepción (D5): no se liquida hasta resolverla. */
  pendiente: string | null
  payLevelId: string | null
  payLevelName: string | null
  tableVersionId: string | null
  countMode: string | null
  conteo: number
}

type Fila = Omit<FilaDiferencia, 'corresponde' | 'congelado' | 'conciliado' | 'pendiente'> & {
  corresponde: Prisma.Decimal | null
  congelado: Prisma.Decimal
  conciliado: Prisma.Decimal
  pendiente: Prisma.Decimal | null
}

const dinero = (d: Prisma.Decimal) => new Prisma.Decimal(d).toFixed(2)
const aDto = (f: Fila): FilaDiferencia => ({
  ...f,
  corresponde: f.corresponde === null ? null : dinero(f.corresponde),
  congelado: dinero(f.congelado),
  conciliado: dinero(f.conciliado),
  pendiente: f.pendiente === null ? null : dinero(f.pendiente),
})

type CursorFila = { classSessionId: string; persona: string }

/**
 * LA valoración (spec §6.1) en modo 'periodo' de UN lote de clases (`f.claseIds`, nunca vacío), envuelta (spec §6.4):
 * una fila por clase y persona, con personas = coach de hoy ∪ quien ya tiene SERVICE o RECONCILE de la clase.
 * pendiente = corresponde hoy − SERVICE congelado − todos sus RECONCILE; en excepción, null para todas sus filas (D5).
 * Sin LIMIT: lo acota el lote de clases. Orden fijo (clase, persona) para el cursor.
 */
export function diferenciasSql(f: FiltroValoracion, despues: CursorFila | null, soloPendientes: boolean): Prisma.Sql {
  const trasFila = despues
    ? Prisma.sql`AND (y."classSessionId", COALESCE(y.persona, '')) > (${despues.classSessionId}::text, ${despues.persona}::text)`
    : Prisma.empty
  const filtro = soloPendientes ? Prisma.sql`AND (y.pendiente IS NULL OR y.pendiente <> 0)` : Prisma.empty
  return Prisma.sql`
    ${valoracionCte(f)},
    lineas AS (
      SELECT e."sourceId" AS cid, e."staffId",
             COALESCE(SUM(e.amount) FILTER (WHERE e.concept = 'SERVICE'), 0) AS congelado,
             COALESCE(SUM(e.amount) FILTER (WHERE e.concept = 'RECONCILE'), 0) AS conciliado
      FROM "ServiceEarning" e
      WHERE e."organizationId" = ${f.organizationId}
        AND e."sourceType" = 'CLASS_SESSION' AND e.concept IN ('SERVICE', 'RECONCILE')
        AND e."sourceId" IN (SELECT "classSessionId" FROM valoradas)
      GROUP BY e."sourceId", e."staffId"
    ),
    personas AS (
      SELECT "classSessionId" AS cid, "staffId" AS persona FROM valoradas WHERE "staffId" IS NOT NULL
      UNION
      SELECT cid, "staffId" AS persona FROM lineas
    ),
    x AS (
      SELECT v."classSessionId", v."venueId", v."productName", v."startsAt", v."fechaLocal", v."fechaValoracion",
             v."periodoOrigen" AS "periodoOrigenId", p.persona, v."staffId" AS "coachActual",
             v.estado AS "estadoClase", v.motivo, v."payLevelId", v."payLevelName", v."tableVersionId", v."countMode", v.conteo,
             CASE WHEN v.estado = 'EXCEPCION' THEN NULL
                  WHEN v.estado = 'OK' AND p.persona = v."staffId" THEN v.monto
                  ELSE 0 END AS corresponde,
             COALESCE(l.congelado, 0) AS congelado,
             COALESCE(l.conciliado, 0) AS conciliado
      FROM valoradas v
      LEFT JOIN personas p ON p.cid = v."classSessionId"
      LEFT JOIN lineas l ON l.cid = p.cid AND l."staffId" = p.persona
      -- Una clase en excepción SIN nadie (sin coach y sin líneas) no puede desaparecer: sale con persona NULL (R1-17).
      WHERE p.persona IS NOT NULL OR v.estado = 'EXCEPCION'
    ),
    -- El pendiente en su propio paso: un alias del SELECT no se puede usar en el WHERE.
    y AS (
      SELECT x.*, x.corresponde - x.congelado - x.conciliado AS pendiente FROM x
    )
    SELECT y.*, NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), '') AS "personaNombre"
    FROM y
    LEFT JOIN "Staff" s ON s.id = y.persona
    WHERE true ${trasFila} ${filtro}
    ORDER BY y."classSessionId" ASC, COALESCE(y.persona, '') ASC`
}

type Desde = { id: string; incluido: boolean } | null
type FiltroDelPeriodo = FiltroValoracion & { periodId: string }
/** `desde.incluido` reanuda EN la clase del cursor (le faltan personas); si no, después de ella. */
const tras = (desde: Desde, col: Prisma.Sql) =>
  desde ? Prisma.sql`AND ${col} ${Prisma.raw(desde.incluido ? '>=' : '>')} ${desde.id}` : Prisma.empty

/**
 * Rama «sin ancla» de las candidatas (spec §6.4): las clases de la sede cuya fecha cae en el periodo y no tienen ancla —
 * las que llegaron tarde y las canceladas—, por llave. Después de un cierre casi no hay, pero encontrarlas recorre todo el
 * rango de la sede (ninguna columna dice «sin ancla»): por eso se piden UNA vez por página y no en cada lote (medido B1).
 */
export const idsSinAncla = (f: FiltroDelPeriodo, desde: Desde, n: number) => Prisma.sql`
  SELECT cs.id
  FROM "ClassSession" cs LEFT JOIN "ClassSessionPayState" ps ON ps."classSessionId" = cs.id
  WHERE cs."venueId" = ${f.venueId} AND cs."startsAt" >= ${utcTs(f.desde)} AND cs."startsAt" < ${utcTs(f.hasta)}
    AND ps."originPeriodId" IS NULL ${tras(desde, Prisma.sql`cs.id`)}
  ORDER BY cs.id ASC
  LIMIT ${n}`

/**
 * Los siguientes `n` ids candidatos de un periodo cerrado en una sede (spec §6.4), por llave y en el orden de la base: las
 * ANCLADAS en el periodo, por id y sin importar su fecha de hoy (una reprogramada a otro mes sigue aquí), ∪ las SIN ancla.
 * Como `consultaIdsDelLote` del cierre (A13): se pagina ANTES de valorar y sólo esos ids se valoran; lo demás (terminada,
 * cancelada = $0) lo aplica la valoración. `sinAncla`: la rama sin ancla ya cargada (lo que falta, en orden); null = se busca
 * en la tabla en cada lote (más lento, igual de correcto).
 */
export const idsCandidatas = (f: FiltroDelPeriodo, desde: Desde, n: number, sinAncla: string[] | null) => {
  const ramas = [
    Prisma.sql`(SELECT ps."classSessionId" AS id
       FROM "ClassSessionPayState" ps JOIN "ClassSession" cs ON cs.id = ps."classSessionId"
       WHERE ps."originPeriodId" = ${f.periodId} AND cs."venueId" = ${f.venueId} ${tras(desde, Prisma.sql`ps."classSessionId"`)}
       ORDER BY ps."classSessionId" ASC LIMIT ${n})`,
  ]
  if (sinAncla === null) ramas.push(Prisma.sql`(${idsSinAncla(f, desde, n)})`)
  else if (sinAncla.length)
    ramas.push(Prisma.sql`(SELECT x AS id FROM unnest(${sinAncla}::text[]) x WHERE true ${tras(desde, Prisma.sql`x`)})`)
  return Prisma.sql`SELECT id FROM (${Prisma.join(ramas, ' UNION ALL ')}) u ORDER BY id ASC LIMIT ${n}`
}

/** El periodo cerrado del que una clase es candidata: su ancla, o el cerrado que contiene su fecha (llegó tarde). */
export async function origenDeClase(
  db: Db,
  cs: {
    startsAt: Date
    endsAt: Date
    venue: { organizationId: string; timezone: string | null }
    payState: { originPeriodId: string | null } | null
  },
  ahora: Date,
): Promise<ServicePayPeriod | null> {
  if (cs.payState?.originPeriodId) {
    return db.servicePayPeriod.findFirst({ where: { id: cs.payState.originPeriodId, organizationId: cs.venue.organizationId } })
  }
  if (cs.endsAt > ahora) return null
  const p = await periodoQueContieneFecha(db, cs.venue.organizationId, venueDayKey(cs.startsAt, cs.venue.timezone || TZ_DEFAULT))
  return p?.status === 'CLOSED' ? p : null
}

const filtroDelPeriodo = (p: ServicePayPeriod, venueId: string, tz: string, ahora: Date) => {
  const { from, to } = venuePeriodRange({ start: dbDateComoFecha(p.periodStart), end: dbDateComoFecha(p.periodEnd) }, tz)
  return { venueId, organizationId: p.organizationId, tz, desde: from, hasta: to, ahora, modo: 'periodo' as const, periodId: p.id }
}

/** Las diferencias de UNA clase, todas sus personas (no escribe). Sin periodo cerrado de origen: `{ origen: null, filas: [] }`. */
export async function diferenciasDeClase(
  db: Db,
  input: { venueId: string; classSessionId: string; ahora?: Date },
): Promise<{ origen: ServicePayPeriod | null; filas: FilaDiferencia[] }> {
  const ahora = input.ahora ?? new Date()
  const cs = await db.classSession.findFirst({
    where: { id: input.classSessionId, venueId: input.venueId },
    select: {
      startsAt: true,
      endsAt: true,
      venue: { select: { organizationId: true, timezone: true } },
      payState: { select: { originPeriodId: true } },
    },
  })
  if (!cs) throw new NotFoundError('Clase no encontrada')
  const origen = await origenDeClase(db, cs, ahora)
  if (!origen) return { origen: null, filas: [] }
  const f = { ...filtroDelPeriodo(origen, input.venueId, cs.venue.timezone || TZ_DEFAULT, ahora), claseIds: [input.classSessionId] }
  return { origen, filas: (await db.$queryRaw<Fila[]>(diferenciasSql(f, null, false))).map(aDto) }
}

/**
 * Lo pendiente de un periodo CERRADO (spec §6.4): sólo filas con pendiente ≠ 0 o en excepción, paginadas con cursor
 * estable `<venueId>:<classSessionId>:<persona>`. Por sede (alcance HISTÓRICO del periodo, Codex R1-1) y, dentro, por
 * lotes de ≤`tamLote` ids por llave (`idsCandidatas`): cada lote cuesta lo mismo y un lote sin pendientes no corta el
 * recorrido. No escribe.
 */
export async function diferenciasDelPeriodo(input: {
  userId: string
  venueId: string
  periodId: string
  cursor?: string
  limit: number
  ahora?: Date
  /** Sólo para pruebas: el tamaño del lote de ids y el tope de la lista «sin ancla». */
  tamLote?: number
  topeSinAncla?: number
}): Promise<{ items: FilaDiferencia[]; nextCursor: string | null; parcial: boolean }> {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  const p = await prisma.servicePayPeriod.findFirst({ where: { id: input.periodId, organizationId: v.organizationId } })
  if (!p) throw new NotFoundError('Periodo no encontrado')
  if (p.status !== 'CLOSED') return { items: [], nextCursor: null, parcial: false }
  // Alcance histórico del periodo (Codex R1-1): apagar una sede no esconde sus diferencias.
  const legibles = await sedesLegiblesDe(input.userId, p.venueIds)
  const sedes = (
    await prisma.venue.findMany({
      where: { id: { in: legibles.venueIds }, organizationId: v.organizationId },
      select: { id: true, timezone: true },
      take: p.venueIds.length,
    })
  ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const limite = Math.min(Math.max(input.limit, 1), TOPE_PAGINA)
  const tam = Math.min(Math.max(input.tamLote ?? LOTE_DIFERENCIAS, 1), 1000)
  const tope = Math.min(Math.max(input.topeSinAncla ?? TOPE_SIN_ANCLA, 1), TOPE_SIN_ANCLA)
  const ahora = input.ahora ?? new Date()
  const [cv, cc, cp] = input.cursor ? input.cursor.split(':') : []
  // Se reanuda en la sede del cursor o, si ya no es legible, en la siguiente: nunca se repite desde el principio.
  let idx = cv ? sedes.findIndex(s => s.id >= cv) : 0
  if (idx < 0) idx = sedes.length
  const items: FilaDiferencia[] = []
  for (; idx < sedes.length; idx++) {
    const s = sedes[idx]
    const f = filtroDelPeriodo(p, s.id, s.timezone || TZ_DEFAULT, ahora)
    const enCursor = s.id === cv && cc ? { classSessionId: cc, persona: cp ?? '' } : null
    let desde: Desde = enCursor ? { id: enCursor.classSessionId, incluido: true } : null
    // ponytail: con `tope` o más clases sin ancla en la sede (canceladas o que llegaron tarde), cada lote las vuelve a
    // buscar en la tabla: correcto, sólo más lento.
    const todas = (await prisma.$queryRaw<Array<{ id: string }>>(idsSinAncla(f, desde, tope))).map(x => x.id)
    let sinAncla = todas.length < tope ? todas : null
    for (;;) {
      const ids = (await prisma.$queryRaw<Array<{ id: string }>>(idsCandidatas(f, desde, tam, sinAncla))).map(x => x.id)
      if (!ids.length) break
      // El lote son los `tam` ids menores que quedan: las sin ancla que no entraron van después de él. Podarlas sólo aligera
      // el arreglo que viaja; el avance lo garantiza `desde`.
      if (sinAncla) {
        const enLote = new Set(ids)
        sinAncla = sinAncla.filter(id => !enLote.has(id))
      }
      for (const fila of await prisma.$queryRaw<Fila[]>(diferenciasSql({ ...f, claseIds: ids }, enCursor, true))) {
        items.push(aDto(fila))
        if (items.length === limite) {
          return { items, nextCursor: `${s.id}:${fila.classSessionId}:${fila.persona ?? ''}`, parcial: legibles.parcial }
        }
      }
      desde = { id: ids[ids.length - 1], incluido: false }
    }
  }
  return { items, nextCursor: null, parcial: legibles.parcial }
}
