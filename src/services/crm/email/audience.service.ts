/**
 * Los 3 públicos de las campañas del CRM (spec 2026-10-30 §5.6, fase 2): quién recibe una campaña.
 *
 *  - PROSPECTOS: quien marcó la casilla de la landing (una fila de `CrmEmailConsent`). 🔴 El correo es el de ESA fila, el
 *    de quien marcó la casilla: nunca el `externalKey` de la cuenta ni otro contacto suyo. Dos personas que comparten un
 *    teléfono comparten cuenta, y sólo una dio su consentimiento.
 *  - CLIENTES: las organizaciones que son clientes (la misma regla de «Clientes», `clientSql`) y no están ocultas, un correo
 *    por negocio real con la cadena que usan los avisos de plan (`resolvePlanNotificationTarget`).
 *  - USUARIOS: las personas activas y verificadas con un rol pedido en un negocio real.
 *
 * Todo es SQL acotado en la base, sin leer un negocio a la vez. La audiencia se recorre en lotes de 1,000 ordenados por
 * correo y paginados por cursor, ya JUNTOS por correo entre públicos (gana el primero en el orden PROSPECTOS, CLIENTES,
 * USUARIOS, que además es el que le dice a la persona por qué le llega) y SIN los bloqueados.
 *
 * 🔴 Los bloqueados (baja, rebote, queja) se quitan lote por lote, justo cuando se lee cada lote: una baja que llega a media
 * campaña ya no sale en el lote siguiente. Quien manda los vuelve a revisar al borde de cada envío (`isBlocked`).
 */
import { Prisma } from '@prisma/client'
import type { Audiencia, Segmento } from '../../../schemas/crm.schema'
import prisma from '../../../utils/prismaClient'
import { normalizeEmail } from '../../marketing/emailSuppression.service'
import { clientSql, planVigenteSql, type PaidPlan } from '../clients.service'
import { teamOrganizationId } from '../inbound.service'
import { REAL_VENUE_SQL } from '../sweep.service'
import type { MotivoDeEnvio } from './footer'
import { filtrarBloqueados } from './optOut.service'
import type { Vars } from './templateVars'

/** El tamaño del lote: el de `filtrarBloqueados` (un solo `IN`) y el de las deliveries que crea quien encola. */
const LOTE = 1_000

/** A quien llega por usuario no lo atiende un vendedor: es Avoqado. */
const VENDEDOR_DE_USUARIOS = 'el equipo de Avoqado'

type Tipo = Segmento['tipo']

/** El orden ES la prioridad: el primero que alcanza a un correo se lo queda (su `prio` en SQL es la posición + 1). */
const PUBLICOS: ReadonlyArray<{ tipo: Tipo; reason: MotivoDeEnvio }> = [
  { tipo: 'PROSPECTOS', reason: 'PROSPECTO' },
  { tipo: 'CLIENTES', reason: 'CLIENTE' },
  { tipo: 'USUARIOS', reason: 'USUARIO' },
]

const TIPO_DE = Object.fromEntries(PUBLICOS.map(p => [p.reason, p.tipo])) as Record<MotivoDeEnvio, Tipo>

export interface Destinatario {
  /** Normalizado (minúsculas, sin espacios): con él se deduplica, se bloquea y se manda. */
  email: string
  name?: string
  reason: MotivoDeEnvio
  /** Sólo USUARIO: el negocio que dice el pie del correo («Te llega porque usas Avoqado en …»). */
  reasonVenueName?: string
  vars: Vars
  /** El negocio del CRM, cuando lo hay (PROSPECTO y CLIENTE ligado). */
  accountId?: string
}

interface Fila {
  email: string
  name: string | null
  negocio: string | null
  vendedor: string | null
  accountId: string | null
  venueName: string | null
  prio: number
}

interface Contexto {
  equipo: string | null
  ahora: Date
}

// ── Una rama de SQL por público ───────────────────────────────────────────────────────────────────────────────────────
// Todas devuelven las mismas columnas: email (normalizado y en orden de bytes), name, negocio, vendedor, accountId,
// venueName, prio, y `orden`/`fila` para que, entre filas del mismo correo y del mismo público, gane siempre la misma.

