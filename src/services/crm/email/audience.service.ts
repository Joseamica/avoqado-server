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
 * Encima de los públicos, personas sueltas (plan B, tarea 5): las AGREGADAS a mano (`incluir`, una cuarta rama con la misma regla de
 * `sqlCorreoAgregable`) y las QUITADAS (`excluir`, que gana sobre cualquier rama y no cuenta como bloqueada).
 *
 * Todo es SQL acotado en la base, sin leer un negocio a la vez. La audiencia se recorre en lotes de 1,000 ordenados por
 * correo y paginados por cursor, ya JUNTOS por correo entre públicos (gana el primero en el orden PROSPECTOS, CLIENTES,
 * USUARIOS, AGREGADOS, que además es el que le dice a la persona por qué le llega) y SIN los bloqueados. Contar y mandar son la
 * MISMA pasada, y las dos devuelven el `conjuntoHash` de las personas que salieron: lo que se confirma son personas, no un número.
 *
 * 🔴 Los bloqueados (baja, rebote, queja) se quitan lote por lote, justo cuando se lee cada lote: una baja que llega a media
 * campaña ya no sale en el lote siguiente. Quien manda los vuelve a revisar al borde de cada envío (`isBlocked`).
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import type { Audiencia, Segmento } from '../../../schemas/crm.schema'
import prisma from '../../../utils/prismaClient'
import { normalizeEmail } from '../../marketing/emailSuppression.service'
import { clientSql, planVigenteSql, type PaidPlan } from '../clients.service'
import { teamOrganizationId } from '../inbound.service'
import { escaparLike, plegarTexto, TABLA_DE_PLEGADO_SQL } from '../../shared/customerSearch'
import { REAL_VENUE_SQL } from '../sweep.service'
import type { MotivoDeEnvio } from './footer'
import { filtrarBloqueados, sqlBloqueado } from './optOut.service'
import type { Vars } from './templateVars'

/** El tamaño del lote: el de `filtrarBloqueados` (un solo `IN`) y el de las deliveries que crea quien encola. */
const LOTE = 1_000

/** A quien llega por usuario no lo atiende un vendedor: es Avoqado. */
const VENDEDOR_DE_USUARIOS = 'el equipo de Avoqado'

/** Por qué público le llega a cada persona: uno de los tres, o «agregada a mano». */
export type Publico = Segmento['tipo'] | 'AGREGADOS'

/**
 * El orden ES la prioridad: el primero que alcanza a un correo se lo queda (su `prio` en SQL es la posición + 1). Una persona agregada
 * siempre tiene permiso (`sqlCorreoAgregable`), así que su pie es el del prospecto; si además llega por un público, sale por ése.
 * 🔴 Dos públicos comparten `reason`: se cuenta por `publico`, nunca por `reason`.
 */
const PUBLICOS: ReadonlyArray<{ tipo: Publico; reason: MotivoDeEnvio }> = [
  { tipo: 'PROSPECTOS', reason: 'PROSPECTO' },
  { tipo: 'CLIENTES', reason: 'CLIENTE' },
  { tipo: 'USUARIOS', reason: 'USUARIO' },
  { tipo: 'AGREGADOS', reason: 'PROSPECTO' },
]

