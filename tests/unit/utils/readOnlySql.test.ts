/**
 * ¿Este SQL crudo es una lectura pura? — el clasificador del freno del MCP (incidente del 23-sep-2026).
 *
 * El freno sólo corta LECTURAS. El repo también muta con `$queryRaw` (UPDATE … RETURNING, INSERT … ON CONFLICT)
 * y toma candados advisory con él, así que un SQL crudo sólo es lectura cuando se puede DEMOSTRAR: una sola
 * sentencia SELECT/WITH, sin palabras de escritura, sin candados de fila y sin funciones fuera de una lista de
 * funciones puras. Lo que no se reconoce es escritura: una lectura tomada por escritura sólo pierde el freno;
 * una escritura tomada por lectura rompería «una escritura nunca se interrumpe».
 *
 * La auditoría de Codex (ronda 2) encontró tres engaños al clasificador por expresiones regulares: una función
 * con efectos escrita ENTRE COMILLAS, un `'--'` dentro de un texto que hacía desaparecer el resto del SQL, y una
 * función propia que escribe. Están aquí, literales.
 */
import { isReadOnlySql } from '@/utils/readOnlySql'

describe('isReadOnlySql — los engaños de la auditoría de Codex (ronda 2)', () => {
  it.each([
    ['función con efectos ENTRE COMILLAS', 'SELECT "pg_advisory_xact_lock"(1)'],
    ['un -- dentro de un texto no se come el resto', "SELECT '--' AS label, nextval('folio_seq')"],
    [
      'un -- dentro de un texto no esconde un UPDATE en otro CTE',
      'WITH marker AS (SELECT \'--\'), changed AS (UPDATE "Stock" SET qty = qty - 1 RETURNING *) SELECT * FROM changed',
    ],
    ['una función propia (puede escribir)', 'SELECT registrar_evento($1)'],
    ['una función calificada con esquema propio', 'SELECT public.recalcular_saldos($1)'],
  ])('%s ⇒ NO es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(false)
  })
})

describe('isReadOnlySql — los engaños de la auditoría de Codex (ronda 3) y sus hermanos', () => {
  it.each([
    // Postgres termina un comentario de línea con \n O con \r (scan.l: non_newline [^\n\r]).
    ['un \\r termina el comentario de línea', "SELECT 1 -- comentario\r, nextval('folio_seq')"],
    ['un \\r\\n también', "SELECT 1 -- comentario\r\n, nextval('folio_seq')"],
    // Un nombre calificado nunca es palabra clave: es una llamada a la función `filter` del esquema public.
    ['función calificada con nombre de palabra clave', 'SELECT public.filter()'],
    ['función calificada entre comillas', 'SELECT public."filter"(1)'],
    // Tras un punto cualquier palabra es un nombre: `public.exists(1)` llama a una función propia llamada exists.
    ['función calificada con nombre de palabra RESERVADA', 'SELECT public.exists(1)'],
    // Palabras clave NO reservadas (o de tipo/función): Postgres acepta funciones con esos nombres.
    ['filter( fuera de su posición', 'SELECT filter(1)'],
    ['over( fuera de su posición', 'SELECT over(1)'],
    ['by( fuera de ORDER/GROUP/PARTITION BY', 'SELECT by(1)'],
    ['join( donde empieza una expresión', 'SELECT 1 WHERE join(1) = 1'],
    ['join( en la lista de FROM', 'SELECT * FROM a, join(1)'],
    ['like( como llamada', 'SELECT like(1, 2)'],
    // Para Postgres cualquier carácter no ASCII es parte del identificador: `€count` es UNA función.
    ['nombre que empieza con un carácter no ASCII', 'SELECT €count(1)'],
    // Etiquetas de «texto con dólares» con letras no ASCII: el -- de adentro es texto, no un comentario.
    ['etiqueta de dólares no ASCII esconde un --', "SELECT $ñ$ -- $ñ$, nextval('folio_seq')"],
    // ROLLUP/CUBE/GROUPING SETS/MATERIALIZED no aparecen en el SQL del repo (medido el 23-sep): ya no se aceptan.
    ['ROLLUP (lado seguro: pierde el freno)', 'SELECT sum(x) FROM t GROUP BY ROLLUP (1)'],
  ])('%s ⇒ NO es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(false)
  })

  it.each([
    ['FILTER tras la llamada', 'SELECT count(*) FILTER (WHERE a > 1) FROM t'],
    ['OVER tras la llamada', 'SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM t'],
    ['ORDER BY con expresión entre paréntesis', 'SELECT a FROM t ORDER BY (a / NULLIF(b, 0)) ASC'],
    ['WITHIN GROUP', 'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) FROM "Payment"'],
    ['un -- dentro de un texto con dólares no ASCII', 'SELECT $ñ$ -- $ñ$ AS texto'],
    ['identificador con letras no ASCII', 'SELECT año FROM t'],
  ])('%s ⇒ es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(true)
  })
})