const normalizado = (columna: Prisma.Sql) => Prisma.sql`(lower(btrim(${columna})) COLLATE "C")`
/** El dueño de la cuenta del CRM (`ow`, un `Staff`), con nombre y apellido. */
const DUENO = Prisma.sql`NULLIF(btrim(concat_ws(' ', ow."firstName", ow."lastName")), '')`

function prospectos(segmento: Extract<Segmento, { tipo: 'PROSPECTOS' }>): Prisma.Sql {
  // Con etapas pedidas: sólo cuentas en ellas. Sin pedirlas: las abiertas, y también quien marcó la casilla sin cuenta.
  // En los dos casos, una cuenta archivada queda fuera.
  const cuenta = segmento.etapas?.length
    ? Prisma.sql`ca."archivedAt" IS NULL AND ca."stageId" IN (${Prisma.join(segmento.etapas)})`
    : Prisma.sql`(ec."accountId" IS NULL OR (ca."archivedAt" IS NULL AND cs."kind" = 'ABIERTA'))`
  return Prisma.sql`
    SELECT ${normalizado(Prisma.sql`ec."email"`)} AS "email",
      NULLIF(btrim(ct."name"), '') AS "name",
      NULLIF(btrim(ca."name"), '') AS "negocio",
      ${DUENO} AS "vendedor",
      ca."id" AS "accountId", NULL::text AS "venueName", 1 AS "prio", ''::text AS "orden", ec."id" AS "fila"
    FROM "CrmEmailConsent" ec
    LEFT JOIN "CrmAccount" ca ON ca."id" = ec."accountId"
    LEFT JOIN "CrmStage" cs ON cs."id" = ca."stageId"
    LEFT JOIN "Staff" ow ON ow."id" = ca."ownerStaffId"
    LEFT JOIN LATERAL (
      SELECT c."name" FROM "CrmContact" c
      WHERE c."accountId" = ca."id"
      ORDER BY COALESCE(lower(btrim(c."email")) = lower(btrim(ec."email")), false) DESC, c."isPrimary" DESC, c."createdAt", c."id"
      LIMIT 1
    ) ct ON true
    WHERE ${cuenta}`
}

/** Los filtros de giro y ciudad sobre un negocio aliased `v`. La ciudad se compara sin mayúsculas ni espacios de más. */
function filtrosDeNegocio(segmento: { giros?: string[]; ciudades?: string[] }): Prisma.Sql {
  const giros = segmento.giros?.length
    ? Prisma.sql` AND v."type"::text IN (${Prisma.join(segmento.giros.map(giro => giro.trim().toUpperCase()))})`
    : Prisma.empty
  const ciudades = segmento.ciudades?.length
    ? Prisma.sql` AND lower(btrim(v."city")) IN (${Prisma.join(segmento.ciudades.map(ciudad => ciudad.trim().toLowerCase()))})`
    : Prisma.empty
  return Prisma.sql`${giros}${ciudades}`
}

const NO_OCULTA = Prisma.sql`NOT EXISTS (SELECT 1 FROM "CrmHiddenClient" h WHERE h."organizationId" = o."id")`

/** `planes` con la MISMA regla que «Clientes» (`planVigenteSql`): GRATIS es no tener ninguno vigente. */
function filtroDePlanes(planes: Array<'GRATIS' | PaidPlan>, ahora: Date): Prisma.Sql {
  const partes = planes.map(plan => (plan === 'GRATIS' ? Prisma.sql`NOT ${planVigenteSql(ahora)}` : planVigenteSql(ahora, [plan])))
  return Prisma.sql` AND (${Prisma.join(partes, ' OR ')})`
}

