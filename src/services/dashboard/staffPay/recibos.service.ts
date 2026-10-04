import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { createHash } from 'crypto'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { utcTs } from '../../../utils/sqlDates'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { encodeExport, EncodedExport, ExportColumnDef, getRowCapForFormat } from '../export.helpers'
import { runWithoutCancellation } from '../../../utils/requestCancellation'
import { assertPermisoEnSedes, exigirPermisoEnSedes, sedesConPermiso, sedesConServicePay, sedesLegiblesDe } from './acceso'
import { bloquearPeriodo, periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, periodoQueContiene, venuePeriodRange } from './periodos'
import { valoracionCte } from './valoracion'

/** Tope de UNA página del recibo (Codex R2-R1-20). El recibo entero no tiene tope: se recorre con cursor. */
export const RECIBO_LIMITE_MAX = 500
const LOTE_EXPORT = 1000
const LOTE_PAGO = 1000
const MUESTRA_PAGO = 100
const TZ_DEFAULT = 'America/Mexico_City'

export interface RenglonRecibo {
  tipo: 'CLASE' | 'DIFERENCIA' | 'AJUSTE'
  fecha: string
  hora: string | null
  sede: string
  concepto: string
  lugares: number | null
  monto: string
}
export interface Recibo {
  persona: string
  periodo: { id: string | null; start: string; end: string; estado: 'OPEN' | 'CLOSED' }
  /** UNA página, en orden (fecha de servicio, id). */
  renglones: RenglonRecibo[]
  /** Del recibo ENTERO (SUM en la base), nunca la suma de la página. */
  total: string
  /** Renglones del recibo entero (COUNT en la base). */
  cantidad: number
  /** Cursor de la página siguiente, o null si ésta es la última. */
  siguiente: string | null
  pagadoEn: string | null
  parcial: boolean
}

type Db = Prisma.TransactionClient | typeof prisma

/**
 * TODOS los recibos pendientes que tocaría «marcar pagado», por cursor y sin tope (Codex R2-Nuevo 1): la cantidad, el
 * total y la huella son del conjunto ENTERO; `muestra` (los primeros 100) sólo sirve para enseñarlos. El preview y la
 * escritura llaman a esta MISMA función, con el mismo recorrido.
 */
