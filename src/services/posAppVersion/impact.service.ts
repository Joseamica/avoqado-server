// Actualizador del POS — impacto de una mínima candidata (spec §4.4).
//
// Contesta «si pongo esta mínima, ¿cuántos registros quedan debajo, y en qué negocios?». Es orientativo: el aparato sólo se
// bloquea si su tienda le confirma la actualización (§6.3).
//
// Reglas que no se negocian:
// 1. NO se juntan registros. Cada `Terminal` (una instalación en un negocio) cuenta por separado: juntar por aparato se
//    intentó dos veces y las dos falló (el `deviceUid` cambia al reinstalar; el `lastHeartbeat` más reciente puede traer una
//    versión vieja). El conteo se equivoca hacia arriba, a propósito.
// 2. UNA sola sentencia (un `WITH`): los totales, los grupos por versión y los negocios salen de la misma foto de la base y
//    no pueden contradecirse. Los totales son exactos; las listas, con tope de 50.
// 3. Conversiones seguras: nunca se convierte un texto que no cumple su forma, así que una versión inventada en un registro
//    va a `unknownVersion` y no tumba la consulta.
// 4. Nada de texto pegado: los valores van como parámetros de `Prisma.sql`; `Prisma.raw` sólo con constantes de este archivo.
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { normalizeVersionName } from './version'

type Plataforma = 'ANDROID' | 'IOS'

export interface ImpactView {
  platform: Plataforma
  days: number
  candidate: { versionCode: number | null; versionName: string | null } | null
  totalSeen: number
  below: number | null
  unknownVersion: number
  venuesBelow: number | null
  byVersion: Array<{ versionCode: number | null; versionName: string | null; records: number; venues: number; lastSeenAt: string }>
  byVersionTruncated: boolean
  venuesBelowList: Array<{ venueId: string; venueName: string; records: number; lastSeenAt: string }>
  venuesBelowListTruncated: boolean
}

/** Lo que se muestra de cada lista; se piden 51 para saber si hubo más. */
const TOPE_DE_LISTA = 50
const POLICY_ERROR = 'POS_APP_VERSION_POLICY_INVALID'
const DIAS_MIN = 1
const DIAS_MAX = 90

/**
 * Por plataforma, fijos en el código (nunca del usuario):
 * - el tipo de `Terminal` que cuenta;
 * - el campo que decide si un registro queda debajo (ANDROID: el número de compilación; iOS: el nombre rellenado a 4 partes);
 * - cómo se arma cada renglón de `byVersion`: qué columnas lleva, por qué se agrupa y en qué orden sale (la más nueva primero).
 *
 * 🔴 En iOS el renglón es el NOMBRE, no la compilación (§4.1: en iOS el número sólo se muestra). Las apps de iOS sí guardan
 * su `CFBundleVersion` en `systemInfo.versionCode`, así que agrupar también por él partiría una misma versión (1.15.11 como
 * compilaciones 40 y 41) en varios renglones. Por eso en iOS el número sale `NULL` y no entra al grupo ni al orden.
 */
const POR_PLATAFORMA = {
  ANDROID: {
    tipo: 'POS_ANDROID',
    decide: Prisma.raw('"versionCode"'),
    columnasDelRenglon: Prisma.raw('"versionCode", "versionName", "nameKey"'),
    agruparPor: Prisma.raw('"versionCode", "versionName", "nameKey"'),
    ordenDelRenglon: ['"versionCode"', '"nameKey"', '"versionName"'],
  },
  IOS: {
    tipo: 'POS_IOS',
    decide: Prisma.raw('"nameKey"'),
    columnasDelRenglon: Prisma.raw('NULL::bigint AS "versionCode", "versionName", "nameKey"'),
    agruparPor: Prisma.raw('"versionName", "nameKey"'),
    ordenDelRenglon: ['"nameKey"', '"versionName"'],
  },
} as const

/** El orden de los renglones de `byVersion`, con o sin el alias de la subconsulta. Sólo constantes de `POR_PLATAFORMA`. */
function ordenDeLasVersiones(columnas: readonly string[], alias: '' | 'g.'): Prisma.Sql {
  return Prisma.raw(columnas.map(c => `${alias}${c} DESC NULLS LAST`).join(', '))
}