function clientes(segmento: Extract<Segmento, { tipo: 'CLIENTES' }>, { equipo, ahora }: Contexto): Prisma.Sql {
  const planes = segmento.planes?.length ? filtroDePlanes(segmento.planes, ahora) : Prisma.empty
  return Prisma.sql`
    SELECT ${normalizado(Prisma.sql`r."email"`)} AS "email",
      CASE WHEN r."deStaff" THEN NULLIF(btrim(st."firstName"), '') END AS "name",
      NULLIF(btrim(v."name"), '') AS "negocio",
      ${DUENO} AS "vendedor",
      ca."id" AS "accountId", NULL::text AS "venueName", 2 AS "prio", COALESCE(v."name", '') AS "orden", v."id" AS "fila"
    FROM "Organization" o
    JOIN "Venue" v ON v."organizationId" = o."id"
    LEFT JOIN "CrmAccount" ca ON ca."organizationId" = o."id"
    LEFT JOIN "Staff" ow ON ow."id" = ca."ownerStaffId"
    LEFT JOIN LATERAL (
      SELECT s."email", s."firstName"
      FROM "StaffVenue" sv JOIN "Staff" s ON s."id" = sv."staffId"
      WHERE sv."venueId" = v."id" AND sv."active" = true AND sv."role"::text IN ('OWNER', 'ADMIN')
      ORDER BY (sv."role"::text = 'OWNER') DESC, sv."startDate", sv."id"
      LIMIT 1
    ) st ON true
    CROSS JOIN LATERAL (
      SELECT COALESCE(NULLIF(btrim(v."email"), ''), NULLIF(btrim(st."email"), ''), NULLIF(btrim(o."email"), '')) AS "email",
        (NULLIF(btrim(v."email"), '') IS NULL AND NULLIF(btrim(st."email"), '') IS NOT NULL) AS "deStaff"
    ) r
    WHERE ${clientSql(equipo, ahora)} AND ${NO_OCULTA} AND ${REAL_VENUE_SQL}${filtrosDeNegocio(segmento)}${planes}`
}

function usuarios(segmento: Extract<Segmento, { tipo: 'USUARIOS' }>, { equipo, ahora }: Contexto): Prisma.Sql {
  const sinEquipo = equipo ? Prisma.sql` AND o."id" <> ${equipo}` : Prisma.empty
  const soloClientes = segmento.soloClientes ? Prisma.sql` AND ${clientSql(equipo, ahora)}` : Prisma.empty
  return Prisma.sql`
    SELECT ${normalizado(Prisma.sql`s."email"`)} AS "email",
      NULLIF(btrim(s."firstName"), '') AS "name",
      q."venueName" AS "negocio", NULL::text AS "vendedor",
      NULL::text AS "accountId", q."venueName" AS "venueName", 3 AS "prio", q."venueName" AS "orden", s."id" AS "fila"
    FROM "Staff" s
    CROSS JOIN LATERAL (
      SELECT v."name" AS "venueName"
      FROM "StaffVenue" sv
      JOIN "Venue" v ON v."id" = sv."venueId"
      JOIN "Organization" o ON o."id" = v."organizationId"
      WHERE sv."staffId" = s."id" AND sv."active" = true AND sv."role"::text IN (${Prisma.join(segmento.roles)})
        AND ${REAL_VENUE_SQL}${sinEquipo} AND ${NO_OCULTA}${soloClientes}${filtrosDeNegocio(segmento)}
      ORDER BY v."name", v."id"
      LIMIT 1
    ) q
    WHERE s."active" = true AND s."emailVerified" = true`
}

function rama(segmento: Segmento, contexto: Contexto): Prisma.Sql {
  switch (segmento.tipo) {
    case 'PROSPECTOS':
      return prospectos(segmento)
    case 'CLIENTES':
      return clientes(segmento, contexto)
    case 'USUARIOS':
      return usuarios(segmento, contexto)
    default:
      throw new Error(`Público desconocido: ${(segmento as { tipo?: string }).tipo}`)
  }
}

/**
 * La página siguiente: los primeros `LOTE` correos DISTINTOS después del cursor, ya sin repetidos entre públicos (gana el
 * de menor `prio`) y con forma de correo (basura como «N/A» en el correo de una organización nunca llega a Resend, donde
 * rebotaría contra la reputación del remitente).
 *
 * El correo va en `COLLATE "C"` en las dos puntas (orden y cursor) para que el cursor nunca dependa de la regla de
 * acomodo de la base.
 *
 * ponytail: cada página vuelve a evaluar el público completo (el filtro del cursor baja con la página, el costo de armarlo
 * no). Con ~50 mil destinatarios son decenas de páginas de milisegundos; encima de eso, un cursor por público
 * mezclado en memoria, o materializar el público una vez, en un paso aparte.
 */
