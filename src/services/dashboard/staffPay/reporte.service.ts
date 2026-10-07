import { Prisma, ServicePayPeriod } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { ConflictError } from '../../../errors/AppError'
import { periodoQueContieneFecha } from './periodosGuardados'
import { ClaseValorada, contarPorEstado, FiltroValoracion, valoracionCte, valorarClases } from './valoracion'
import { dbDateComoFecha, hoyLocal, periodoQueContiene, PeriodoCanonico, venuePeriodRange } from './periodos'
import { AlcanceBarrido, nombreGuardadoSql, PERSONA_DADA_DE_BAJA, sqlVentasDelPeriodo } from './fuentesVenta'
import { rangosConParticipacion } from './rangos'
import { alcanceEnLaFoto, LecturaPreparada, prepararLectura, zonasEnLaFoto } from './lectura'
import { enUnaFoto } from './foto'

type Db = Prisma.TransactionClient | typeof prisma

/** Los campos del ancla (A4) no salen en el desglose: la pantalla no los usa y `payAmountOverride` saldría sin formato. */
type CamposDelAncla = 'fechaValoracion' | 'periodoOrigen' | 'cancelada' | 'payCountOverride' | 'payAmountOverride' | 'excluida'
export type ClaseValoradaDto = Omit<ClaseValorada, 'monto' | CamposDelAncla> & { monto: string | null }
const dto = ({
  fechaValoracion,
  periodoOrigen,
  cancelada,
  payCountOverride,
  payAmountOverride,
  excluida,
  ...c
}: ClaseValorada): ClaseValoradaDto => ({ ...c, monto: c.monto ? new Prisma.Decimal(c.monto).toFixed(2) : null })

interface Contexto {
  organizationId: string
  periodicidad: 'MONTHLY' | 'SEMIMONTHLY'
  periodo: PeriodoCanonico
  venueIds: string[]
  parcial: boolean
  filtros: FiltroValoracion[]
  /** El periodo guardado que contiene la fecha (D1: puede no existir aún). */
  fila: ServicePayPeriod | null
  /** `Organization.staffPayStartDate` (fase 3): sin activar, el periodo abierto no muestra ventas. */
  startDate: string | null
}

/** Quién pregunta y por qué sedes (`soloSedes`: el alcance de una conexión MCP, B14-fix F1). */
type EntradaReporte = { userId: string; venueId: string; fecha?: string; sede?: string; soloSedes?: readonly string[] }
/** Lo resuelto con el cliente GLOBAL antes de leer (`prepararLectura`) y el día que se pidió (o «hoy» de quien pregunta). */
type ReportePreparado = { dia: string; lectura: LecturaPreparada }

async function preparar(input: EntradaReporte): Promise<ReportePreparado> {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true, timezone: true } })
  const dia = input.fecha ?? hoyLocal(v.timezone || 'America/Mexico_City')
  return { dia, lectura: await prepararLectura({ ...input, organizationId: v.organizationId, fecha: dia }) }
}

/**
 * Alcance del reporte: las sedes con el módulo que el usuario puede leer (spec §9.2) y, si pidió `sede` (filtro de sede,
 * spec §7.3), sólo la intersección con esa sede. Una sede no legible o sin el módulo da alcance VACÍO, nunca otras sedes,
 * y entonces `parcial` es true: el usuario no está viendo lo que pidió. 🔴 El MISMO alcance legible que el recibo (Codex R1-1,
 * R3-Nuevo 2; `alcanceEnLaFoto`): CERRADO = su alcance guardado; ABIERTO = guardadas ∪ con módulo ∪ con ventana.
 * B14-fix: con `db` = la foto del reporte (F3) se lee TODO del mismo instante —periodicidad, periodo, sedes y sus zonas— y
 * una sede que ya no es de la organización no entra (F2). Permisos y módulos llegan resueltos (`preparar`).
 */