describe('isReadOnlySql — los engaños de la auditoría de Codex (ronda 4)', () => {
  it.each([
    // Una cadena continúa en la línea siguiente CONSERVANDO su modo: `\'` escapa la comilla y el -- queda en el texto,
    // así que pg_advisory_lock queda FUERA de la cadena (scan.l, estados xqs/xe).
    ['cadena E que continúa en otra línea', "SELECT E''\n'\\' -- ', pg_advisory_lock(1) -- '"],
    ['dos cadenas seguidas (continuación, con comentario en medio)', "SELECT 'a' -- nota\n'b'"],
    // Postgres (UTF-8) sólo pasa a minúsculas A-Z: con la K de Kelvin es otra función, no `rank`.
    ['K de Kelvin en el nombre de una función', 'SELECT ran\u212a()'],
    // Tras AT TIME ZONE empieza una expresión: `join()` puede ser una función.
    ['join( tras AT TIME ZONE', "SELECT TIMESTAMP '2000-01-01' AT TIME ZONE join()"],
  ])('%s ⇒ NO es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(false)
  })

  // JOIN ( ya no se acepta: ninguna consulta del repo lo usa en algo que hoy sea lectura (medido el 23-sep, 0 de 383).
  it.each([
    [
      'LEFT JOIN a una subconsulta',
      'SELECT * FROM "Payment" p LEFT JOIN (SELECT "paymentId", sum(amount) AS amt FROM "Tip" GROUP BY "paymentId") t ON t."paymentId" = p.id',
    ],
    ['JOIN a subconsulta tras una condición ON', 'SELECT * FROM a JOIN b ON a.id = b.aid JOIN (SELECT 1 AS x) c ON true'],
  ])('%s ⇒ NO es lectura (lado seguro: pierde el freno)', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(false)
  })

  it.each([
    ['dos cadenas separadas por un operador', "SELECT 'a' || 'b'"],
    ['cadenas en una lista', "SELECT 'a' AS x, 'b' AS y"],
    ['JOIN a una tabla (sin paréntesis)', 'SELECT * FROM "Order" o JOIN "Payment" p ON p."orderId" = o.id'],
  ])('%s ⇒ es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(true)
  })
})

/**
 * Ronda 5: PostgreSQL une `U&"nombre" UESCAPE '!'` en UN solo identificador (su filtro léxico, `parser.c`), así que el
 * nombre de la función queda separado de su "(" por otros dos tokens y la revisión de llamadas no lo veía. Los
 * identificadores y cadenas con escapes Unicode sólo se sabrían leer decodificándolos con su carácter de escape; ninguna
 * lectura del repo los usa (medido el 23-sep), así que se rechazan sin intentarlo.
 */
describe('isReadOnlySql — los engaños de la auditoría de Codex (ronda 5)', () => {
  it.each([
    ['candado con identificador Unicode y UESCAPE', 'SELECT U&"pg_advisory_lock" UESCAPE \'!\' (1)'],
    ['candado calificado con identificador Unicode y UESCAPE', 'SELECT pg_catalog.U&"pg_advisory_xact_lock" UESCAPE \'!\' (1)'],
    ['identificador Unicode en minúscula', 'SELECT u&"pg_advisory_lock" uescape \'!\' (1)'],
    ['identificador Unicode sin UESCAPE', 'SELECT U&"pg\\005fadvisory_lock"(1)'],
    ['cadena con escapes Unicode', "SELECT U&'d\\0061t\\+000061'"],
    ['UESCAPE suelto', "SELECT 1 UESCAPE '!'"],
  ])('%s ⇒ NO es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(false)
  })

  it.each([
    // `menu` es una palabra entera: `&` es un operador y "x" un identificador normal — no hay escape Unicode.
    ['una palabra que termina en u seguida de &', 'SELECT menu&"x" FROM t'],
    ['una columna llamada u con un operador &', 'SELECT u & 1 FROM t'],
  ])('%s ⇒ es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(true)
  })
})

