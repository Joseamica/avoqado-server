import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { createHash } from 'crypto'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { utcTs } from '../../../utils/sqlDates'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { encodeExport, EncodedExport, ExportColumnDef, fechaMx, getRowCapForFormat } from '../export.helpers'
import { assertPermisoEnSedes, exigirPermisoEnSedes, sedesConPermiso, sedesConServicePay, sedesLegiblesDe } from './acceso'
import { bloquearPeriodo, periodoQueContieneFecha } from './periodosGuardados'
import { transaccionConPresupuesto } from '../../../utils/esperaDeCandados'
import { dbDateComoFecha, MESES_LARGOS, periodoQueContiene, venuePeriodRange } from './periodos'
import { ReglaDeClase, textoDeRegla, valoracionCte } from './valoracion'
import { AlcanceBarrido, sqlVentasDelPeriodo } from './fuentesVenta'
import { personaDelRecibo } from './recibos.persona'
import { enUnaFoto } from './foto'
import { DevolucionesPendientes, devolucionesPendientes } from './devolucionesPendientes'
import { alcanceDelPeriodo, sedesConVentana } from './alcance'
import { rangosConParticipacion } from './rangos'

/** Tope de UNA página del recibo (Codex R2-R1-20). El recibo entero no tiene tope: se recorre con cursor. */
export const RECIBO_LIMITE_MAX = 500
const LOTE_EXPORT = 1000
const LOTE_PAGO = 1000
const MUESTRA_PAGO = 100
const TZ_DEFAULT = 'America/Mexico_City'