async function contextoEn(db: Db, p: ReportePreparado, sede?: string): Promise<Contexto> {
  const organizationId = p.lectura.organizationId
  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { servicePayPeriodicity: true, staffPayStartDate: true },
  })
  const periodicidad = org.servicePayPeriodicity
  const canonico = periodoQueContiene(p.dia, periodicidad)
  const fila = await periodoQueContieneFecha(db, organizationId, canonico.start)
  const periodo: PeriodoCanonico = fila ? { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd) } : canonico
  const startDate = org.staffPayStartDate ? dbDateComoFecha(org.staffPayStartDate) : null
  const legible = alcanceEnLaFoto(p.lectura, fila, periodo, startDate, sede)
  const tzDe = await zonasEnLaFoto(db, organizationId, legible.venueIds)
  const venueIds = legible.venueIds.filter(v => tzDe.has(v))
  const ahora = new Date()
  const filtros = venueIds.map(id => {
    const tz = tzDe.get(id)!
    const { from, to } = venuePeriodRange(periodo, tz)
    return { venueId: id, organizationId, tz, desde: from, hasta: to, ahora }
  })
  return { organizationId, periodicidad, periodo, venueIds, parcial: legible.parcial, filtros, fila, startDate }
}

/** Con el cliente global, sin foto: el desglose en vivo, las excepciones, las huérfanas y el `EXPLAIN` de A13. */
const contexto = async (input: EntradaReporte) => contextoEn(prisma, await preparar(input), input.sede)

/**
 * La fuente de personas del periodo ABIERTO, en UNA consulta (Codex R2-R1-12): la valoración en vivo de cada sede (cada
 * rama es una subconsulta con su PROPIO `WITH`), los RECONCILE/MANUAL guardados del periodo y —fase 3 §11— las comisiones
 * y propinas que hoy entrarían al cierre (las MISMAS reglas que el cierre, B3), con `UNION ALL`. Cada rama trae
 * `comisiones` y `propinas` aparte (0 donde no aplica). Devuelve null si no hay ninguna sede legible.
 */
async function fuentePorPersona(db: Db, c: Contexto): Promise<Prisma.Sql | null> {
  const partes = c.filtros.map(
    f => Prisma.sql`
      SELECT vv."staffId", vv."staffName", vv."venueId", 1 AS clases, vv.conteo AS lugares, vv.monto, 0::numeric AS ajuste,
             0::numeric AS comisiones, 0::numeric AS propinas
      FROM (${valoracionCte(f)} SELECT * FROM valoradas) vv
      WHERE vv.estado = 'OK' AND vv."staffId" IS NOT NULL`,
  )
  if (c.fila && c.venueIds.length) {
    partes.push(Prisma.sql`
      SELECT e."staffId", COALESCE(NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), ''), e.descriptor->>'persona') AS "staffName",
             e."venueId", 0 AS clases, 0 AS lugares, e.amount AS monto, e.amount AS ajuste, 0::numeric AS comisiones,
             0::numeric AS propinas
      FROM "ServiceEarning" e
      LEFT JOIN "Staff" s ON s.id = e."staffId"
      WHERE e."periodId" = ${c.fila.id} AND e.concept IN ('RECONCILE', 'MANUAL') AND e."venueId" IN (${Prisma.join(c.venueIds)})`)
  }
  // B11: con la participación por sede; los rangos, una vez para el reporte entero.
  const a: AlcanceBarrido | null =
    c.startDate && c.filtros.length
      ? {
          organizationId: c.organizationId,
          periodo: { id: c.fila?.id ?? null, ...c.periodo },
          sedes: c.filtros.map(f => ({ venueId: f.venueId, tz: f.tz })),
          startDate: c.startDate,
        }
      : null
  const ventas = a ? sqlVentasDelPeriodo(a, await rangosConParticipacion(db, a)) : null
  if (ventas) {
    partes.push(Prisma.sql`
      SELECT v."staffId", v.persona AS "staffName", v."venueId", 0 AS clases, 0 AS lugares, v.monto, 0::numeric AS ajuste,
             CASE WHEN v.fuente = 'COMMISSION' THEN v.monto ELSE 0 END AS comisiones,
             CASE WHEN v.fuente = 'TIP' THEN v.monto ELSE 0 END AS propinas
      FROM (${ventas}) v`)
  }
  return partes.length ? Prisma.join(partes, ' UNION ALL ') : null
}