export interface Destinatario {
  /** Normalizado (minúsculas, sin espacios): con él se deduplica, se bloquea y se manda. */
  email: string
  name?: string
  reason: MotivoDeEnvio
  /** El público por el que le llega (interno: las deliveries no lo guardan; con él se cuenta por público). */
  publico: Publico
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
      -- Sólo un contacto con ESE correo (C2, Codex plan r2 H3): si se quitó a la persona o cambió su correo, sin nombre
      -- (el correo saluda con el nombre del negocio), nunca el de otra persona del negocio.
      SELECT c."name" FROM "CrmContact" c
      WHERE c."accountId" = ca."id" AND lower(btrim(c."email")) = lower(btrim(ec."email"))
      ORDER BY c."isPrimary" DESC, c."createdAt", c."id"
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
 * Las personas agregadas a mano: sólo las que deja `sqlCorreoAgregable` (la MISMA regla del PATCH y del buscador). Nombre, negocio,
 * vendedor y cuenta salen de UN contacto con ese correo en una cuenta VISIBLE, el mismo que exige la regla, y nunca de la cuenta que
 * cuelga del permiso: ésa puede estar archivada u oculta (Codex r3 #4). Entre varios, gana el principal y luego el más viejo.
 *
 * El contacto se elige en UNA pasada sobre los contactos de los correos pedidos (DISTINCT ON), no con una subconsulta por persona: el
 * correo del contacto se compara normalizado, así que su índice no sirve, y 500 agregados serían 500 lecturas de la tabla.
 *
 * 🔴 Por eso la regla va DESENROLLADA aquí, con sus mismas tres piezas y no con `sqlCorreoAgregable`: el permiso es la propia fila `ec`, el
 * contacto visible es `vc` (INNER JOIN, mismo `sqlCuentaVisible`) y la baja es `sqlBloqueado`. Con `sqlCorreoAgregable` el EXISTS del
 * contacto se volvía un semi-join por persona que recorría la tabla de contactos (medido el 5-nov en la nube: 500 agregados × 7,500
 * contactos = 1.37 s por página, también en «Ver quiénes»). Lo que dice que las dos son la misma regla son las pruebas de integración que
 * comparan `personasNoElegibles` con la resolución.
 */
function agregados(incluir: string[], { equipo }: Contexto): Prisma.Sql {
  return Prisma.sql`
    SELECT ${normalizado(Prisma.sql`ec."email"`)} AS "email",
      NULLIF(btrim(vc."name"), '') AS "name",
      NULLIF(btrim(vc."negocio"), '') AS "negocio",
      vc."vendedor", vc."accountId", NULL::text AS "venueName", 4 AS "prio", ''::text AS "orden", ec."id" AS "fila"
    FROM "CrmEmailConsent" ec
    JOIN (
      SELECT DISTINCT ON (lower(btrim(c."email"))) lower(btrim(c."email")) AS "email",
        c."name", ca."name" AS "negocio", ${DUENO} AS "vendedor", ca."id" AS "accountId"
      FROM "CrmContact" c
      JOIN "CrmAccount" ca ON ca."id" = c."accountId"
      LEFT JOIN "Staff" ow ON ow."id" = ca."ownerStaffId"
      WHERE lower(btrim(c."email")) = ANY(${incluir}::text[]) AND ${sqlCuentaVisible(Prisma.sql`ca`, equipo)}
      ORDER BY lower(btrim(c."email")), c."isPrimary" DESC, c."createdAt", c."id"
    ) vc ON vc."email" = ec."email"
    WHERE ec."email" = ANY(${incluir}::text[]) AND NOT ${sqlBloqueado(Prisma.sql`ec."email"`)}`
}

/** Las ramas de una audiencia: una por público y, si hay personas agregadas, la suya. */
function ramas(audiencia: Audiencia, contexto: Contexto): Prisma.Sql[] {
  const incluir = (audiencia.incluir ?? []).map(normalizeEmail)
  return [...audiencia.segmentos.map(segmento => rama(segmento, contexto)), ...(incluir.length ? [agregados(incluir, contexto)] : [])]
}

/**
 * La resolución: un destinatario por correo DISTINTO (gana el de menor `prio`; entre filas del mismo público, siempre la misma), con
 * forma de correo (basura como «N/A» en el correo de una organización nunca llega a Resend, donde rebotaría contra la reputación del
 * remitente) y sin las personas quitadas a mano, que ganan sobre cualquier rama. Su `ORDER BY` sólo elige al ganador de cada correo:
 * quien la usa (el conteo y el recorrido, y la página de «Ver quiénes») la envuelve, la ordena por correo y la pagina.
 */
function seleccionDistinta(ramasDeLaAudiencia: Prisma.Sql[], excluir: string[]): Prisma.Sql {
  const union = Prisma.join(
    ramasDeLaAudiencia.map(r => Prisma.sql`(${r})`),
    ' UNION ALL ',
  )
  const sinQuitados = excluir.length ? Prisma.sql` AND u."email" <> ALL(${excluir.map(normalizeEmail)}::text[])` : Prisma.empty
  return Prisma.sql`
    SELECT DISTINCT ON (u."email") u."email", u."name", u."negocio", u."vendedor", u."accountId", u."venueName", u."prio"
    FROM (${union}) u
    WHERE u."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'${sinQuitados}
    ORDER BY u."email", u."prio", u."orden", u."fila"`
}

/**
 * La página siguiente: los primeros `LOTE` destinatarios de la resolución después del cursor. El correo va en `COLLATE "C"` en las dos
 * puntas (orden y cursor) para que el cursor nunca dependa de la regla de acomodo de la base. El filtro del cursor es sobre la columna
 * del DISTINCT ON, así que Postgres lo baja hasta las ramas.
 *
 * ponytail: cada página vuelve a evaluar el público completo (el filtro del cursor baja con la página, el costo de armarlo
 * no). Con ~50 mil destinatarios son decenas de páginas de milisegundos; encima de eso, un cursor por público
 * mezclado en memoria, o materializar el público una vez, en un paso aparte.
 */
async function pagina(resolucion: Prisma.Sql, desde: string | null): Promise<Fila[]> {
  return prisma.$queryRaw<Fila[]>(Prisma.sql`
    SELECT d.* FROM (${resolucion}) d${desde === null ? Prisma.empty : Prisma.sql` WHERE d."email" > ${desde}`}
    ORDER BY d."email"
    LIMIT ${LOTE}`)
}

/**
 * Las personas quitadas, comparadas con el correo con el que se MANDA (`aDestinatario`). 🔴 El `btrim` de SQL sólo quita espacios ASCII y
 * `normalizeEmail` también quita U+00A0, U+202F y U+FEFF: un correo de origen con uno de ésos pasa el filtro de SQL (`seleccionDistinta`)
 * con el correo crudo, y «Quitar» guardó el normalizado. Por eso contar, el `conjuntoHash`, encolar y «Ver quiénes» lo vuelven a quitar aquí.
 */
const quitados = (audiencia: Audiencia) => new Set((audiencia.excluir ?? []).map(normalizeEmail))

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
    publico: tipo,
    ...(tipo === 'USUARIOS' && fila.venueName ? { reasonVenueName: fila.venueName } : {}),
    vars,
    ...(fila.accountId ? { accountId: fila.accountId } : {}),
  }
}

