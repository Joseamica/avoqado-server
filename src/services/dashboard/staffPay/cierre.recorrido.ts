// src/services/dashboard/staffPay/cierre.recorrido.ts — el ÚNICO recorrido de la huella y las lecturas que comparten la vista
// previa y el cierre (fases 2-3). Sale de `cierre.service.ts` en B12 para que la vista previa (`cierre.preview.ts`) lo use sin
// ciclo de imports.
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { utcTs } from '../../../utils/sqlDates'
import { venuePeriodRange } from './periodos'
import { ClaseValorada, FiltroValoracion, valorarClases } from './valoracion'
import { Huella } from './huella'
import { comisionesBarribles, LineaBarrible, propinasBarribles, propinasSinDueno, reversosPorAnulacion } from './fuentesVenta'
import { Alcance, Barrido, filtroDe, Sede } from './cierre.alcance'
import { cero, CuentaCruda, Suma } from './participacion.vistaPrevia'

type Db = Prisma.TransactionClient | typeof prisma

export const LOTE_CIERRE = 500
/**
 * El timeout de UN intento de cierre (medido y explicado en `cierre.service.ts`). B13 (revisión de B12 #1): también el de la foto
 * de su vista previa, que corre el MISMO recorrido y es la única que da la huella con la que se cierra.
 */
export const TIMEOUT_CIERRE_MS = 120_000

export const sinDuenoDe = async (db: Db, v: Barrido | null) => (v ? propinasSinDueno(db, v.a, v.r) : { n: 0, total: new Prisma.Decimal(0) })

/**
 * Resolución 16: efectos de comisión en revisión (`…:policy-error:v1`) sin resolver de las sedes del alcance. Sólo de cobros
 * desde el inicio de pago al personal en la zona de SU sede (B4 r1): lo de antes nunca entra al sobre, y su aviso sería
 * falso para siempre.
 */
export const comisionesPorRevisar = (db: Db, v: Barrido | null) =>
  v
    ? db.paymentEffect.count({
        where: {
          kind: 'COMMISSION',
          dedupeKey: { endsWith: ':policy-error:v1' },
          status: { not: 'DONE' },
          OR: v.a.sedes.map(s => ({
            venueId: s.venueId,
            payment: { createdAt: { gte: venuePeriodRange({ start: v.a.startDate, end: v.a.startDate }, s.tz).from } },
          })),
        },
      })
    : Promise.resolve(0)