// Las consultas pesadas del reporte, como funciones: el reporte las ejecuta y A13 las pasa por `EXPLAIN` (Codex R3-R1-12).
// `total` sale de la MISMA fuente que las personas: la tarjeta y la suma de las personas no pueden descuadrar.
const sqlCuentaAbierto = (fuente: Prisma.Sql) => Prisma.sql`
  SELECT COUNT(DISTINCT u."staffId")::int AS personas, SUM(u.monto) AS total,
         SUM(u.comisiones) AS comisiones, SUM(u.propinas) AS propinas
  FROM (${fuente}) u`

const sqlPaginaAbierto = (c: Contexto, fuente: Prisma.Sql, offset: number, limit: number) => Prisma.sql`
  SELECT g.*, nv.name AS "payLevelName"
  FROM (
    SELECT u."staffId",
           -- Una persona borrada: un nombre real de sus ramas y si no, el que guardó (la regla del recibo); nunca gana
           -- «Persona dada de baja» (lo que dice una venta en vivo sin fila de Staff) sobre su nombre.
           COALESCE(MAX(NULLIF(u."staffName", ${PERSONA_DADA_DE_BAJA})), ${nombreGuardadoSql(c.organizationId, Prisma.sql`u."staffId"`)},
                    MAX(u."staffName")) AS "staffName",
           -- Las sedes donde hubo dinero (clases, ventas o ajustes), la misma regla que el cerrado.
           ARRAY_AGG(DISTINCT u."venueId") AS "venueIds",
           SUM(u.clases)::int AS clases, COALESCE(SUM(u.lugares), 0)::int AS "sumaLugares",
           SUM(u.ajuste) AS ajustes, SUM(u.comisiones) AS comisiones, SUM(u.propinas) AS propinas, SUM(u.monto) AS total
    FROM (${fuente}) u
    GROUP BY u."staffId"
    ORDER BY "staffName" ASC NULLS LAST, u."staffId" ASC
    OFFSET ${offset} LIMIT ${limit}
  ) g
  LEFT JOIN LATERAL (
    SELECT l.name
    FROM "StaffPayLevelAssignment" a JOIN "StaffPayLevel" l ON l.id = a."payLevelId"
    WHERE a."organizationId" = ${c.organizationId} AND a."staffId" = g."staffId" AND a."effectiveFrom" <= ${c.periodo.end}::date
    ORDER BY a."effectiveFrom" DESC, a.revision DESC
    LIMIT 1
  ) nv ON true
  ORDER BY g."staffName" ASC NULLS LAST, g."staffId" ASC`

// Codex R3-R1-12: las dos consultas del reporte cerrado, como funciones (las ejecuta `reporteCerrado` y las mide A13).
const sqlTarjetasCerrado = (c: Contexto) => Prisma.sql`
    SELECT SUM(e.amount) AS total,
           COUNT(*) FILTER (WHERE e.concept = 'SERVICE' AND e."sourceType" = 'CLASS_SESSION')::int AS clases,
           SUM(e.amount) FILTER (WHERE e."sourceType" = 'COMMISSION') AS comisiones,
           SUM(e.amount) FILTER (WHERE e."sourceType" = 'TIP') AS propinas,
           COUNT(DISTINCT e."staffId")::int AS personas,
           COUNT(DISTINCT e."staffId") FILTER (WHERE st."paidAt" IS NOT NULL)::int AS pagadas
    FROM "ServiceEarning" e
    LEFT JOIN "StaffPayStatement" st ON st."periodId" = e."periodId" AND st."staffId" = e."staffId"
    WHERE e."periodId" = ${c.fila!.id} AND e."venueId" IN (${Prisma.join(c.venueIds)})`