// ── Quién se puede agregar a mano (plan B, tarea 4; rediseño tras Codex r2, Familia 3) ──────────────────────────────────
// UNA definición, decidida POR CORREO, que usan la revisión del PATCH (`personasNoElegibles`), la rama de `incluir` al resolver y el
// buscador de «Agregar»: así nunca se agrega, se cuenta o se manda a alguien que otro de los tres no dejaría. (La rama de `incluir` la
// lleva desenrollada, con las mismas piezas, por rendimiento: ver `agregados`.)

/**
 * La cuenta del CRM `cuenta` (un alias de `CrmAccount`) es VISIBLE: no está archivada, su organización no está oculta
 * (`CrmHiddenClient`) y no es la del equipo de ventas. Una cuenta sin organización (un prospecto) es visible si no está archivada.
 */
export function sqlCuentaVisible(cuenta: Prisma.Sql, equipo: string | null): Prisma.Sql {
  const sinEquipo = equipo ? Prisma.sql` AND ${cuenta}."organizationId" IS DISTINCT FROM ${equipo}` : Prisma.empty
  return Prisma.sql`(${cuenta}."archivedAt" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "CrmHiddenClient" vis_h WHERE vis_h."organizationId" = ${cuenta}."organizationId")${sinEquipo})`
}

/**
 * ¿Se puede agregar `correo` (ya NORMALIZADO) a una campaña? Las tres cosas:
 *  - hay fila de permiso (`CrmEmailConsent`) para ese correo, cuelgue de la cuenta que cuelgue (se decide por el correo);
 *  - hay un contacto del CRM con ese correo en una cuenta VISIBLE (`sqlCuentaVisible`);
 *  - no pidió la baja ni rebotó ni se quejó (`sqlBloqueado`).
 * «Eliminado» (D7) queda fuera solo: borrar a la persona borra su contacto y su permiso.
 *
 * 🔴 Alias propios (`agr_*`): el correo puede venir de una columna de la consulta de afuera (`ec."email"`), y un alias igual adentro
 * lo taparía (la subconsulta se compararía consigo misma y todos saldrían agregables).
 */