async function pendientesDePago(db: Db, p: { id: string; status: string }, staffId?: string) {
  const h = createHash('sha256').update(p.status)
  let cantidad = 0
  let total = new Prisma.Decimal(0)
  const muestra: Array<{ staffId: string; total: Prisma.Decimal }> = []
  let despuesDe: string | undefined
  for (;;) {
    const page = await db.staffPayStatement.findMany({
      where: { periodId: p.id, paidAt: null, ...(staffId ? { staffId } : {}), ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: { id: true, staffId: true, total: true },
      orderBy: { id: 'asc' },
      take: LOTE_PAGO,
    })
    if (!page.length) break
    for (const r of page) {
      h.update(`|${r.id}:${r.staffId}:${r.total.toFixed(2)}`)
      cantidad++
      total = total.plus(r.total)
      if (muestra.length < MUESTRA_PAGO) muestra.push({ staffId: r.staffId, total: r.total })
    }
    despuesDe = page[page.length - 1].id
  }
  return { cantidad, total, muestra, huella: h.digest('hex') }
}

const TOPE_SEDES_RECIBO = 500

/** Las sedes de un recibo, para su permiso. Nunca recorta: con más del tope se niega en vez de revisar sólo una parte. */
async function sedesDeRecibo(db: Db, periodId: string, staffId: string): Promise<string[]> {
  const sedes = await db.serviceEarning.findMany({
    where: { periodId, staffId },
    select: { venueId: true },
    distinct: ['venueId'],
    orderBy: { venueId: 'asc' },
    take: TOPE_SEDES_RECIBO + 1,
  })
  if (sedes.length > TOPE_SEDES_RECIBO) {
    throw new BadRequestError(
      `Este recibo tiene más de ${TOPE_SEDES_RECIBO} sedes: no se puede revisar el permiso. Pide ayuda a Avoqado.`,
      'RECIBO_DEMASIADAS_SEDES',
    )
  }
  return sedes.map(s => s.venueId)
}

export async function previewPagado(input: { userId: string; venueId: string; periodId: string; staffId?: string }) {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  const p = await prisma.servicePayPeriod.findFirst({ where: { id: input.periodId, organizationId: v.organizationId } })
  if (!p) throw new NotFoundError('Periodo no encontrado')
  // Mismo permiso que marcar: el preview enseña totales. Sin sedes, `assertPermisoEnSedes` no revisaría nada.
  const sedes = input.staffId ? await sedesDeRecibo(prisma, p.id, input.staffId) : p.venueIds
  if (input.staffId && !sedes.length) throw new NotFoundError('Esa persona no tiene recibo en este periodo')
  await assertPermisoEnSedes(
    input.userId,
    sedes,
    'staffpay:close',
    'Necesitas el permiso de cerrar periodos en todas las sedes de esos recibos',
  )
  const { cantidad, total, muestra, huella } = await pendientesDePago(prisma, p, input.staffId)
  const staff = muestra.length
    ? await prisma.staff.findMany({
        where: { id: { in: muestra.map(r => r.staffId) } },
        select: { id: true, firstName: true, lastName: true },
        take: muestra.length,
      })
    : []
  const nombre = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))
  return {
    periodo: { start: dbDateComoFecha(p.periodStart), end: dbDateComoFecha(p.periodEnd), estado: p.status },
    cantidad,
    total: total.toFixed(2),
    recibos: muestra.map(r => ({ staffId: r.staffId, nombre: nombre.get(r.staffId) ?? '—', total: r.total.toFixed(2) })),
    huella,
  }
}

export async function marcarPagado(input: {
  userId: string
  venueId: string
  periodId: string
  staffId?: string
  nota?: string
  huellaEsperada?: string
}) {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  // Permisos con el cliente GLOBAL, ANTES de la transacción: dentro retendrían su conexión mientras piden otra (la familia
  // de Codex R4-Nuevo 1). Candidatas: las sedes del periodo (y, uno por uno, las del recibo). Dentro sólo se COMPARA.
  const antes = await prisma.servicePayPeriod.findFirst({
    where: { id: input.periodId, organizationId: v.organizationId },
    select: { venueIds: true },
  })
  if (!antes) throw new NotFoundError('Periodo no encontrado')
  const candidatas = input.staffId ? [...antes.venueIds, ...(await sedesDeRecibo(prisma, input.periodId, input.staffId))] : antes.venueIds
  const permitidas = new Set(await sedesConPermiso(input.userId, candidatas, 'staffpay:close'))
  return withSerializableRetry(async tx => {
    const p = await bloquearPeriodo(tx, input.periodId)
    if (p.organizationId !== v.organizationId) throw new NotFoundError('Periodo no encontrado')
    if (p.status !== 'CLOSED') throw new BadRequestError('Sólo se marca pagado un periodo cerrado')
    // Permiso ANTES de recorrer nada (como el cierre, Codex R1-8), sobre el periodo ya bloqueado (spec §6.5, §9.2).
    if (input.staffId) {
      const sedes = await sedesDeRecibo(tx, p.id, input.staffId)
      if (!sedes.length) throw new NotFoundError('Esa persona no tiene recibo en este periodo')
      exigirPermisoEnSedes(permitidas, sedes, 'Para marcar pagado este recibo necesitas el permiso de cerrar periodos en todas sus sedes')
    } else {
      exigirPermisoEnSedes(
        permitidas,
        p.venueIds,
        'Para marcar pagados a todos necesitas el permiso de cerrar periodos en todas las sedes del periodo',
      )
    }
    // Codex R2-Nuevo 1: se recalcula DENTRO con el MISMO recorrido completo del preview y, con huella, se compara ANTES
    // de escribir; la escritura usa el MISMO `where` y tiene que tocar exactamente esa cantidad (también da el monto del
    // ActivityLog). Un ConflictError no se reintenta (`withSerializableRetry` sólo reintenta 40001/55P03).
    const pendientes = await pendientesDePago(tx, p, input.staffId)
    const cambiaron = () => new ConflictError('Los recibos cambiaron desde la vista previa: revisa de nuevo', 'HUELLA_CAMBIO')
    if (input.huellaEsperada && pendientes.huella !== input.huellaEsperada) throw cambiaron()
    const marcados = (
      await tx.staffPayStatement.updateMany({
        where: { periodId: p.id, paidAt: null, ...(input.staffId ? { staffId: input.staffId } : {}) },
        data: { paidAt: new Date(), paidById: input.userId, paidNote: input.nota ?? null },
      })
    ).count
    // Red: si el conjunto escrito no es el recorrido (el confirmado), se revierte todo; así el monto del log es el marcado.
    if (marcados !== pendientes.cantidad) throw cambiaron()
    if (marcados > 0) {
      await writeLegacyActivityAuditTx(tx, {
        staffId: input.userId,
        venueId: input.venueId,
        action: 'SERVICE_PAY_MARKED_PAID',
        entity: 'ServicePayPeriod',
        entityId: p.id,
        data: {
          staffId: input.staffId ?? 'todos',
          marcados,
          total: pendientes.total.toFixed(2),
          periodo: { start: dbDateComoFecha(p.periodStart), end: dbDateComoFecha(p.periodEnd) },
          nota: input.nota ?? null,
        },
      })
    }
    return { marcados }
  })
}