const sqlPaginaCerrado = (c: Contexto, offset: number, limit: number) => Prisma.sql`
    SELECT e."staffId",
           -- Una persona borrada conserva el nombre que guardó (fase 3 §6.1), con la MISMA regla que su recibo (B5 r1).
           COALESCE(NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), ''),
                    ${nombreGuardadoSql(c.organizationId, Prisma.sql`e."staffId"`)},
                    CASE WHEN MAX(s.id) IS NULL THEN ${PERSONA_DADA_DE_BAJA} END) AS "staffName",
           MAX(e."payLevelName") FILTER (WHERE e.concept = 'SERVICE' AND e."sourceType" = 'CLASS_SESSION') AS "payLevelName",
           ARRAY_AGG(DISTINCT e."venueId") AS "venueIds",
           COUNT(*) FILTER (WHERE e.concept = 'SERVICE' AND e."sourceType" = 'CLASS_SESSION')::int AS clases,
           COALESCE(SUM(e.count) FILTER (WHERE e.concept = 'SERVICE' AND e."sourceType" = 'CLASS_SESSION'), 0)::int AS "sumaLugares",
           -- Sólo diferencias de clase y ajustes manuales: las anulaciones de comisión cuentan en comisiones.
           SUM(e.amount) FILTER (WHERE e.concept <> 'SERVICE' AND e."sourceType" IS DISTINCT FROM 'COMMISSION') AS ajustes,
           SUM(e.amount) FILTER (WHERE e."sourceType" = 'COMMISSION') AS comisiones,
           SUM(e.amount) FILTER (WHERE e."sourceType" = 'TIP') AS propinas,
           SUM(e.amount) AS total, MAX(st."paidAt") AS "paidAt"
    FROM "ServiceEarning" e
    LEFT JOIN "Staff" s ON s.id = e."staffId"
    LEFT JOIN "StaffPayStatement" st ON st."periodId" = e."periodId" AND st."staffId" = e."staffId"
    WHERE e."periodId" = ${c.fila!.id} AND e."venueId" IN (${Prisma.join(c.venueIds)})
    GROUP BY e."staffId", s."firstName", s."lastName"
    -- Codex R2-R1-12: por nombre e id, paginado en SQL; el total de personas es el COUNT(DISTINCT) de arriba.
    ORDER BY "staffName" ASC NULLS LAST, e."staffId" ASC
    OFFSET ${offset} LIMIT ${limit}`

/**
 * Las consultas del reporte TAL COMO se ejecutan (agregada por persona y `COUNT(DISTINCT)`), SÓLO para su `EXPLAIN` en
 * A13 (Codex R3-R1-12). null si no hay sedes legibles.
 */
export async function consultasDelReporte(input: { userId: string; venueId: string; fecha?: string; offset: number; limit: number }) {
  const c = await contexto(input)
  if (c.fila?.status === 'CLOSED') {
    return c.venueIds.length ? { cuenta: sqlTarjetasCerrado(c), pagina: sqlPaginaCerrado(c, input.offset, input.limit) } : null
  }
  const fuente = await fuentePorPersona(prisma, c)
  return fuente ? { cuenta: sqlCuentaAbierto(fuente), pagina: sqlPaginaAbierto(c, fuente, input.offset, input.limit) } : null
}

const pesosDe = (d: Prisma.Decimal | null | undefined) => new Prisma.Decimal(d ?? 0).toFixed(2)

/**
 * B14-fix F3 (Codex participación r1 #3): el reporte ENTERO —periodo, alcance, contadores, rangos, total, personas, página y
 * huérfanas— en UNA foto (`enUnaFoto`: su tope de 60 s, también en la base). Antes leía con el cliente global y una
 * desactivación que confirmaba entre los rangos de ventas y la valoración de clases dejaba un total imposible ($100 de una
 * comisión sin la clase de $500 del mismo día: ni el $600 de antes ni el $0 de después). Permisos y módulos, antes.
 */