/** La hora de la columna es reloj UTC sin zona: se formatea igual que `Date.toISOString()`. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

type FilaCruda = {
  totalSeen: unknown
  unknownVersion: unknown
  below: unknown
  venuesBelow: unknown
  byVersion: Array<Record<string, unknown>> | null
  venuesBelowList: Array<Record<string, unknown>> | null
}

export async function getImpact(input: {
  platform: Plataforma
  candidate: { versionCode?: number; versionName?: string } | null
  days: number
}): Promise<ImpactView> {
  const { platform, days } = input
  const conf = POR_PLATAFORMA[platform]

  // La ruta ya valida todo esto (`impactQuerySchema` + `assertImpactCandidate`); aquí se repite por si alguien llama directo,
  // porque una candidata que no decide daría `below: null` como si no la hubiera, y un `days` raro llegaría al `::int`.
  if (!Number.isInteger(days) || days < DIAS_MIN || days > DIAS_MAX) {
    throw new BadRequestError('Los días deben ser de 1 a 90', POLICY_ERROR)
  }
  const candidata = resolverCandidata(platform, input.candidate)

  const debajo = candidata ? Prisma.sql`(${conf.decide} IS NOT NULL AND ${conf.decide} < ${candidata.parametro})` : Prisma.sql`false`

  // Dos detalles del texto que no se ven a simple vista (los dos se probaron contra un Postgres 16 desechable):
  // - El punto del nombre de iOS va como `[.]`, no `\.`: en una plantilla de JS el `\.` pierde la barra, el punto aceptaría
  //   cualquier carácter y una versión «1x16» tumbaría TODA la consulta en el `::int[]`.
  // - La ventana se mide con `now() AT TIME ZONE 'UTC'`: `lastHeartbeat` guarda el reloj UTC sin zona, y un `now()` a secas
  //   se compararía en la zona de la sesión (la local es America/Mexico_City: 6 horas corrido).
  // Y una decisión a propósito en la exclusión de demos (`v."status" <> 'LIVE_DEMO'`): LIVE_DEMO es la demo pública y
  // anónima, no un cliente. Los negocios TRIAL sí cuentan: son prospectos reales en su alta, y contarlos equivoca el conteo
  // hacia arriba, como pide §4.4.
  const consulta = Prisma.sql`WITH vistos AS (
  SELECT t."venueId", v."name" AS "venueName", t."lastHeartbeat",
         t."version" AS "versionName",
         CASE WHEN t."systemInfo"->>'versionCode' ~ '^[1-9][0-9]{0,9}$'
              THEN (t."systemInfo"->>'versionCode')::bigint END AS "versionCode",
         CASE WHEN t."version" ~ '^[0-9]{1,6}([.][0-9]{1,6}){0,3}$'
              THEN ((string_to_array(t."version" || '.0.0.0', '.'))[1:4])::int[] END AS "nameKey"
  FROM "Terminal" t
  JOIN "Venue" v ON v."id" = t."venueId"
  WHERE t."type" = ${conf.tipo}::"TerminalType"
    AND t."lastHeartbeat" >= (now() AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
    AND v."status" <> 'LIVE_DEMO'
), clasificados AS (
  SELECT vistos.*,
         (${conf.decide} IS NULL) AS desconocido,
         ${debajo} AS debajo
  FROM vistos
)
SELECT json_build_object(
  'totalSeen', (SELECT count(*) FROM clasificados),
  'unknownVersion', (SELECT count(*) FROM clasificados WHERE desconocido),
  'below', ${candidata ? Prisma.sql`(SELECT count(*) FROM clasificados WHERE debajo)` : Prisma.sql`NULL`},
  'venuesBelow', ${candidata ? Prisma.sql`(SELECT count(DISTINCT "venueId") FROM clasificados WHERE debajo)` : Prisma.sql`NULL`},
  'byVersion', (
    SELECT COALESCE(json_agg(json_build_object(
             'versionCode', g."versionCode",
             'versionName', g."versionName",
             'records', g.cuantos,
             'venues', g.negocios,
             'lastSeenAt', to_char(g.ultima_vez, ${Prisma.raw(ISO_UTC)}))
           ORDER BY ${ordenDeLasVersiones(conf.ordenDelRenglon, 'g.')}), '[]'::json)
    FROM (
      SELECT ${conf.columnasDelRenglon},
             count(*) AS cuantos, count(DISTINCT "venueId") AS negocios, max("lastHeartbeat") AS ultima_vez
      FROM clasificados
      GROUP BY ${conf.agruparPor}
      ORDER BY ${ordenDeLasVersiones(conf.ordenDelRenglon, '')}
      LIMIT ${Prisma.raw(String(TOPE_DE_LISTA + 1))}
    ) g
  ),
  'venuesBelowList', ${
    candidata
      ? Prisma.sql`(
    SELECT COALESCE(json_agg(json_build_object(
             'venueId', n."venueId",
             'venueName', n."venueName",
             'records', n.cuantos,
             'lastSeenAt', to_char(n.ultima_vez, ${Prisma.raw(ISO_UTC)}))
           ORDER BY n.cuantos DESC, n."venueName", n."venueId"), '[]'::json)
    FROM (
      SELECT "venueId", "venueName", count(*) AS cuantos, max("lastHeartbeat") AS ultima_vez
      FROM clasificados
      WHERE debajo
      GROUP BY "venueId", "venueName"
      ORDER BY count(*) DESC, "venueName", "venueId"
      LIMIT ${Prisma.raw(String(TOPE_DE_LISTA + 1))}
    ) n
  )`
      : Prisma.sql`'[]'::json`
  }
) AS result`

  const filas = await prisma.$queryRaw<Array<{ result: FilaCruda | string }>>(consulta)
  const crudo = filas[0]?.result
  // Un SELECT sin FROM siempre devuelve una fila: si no llega, algo se rompió y no se contesta con ceros inventados.
  if (crudo === undefined || crudo === null) throw new Error('La consulta de impacto no devolvió resultado')
  const r: FilaCruda = typeof crudo === 'string' ? JSON.parse(crudo) : crudo

  const versiones = Array.isArray(r.byVersion) ? r.byVersion : []
  const negocios = candidata && Array.isArray(r.venuesBelowList) ? r.venuesBelowList : []

  return {
    platform,
    days,
    candidate: candidata ? candidata.eco : null,
    totalSeen: aNumero(r.totalSeen) ?? 0,
    below: candidata ? (aNumero(r.below) ?? 0) : null,
    unknownVersion: aNumero(r.unknownVersion) ?? 0,
    venuesBelow: candidata ? (aNumero(r.venuesBelow) ?? 0) : null,
    byVersion: versiones.slice(0, TOPE_DE_LISTA).map(g => ({
      // En iOS el renglón es el nombre: el número no se muestra aunque la fila lo trajera (§4.1).
      versionCode: platform === 'IOS' ? null : aNumero(g.versionCode),
      versionName: typeof g.versionName === 'string' ? g.versionName : null,
      records: aNumero(g.records) ?? 0,
      venues: aNumero(g.venues) ?? 0,
      lastSeenAt: aIso(g.lastSeenAt),
    })),
    byVersionTruncated: versiones.length > TOPE_DE_LISTA,
    venuesBelowList: negocios.slice(0, TOPE_DE_LISTA).map(n => ({
      venueId: String(n.venueId),
      venueName: String(n.venueName),
      records: aNumero(n.records) ?? 0,
      lastSeenAt: aIso(n.lastSeenAt),
    })),
    venuesBelowListTruncated: negocios.length > TOPE_DE_LISTA,
  }
}

/**
 * La candidata que decide en la plataforma, ya como parámetro con su conversión explícita (Prisma manda los enteros como
 * INT8 y los arreglos sin tipo): ANDROID `::bigint`, iOS el nombre normalizado a 4 partes `::int[]`.
 */
function resolverCandidata(
  platform: Plataforma,
  candidate: { versionCode?: number; versionName?: string } | null,
): { parametro: Prisma.Sql; eco: { versionCode: number | null; versionName: string | null } } | null {
  if (!candidate) return null
  if (platform === 'ANDROID') {
    const code = candidate.versionCode
    if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 1) {
      throw new BadRequestError('En Android el impacto se calcula con versionCode, un entero mayor que 0', POLICY_ERROR)
    }
    return { parametro: Prisma.sql`${code}::bigint`, eco: { versionCode: code, versionName: null } }
  }
  const name = candidate.versionName
  const partes = typeof name === 'string' ? normalizeVersionName(name) : null
  if (!partes) {
    throw new BadRequestError('En iOS el impacto se calcula con versionName (por ejemplo 1.16.0)', POLICY_ERROR)
  }
  return { parametro: Prisma.sql`${partes}::int[]`, eco: { versionCode: null, versionName: name as string } }
}

/** `count(*)` llega como bigint (o como texto, según el camino); a `number`. `null` se queda `null`. */
function aNumero(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** La consulta ya formatea en ISO UTC; si llegara un `Date`, se formatea igual. */
function aIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  return String(v)
}