/** Una fila de la fuente del recibo: la misma forma para lo congelado y para lo valorado en vivo. */
interface FilaRecibo {
  tipo: 'CLASE' | 'DIFERENCIA' | 'AJUSTE'
  instante: Date
  id: string
  venueId: string
  fecha: string
  hora: string | null
  clase: string | null
  sedeFoto: string | null
  reason: string | null
  lugares: number | null
  monto: Prisma.Decimal
}

interface FuenteRecibo {
  persona: string
  periodo: Recibo['periodo']
  parcial: boolean
  nombreSede: Map<string, string>
  /** UNA consulta (UNION ALL) con todos los renglones; null si el usuario no puede leer ninguna sede. */
  sql: Prisma.Sql | null
  pagadoEn: string | null
  /** De QUÉ recibo es un cursor (organización, inicio del periodo, persona y sede): ver `leerCursor`. */
  llave: string
}

type EntradaRecibo = {
  userId: string
  venueId: string
  staffId: string
  fecha: string
  sede?: string
  cursor?: string
  limit: number
  /** SÓLO para pruebas (como `entreLotes`): corre entre la preparación y la instantánea (Codex R5). */
  trasPreparar?: () => Promise<void>
}

/**
 * Todo lo que se consulta con el cliente GLOBAL —la sede y la persona, los MÓDULOS (`sedesConServicePay`) y los
 * PERMISOS (`sedesLegiblesDe`)—, resuelto ANTES de abrir la instantánea y pasado como datos (Codex R4-Nuevo 1). Si se
 * consultara dentro, cada transacción retendría su conexión esperando OTRA del pool: 18 recibos simultáneos ocupaban las
 * 18 conexiones y ninguno terminaba.
 * El permiso se resuelve para TODAS las sedes candidatas: las del periodo como está ahora ∪ las que hoy tienen el módulo.
 */
interface ReciboPreparado {
  organizationId: string
  persona: string
  activas: string[]
  permitidas: Set<string>
  /** Sólo el NOMBRE para mostrar. La zona horaria y la periodicidad deciden qué clases entran: se leen DENTRO de la
   *  instantánea, en `fuenteDelRecibo` (Codex R5: una zona leída antes mezclaba el día de ayer con el monto de hoy). */
  sedes: Map<string, { nombre: string }>
}