export async function reportePeriodo(input: EntradaReporte & { offset: number; limit: number }) {
  const p = await preparar(input)
  // El MCP llama sin la validación de la ruta: el offset se acota aquí también.
  const offset = Math.max(0, Math.trunc(input.offset) || 0)
  const limit = Math.min(Math.max(input.limit, 1), 100)
  return enUnaFoto(async tx => {
    const c = await contextoEn(tx, p, input.sede)
    return c.fila?.status === 'CLOSED' ? reporteCerrado(tx, c, offset, limit) : reporteAbierto(tx, c, offset, limit)
  })
}

async function reporteAbierto(db: Db, c: Contexto, offset: number, limit: number) {
  // Contadores de clases: agregados en la base (fase 1), sede por sede. El dinero sale de `cuenta`, abajo.
  let clases = 0,
    excepciones = 0,
    excluidas = 0
  for (const f of c.filtros) {
    const e = await contarPorEstado(db, f)
    clases += e.ok
    excepciones += e.excepciones
    excluidas += e.excluidas
  }
  const fuente = await fuentePorPersona(db, c)
  // Total de personas y de dinero: un COUNT(DISTINCT) y un SUM aparte (Codex R2-R1-12).
  const [cuenta] = fuente
    ? await db.$queryRaw<
        Array<{ personas: number; total: Prisma.Decimal | null; comisiones: Prisma.Decimal | null; propinas: Prisma.Decimal | null }>
      >(sqlCuentaAbierto(fuente))
    : [{ personas: 0, total: null, comisiones: null, propinas: null }]
  const total = cuenta.total ?? new Prisma.Decimal(0)
  // La página: agrupada por persona, ordenada por nombre e id, con OFFSET/LIMIT en SQL; el nivel vigente al final del
  // periodo sólo para las personas de ESTA página.
  const pagina = fuente
    ? await db.$queryRaw<
        Array<{
          staffId: string
          staffName: string | null
          payLevelName: string | null
          venueIds: string[] | null
          clases: number
          sumaLugares: number
          ajustes: Prisma.Decimal | null
          comisiones: Prisma.Decimal | null
          propinas: Prisma.Decimal | null
          total: Prisma.Decimal
        }>
      >(sqlPaginaAbierto(c, fuente, offset, limit))
    : []
  const items = pagina.map(p => ({
    staffId: p.staffId,
    staffName: p.staffName ?? '—',
    payLevelName: p.payLevelName,
    venueIds: p.venueIds ?? [],
    clases: p.clases,
    promedioLugares: p.clases ? Math.round((p.sumaLugares / p.clases) * 10) / 10 : 0,
    ajustes: pesosDe(p.ajustes),
    comisiones: pesosDe(p.comisiones),
    propinas: pesosDe(p.propinas),
    total: new Prisma.Decimal(p.total).toFixed(2),
    pagadoEn: null as string | null,
  }))
  return {
    periodo: { ...c.periodo, periodicidad: c.periodicidad, id: c.fila?.id ?? null, estado: 'OPEN' as const },
    parcial: c.parcial,
    venueIds: c.venueIds,
    // El campo se queda (contrato); ya no hay tope por sede que pueda truncar: se pagina en SQL (Codex R2-R1-12).
    truncado: false,
    tarjetas: {
      total: total.toFixed(2),
      clases,
      personas: cuenta.personas,
      excepciones,
      excluidas,
      comisiones: pesosDe(cuenta.comisiones),
      propinas: pesosDe(cuenta.propinas),
    },
    personas: { items, total: cuenta.personas, offset, limit },
    huerfanas: await contarHuerfanas(db, c),
  }
}