/** IDs de las reservas de clase sin horario del periodo (spec §5.5), en orden fijo: sede → id. */
export async function idsHuerfanas(db: Db, a: Alcance, ahora: Date): Promise<string[]> {
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

export type AjusteGuardado = { id: string; staffId: string; venueId: string; amount: Prisma.Decimal }

/** TODOS los ajustes del periodo, por páginas con cursor: un tope de página nunca es un tope contable (Codex R1-3). */
export async function ajustesDelPeriodo(db: Db, organizationId: string, periodId: string | null): Promise<AjusteGuardado[]> {
  if (!periodId) return []
  const todos: AjusteGuardado[] = []
  let despuesDe: string | undefined
  for (;;) {
    const page = await db.serviceEarning.findMany({
      where: { organizationId, periodId, concept: { in: ['RECONCILE', 'MANUAL'] }, ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: { id: true, staffId: true, venueId: true, amount: true },
      orderBy: { id: 'asc' },
      take: 1000,
    })
    if (!page.length) return todos
    todos.push(...page)
    despuesDe = page[page.length - 1].id
  }
}

/**
 * Los siguientes `n` ids de clase de la sede en el rango, por llave (A13): se pagina ANTES de los joins pesados y sólo
 * esos ids se valoran. Sin los demás filtros de la valoración (terminada, no cancelada, sin ancla): ésos los aplica la
 * valoración, así que un lote puede valorar menos de `n` clases, nunca otras.
 */
export const consultaIdsDelLote = (f: FiltroValoracion, despuesDe: string | undefined, n: number): Prisma.Sql => Prisma.sql`
  SELECT cs.id FROM "ClassSession" cs
  WHERE cs."venueId" = ${f.venueId} AND cs."startsAt" >= ${utcTs(f.desde)} AND cs."startsAt" < ${utcTs(f.hasta)}
    ${despuesDe ? Prisma.sql`AND cs.id > ${despuesDe}` : Prisma.empty}
  ORDER BY cs.id ASC
  LIMIT ${n}`

export interface Recorrido {
  clases: number
  excluidas: number
  comisiones: number
  propinas: number
  reversos: number
  personas: Set<string>
  sedesConDinero: Set<string>
  totalServicios: Prisma.Decimal
  totalVentas: Prisma.Decimal
  totalAjustes: Prisma.Decimal
  /** B12: lo que el recorrido pone en el cierre, por sede (clases OK con persona y monto, y cada línea de venta en su fuente:
   *  las anulaciones cuentan como comisiones) y las clases que no se pueden valuar. Fuera de la huella. */
  porSede: Map<string, CuentaCruda>
  huella: string
}

/**
 * El ÚNICO recorrido de la huella (spec §6.3 puntos 2 y 4; fase 3 §6.5), el mismo para el preview y el cierre: cabecera →
 * clases (sede → clase, por lotes con cursor `classSessionId > último`) → comisiones (M) → propinas (T) → reversos por
 * anulación (X), cada fuente por lotes ordenados por id → ajustes por id → huérfanas por id. Cada lote pasa por la huella
 * ANTES de `alLote` / `alVentas`. No escribe nada: el cierre guarda lo de cada lote y escribe al terminar (A13). Todo nace
 * dentro de cada llamada: un reintento de `withSerializableRetry` empieza de cero. `digest()` se llama una sola vez.
 */
export async function recorrer(
  db: Db,
  a: Alcance,
  ahora: Date,
  o: {
    tamLote: number
    ajustes: AjusteGuardado[]
    huerfanas: string[]
    /** null: sin activar, no se barren ventas (B-D5). Con sus rangos, calculados UNA vez por operación (B11). */
    ventas: Barrido | null
    alLote?: (lote: ClaseValorada[], sede: Sede) => Promise<void>
    alVentas?: (lote: LineaBarrible[]) => void
  },
): Promise<Recorrido> {
  const huella = new Huella()
  huella.cabecera({ organizationId: a.organizationId, ...a.periodo, venueIds: a.venueIds })
  const r = {
    clases: 0,
    excluidas: 0,
    comisiones: 0,
    propinas: 0,
    reversos: 0,
    personas: new Set<string>(),
    sedesConDinero: new Set<string>(),
    totalServicios: new Prisma.Decimal(0),
    totalVentas: new Prisma.Decimal(0),
    totalAjustes: new Prisma.Decimal(0),
    porSede: new Map<string, CuentaCruda>(),
  }
  const deSede = (venueId: string): CuentaCruda => {
    const c = r.porSede.get(venueId) ?? { clases: { ...cero(), pendientes: 0 }, comisiones: cero(), propinas: cero() }
    r.porSede.set(venueId, c)
    return c
  }
  const sumar = (x: Suma, monto: Prisma.Decimal | string) => {
    x.n++
    x.total = x.total.plus(monto)
  }
  // El mismo tope que `valorarClases`: con más ids que su LIMIT se perderían clases del lote.
  const tam = Math.min(Math.max(o.tamLote, 1), 1000)
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    let despuesDe: string | undefined
    for (;;) {
      // A13: primero los ids del lote (por llave), luego la valoración de SÓLO esos ids. Antes cada lote valoraba todo lo
      // que quedaba del periodo para quedarse con 500 (O(N²/lote)). El orden sigue siendo por classSessionId.
      const ids = (await db.$queryRaw<Array<{ id: string }>>(consultaIdsDelLote(f, despuesDe, tam))).map(x => x.id)
      if (!ids.length) break
      const lote = await valorarClases(db, { ...f, claseIds: ids }, { limite: tam })
      for (const c of lote) {
        huella.clase(c)
        if (c.estado === 'OK' && c.staffId && c.monto !== null) {
          r.clases++
          r.personas.add(c.staffId)
          r.sedesConDinero.add(s.venueId)
          r.totalServicios = r.totalServicios.plus(c.monto)
          sumar(deSede(s.venueId).clases, c.monto)
        } else if (c.estado === 'EXCLUIDA') r.excluidas++
        else if (c.estado === 'EXCEPCION') deSede(s.venueId).clases.pendientes++
      }
      if (o.alLote) await o.alLote(lote, s)
      despuesDe = ids[ids.length - 1]
    }
  }
  if (o.ventas) {
    const fuentes = [
      // `reversosPorAnulacion` recibe `r` sin usarlo: misma firma que las otras dos (una anulación no depende de rangos, §6.4).
      { leer: comisionesBarribles, hashear: (l: LineaBarrible) => huella.comision(l), contar: () => r.comisiones++ },
      { leer: propinasBarribles, hashear: (l: LineaBarrible) => huella.propina(l), contar: () => r.propinas++ },
      { leer: reversosPorAnulacion, hashear: (l: LineaBarrible) => huella.reverso(l), contar: () => r.reversos++ },
    ]
    for (const f of fuentes) {
      let despuesDe: string | undefined
      for (;;) {
        const lote = await f.leer(db, o.ventas.a, o.ventas.r, { despuesDe, limite: tam })
        if (!lote.length) break
        for (const l of lote) {
          f.hashear(l)
          f.contar()
          r.totalVentas = r.totalVentas.plus(l.monto)
          r.personas.add(l.staffId)
          r.sedesConDinero.add(l.venueId)
          sumar(deSede(l.venueId)[l.fuente === 'TIP' ? 'propinas' : 'comisiones'], l.monto)
        }
        o.alVentas?.(lote)
        despuesDe = lote[lote.length - 1].sourceId
      }
    }
  }
  for (const aj of o.ajustes) {
    huella.ajuste(aj)
    r.totalAjustes = r.totalAjustes.plus(aj.amount)
    r.personas.add(aj.staffId)
    r.sedesConDinero.add(aj.venueId)
  }
  for (const id of o.huerfanas) huella.huerfana(id)
  return { ...r, huella: huella.digest() }
}

export async function organizacionDe(venueId: string): Promise<string> {
  return (await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })).organizationId
}

/** Lo GUARDADO de un periodo cerrado: personas y total de los recibos (lo mismo que el retorno idempotente). */
export async function recibosGuardados(db: Db, organizationId: string, periodId: string) {
  const agg = await db.staffPayStatement.aggregate({
    where: { periodId, period: { organizationId } },
    _count: { _all: true },
    _sum: { total: true },
  })
  return { personas: agg._count._all, total: agg._sum.total ?? new Prisma.Decimal(0) }
}