async function prepararRecibo(input: { userId: string; venueId: string; staffId: string; fecha: string }): Promise<ReciboPreparado> {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  // La persona, sólo si trabaja (o trabajó) en esta organización: nunca el nombre de alguien de otro negocio. «Trabajó» lo
  // acredita también un devengo en la organización (Codex bloque A #4): eliminarla del equipo borra su StaffVenue pero no
  // su recibo cerrado, que tiene que seguir abriendo (pantalla, PDF y Excel).
  const select = { firstName: true, lastName: true }
  const staff =
    (await prisma.staff.findFirst({
      where: { id: input.staffId, venues: { some: { venue: { organizationId: v.organizationId } } } },
      select,
    })) ??
    ((await prisma.serviceEarning.findFirst({
      where: { organizationId: v.organizationId, staffId: input.staffId },
      select: { id: true },
    }))
      ? await prisma.staff.findUnique({ where: { id: input.staffId }, select })
      : null)
  if (!staff) throw new NotFoundError('Persona no encontrada')
  const filaAhora = await periodoQueContieneFecha(prisma, v.organizationId, input.fecha)
  const activas = await sedesConServicePay(v.organizationId)
  const candidatas = [...new Set([...(filaAhora?.venueIds ?? []), ...activas])]
  const { venueIds: permitidas } = await sedesLegiblesDe(input.userId, candidatas)
  const sedes = candidatas.length
    ? await prisma.venue.findMany({
        where: { id: { in: candidatas }, organizationId: v.organizationId },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
        take: candidatas.length,
      })
    : []
  return {
    organizationId: v.organizationId,
    persona: `${staff.firstName} ${staff.lastName}`.trim(),
    activas,
    permitidas: new Set(permitidas),
    sedes: new Map(sedes.map(x => [x.id, { nombre: x.name }])),
  }
}

/**
 * La MISMA regla que `alcanceLegibleDelPeriodo` (A3: cerrado = su alcance; abierto = guardadas ∪ activas; filtrado por
 * permiso y por `sede`), pero con módulos y permisos ya resueltos: es pura y corre dentro de la instantánea. Una sede
 * que entró al periodo entre la preparación y la instantánea no tiene permiso resuelto: no se lee y el recibo dice
 * `parcial` (conservador; la siguiente lectura ya la incluye).
 */
function alcanceEnLaFoto(p: ReciboPreparado, fila: { status: string; venueIds: string[] } | null, sede?: string) {
  const alcance = fila?.status === 'CLOSED' ? [...new Set(fila.venueIds)] : [...new Set([...(fila?.venueIds ?? []), ...p.activas])]
  const legibles = alcance.filter(v => p.permitidas.has(v)).sort()
  const venueIds = sede ? legibles.filter(id => id === sede) : legibles
  return { venueIds, parcial: legibles.length < alcance.length || (sede !== undefined && venueIds.length === 0) }
}

/**
 * UNA instantánea de sólo lectura (Codex R3-Nuevo 1): la fuente, el total y las páginas del recibo se leen del MISMO
 * instante. Sin esto, un cierre entre dos lecturas deja renglones que no suman el total (la valoración en vivo pierde
 * las clases recién ancladas y la fuente del periodo abierto no incluye los SERVICE nuevos).
 * 🔴 Regla (Codex R4-Nuevo 1): dentro de `fn` SÓLO se lee con `tx` —periodo, total y páginas—; nunca `prisma.` global
 * ni un helper que lo use (`sedesConServicePay`, `sedesLegiblesDe`, `alcanceLegibleDelPeriodo`, permisos): eso va en
 * `prepararRecibo`, antes.
 * Exportada sólo para su prueba de cancelación.
 */