async function pagina(ramas: Prisma.Sql[], desde: string | null): Promise<Fila[]> {
  const union = Prisma.join(
    ramas.map(r => Prisma.sql`(${r})`),
    ' UNION ALL ',
  )
  return prisma.$queryRaw<Fila[]>(Prisma.sql`
    SELECT DISTINCT ON (u."email") u."email", u."name", u."negocio", u."vendedor", u."accountId", u."venueName", u."prio"
    FROM (${union}) u
    WHERE u."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'${desde === null ? Prisma.empty : Prisma.sql` AND u."email" > ${desde}`}
    ORDER BY u."email", u."prio", u."orden", u."fila"
    LIMIT ${LOTE}`)
}

function aDestinatario(fila: Fila): Destinatario {
  const { reason, tipo } = PUBLICOS[fila.prio - 1]
  const vendedor = tipo === 'USUARIOS' ? VENDEDOR_DE_USUARIOS : fila.vendedor
  const vars: Vars = {}
  if (fila.name) vars.nombre = fila.name
  if (fila.negocio) vars.negocio = fila.negocio
  if (vendedor) vars.vendedor = vendedor
  return {
    email: normalizeEmail(fila.email),
    ...(fila.name ? { name: fila.name } : {}),
    reason,
    ...(tipo === 'USUARIOS' && fila.venueName ? { reasonVenueName: fila.venueName } : {}),
    vars,
    ...(fila.accountId ? { accountId: fila.accountId } : {}),
  }
}

/** Lee la audiencia lote por lote: cada uno ya sin bloqueados, con cuántos se quitaron. */
async function porLotes(
  audiencia: Audiencia,
  alLote: (lote: { destinatarios: Destinatario[]; bloqueados: number }) => Promise<void>,
): Promise<void> {
  if (audiencia.segmentos.length === 0) return
  const contexto: Contexto = { equipo: await teamOrganizationId(), ahora: new Date() }
  const ramas = audiencia.segmentos.map(segmento => rama(segmento, contexto))

  let desde: string | null = null
  for (;;) {
    const filas = await pagina(ramas, desde)
    if (filas.length === 0) return
    const destinatarios = filas.map(aDestinatario)
    // Un solo `IN` por lote de a lo más LOTE correos, nunca la audiencia entera.
    const bloqueados = await filtrarBloqueados(
      prisma,
      destinatarios.map(d => d.email),
    )
    const sinBloqueados = destinatarios.filter(d => !bloqueados.has(d.email))
    await alLote({ destinatarios: sinBloqueados, bloqueados: destinatarios.length - sinBloqueados.length })
    if (filas.length < LOTE) return
    desde = filas[filas.length - 1].email
  }
}

/**
 * Cuántos recibirían la campaña ahora mismo, por público (a quien gana cada correo), y cuántos se quedaron fuera por baja,
 * rebote o queja. Recorre lo mismo que `recorrerAudiencia`, así que el número que se confirma es el que se manda.
 */
export async function contarAudiencia(
  audiencia: Audiencia,
): Promise<{ total: number; porSegmento: Record<Tipo, number>; bloqueados: number }> {
  const porSegmento: Record<Tipo, number> = { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 0 }
  let total = 0
  let bloqueados = 0
  await porLotes(audiencia, async lote => {
    for (const destinatario of lote.destinatarios) porSegmento[TIPO_DE[destinatario.reason]] += 1
    total += lote.destinatarios.length
    bloqueados += lote.bloqueados
  })
  return { total, porSegmento, bloqueados }
}

/**
 * Entrega la audiencia a `alLote` en lotes de a lo más 1,000, ordenados por correo, sin repetidos y sin bloqueados.
 * Devuelve cuántos destinatarios entregó. Un error de `alLote` corta el recorrido y se propaga.
 */
export async function recorrerAudiencia(audiencia: Audiencia, alLote: (destinatarios: Destinatario[]) => Promise<void>): Promise<number> {
  let entregados = 0
  await porLotes(audiencia, async ({ destinatarios }) => {
    if (destinatarios.length === 0) return
    await alLote(destinatarios)
    entregados += destinatarios.length
  })
  return entregados
}