export function sqlCorreoAgregable(correo: Prisma.Sql, equipo: string | null): Prisma.Sql {
  // El permiso guarda el correo normalizado (y único): igualdad exacta, por su índice.
  return Prisma.sql`(EXISTS (SELECT 1 FROM "CrmEmailConsent" agr_ec WHERE agr_ec."email" = ${correo})
    AND EXISTS (
      SELECT 1 FROM "CrmContact" agr_c JOIN "CrmAccount" agr_a ON agr_a."id" = agr_c."accountId"
      WHERE lower(btrim(agr_c."email")) = ${correo} AND ${sqlCuentaVisible(Prisma.sql`agr_a`, equipo)}
    )
    AND NOT ${sqlBloqueado(correo)})`
}

/**
 * De los correos dados, los que NO se pueden agregar (normalizados, en el orden en que llegaron). UNA consulta; sin correos no
 * consulta. `db` = la transacción de quien guarda el público, con la campaña bloqueada.
 */
export async function personasNoElegibles(emails: string[], db: Prisma.TransactionClient = prisma): Promise<string[]> {
  const pedidos = [...new Set(emails.map(normalizeEmail))]
  if (pedidos.length === 0) return []
  const equipo = await teamOrganizationId()
  const filas = await db.$queryRaw<Array<{ email: string }>>(Prisma.sql`
    SELECT p."email" FROM unnest(${pedidos}::text[]) WITH ORDINALITY AS p("email", "n")
    WHERE NOT ${sqlCorreoAgregable(Prisma.sql`p."email"`, equipo)}
    ORDER BY p."n"`)
  return filas.map(f => f.email)
}

/**
 * Lee la audiencia lote por lote: cada uno ya sin bloqueados, con cuántos se quitaron. Devuelve el `conjuntoHash` de lo que entregó:
 * sha256 de «correo\n» por persona, en el orden de entrega (correo en `COLLATE "C"`). Sin públicos ni agregados no consulta nada.
 */
async function porLotes(
  audiencia: Audiencia,
  alLote: (lote: { destinatarios: Destinatario[]; bloqueados: number }) => Promise<void>,
): Promise<string> {
  const conjunto = createHash('sha256')
  if (audiencia.segmentos.length === 0 && !audiencia.incluir?.length) return conjunto.digest('hex')
  const contexto: Contexto = { equipo: await teamOrganizationId(), ahora: new Date() }
  const resolucion = seleccionDistinta(ramas(audiencia, contexto), audiencia.excluir ?? [])
  const excluidos = quitados(audiencia)

  let desde: string | null = null
  for (;;) {
    const filas = await pagina(resolucion, desde)
    if (filas.length === 0) break
    // Quitados antes de los bloqueados: una persona quitada no cuenta como bloqueada.
    const destinatarios = filas.map(aDestinatario).filter(d => !excluidos.has(d.email))
    // Un solo `IN` por lote de a lo más LOTE correos, nunca la audiencia entera.
    const bloqueados = await filtrarBloqueados(
      prisma,
      destinatarios.map(d => d.email),
    )
    const sinBloqueados = destinatarios.filter(d => !bloqueados.has(d.email))
    for (const d of sinBloqueados) conjunto.update(`${d.email}\n`)
    await alLote({ destinatarios: sinBloqueados, bloqueados: destinatarios.length - sinBloqueados.length })
    if (filas.length < LOTE) break
    desde = filas[filas.length - 1].email
  }
  return conjunto.digest('hex')
}

/** Una columna de texto, sin mayúsculas ni acentos (la misma tabla que plegó `plegarTexto`). */
const plegada = (columna: Prisma.Sql) =>
  Prisma.sql`translate(lower(coalesce(${columna}, '')), ${TABLA_DE_PLEGADO_SQL.de}, ${TABLA_DE_PLEGADO_SQL.a})`