export function enUnaFoto<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async tx => {
      // Codex R4-Nuevo 2: el freno de lecturas del MCP trata todo `$executeRaw` como escritura (`hasWritten = true`) y
      // dejaría de cortar las lecturas que siguen. Este SET no escribe nada: va fuera del freno, y SÓLO él.
      await runWithoutCancellation(() => tx.$executeRaw`SET TRANSACTION READ ONLY`)
      return fn(tx)
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 60_000 },
  )
}

/**
 * Qué renglones forman el recibo, como UNA fuente SQL (Codex R2-R1-20): los `ServiceEarning` (SERVICE, RECONCILE,
 * MANUAL) del periodo y la persona y, si el periodo está ABIERTO, además la valoración en vivo de cada sede (cada
 * subconsulta con su propio WITH). Todas las ramas llevan la misma llave de orden: (instante de servicio, id).
 * Corre dentro de `enUnaFoto`: sólo `db` (el `tx`) y los datos de `prep` (Codex R4-Nuevo 1).
 */
async function fuenteDelRecibo(
  db: Db,
  prep: ReciboPreparado,
  input: { staffId: string; fecha: string; sede?: string },
): Promise<FuenteRecibo> {
  const fila = await periodoQueContieneFecha(db, prep.organizationId, input.fecha)
  // El MISMO alcance legible que el reporte (Codex R1-1, R3-Nuevo 2), con el filtro de `sede` (R2-R1-21).
  const { venueIds, parcial } = alcanceEnLaFoto(prep, fila, input.sede)
  // Codex R5: periodicidad y zona horaria deciden QUÉ clases entran, así que salen de la MISMA instantánea que los montos.
  const org = await db.organization.findUniqueOrThrow({ where: { id: prep.organizationId }, select: { servicePayPeriodicity: true } })
  const zonas = venueIds.length
    ? await db.venue.findMany({
        where: { id: { in: venueIds }, organizationId: prep.organizationId },
        select: { id: true, timezone: true },
        take: venueIds.length,
      })
    : []
  const tzDe = new Map(zonas.map(x => [x.id, x.timezone || TZ_DEFAULT]))
  const canon = fila
    ? { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd) }
    : periodoQueContiene(input.fecha, org.servicePayPeriodicity)
  const partes: Prisma.Sql[] = []
  if (fila && venueIds.length) {
    partes.push(Prisma.sql`
      SELECT CASE e.concept WHEN 'SERVICE' THEN 'CLASE' WHEN 'RECONCILE' THEN 'DIFERENCIA' ELSE 'AJUSTE' END AS tipo,
             COALESCE(e."occurredAt", e."createdAt") AS instante, e.id, e."venueId",
             COALESCE(e.descriptor->>'fecha', to_char(e."createdAt", 'YYYY-MM-DD')) AS fecha,
             e.descriptor->>'hora' AS hora, e.descriptor->>'clase' AS clase, e.descriptor->>'sede' AS "sedeFoto",
             e.reason, e.count AS lugares, e.amount AS monto
      FROM "ServiceEarning" e
      WHERE e."periodId" = ${fila.id} AND e."staffId" = ${input.staffId} AND e."venueId" IN (${Prisma.join(venueIds)})
        ${fila.status === 'CLOSED' ? Prisma.empty : Prisma.sql`AND e.concept IN ('RECONCILE', 'MANUAL')`}`)
  }
  if (fila?.status !== 'CLOSED') {
    const ahora = new Date()
    for (const venueId of venueIds) {
      const tz = tzDe.get(venueId) ?? TZ_DEFAULT
      const { from, to } = venuePeriodRange(canon, tz)
      const f = { venueId, organizationId: prep.organizationId, tz, desde: from, hasta: to, ahora, staffId: input.staffId }
      partes.push(Prisma.sql`
        SELECT 'CLASE'::text AS tipo, vv."startsAt" AS instante, vv."classSessionId" AS id, vv."venueId", vv."fechaLocal" AS fecha,
               to_char(((vv."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'HH24:MI') AS hora,
               vv."productName" AS clase, NULL::text AS "sedeFoto", NULL::text AS reason, vv.conteo AS lugares, vv.monto
        FROM (${valoracionCte(f)} SELECT * FROM valoradas) vv
        WHERE vv.estado = 'OK' AND vv.monto IS NOT NULL`)
    }
  }
  const pagado =
    fila?.status === 'CLOSED'
      ? await db.staffPayStatement.findUnique({
          where: { periodId_staffId: { periodId: fila.id, staffId: input.staffId } },
          select: { paidAt: true },
        })
      : null
  return {
    persona: prep.persona,
    periodo: { id: fila?.id ?? null, ...canon, estado: fila?.status ?? 'OPEN' },
    parcial,
    nombreSede: new Map([...prep.sedes].map(([id, x]) => [id, x.nombre])),
    sql: partes.length ? Prisma.join(partes, ' UNION ALL ') : null,
    pagadoEn: pagado?.paidAt?.toISOString() ?? null,
    llave: createHash('sha256')
      .update([prep.organizationId, canon.start, input.staffId, input.sede ?? ''].join('|'))
      .digest('hex')
      .slice(0, 12),
  }
}