/**
 * Ronda 6: la excepción para la lista de columnas de un CTE (`, nombre (cols) AS (…)`) miraba sólo los tokens de
 * alrededor, y aceptaba una llamada seguida de un alias que se ve igual: `, pg_try_advisory_lock(1) AS materialized` en
 * la lista del SELECT, o `ROWS FROM (…, f() AS (r integer))`. Ahora la lista de columnas se reconoce recorriendo la
 * propia lista del WITH.
 */
describe('isReadOnlySql — los engaños de la auditoría de Codex (ronda 6)', () => {
  it.each([
    ['candado con alias AS materialized', 'SELECT 0, pg_try_advisory_lock(923006) AS materialized'],
    ['secuencia con alias AS materialized', "SELECT 0, nextval('folio_seq') AS materialized"],
    ['candado con alias AS not', 'SELECT 0, pg_advisory_xact_lock(1) AS not'],
    [
      'función con efectos en ROWS FROM con lista de definición',
      'SELECT * FROM ROWS FROM (generate_series(1,1), funcion_con_efectos() AS (resultado integer))',
    ],
    ['lo mismo con un argumento', 'SELECT * FROM ROWS FROM (generate_series(1,1), funcion_con_efectos(x) AS (resultado integer))'],
    ['una «lista de columnas» de CTE que no son columnas', 'WITH pg_advisory_lock(1) AS (SELECT 1) SELECT 1'],
    // No es un WITH válido (PostgreSQL lo rechaza): el recorrido sólo reconoce la gramática exacta.
    ['AS NOT sin MATERIALIZED', 'WITH x(a) AS NOT (SELECT 1) SELECT * FROM x'],
    // `WITH ORDINALITY AS materialized(v, n)` imita el arranque de una lista del WITH, y lo que sigue tras la coma es otra
    // función del FROM con lista de definición: sólo un WITH al inicio de la sentencia (o tras «(») abre una lista.
    [
      'WITH ORDINALITY que imita una lista de CTE',
      'SELECT * FROM unnest(ARRAY[1]) WITH ORDINALITY AS materialized(v, n), funcion_con_efectos(v) AS (r integer)',
    ],
  ])('%s ⇒ NO es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(false)
  })

  it.each([
    [
      'varios CTE con MATERIALIZED y NOT MATERIALIZED',
      'WITH a(x) AS MATERIALIZED (SELECT 1), b(y) AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b',
    ],
    ['CTE con lista de columnas dentro de una subconsulta', 'SELECT * FROM (WITH x(a) AS (SELECT 1) SELECT a FROM x) s'],
    [
      'CTE recursivo seguido de otro con lista',
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3), u (m) AS (SELECT 2) SELECT * FROM t, u',
    ],
    [
      'WITH ORDINALITY con alias de columnas',
      'SELECT e.v, e.n FROM "Venue" v, LATERAL jsonb_array_elements(v.settings) WITH ORDINALITY AS e(v, n)',
    ],
  ])('%s ⇒ es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(true)
  })
})