/**
 * Una página de «Ver quiénes»: UNA consulta, sin total. Envuelve la MISMA resolución que cuenta y manda (`seleccionDistinta`), así el
 * ganador de cada correo (y su motivo) es el mismo; las bajas (`sqlBloqueado`) y la búsqueda se aplican DESPUÉS del `DISTINCT ON`,
 * nunca adentro. Orden por correo en `COLLATE "C"`, cursor = el último correo entregado, `LIMIT limit + 1` para saber si hay más.
 * La búsqueda (sin mayúsculas ni acentos; `%`, `_` y `!` no son comodín) mira correo, nombre y negocio del ganador.
 */
export async function paginaDeDestinatarios(
  audiencia: Audiencia,
  opciones: { desde?: string; limit: number; buscar?: string },
): Promise<{ filas: Destinatario[]; siguiente: string | null }> {
  if (audiencia.segmentos.length === 0 && !audiencia.incluir?.length) return { filas: [], siguiente: null }
  const contexto: Contexto = { equipo: await teamOrganizationId(), ahora: new Date() }
  const resolucion = seleccionDistinta(ramas(audiencia, contexto), audiencia.excluir ?? [])
  const desde = opciones.desde === undefined ? Prisma.empty : Prisma.sql` AND w."email" > ${opciones.desde}`
  const texto = plegarTexto((opciones.buscar ?? '').split('\u0000').join(''))
    .trim()
    .slice(0, 100)
  const patron = `%${escaparLike(texto)}%`
  const buscar = texto
    ? Prisma.sql` AND (${plegada(Prisma.sql`w."email"`)} LIKE ${patron} ESCAPE '!' OR ${plegada(Prisma.sql`w."name"`)} LIKE ${patron} ESCAPE '!' OR ${plegada(Prisma.sql`w."negocio"`)} LIKE ${patron} ESCAPE '!')`
    : Prisma.empty
  const filas = await prisma.$queryRaw<Fila[]>(Prisma.sql`
    SELECT w.* FROM (${resolucion}) w
    WHERE NOT ${sqlBloqueado(Prisma.sql`w."email"`)}${desde}${buscar}
    ORDER BY w."email"
    LIMIT ${opciones.limit + 1}`)
  const pagina = filas.slice(0, opciones.limit)
  // El cursor es el último correo CRUDO de la página (el de la consulta), aunque esa fila sea de alguien quitado: así ninguna se repite
  // ni se pierde. Por eso una página puede traer menos de `limit` filas.
  const excluidos = quitados(audiencia)
  return {
    filas: pagina.map(aDestinatario).filter(d => !excluidos.has(d.email)),
    siguiente: filas.length > opciones.limit ? pagina[pagina.length - 1].email : null,
  }
}

/** Cuántas personas trae el buscador de «Agregar»: lo impone el servidor, no el cliente. */
const TOPE_DEL_BUSCADOR = 20

export interface PersonaBuscada {
  email: string
  nombre: string | null
  negocio: string | null
  /** Hay fila de permiso (`CrmEmailConsent`) para ese correo. */
  aceptoCorreos: boolean
  /** Baja, rebote o queja (`sqlBloqueado`). */
  bloqueado: boolean
  /** `aceptoCorreos && !bloqueado`: exactamente lo que `personasNoElegibles` deja pasar (la persona ya es de una cuenta visible). */
  agregable: boolean
}

/**
 * «Agregar» a una campaña: busca SÓLO entre personas que ya están en el CRM y son visibles (`sqlCuentaVisible`: nunca una cuenta
 * archivada, un cliente oculto ni el equipo, ni sus datos). UNA consulta, una fila por correo (gana el contacto principal y luego el
 * más viejo, como la rama `incluir`), y la búsqueda —frase completa, sin mayúsculas ni acentos, igual que «Ver quiénes»— mira correo,
 * nombre y negocio de ESE contacto. Orden por correo en `COLLATE "C"`; `TOPE_DEL_BUSCADOR + 1` filas para saber si hay más.
 *
 * ponytail: no busca permisos de la landing sin cuenta (no son agregables: siguen llegando con «Prospectos» sin etapas). El correo
 * del contacto se compara normalizado, así que su índice no sirve: cada búsqueda lee los contactos con correo de cuentas visibles.
 */
