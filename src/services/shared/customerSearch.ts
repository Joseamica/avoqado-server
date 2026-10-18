import { Prisma } from '@prisma/client'

/**
 * Búsqueda de clientes del negocio (spec 2026-10-14 §3.2, C2 de Testarudo: «Dany no aparece»).
 *
 * Una regla, la misma que Android aplica SIN red (`filtrarClientesLocal`): si el texto parece teléfono (≥ 4 dígitos y sólo
 * `0-9 espacio + - ( )`) se comparan DÍGITOS contra dígitos, quitando un `52`/`521` sobrante del texto; si no, CADA palabra
 * debe aparecer en nombre, apellido o correo, sin importar mayúsculas ni acentos.
 *
 * 🔴 Acentos sin `unaccent`: la extensión no está instalada en local ni en las bases de prueba, y la base local tiene
 * lc_ctype C (`lower('É')` = 'É'). `translate` con una tabla GENERADA desde `plegarTexto` (todo el latino U+00C0–U+017F,
 * mayúsculas y minúsculas) pliega igual que el texto buscado, en local, en CI y en producción. Fuera de ese rango (p. ej.
 * vietnamita «ạ» o mayúsculas cirílicas con lc_ctype C) el lado SQL no pliega y esa letra sólo casa escrita igual.
 *
 * 🔴 UNA sola regla, siempre (auditoría A #7). La versión anterior buscaba con un `contains` de Prisma, que no pliega acentos
 * ni dígitos: «jose» no encontraba «José» y «55 4345 3965» no encontraba «+525543453965». Pasado el tope de 5000 coincidencias
 * se paginan las más nuevas (ruling B3: `meta.totalCount` = lo alcanzable, `meta.totalMatches` = el total exacto contado con la
 * MISMA regla, `meta.searchCapped`), nunca se cambia a otra regla.
 */

export const CUSTOMER_PAGE_SIZE_DEFAULT = 20
export const CUSTOMER_PAGE_SIZE_MAX = 100
/** Cuántos ids paginables da el prefiltro. Más que esto ⇒ las más nuevas, total exacto aparte y `meta.searchCapped`. */
export const SEARCH_PREFILTER_CAP = 5000
const SEARCH_MAX_CHARS = 100
const SEARCH_MAX_WORDS = 6

export type CustomerSearch = { kind: 'PHONE'; digits: string } | { kind: 'WORDS'; words: string[] }

/** Minúsculas y sin acentos (el texto que escribe el cajero; la columna se pliega igual en SQL con `translate`). */
export function plegarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/**
 * La tabla de `translate`, GENERADA con `plegarTexto` para que los dos lados plieguen igual (revisión de S7, ronda 1: con una
 * tabla escrita a mano de 44 letras, «João» quedaba 'joao' en JS y 'joão' en SQL y escrito EXACTO no encontraba a nadie).
 * Cubre todo el latino de Latin-1 Suplemento y Latin Extendido-A (U+00C0–U+017F): cada letra `c` cuyo plegado es UNA sola
 * letra distinta de `c` se mapea a ese plegado (173 ↔ 173). Lleva mayúsculas y minúsculas porque con lc_ctype C (local y
 * CI) `lower()` sólo baja A-Z; con un locale UTF-8 `lower()` baja primero y la minúscula también está en la tabla. Las que
 * no se descomponen (ø, ł, æ, ß, đ…) quedan como su minúscula en los DOS lados. La paridad la fija una prueba unitaria.
 */
function construirTablaDePlegado(): { de: string; a: string } {
  let de = ''
  let a = ''
  for (let punto = 0x00c0; punto <= 0x017f; punto++) {
    const letra = String.fromCharCode(punto)
    const plegada = plegarTexto(letra)
    if (plegada !== letra && [...plegada].length === 1) {
      de += letra
      a += plegada
    }
  }
  return { de, a }
}
/** La tabla que recibe `translate` (exportada para la prueba de paridad con `plegarTexto`). */
export const TABLA_DE_PLEGADO_SQL: Readonly<{ de: string; a: string }> = Object.freeze(construirTablaDePlegado())
const ACENTOS_DE = TABLA_DE_PLEGADO_SQL.de
const ACENTOS_A = TABLA_DE_PLEGADO_SQL.a

/**
 * `null` = sin búsqueda (vacío, sólo espacios o un parámetro que no es texto, p. ej. `?search=a&search=b`).
 *
 * 🔴 BAJO-1 (full-testing, 15-oct-2026): el byte nulo se quita ANTES de todo. Postgres no lo acepta en un texto (22021) y
 * `?search=jo%00se` respondía 500; sin él, «jose» se busca normal.
 */
export function interpretarBusquedaDeClientes(raw: unknown): CustomerSearch | null {
  if (typeof raw !== 'string') return null
  const texto = raw.split('\u0000').join('').trim().slice(0, SEARCH_MAX_CHARS)
  if (!texto) return null
  let digitos = texto.replace(/\D/g, '')
  if (/^[0-9 +\-()]+$/.test(texto) && digitos.length >= 4) {
    if (digitos.length > 10 && digitos.startsWith('521')) digitos = digitos.slice(3)
    else if (digitos.length > 10 && digitos.startsWith('52')) digitos = digitos.slice(2)
    return { kind: 'PHONE', digits: digitos }
  }
  const words = plegarTexto(texto).split(/\s+/).filter(Boolean).slice(0, SEARCH_MAX_WORDS)
  return words.length ? { kind: 'WORDS', words } : null
}

const escaparLike = (s: string) => s.replace(/[!%_]/g, m => `!${m}`)