describe('isReadOnlySql — escrituras, candados y efectos', () => {
  it.each([
    ['UPDATE … RETURNING (custodia)', 'UPDATE "SerializedItem" SET "status" = $1 WHERE "id" = $2 RETURNING "id"'],
    ['INSERT … ON CONFLICT DO UPDATE (outbox)', 'INSERT INTO "Outbox" ("id") VALUES ($1) ON CONFLICT ("id") DO UPDATE SET "n" = 1'],
    ['DELETE', 'DELETE FROM "X" WHERE "id" = $1'],
    ['un WITH que muta', 'WITH moved AS (UPDATE "Stock" SET qty = qty - 1 RETURNING *) SELECT * FROM moved'],
    ['SELECT … FOR UPDATE', 'SELECT * FROM "Terminal" WHERE "id" = $1 FOR UPDATE'],
    ['SELECT … FOR NO KEY UPDATE', 'SELECT * FROM "Terminal" FOR NO KEY UPDATE'],
    ['SELECT … FOR SHARE', 'SELECT * FROM "Terminal" FOR SHARE'],
    ['SELECT … FOR KEY SHARE', 'SELECT * FROM "Terminal" FOR KEY SHARE SKIP LOCKED'],
    ['candado advisory', 'SELECT pg_advisory_xact_lock($1)'],
    ['intento de candado advisory', 'SELECT pg_try_advisory_xact_lock(hashtext($1))'],
    ['secuencia', "SELECT nextval('folio_seq')"],
    ['SELECT … INTO (crea tabla)', 'SELECT * INTO tmp_x FROM "Order"'],
    ['dos sentencias', 'SELECT 1; DELETE FROM "X"'],
    ['algo que no empieza con SELECT/WITH', 'EXPLAIN ANALYZE SELECT 1'],
    ['un texto sin cerrar', "SELECT 'sin cerrar"],
    ['un comentario de bloque sin cerrar', 'SELECT 1 /* sin cerrar'],
    ['vacío', '   '],
  ])('%s ⇒ NO es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(false)
  })
})

describe('isReadOnlySql — lecturas reales del repo (no deben perder el freno)', () => {
  it.each([
    ['un SELECT simple', 'SELECT count(*) FROM "Order" WHERE "venueId" = $1'],
    ['identificadores con palabras de escritura', 'SELECT "updatedAt", "comment", "deletedAt", "createdBy", "lock" FROM "Order"'],
    ['palabras de escritura dentro de un texto', "SELECT * FROM \"ActivityLog\" WHERE action = 'DELETE' OR action = 'UPDATE INTO'"],
    ['comentarios de línea y de bloque (anidados)', '-- reporte\n/* bloque /* anidado */ sigue */ (SELECT 1)'],
    ['texto con comilla escapada', "SELECT 'it''s -- not a comment' AS a, 1"],
    ['cadena E con barra invertida', "SELECT E'it\\'s -- still a string' AS a"],
    ['cadena con dólares que contiene UPDATE', 'SELECT $$ UPDATE x SET y = 1 $$ AS texto'],
    ['cadena con dólares y etiqueta', 'SELECT $tag$ DELETE FROM x; $tag$ AS texto'],
    [
      'analítica típica: agregados, ventanas, fechas, casts y FILTER',
      `SELECT date_trunc('day', (o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE $1) AS dia,
              coalesce(sum(p.amount), 0)::numeric(12,2) AS total,
              count(*) FILTER (WHERE p.status = 'COMPLETED') AS pagados,
              row_number() OVER (PARTITION BY o."venueId" ORDER BY o."createdAt" DESC) AS n,
              to_char(o."createdAt", 'YYYY-MM-DD') AS fecha,
              extract(epoch FROM o."createdAt") AS epoch,
              substring(o.folio FROM 1 FOR 3) AS pre,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY p.amount) AS mediana
         FROM "Order" o JOIN "Payment" p ON p."orderId" = o.id
        WHERE o."venueId" = ANY($2) AND NOT EXISTS (SELECT 1 FROM "Refund" r WHERE r."orderId" = o.id)
        GROUP BY 1 ORDER BY 1 LIMIT $3`,
    ],
    ['jsonb con alias de columnas', 'SELECT e.value FROM "Venue" v, LATERAL jsonb_array_elements(v.settings) AS e(value)'],
    ['CAST con tipo con modificador', "SELECT CAST(x AS numeric(10,2)), lower(trim(both ' ' FROM y)) FROM t"],
    [
      'CTE con lista de columnas',
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3), u (m) AS (VALUES (1), (2)) SELECT * FROM t, u',
    ],
    [
      'búsqueda por similitud (pg_trgm)',
      'SELECT id FROM "Product" WHERE similarity(lower(name), lower($1)) > 0.3 ORDER BY similarity(name, $1) DESC',
    ],
    ['función de pg_catalog calificada', 'SELECT pg_catalog.lower($1)'],
    ['punto y coma final', 'SELECT 1;'],
  ])('%s ⇒ es lectura', (_caso, sql) => {
    expect(isReadOnlySql(sql)).toBe(true)
  })
})