/**
 * Cursor «<A|C>.<llave>.<instante ISO>|<id>»: la posición estable (fecha de servicio, id), el ESTADO del periodo con que
 * se emitió (Codex R3-Nuevo 3) y la `llave` de SU recibo (organización, inicio del periodo, persona y sede). Un cursor de
 * otro estado (el periodo se cerró entre páginas), de OTRO recibo (otra persona, otro periodo, otro filtro de sede: sin
 * la llave, devolvía sólo los renglones posteriores de la otra persona con el total completo) o con el formato del
 * desglose en vivo (`venueId:classSessionId`) no se puede seguir: 409 `RECIBO_CAMBIO` y se vuelve a leer desde el principio.
 */
const prefijo = (estado: 'OPEN' | 'CLOSED') => (estado === 'CLOSED' ? 'C' : 'A')
const reciboCambio = () =>
  new ConflictError('El periodo cambió mientras leías: vuelve a cargar el recibo desde el principio.', 'RECIBO_CAMBIO')

function leerCursor(s: string, f: Pick<FuenteRecibo, 'periodo' | 'llave'>): { instante: Date; id: string } {
  const m = /^([AC])\.([0-9a-f]{12})\.([^|]+)\|(.+)$/.exec(s)
  if (!m) {
    if (/^[^|]+:[^|]+$/.test(s)) throw reciboCambio() // el cursor del desglose en vivo de un periodo que ya se cerró
    throw new BadRequestError('Cursor inválido')
  }
  if (m[1] !== prefijo(f.periodo.estado) || m[2] !== f.llave) throw reciboCambio()
  const instante = new Date(m[3])
  if (Number.isNaN(instante.getTime())) throw new BadRequestError('Cursor inválido')
  return { instante, id: m[4] }
}

async function totalDelRecibo(db: Db, f: FuenteRecibo): Promise<{ total: Prisma.Decimal; cantidad: number }> {
  if (!f.sql) return { total: new Prisma.Decimal(0), cantidad: 0 }
  const [r] = await db.$queryRaw<Array<{ total: Prisma.Decimal | null; cantidad: number }>>`
    SELECT SUM(r.monto) AS total, COUNT(*)::int AS cantidad FROM (${f.sql}) r`
  return { total: r.total ?? new Prisma.Decimal(0), cantidad: r.cantidad }
}