async function reporteCerrado(db: Db, c: Contexto, offset: number, limit: number) {
  const periodo = { ...c.periodo, periodicidad: c.periodicidad, id: c.fila!.id, estado: 'CLOSED' as const }
  const vacio = { periodo, parcial: c.parcial, venueIds: c.venueIds, truncado: false, huerfanas: 0 }
  if (!c.venueIds.length) {
    return {
      ...vacio,
      tarjetas: { total: '0.00', clases: 0, personas: 0, pagadas: 0, excepciones: 0, excluidas: 0, comisiones: '0.00', propinas: '0.00' },
      personas: { items: [], total: 0, offset, limit },
    }
  }
  const [t] = await db.$queryRaw<
    Array<{
      total: Prisma.Decimal | null
      clases: number
      comisiones: Prisma.Decimal | null
      propinas: Prisma.Decimal | null
      personas: number
      pagadas: number
    }>
  >(sqlTarjetasCerrado(c))
  const filas = await db.$queryRaw<
    Array<{
      staffId: string
      staffName: string | null
      payLevelName: string | null
      venueIds: string[]
      clases: number
      sumaLugares: number
      ajustes: Prisma.Decimal | null
      comisiones: Prisma.Decimal | null
      propinas: Prisma.Decimal | null
      total: Prisma.Decimal
      paidAt: Date | null
    }>
  >(sqlPaginaCerrado(c, offset, limit))
  return {
    ...vacio,
    // `pagadas` es del periodo entero (Codex R1-23): el contador no puede depender de la página que se ve.
    tarjetas: {
      total: (t.total ?? new Prisma.Decimal(0)).toFixed(2),
      clases: t.clases,
      personas: t.personas,
      pagadas: t.pagadas,
      excepciones: 0,
      excluidas: 0,
      comisiones: pesosDe(t.comisiones),
      propinas: pesosDe(t.propinas),
    },
    personas: {
      items: filas.map(f => ({
        staffId: f.staffId,
        staffName: f.staffName ?? '—',
        payLevelName: f.payLevelName,
        venueIds: f.venueIds,
        clases: f.clases,
        promedioLugares: f.clases ? Math.round((f.sumaLugares / f.clases) * 10) / 10 : 0,
        ajustes: pesosDe(f.ajustes),
        comisiones: pesosDe(f.comisiones),
        propinas: pesosDe(f.propinas),
        total: new Prisma.Decimal(f.total).toFixed(2),
        pagadoEn: f.paidAt?.toISOString() ?? null,
      })),
      total: t.personas,
      offset,
      limit,
    },
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

/** Codex R2-R1-21: lo EN VIVO (desglose, excepciones, huérfanas) excluye las clases ancladas: de un periodo cerrado mentiría. */
async function contextoEnVivo(input: EntradaReporte): Promise<Contexto> {
  const c = await contexto(input)
  if (c.fila?.status === 'CLOSED') throw new ConflictError('Este periodo ya se cerró: consulta el recibo.', 'PERIODO_CERRADO')
  return c
}

export async function detallePersona(input: EntradaReporte & { staffId: string; despuesDe?: string; limit: number }) {
  return recorrer(await contextoEnVivo(input), { staffId: input.staffId }, input.despuesDe, input.limit)
}

export async function excepcionesPeriodo(input: EntradaReporte & { despuesDe?: string; limit: number }) {
  return recorrer(await contextoEnVivo(input), {}, input.despuesDe, input.limit, true)
}

function whereHuerfanas(c: Contexto): Prisma.ReservationWhereInput {
  return {
    OR: c.filtros.map(f => ({ venueId: f.venueId, startsAt: { gte: f.desde, lt: f.hasta } })),
    classSessionId: null,
    status: { notIn: ['CANCELLED', 'PENDING'] },
    product: { type: 'CLASS' },
  }
}

async function contarHuerfanas(db: Db, c: Contexto): Promise<number> {
  if (!c.filtros.length) return 0
  return db.reservation.count({ where: whereHuerfanas(c) })
}

export async function huerfanasPeriodo(input: EntradaReporte & { offset: number; limit: number }) {
  const c = await contextoEnVivo(input)
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