const columnaPlegada = (columna: 'firstName' | 'lastName' | 'email') =>
  Prisma.sql`translate(lower(coalesce(${Prisma.raw(`"${columna}"`)}, '')), ${ACENTOS_DE}, ${ACENTOS_A})`

/** La regla, en SQL. Sólo condiciones sobre columnas de "Customer"; los valores van SIEMPRE como parámetros. */
function condicionSqlDeBusqueda(busqueda: CustomerSearch): Prisma.Sql {
  if (busqueda.kind === 'PHONE') {
    return Prisma.sql`"phone" IS NOT NULL AND regexp_replace("phone", '[^0-9]', '', 'g') LIKE ${`%${busqueda.digits}%`}`
  }
  return Prisma.join(
    busqueda.words.map(palabra => {
      const patron = `%${escaparLike(palabra)}%`
      return Prisma.sql`(${columnaPlegada('firstName')} LIKE ${patron} ESCAPE '!' OR ${columnaPlegada('lastName')} LIKE ${patron} ESCAPE '!' OR ${columnaPlegada('email')} LIKE ${patron} ESCAPE '!')`
    }),
    ' AND ',
  )
}

/** Los filtros del dashboard que también aplica Prisma en `getCustomers` (mismo significado, en SQL). */
export interface FiltrosDeClientes {
  customerGroupId?: string
  noGroup?: boolean
  tags?: string[]
  hasPendingBalance?: boolean
}

/**
 * Los MISMOS filtros que Prisma aplica en `getCustomers`, en SQL, para que el tope del prefiltro y el conteo exacto los
 * respeten: grupo (gana a «sin grupo», como en Prisma), etiquetas con `&&` (= `hasSome`) y saldo pendiente SIN cuentas
 * canceladas (= `CUENTA_NO_CANCELADA` de customer.dashboard.service.ts). Vacío si no hay ninguno.
 */
export function sqlDeFiltrosDeClientes(f: FiltrosDeClientes): Prisma.Sql {
  const partes: Prisma.Sql[] = []
  if (f.customerGroupId) partes.push(Prisma.sql`"customerGroupId" = ${f.customerGroupId}`)
  else if (f.noGroup) partes.push(Prisma.sql`"customerGroupId" IS NULL`)
  if (f.tags?.length) partes.push(Prisma.sql`"tags" && ${f.tags}::text[]`)
  if (f.hasPendingBalance) {
    partes.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "OrderCustomer" oc JOIN "Order" o ON o."id" = oc."orderId" WHERE oc."customerId" = "Customer"."id" AND o."paymentStatus" IN ('PENDING', 'PARTIAL') AND o."remainingBalance" > 0 AND o."status" NOT IN ('CANCELLED', 'DELETED'))`,
    )
  }
  return partes.length ? Prisma.sql` AND ${Prisma.join(partes, ' AND ')}` : Prisma.empty
}

/**
 * Ids que cumplen la búsqueda Y los filtros, SÓLO del negocio, más nuevos primero, con `LIMIT tope + 1` para saber si se pasó.
 * `tope` se inyecta sólo en pruebas.
 */
export function sqlDeIdsDeClientes(
  venueId: string,
  busqueda: CustomerSearch,
  opciones: { tope?: number; filtros?: FiltrosDeClientes } = {},
): Prisma.Sql {
  const tope = opciones.tope ?? SEARCH_PREFILTER_CAP
  return Prisma.sql`SELECT "id" FROM "Customer"
    WHERE "venueId" = ${venueId} AND ${condicionSqlDeBusqueda(busqueda)}${sqlDeFiltrosDeClientes(opciones.filtros ?? {})}
    ORDER BY "createdAt" DESC, "id" DESC LIMIT ${tope + 1}`
}

/** El total EXACTO de la MISMA búsqueda con los MISMOS filtros (sólo se corre cuando el prefiltro se pasó del tope). */
export function sqlDeConteoDeClientes(venueId: string, busqueda: CustomerSearch, filtros: FiltrosDeClientes = {}): Prisma.Sql {
  return Prisma.sql`SELECT COUNT(*)::int AS "total" FROM "Customer"
    WHERE "venueId" = ${venueId} AND ${condicionSqlDeBusqueda(busqueda)}${sqlDeFiltrosDeClientes(filtros)}`
}

/**
 * 🔴 H6 (auditoría de Codex del código, 15-oct-2026): cuántas cuentas por cobrar tiene cada cliente de UNA página y cuánto
 * deben, agregado en la base. Antes `getCustomers` traía con cada cliente TODAS sus cuentas pendientes (sin tope) para contar
 * y sumar en JavaScript: el tope de 100 clientes no topaba esas filas. La regla es la MISMA del `include` de antes y del filtro
 * «con saldo pendiente» (`sqlDeFiltrosDeClientes`): pendiente o parcial, saldo > 0, sin cuentas canceladas ni borradas. El
 * negocio va por el cliente (los ids ya salen de una consulta del negocio: no cambia ningún valor). La suma es EXACTA
 * (decimal de Postgres), sin el ruido de flotante de sumar en JavaScript.
 */
export function sqlDeSaldosPendientesDeClientes(venueId: string, customerIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`SELECT oc."customerId" AS "customerId", COUNT(*)::int AS "pendientes", COALESCE(SUM(o."remainingBalance"), 0) AS "saldo"
    FROM "OrderCustomer" oc JOIN "Order" o ON o."id" = oc."orderId"
    JOIN "Customer" c ON c."id" = oc."customerId" AND c."venueId" = ${venueId}
    WHERE oc."customerId" IN (${Prisma.join([...customerIds])}) AND o."paymentStatus" IN ('PENDING', 'PARTIAL') AND o."remainingBalance" > 0 AND o."status" NOT IN ('CANCELLED', 'DELETED')
    GROUP BY oc."customerId"`
}