function sqlPaginaDelRecibo(fuente: Prisma.Sql, c: { instante: Date; id: string } | null, limite: number): Prisma.Sql {
  const despues = c ? Prisma.sql`WHERE (r.instante, r.id) > (${utcTs(c.instante)}, ${c.id})` : Prisma.empty
  return Prisma.sql`SELECT * FROM (${fuente}) r ${despues} ORDER BY r.instante ASC, r.id ASC LIMIT ${limite + 1}`
}

async function paginaDelRecibo(
  db: Db,
  f: FuenteRecibo,
  cursor: string | undefined,
  limite: number,
): Promise<{ filas: FilaRecibo[]; siguiente: string | null }> {
  // El cursor se valida aunque la fuente esté vacía: un cursor viejo nunca se acepta en silencio.
  const c = cursor ? leerCursor(cursor, f) : null
  if (!f.sql) return { filas: [], siguiente: null }
  const filas = await db.$queryRaw<FilaRecibo[]>(sqlPaginaDelRecibo(f.sql, c, limite))
  const pagina = filas.slice(0, limite)
  const u = pagina[pagina.length - 1]
  return {
    filas: pagina,
    siguiente: filas.length > limite && u ? `${prefijo(f.periodo.estado)}.${f.llave}.${u.instante.toISOString()}|${u.id}` : null,
  }
}

const aRenglon =
  (f: FuenteRecibo) =>
  (r: FilaRecibo): RenglonRecibo => ({
    tipo: r.tipo,
    fecha: r.fecha,
    hora: r.hora,
    // Lo congelado manda (spec §5.6; Codex bloque A #8): renombrar la sede no reescribe un recibo cerrado. El nombre de
    // hoy sólo para lo valorado en vivo, que no trae foto.
    sede: r.sedeFoto ?? f.nombreSede.get(r.venueId) ?? '',
    concepto: r.tipo === 'AJUSTE' ? (r.reason ?? 'Ajuste') : `${r.clase ?? 'Clase'}${r.tipo === 'DIFERENCIA' ? ' (diferencia)' : ''}`,
    lugares: r.lugares,
    monto: new Prisma.Decimal(r.monto).toFixed(2),
  })

const acotar = (limit: number) => Math.min(Math.max(Math.trunc(limit) || 1, 1), RECIBO_LIMITE_MAX)

/** Una página del recibo; su página y su total salen de la MISMA instantánea (Codex R3-Nuevo 1). */
export async function reciboDePersona(input: EntradaRecibo): Promise<Recibo> {
  const prep = await prepararRecibo(input) // cliente global ANTES de la instantánea (Codex R4-Nuevo 1)
  await input.trasPreparar?.()
  return enUnaFoto(async tx => {
    const f = await fuenteDelRecibo(tx, prep, input)
    const { total, cantidad } = await totalDelRecibo(tx, f)
    const pagina = await paginaDelRecibo(tx, f, input.cursor, acotar(input.limit))
    return {
      persona: f.persona,
      periodo: f.periodo,
      renglones: pagina.filas.map(aRenglon(f)),
      total: total.toFixed(2),
      cantidad,
      siguiente: pagina.siguiente,
      pagadoEn: f.pagadoEn,
      parcial: f.parcial,
    }
  })
}

/** La consulta de UNA página del recibo tal como se ejecuta, para su `EXPLAIN` en A13 (Codex R3-R1-12). Nada más la usa. */
export async function consultaDePaginaDelRecibo(input: EntradaRecibo): Promise<Prisma.Sql | null> {
  const f = await fuenteDelRecibo(prisma, await prepararRecibo(input), input)
  return f.sql ? sqlPaginaDelRecibo(f.sql, input.cursor ? leerCursor(input.cursor, f) : null, acotar(input.limit)) : null
}

/** Las filas que reciben LOS DOS formatos, PDF y Excel (Codex R2-R1-14): cada renglón con su signo + el total. Pura. */
export function filasDelRecibo(r: Pick<Recibo, 'renglones' | 'total' | 'parcial'>): RenglonRecibo[] {
  return [
    ...r.renglones,
    {
      tipo: 'AJUSTE',
      fecha: '',
      hora: null,
      sede: '',
      concepto: r.parcial ? 'Total (vista parcial)' : 'Total',
      lugares: null,
      monto: r.total,
    },
  ]
}