export interface RenglonRecibo {
  tipo: 'CLASE' | 'DIFERENCIA' | 'AJUSTE' | 'COMISION' | 'PROPINA'
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
  /** Del recibo ENTERO, por tipo (SUM en la base); sólo los tipos que tienen renglones (spec fase 3 §11). */
  totalesPorTipo: Partial<Record<RenglonRecibo['tipo'], string>>
  /** B12 (r6.2, r5.1): devoluciones de esta persona que se descontarán solas en OTRO cierre; null en un recibo cerrado. */
  pendientes: DevolucionesPendientes | null
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
  return transaccionConPresupuesto(async (tx, presupuesto) => {
    const p = await bloquearPeriodo(tx, input.periodId, presupuesto)
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
  tipo: RenglonRecibo['tipo']
  instante: Date
  id: string
  venueId: string
  fecha: string
  hora: string | null
  clase: string | null
  sedeFoto: string | null
  reason: string | null
  /** De una DIFERENCIA: el inicio del periodo de origen de su clase (`descriptor.periodoOrigen.start`, B2). */
  origen: string | null
  lugares: number | null
  monto: Prisma.Decimal
  /**
   * Columna 13 de la fuente, justo después de `monto`, en TODOS los brazos (contrato con el Bloque D, D3c): la regla de
   * clase que movió el monto (suplencia, cancelación tardía). B5 la deja `NULL::jsonb` en todos; D3c sólo la llena en las
   * ramas de CLASES (en vivo y congeladas). Ventas, ajustes, diferencias y filas agrupadas la dejan en NULL.
   */
  regla: Prisma.JsonValue | null
  /** De una venta (comisión o propina): número de orden, esquema, base y motivo (VENTA | DEVOLUCION | ANULACION). */
  orden: string | null
  esquema: string | null
  base: Prisma.Decimal | null
  motivo: string | null
  /** Propinas de un día juntas (pantalla y PDF): `cobros` dice cuántas. */
  agrupada: boolean
  cobros: number
}

interface FuenteRecibo {
  persona: string
  periodo: Recibo['periodo']
  parcial: boolean
  nombreSede: Map<string, string>
  /** UNA consulta (UNION ALL) con todos los renglones; null si el usuario no puede leer ninguna sede. */
  sql: Prisma.Sql | null
  /** El alcance legible ya filtrado por `sede` (B12: las pendientes se leen sobre el mismo). */
  venueIds: string[]
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
 * El permiso se resuelve para TODAS las sedes candidatas: las del periodo como está ahora ∪ las que hoy tienen el módulo ∪
 * las que tienen alguna ventana de participación (B11, r4.4: su historia las mete al alcance).
 */
interface ReciboPreparado {
  organizationId: string
  persona: string
  activas: string[]
  /** Las sedes con alguna ventana (B11): dentro de la foto sólo se comparan. */
  conVentana: string[]
  permitidas: Set<string>
  /** Sólo el NOMBRE para mostrar. La zona horaria y la periodicidad deciden qué clases entran: se leen DENTRO de la
   *  instantánea, en `fuenteDelRecibo` (Codex R5: una zona leída antes mezclaba el día de ayer con el monto de hoy). */
  sedes: Map<string, { nombre: string }>
}

async function prepararRecibo(input: { userId: string; venueId: string; staffId: string; fecha: string }): Promise<ReciboPreparado> {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
  const persona = await personaDelRecibo(v.organizationId, input.staffId)
  const filaAhora = await periodoQueContieneFecha(prisma, v.organizationId, input.fecha)
  const activas = await sedesConServicePay(v.organizationId)
  const conVentana = await sedesConVentana(prisma, v.organizationId)
  const candidatas = [...new Set([...(filaAhora?.venueIds ?? []), ...activas, ...conVentana])]
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
    persona,
    activas,
    conVentana,
    permitidas: new Set(permitidas),
    sedes: new Map(sedes.map(x => [x.id, { nombre: x.name }])),
  }
}

/**
 * La MISMA regla que `alcanceLegibleDelPeriodo` (`alcanceDelPeriodo`, B11: cerrado = su alcance; abierto = guardadas ∪
 * activas y, desde el inicio de pago al personal, ∪ las sedes con ventana; filtrado por permiso y por `sede`), pero con
 * módulos, ventanas y permisos ya resueltos: es pura y corre dentro de la instantánea. Una sede que entró al periodo entre
 * la preparación y la instantánea no tiene permiso resuelto: no se lee y el recibo dice `parcial` (conservador; la
 * siguiente lectura ya la incluye).
 */
function alcanceEnLaFoto(
  p: ReciboPreparado,
  fila: { status: 'OPEN' | 'CLOSED'; venueIds: string[] } | null,
  periodo: { start: string; end: string },
  startDate: string | null,
  sede?: string,
) {
  const alcance = alcanceDelPeriodo({
    periodo: { ...periodo, estado: fila?.status ?? 'OPEN' },
    guardadas: fila?.venueIds ?? [],
    activas: p.activas,
    conVentana: p.conVentana,
    startDate,
  })
  const legibles = alcance.filter(v => p.permitidas.has(v)).sort()
  const venueIds = sede ? legibles.filter(id => id === sede) : legibles
  return { venueIds, parcial: legibles.length < alcance.length || (sede !== undefined && venueIds.length === 0) }
}

/** La instantánea vive en `foto.ts` (B12: también la usa la vista previa del cierre); se re-exporta para su prueba. */
export { enUnaFoto } from './foto'

/**
 * Qué renglones forman el recibo, como UNA fuente SQL (Codex R2-R1-20): los `ServiceEarning` (SERVICE, RECONCILE,
 * MANUAL) del periodo y la persona y, si el periodo está ABIERTO, además la valoración en vivo de cada sede (cada
 * subconsulta con su propio WITH) y las comisiones y propinas que hoy entrarían al cierre. Todas las ramas llevan la misma
 * llave de orden: (instante de servicio o de venta, id).
 * Corre dentro de `enUnaFoto`: sólo `db` (el `tx`) y los datos de `prep` (Codex R4-Nuevo 1).
 */
async function fuenteDelRecibo(
  db: Db,
  prep: ReciboPreparado,
  input: { staffId: string; fecha: string; sede?: string },
  o: { agruparPropinas: boolean },
): Promise<FuenteRecibo> {
  const fila = await periodoQueContieneFecha(db, prep.organizationId, input.fecha)
  // Codex R5: periodicidad y zona horaria deciden QUÉ clases entran, así que salen de la MISMA instantánea que los montos.
  const org = await db.organization.findUniqueOrThrow({
    where: { id: prep.organizationId },
    select: { servicePayPeriodicity: true, staffPayStartDate: true },
  })
  const canon = fila
    ? { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd) }
    : periodoQueContiene(input.fecha, org.servicePayPeriodicity)
  const startDate = org.staffPayStartDate ? dbDateComoFecha(org.staffPayStartDate) : null
  // El MISMO alcance legible que el reporte (Codex R1-1, R3-Nuevo 2), con el filtro de `sede` (R2-R1-21).
  const { venueIds, parcial } = alcanceEnLaFoto(prep, fila, canon, startDate, input.sede)
  const zonas = venueIds.length
    ? await db.venue.findMany({
        where: { id: { in: venueIds }, organizationId: prep.organizationId },
        select: { id: true, timezone: true },
        take: venueIds.length,
      })
    : []
  const tzDe = new Map(zonas.map(x => [x.id, x.timezone || TZ_DEFAULT]))
  const crudo: Prisma.Sql[] = []
  if (fila && venueIds.length) {
    crudo.push(Prisma.sql`
      SELECT CASE WHEN e."sourceType" = 'COMMISSION' THEN 'COMISION' WHEN e."sourceType" = 'TIP' THEN 'PROPINA'
                  WHEN e.concept = 'SERVICE' THEN 'CLASE' WHEN e.concept = 'RECONCILE' THEN 'DIFERENCIA' ELSE 'AJUSTE' END AS tipo,
             COALESCE(e."occurredAt", e."createdAt") AS instante, e.id, e."venueId",
             COALESCE(e.descriptor->>'fecha', to_char(e."createdAt", 'YYYY-MM-DD')) AS fecha,
             e.descriptor->>'hora' AS hora, e.descriptor->>'clase' AS clase, e.descriptor->>'sede' AS "sedeFoto",
             e.reason, e.descriptor->'periodoOrigen'->>'start' AS origen, e.count AS lugares, e.amount AS monto,
             e.descriptor->'regla' AS regla, e.descriptor->>'orden' AS orden, e.descriptor->>'esquema' AS esquema,
             (e.descriptor->>'base')::numeric AS base,
             CASE WHEN e."sourceType" IN ('COMMISSION', 'TIP') THEN e.descriptor->>'motivo' END AS motivo
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
      crudo.push(Prisma.sql`
        SELECT 'CLASE'::text AS tipo, vv."startsAt" AS instante, vv."classSessionId" AS id, vv."venueId", vv."fechaLocal" AS fecha,
               to_char(((vv."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'HH24:MI') AS hora,
               vv."productName" AS clase, NULL::text AS "sedeFoto", NULL::text AS reason, NULL::text AS origen,
               vv.conteo AS lugares, vv.monto, vv.regla AS regla, NULL::text AS orden, NULL::text AS esquema,
               NULL::numeric AS base, NULL::text AS motivo
        FROM (${valoracionCte(f)} SELECT * FROM valoradas) vv
        WHERE vv.estado = 'OK' AND vv.monto IS NOT NULL`)
    }
    // Spec fase 3 §11: el periodo abierto muestra en vivo las comisiones y propinas que hoy entrarían al cierre (las MISMAS
    // reglas que el cierre, B3). Sin activar no hay nada que mostrar.
    if (startDate && venueIds.length) {
      const a: AlcanceBarrido = {
        organizationId: prep.organizationId,
        periodo: { id: fila?.id ?? null, ...canon },
        sedes: venueIds.map(id => ({ venueId: id, tz: tzDe.get(id) ?? TZ_DEFAULT })),
        startDate,
      }
      // B11: con la participación por sede; los rangos, una vez para el recibo entero (en la MISMA foto).
      const ventas = sqlVentasDelPeriodo(a, await rangosConParticipacion(db, a), { staffId: input.staffId })
      if (ventas) {
        crudo.push(Prisma.sql`
          SELECT CASE v.fuente WHEN 'COMMISSION' THEN 'COMISION' ELSE 'PROPINA' END AS tipo, v.instante, v."sourceId" AS id,
                 v."venueId", v."fechaLocal" AS fecha, v.hora, NULL::text AS clase, v.sede AS "sedeFoto", NULL::text AS reason,
                 NULL::text AS origen, NULL::int AS lugares, v.monto, NULL::jsonb AS regla, v.orden, v.esquema, v.base, v.motivo
          FROM (${ventas}) v`)
      }
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
    sql: armarFuente(crudo, o.agruparPropinas),
    venueIds,
    pagadoEn: pagado?.paidAt?.toISOString() ?? null,
    llave: createHash('sha256')
      .update([prep.organizationId, canon.start, input.staffId, input.sede ?? ''].join('|'))
      .digest('hex')
      .slice(0, 12),
  }
}

/** El orden de las columnas de la fuente del recibo (contrato con D3c; lo fija la prueba de B5). */
export const COLUMNAS_FUENTE_RECIBO = [
  'tipo',
  'instante',
  'id',
  'venueId',
  'fecha',
  'hora',
  'clase',
  'sedeFoto',
  'reason',
  'origen',
  'lugares',
  'monto',
  'regla',
  'orden',
  'esquema',
  'base',
  'motivo',
  'agrupada',
  'cobros',
] as const

/**
 * B-D6: en pantalla y PDF las propinas se juntan por día, sede y signo («Propinas del 3 oct 2026 · 18 cobros»); el Excel
 * lleva cada cobro. El total, la cuenta y el cursor salen de ESTA fuente, así que siempre cuadran con lo que se ve.
 * 🔴 Columnas en ORDEN FIJO (el segundo brazo es posicional): `COLUMNAS_FUENTE_RECIBO`. Quien agregue una columna a las
 * fuentes crudas la agrega también aquí, en la misma posición; `regla` (13) ya está.
 */
function armarFuente(crudo: Prisma.Sql[], agruparPropinas: boolean): Prisma.Sql | null {
  if (!crudo.length) return null
  const union = Prisma.join(crudo, ' UNION ALL ')
  if (!agruparPropinas) return Prisma.sql`SELECT c.*, false AS agrupada, 1 AS cobros FROM (${union}) c`
  return Prisma.sql`
    WITH crudo AS (${union})
    SELECT c.*, false AS agrupada, 1 AS cobros FROM crudo c WHERE c.tipo <> 'PROPINA'
    UNION ALL
    SELECT 'PROPINA', MIN(c.instante), 'T:' || c."venueId" || ':' || c.fecha || ':' || c.motivo, c."venueId", c.fecha,
           NULL::text, NULL::text, MAX(c."sedeFoto"), NULL::text, NULL::text, NULL::int, SUM(c.monto),
           NULL::jsonb, NULL::text, NULL::text, NULL::numeric, c.motivo, true, COUNT(*)::int
    FROM crudo c
    WHERE c.tipo = 'PROPINA'
    GROUP BY c."venueId", c.fecha, c.motivo`
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

/** Total, cuenta y totales por tipo del recibo ENTERO, en UNA consulta sobre la MISMA fuente que las páginas. */
async function totalDelRecibo(
  db: Db,
  f: FuenteRecibo,
): Promise<{ total: Prisma.Decimal; cantidad: number; porTipo: Partial<Record<RenglonRecibo['tipo'], string>> }> {
  if (!f.sql) return { total: new Prisma.Decimal(0), cantidad: 0, porTipo: {} }
  const filas = await db.$queryRaw<Array<{ tipo: RenglonRecibo['tipo']; total: Prisma.Decimal | null; cantidad: number }>>`
    SELECT r.tipo, SUM(r.monto) AS total, COUNT(*)::int AS cantidad FROM (${f.sql}) r GROUP BY r.tipo`
  let total = new Prisma.Decimal(0)
  let cantidad = 0
  const porTipo: Partial<Record<RenglonRecibo['tipo'], string>> = {}
  for (const x of filas) {
    const t = new Prisma.Decimal(x.total ?? 0)
    total = total.plus(t)
    cantidad += x.cantidad
    porTipo[x.tipo] = t.toFixed(2)
  }
  return { total, cantidad, porTipo }
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

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`
const ventaDe = (r: FilaRecibo) => (r.orden ? `venta #${r.orden}` : null)

/**
 * Una comisión dice su esquema, su venta y su base (spec fase 3 §11): «Comisión Lagree 3 % · venta #1042 · base
 * $3,000.00»; una devolución o una anulación lo dicen al frente. Las propinas de un día van juntas en pantalla y PDF
 * («Propinas del 12 ago 2026 · 2 cobros») y una por cobro en el Excel («Propina · venta #1042»).
 */
function conceptoDe(r: FilaRecibo): string {
  if (r.tipo === 'AJUSTE') return r.reason ?? 'Ajuste'
  if (r.tipo === 'PROPINA') {
    if (r.agrupada) {
      return r.motivo === 'DEVOLUCION'
        ? `Propinas devueltas del ${fechaMx(r.fecha)} · ${plural(r.cobros, 'devolución', 'devoluciones')}`
        : `Propinas del ${fechaMx(r.fecha)} · ${plural(r.cobros, 'cobro', 'cobros')}`
    }
    return [r.motivo === 'DEVOLUCION' ? 'Devolución de propina' : 'Propina', ventaDe(r)].filter(Boolean).join(' · ')
  }
  if (r.tipo === 'COMISION') {
    const cabeza = r.motivo === 'ANULACION' ? 'Anulación · comisión' : r.motivo === 'DEVOLUCION' ? 'Devolución · comisión' : 'Comisión'
    const base = r.motivo === 'VENTA' && r.base !== null ? `base ${pesos.format(Number(r.base))}` : null
    return [r.esquema ? `${cabeza} ${r.esquema}` : cabeza, ventaDe(r), base].filter(Boolean).join(' · ')
  }
  const clase = r.clase ?? 'Clase'
  // `regla` sólo la llenan los brazos de clases, con la forma de `ReglaDeClase` (D3a).
  if (r.tipo === 'CLASE') return r.regla ? `${clase} · ${textoDeRegla(r.regla as ReglaDeClase)}` : clase
  // Una diferencia dice de qué clase es (QA bloque B, defecto 3): «Diferencia · Yoga del 28 sep 2026 (clase de septiembre)».
  // La fecha es la local de la clase en su sede (la de su foto) y el mes, el de su periodo de origen.
  const mes = r.origen ? ` (clase de ${MESES_LARGOS[Number(r.origen.slice(5, 7)) - 1]})` : ''
  return `Diferencia · ${clase} del ${fechaMx(r.fecha)}${mes}`
}

const aRenglon =
  (f: FuenteRecibo) =>
  (r: FilaRecibo): RenglonRecibo => ({
    tipo: r.tipo,
    // Un ajuste no es de un día de servicio: su fecha es la de CAPTURA y no lleva hora (QA 2026-10-03, defecto 9).
    fecha: r.fecha,
    // Un día de propinas tampoco tiene una hora.
    hora: r.tipo === 'AJUSTE' || r.agrupada ? null : r.hora,
    // Lo congelado manda (spec §5.6; Codex bloque A #8): renombrar la sede no reescribe un recibo cerrado. El nombre de
    // hoy sólo para lo valorado en vivo, que no trae foto.
    sede: r.sedeFoto ?? f.nombreSede.get(r.venueId) ?? '',
    concepto: conceptoDe(r),
    lugares: r.lugares,
    monto: new Prisma.Decimal(r.monto).toFixed(2),
  })

const acotar = (limit: number) => Math.min(Math.max(Math.trunc(limit) || 1, 1), RECIBO_LIMITE_MAX)

/** Una página del recibo; su página y su total salen de la MISMA instantánea (Codex R3-Nuevo 1). */
export async function reciboDePersona(input: EntradaRecibo): Promise<Recibo> {
  const prep = await prepararRecibo(input) // cliente global ANTES de la instantánea (Codex R4-Nuevo 1)
  await input.trasPreparar?.()
  return enUnaFoto(async tx => {
    const f = await fuenteDelRecibo(tx, prep, input, { agruparPropinas: true })
    const { total, cantidad, porTipo } = await totalDelRecibo(tx, f)
    const pagina = await paginaDelRecibo(tx, f, input.cursor, acotar(input.limit))
    // B12: en la MISMA foto; sólo el recibo abierto (lo de su periodo ya es renglón: `excluirPeriodo`).
    const pendientes =
      f.periodo.estado === 'CLOSED'
        ? null
        : await devolucionesPendientes(tx, {
            organizationId: prep.organizationId,
            sedes: f.venueIds,
            staffId: input.staffId,
            excluirPeriodo: f.periodo,
          })
    return {
      persona: f.persona,
      periodo: f.periodo,
      renglones: pagina.filas.map(aRenglon(f)),
      total: total.toFixed(2),
      cantidad,
      siguiente: pagina.siguiente,
      pagadoEn: f.pagadoEn,
      parcial: f.parcial,
      totalesPorTipo: porTipo,
      pendientes,
    }
  })
}

/** La consulta de UNA página del recibo tal como se ejecuta, para su `EXPLAIN` en A13 (Codex R3-R1-12). Nada más la usa. */
export async function consultaDePaginaDelRecibo(input: EntradaRecibo): Promise<Prisma.Sql | null> {
  const f = await fuenteDelRecibo(prisma, await prepararRecibo(input), input, { agruparPropinas: true })
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

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
/** «29 sep 2026»; un ajuste se fecha cuando se capturó y lo dice. La fila del total va sin fecha. */
const fechaDelRenglon = (r: RenglonRecibo) => (r.fecha ? `${fechaMx(r.fecha)}${r.tipo === 'AJUSTE' ? ' (captura)' : ''}` : '')
/**
 * `pdfAncho`: el Concepto se lleva casi la mitad de la hoja para que una diferencia se lea entera en el PDF («Diferencia ·
 * Yoga (clase grupal) del 28 sep 2026 (clase de septiembre)», ~280 pt a 9 pt) sin cortar fecha de captura, sede ni monto.
 */
const COLUMNAS: ExportColumnDef<RenglonRecibo>[] = [
  { id: 'fecha', label: 'Fecha', value: fechaDelRenglon, pdfAncho: 1.3 },
  { id: 'hora', label: 'Hora', value: r => r.hora, pdfAncho: 0.6 },
  { id: 'sede', label: 'Sede', value: r => r.sede, pdfAncho: 1.5 },
  { id: 'concepto', label: 'Concepto', value: r => r.concepto, pdfAncho: 4 },
  { id: 'lugares', label: 'Lugares', value: r => r.lugares, pdfAncho: 0.7 },
  { id: 'monto', label: 'Monto', value: r => pesos.format(Number(r.monto)), pdfAncho: 1 },
]
/** El Excel lleva el monto como NÚMERO con formato de moneda (el dueño lo suma); `monto` ya viene con 2 decimales. */
const COLUMNAS_EXCEL: ExportColumnDef<RenglonRecibo>[] = COLUMNAS.map(c =>
  c.id === 'monto' ? { ...c, value: r => Number(r.monto), numFmt: '$#,##0.00' } : c,
)
/** Las columnas de cada formato (exportada para su prueba). */
export const columnasDelRecibo = (formato: 'pdf' | 'xlsx') => (formato === 'xlsx' ? COLUMNAS_EXCEL : COLUMNAS)
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
    // El Excel lleva cada cobro por separado; la pantalla y el PDF, las propinas de un día juntas (B-D6).
    const f = await fuenteDelRecibo(tx, prep, input, { agruparPropinas: input.format === 'pdf' })
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
  const columnas = columnasDelRecibo(input.format)
  const encoded = await encodeExport(input.format, {
    allColumns: columnas,
    requestedColumnIds: columnas.map(c => c.id),
    rows: filasDelRecibo({ renglones, total: total.toFixed(2), parcial: f.parcial }),
    title: `Recibo de ${f.persona} · ${fechaMx(f.periodo.start)} al ${fechaMx(f.periodo.end)}`,
    sheetName: `Recibo de ${f.persona}`,
  })
  return { encoded, nombre: `recibo-${slug(f.persona)}-${f.periodo.start}` }
}