export async function buscarPersonasParaCampana(q: string): Promise<{ rows: PersonaBuscada[]; hayMas: boolean }> {
  const texto = plegarTexto(q.split('\u0000').join('')).trim().slice(0, 100)
  if (!texto) return { rows: [], hayMas: false }
  const patron = `%${escaparLike(texto)}%`
  const equipo = await teamOrganizationId()
  const filas = await prisma.$queryRaw<Array<Omit<PersonaBuscada, 'agregable'>>>(Prisma.sql`
    SELECT w."email", w."nombre", w."negocio",
      EXISTS (SELECT 1 FROM "CrmEmailConsent" bus_ec WHERE bus_ec."email" = w."email") AS "aceptoCorreos",
      ${sqlBloqueado(Prisma.sql`w."email"`)} AS "bloqueado"
    FROM (
      SELECT DISTINCT ON (${normalizado(Prisma.sql`c."email"`)}) ${normalizado(Prisma.sql`c."email"`)} AS "email",
        NULLIF(btrim(c."name"), '') AS "nombre", NULLIF(btrim(a."name"), '') AS "negocio"
      FROM "CrmContact" c
      JOIN "CrmAccount" a ON a."id" = c."accountId"
      WHERE btrim(coalesce(c."email", '')) <> '' AND ${sqlCuentaVisible(Prisma.sql`a`, equipo)}
      ORDER BY ${normalizado(Prisma.sql`c."email"`)}, c."isPrimary" DESC, c."createdAt", c."id"
    ) w
    WHERE (${plegada(Prisma.sql`w."email"`)} LIKE ${patron} ESCAPE '!' OR ${plegada(Prisma.sql`w."nombre"`)} LIKE ${patron} ESCAPE '!' OR ${plegada(Prisma.sql`w."negocio"`)} LIKE ${patron} ESCAPE '!')
    ORDER BY w."email"
    LIMIT ${TOPE_DEL_BUSCADOR + 1}`)
  return {
    rows: filas.slice(0, TOPE_DEL_BUSCADOR).map(f => ({ ...f, agregable: f.aceptoCorreos && !f.bloqueado })),
    hayMas: filas.length > TOPE_DEL_BUSCADOR,
  }
}

/**
 * Cuántos recibirían la campaña ahora mismo, por público (por el que gana cada correo), cuántos se quedaron fuera por baja,
 * rebote o queja (una persona quitada a mano no cuenta ahí), y el `conjuntoHash` de esas personas. Recorre lo mismo que
 * `recorrerAudiencia`, así que lo que se confirma es lo que se manda.
 */
export async function contarAudiencia(
  audiencia: Audiencia,
): Promise<{ total: number; porSegmento: Record<Publico, number>; bloqueados: number; conjuntoHash: string }> {
  const porSegmento: Record<Publico, number> = { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 0, AGREGADOS: 0 }
  let total = 0
  let bloqueados = 0
  const conjuntoHash = await porLotes(audiencia, async lote => {
    for (const destinatario of lote.destinatarios) porSegmento[destinatario.publico] += 1
    total += lote.destinatarios.length
    bloqueados += lote.bloqueados
  })
  return { total, porSegmento, bloqueados, conjuntoHash }
}

/**
 * Entrega la audiencia a `alLote` en lotes de a lo más 1,000, ordenados por correo, sin repetidos y sin bloqueados.
 * Devuelve cuántos destinatarios entregó y su `conjuntoHash`. Un error de `alLote` corta el recorrido y se propaga.
 */
export async function recorrerAudiencia(
  audiencia: Audiencia,
  alLote: (destinatarios: Destinatario[]) => Promise<void>,
): Promise<{ entregados: number; conjuntoHash: string }> {
  let entregados = 0
  const conjuntoHash = await porLotes(audiencia, async ({ destinatarios }) => {
    if (destinatarios.length === 0) return
    await alLote(destinatarios)
    entregados += destinatarios.length
  })
  return { entregados, conjuntoHash }
}