const COLUMNAS: ExportColumnDef<RenglonRecibo>[] = [
  { id: 'fecha', label: 'Fecha', value: r => r.fecha },
  { id: 'hora', label: 'Hora', value: r => r.hora },
  { id: 'sede', label: 'Sede', value: r => r.sede },
  { id: 'concepto', label: 'Concepto', value: r => r.concepto },
  { id: 'lugares', label: 'Lugares', value: r => r.lugares },
  { id: 'monto', label: 'Monto', value: r => r.monto },
]
/** El Excel lleva el monto como NÚMERO (el dueño lo suma); `monto` ya viene redondeado a 2 decimales por `toFixed(2)`. */
const COLUMNAS_EXCEL: ExportColumnDef<RenglonRecibo>[] = COLUMNAS.map(c => (c.id === 'monto' ? { ...c, value: r => Number(r.monto) } : c))
const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

export async function exportarRecibo(input: {
  userId: string
  venueId: string
  staffId: string
  fecha: string
  format: 'pdf' | 'xlsx'
  /** Sólo pruebas (mismo criterio que `ahora`/`tamLote` de D8): renglones por lote. Default 1,000. */
  tamLote?: number
  /** Sólo pruebas (Codex R4, Nuevo 1 de R3): se llama ENTRE un lote y el siguiente, dentro de la instantánea. */
  entreLotes?: () => Promise<void>
}): Promise<{ encoded: EncodedExport; nombre: string }> {
  const tope = getRowCapForFormat(input.format)
  const prep = await prepararRecibo(input) // cliente global ANTES de la instantánea (Codex R4-Nuevo 1)
  // Fuente, total y TODAS las páginas en UNA instantánea de sólo lectura (Codex R3-Nuevo 1); el archivo se genera
  // DESPUÉS de cerrar la transacción (codificar no retiene la conexión).
  const { f, total, renglones } = await enUnaFoto(async tx => {
    const f = await fuenteDelRecibo(tx, prep, input)
    const { total, cantidad } = await totalDelRecibo(tx, f)
    // El tope del ARCHIVO (export.helpers: 1,000 en PDF, 10,000 en Excel) se revisa con la cuenta de la base ANTES de
    // leer los renglones: arriba del tope se explica, nunca se trunca (D6).
    if (cantidad + 1 > tope) {
      throw new BadRequestError(
        `Este recibo tiene ${cantidad} renglones; el ${input.format.toUpperCase()} admite ${tope - 1}. ${input.format === 'pdf' ? 'Descárgalo en Excel.' : 'Pide ayuda a Avoqado.'}`,
      )
    }
    // Clic explícito: se recorren TODAS las páginas en lotes de 1,000 (Codex R2-R1-20).
    const renglones: RenglonRecibo[] = []
    let cursor: string | undefined
    for (;;) {
      const p = await paginaDelRecibo(tx, f, cursor, input.tamLote ?? LOTE_EXPORT)
      renglones.push(...p.filas.map(aRenglon(f)))
      if (!p.siguiente) break
      cursor = p.siguiente
      await input.entreLotes?.()
    }
    return { f, total, renglones }
  })
  const columnas = input.format === 'xlsx' ? COLUMNAS_EXCEL : COLUMNAS
  const encoded = await encodeExport(input.format, {
    allColumns: columnas,
    requestedColumnIds: columnas.map(c => c.id),
    rows: filasDelRecibo({ renglones, total: total.toFixed(2), parcial: f.parcial }),
    title: `Recibo de ${f.persona} · ${f.periodo.start} al ${f.periodo.end}`,
  })
  return { encoded, nombre: `recibo-${slug(f.persona)}-${f.periodo.start}` }
}
