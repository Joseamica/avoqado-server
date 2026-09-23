/**
 * Codex r1 (P1-C, ventana de confirmación): el veto por EVIDENCIA POSITIVA revalidado EN LA ESCRITURA.
 *
 * La consulta del veto y el CAS son dos sentencias: un escritor que no toma el candado —el fallback del webhook cuya espera
 * venció, un Payment etiquetado sólo en `processorData` por una cola vieja— cabe entre las dos, y un `updatedAt` sin tocar no
 * lo delata. Por eso el UPDATE condicional que LIBERA una solicitud (la ventana), la DECLARA sin cobro (el cajero) o la cierra
 * con un NEGATIVO acreditado de la terminal (`closeRow`, Codex r2 P1-A) lleva estos `NOT EXISTS` sobre lo durable en ese instante:
 *
 *  · `sinAprobadoVinculadoSql`: ningún `send_transaction` APROBADO (`estadoBancarioSql`) de un intento vinculado a la solicitud —
 *    por los vínculos ACTUALES (subconsulta sobre `TerminalPaymentAttemptLink`, no una lista en memoria);
 *  · `sinPagoLigadoSql`: ningún cobro con tarjeta COMPLETED (no reembolso, NULL-seguro sobre `type`) del venue ligado a la
 *    solicitud por CUALQUIERA de sus tres identidades: el puntero `terminalPaymentRequestId`, la etiqueta legacy
 *    `processorData.terminalPaymentRequestId` o la llave de intento (`idempotencyKey` = `attemptId` de un vínculo actual).
 *
 * Un UPDATE que devuelve 0 es «no elegible»: nunca «nada que hacer». `pagosLigados` es la misma pregunta como lectura (la
 * guarda G1 de la ventana): si hay un Payment ligado que no se pudo LIGAR, la fila se retiene con marca, nunca en silencio.
 */
import { Prisma } from '@prisma/client'
import { PATRON_SQL_TRIM_COMO_JS } from '../../utils/terminalSerial'
import { estadoBancarioSql } from './estadoBancario'

/** Una cadena como PARÁMETRO ligado (`$n`), para que las envolturas públicas sigan recibiendo `string`. */
const bind = (valor: string): Prisma.Sql => Prisma.sql`${valor}`
/** Una COLUMNA de la fila correlacionada. El alias es una constante del código (se valida), nunca entrada del usuario. */
const columna = (alias: string, nombre: string): Prisma.Sql => {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error(`Alias de tabla inválido: ${alias}`)
  return Prisma.raw(`${alias}."${nombre}"`)
}

/**
 * Ronda 3 (17-sep, P2 de Codex r8): las dos identidades de la solicitud llegan como FRAGMENTO, no como cadena, para que la
 * MISMA pregunta sirva con parámetros (`hayPagoLigadoSql`, el CAS) y CORRELACIONADA con las columnas de una fila
 * (`hayPagoLigadoDeLaFilaSql`, la red durable del barrido: una consulta por lote en vez de una por fila liberada).
 */
const vinculosSql = (requestId: Prisma.Sql, venueId: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`SELECT l."attemptId" FROM "TerminalPaymentAttemptLink" l WHERE l."requestId" = ${requestId} AND l."venueId" = ${venueId}`

const aprobadoVinculadoSql = (requestId: string, venueId: string): Prisma.Sql => Prisma.sql`
      SELECT 1 FROM "ProviderEventLog" e
      WHERE e."provider" = 'PAYMENT_PROCESSOR' AND e."venueId" = ${venueId} AND e."type" = 'send_transaction'
        AND e."attemptId" IN (${vinculosSql(bind(requestId), bind(venueId))})
        AND ${estadoBancarioSql(Prisma.sql`e."payload"->'payload'->'status'`)} = 'APROBADO'`

/**
 * 🔴 Ronda 3 (P2 de Codex r8): la etiqueta legacy se compara con la EXPRESIÓN DEL ÍNDICE
 * (`Payment_terminal_request_recovery_idx`, migración `20260909213000`: `("venueId", ("processorData" #>
 * '{terminalPaymentRequestId}'), "createdAt" DESC, "id" DESC)`). Con `->>` la expresión no coincidía con la indexada y el
 * `LIMIT 5` no acotaba las filas examinadas: para DEMOSTRAR la ausencia había que recorrer el historial de pagos del venue,
 * y el barrido amplifica esa consulta.
 *
 * 🔴 Y las TRES identidades van como `UNION` de tres ramas, no como un `OR`: un `OR` sobre tres columnas distintas no puede
 * usar ningún índice, así que Postgres recorría la tabla ENTERA de pagos del venue para demostrar la ausencia. Medido en la
 * base desechable con 60 000 cobros y 40 solicitudes liberadas (la consulta de la red durable): **1 092 ms y 58 893 buffers
 * con el `OR` (Seq Scan de `Payment` por cada fila candidata) contra 3.7 ms y 250 buffers con el `UNION`**, donde cada rama
 * entra por SU índice — `Payment_terminalPaymentRequestId_idx`, `Payment_terminal_request_recovery_idx` (el del P2) y
 * `Payment_venueId_idempotencyKey_key`. `UNION` y no `UNION ALL` para conservar la semántica de conjunto del `OR`: un cobro
 * que casa por dos identidades sigue apareciendo UNA vez en `pagosLigados`.
 *
 * `#> = to_jsonb(<texto>)` es equivalente a `->> = <texto>` para todo valor que un escritor puede producir: la etiqueta se
 * escribe SIEMPRE como cadena JSON, y todos los lectores en JS (`solicitudDelRegistro`, `procedenciaDelPagoDeSolicitud`)
 * exigen `typeof === 'string'` y tratan cualquier otro tipo como ausente — así que alinear el SQL con el índice lo pone de
 * acuerdo con ellos, en vez de separarlo. Un valor numérico o booleano en esa llave (que ningún escritor produce) ya era
 * invisible para el resto de la plataforma.
 */
const cobroConTarjetaSql = (venueId: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`p."venueId" = ${venueId} AND p."status" = 'COMPLETED' AND p."method" IN ('CREDIT_CARD', 'DEBIT_CARD')
        AND (p."type" IS NULL OR p."type" <> 'REFUND')`

const pagoLigadoSql = (requestId: Prisma.Sql, venueId: Prisma.Sql): Prisma.Sql => Prisma.sql`
      SELECT p."id" FROM "Payment" p
      WHERE ${cobroConTarjetaSql(venueId)} AND p."terminalPaymentRequestId" = ${requestId}
      UNION
      SELECT p."id" FROM "Payment" p
      WHERE ${cobroConTarjetaSql(venueId)} AND p."processorData" #> '{terminalPaymentRequestId}' = to_jsonb(${requestId}::text)
      UNION
      SELECT p."id" FROM "Payment" p
      WHERE ${cobroConTarjetaSql(venueId)} AND p."idempotencyKey" IN (${vinculosSql(requestId, venueId)})`

/**
 * 🔴 Codex r6 (P1-1, 22-sep): «¿existe dinero de ESTE intento?» — la regla ÚNICA, y como FRAGMENTO para poder vivir dentro
 * de un UPDATE.
 *
 * Es deliberadamente más amplia que las de arriba, y por eso no se puede sustituir por ellas: esas cuelgan de la SOLICITUD
 * (vínculos, puntero, etiqueta legacy) y están acotadas al venue, al tipo `send_transaction` y al estado COMPLETED. Ésta
 * pregunta por la LLAVE DEL INTENTO en toda la tabla, insensible a espacios y a cualquier estado: un cobro del mismo intento
 * guardado con la llave sin recortar, registrado bajo otro negocio, o todavía en PENDING, **es dinero** — lo veta la
 * comprobación previa del POST y tenía que vetarlo también la escritura.
 *
 * 🔴 Codex r6 (P2-10): UNA sola rama, sobre el recorte de la llave, y NINGUNA sobre la llave cruda. Medido con
 * `EXPLAIN` (escrito desde archivo, no por el shell, que se come los escapes): una rama `llave = X` no tiene índice
 * que la sirva — el único índice con la llave es `(venueId, idempotencyKey)` y empieza por `venueId` —, así que salía
 * `Filter` y recorría la tabla de pagos; y esto corre en el sondeo interactivo cada 5 s, no sólo al declarar. La rama
 * exacta además SOBRABA: si la llave ES el intento, su recorte también lo es. Queda un solo `Index Cond` por
 * `Payment_idempotencyKey_trimmed_idx`, y lo fija una prueba sobre este mismo fragmento.
 *
 * El intento se recorta en JS con `trim()`, que es exactamente la clase de `PATRON_SQL_TRIM_COMO_JS`: para un intento
 * limpio la regla es idéntica a la de antes, y para uno con espacios es MÁS amplia — ve el cobro guardado con o sin
 * ellos. Más amplia en la dirección del veto es la dirección segura: ante la duda, se retiene.
 *
 * Sin esto, el hueco medido por Codex: la comprobación previa termina, el fallback del webhook (que NO toma el candado
 * consultivo del intento) persiste ese cobro, y el CAS lo ignoraba porque su `NOT EXISTS` era el de la solicitud ⇒ escribía
 * `FAILED / OPERATOR_RECONCILED_NO_CHARGE`, que el POS lee como «no se cobró». Dentro del propio UPDATE no cabe nadie.
 */
const dineroConLaLlaveSql = (llave: Prisma.Sql): Prisma.Sql => Prisma.sql`
      SELECT p."id" FROM "Payment" p
      WHERE regexp_replace(p."idempotencyKey", ${PATRON_SQL_TRIM_COMO_JS}, '', 'g') = ${llave}`
const dineroConEstaLlaveSql = (attemptId: string): Prisma.Sql => dineroConLaLlaveSql(bind(attemptId.trim()))

/**
 * 🔴 Codex r7 (P2-2, 22-sep): «consta dinero con la llave de ALGÚN intento vinculado HOY a la solicitud» — la MISMA regla de
 * la llave (`dineroConLaLlaveSql`: recortada, cualquier estado, cualquier negocio), correlacionada con cada vínculo. La usa la
 * pieza D: `hayPagoLigadoSql` sólo cuenta cobros COMPLETED del venue, así que un Payment PENDING del intento —o uno guardado
 * con la llave sin recortar— lo veían S6 y el POST, pero la consulta por solicitud decía `resuelta:true` y la terminal
 * apagaba su último aviso sobre ese dinero. El vínculo guarda la llave ya canónica, así que casa con el recorte.
 */
export function hayDineroDeSusIntentosSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
      SELECT 1 FROM "TerminalPaymentAttemptLink" l
      WHERE l."requestId" = ${requestId} AND l."venueId" = ${venueId}
        AND EXISTS (${dineroConLaLlaveSql(columna('l', 'attemptId'))}))`
}

/** La LECTURA de esa regla (la comprobación previa del POST, los dos caminos). */
export function hayDineroConEstaLlaveSql(attemptId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (${dineroConEstaLlaveSql(attemptId)})`
}

/** La misma regla como condición de ESCRITURA: va en el `WHERE` de todo UPDATE que declare «no se cobró». */
export function sinDineroConEstaLlaveSql(attemptId: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (${dineroConEstaLlaveSql(attemptId)})`
}

/**
 * 🔴 Codex r7 (P1-3, 22-sep): la regla de EVENTOS DEL PROCESADOR que veta declarar «no se presentó tarjeta», como FRAGMENTO
 * — la misma en la comprobación previa del POST y DENTRO del UPDATE que escribe la declaración con solicitud.
 *
 * Veta un evento de ESTE intento si: llegó bajo OTRO negocio · trae contradicción de vínculo · trae el serial de OTRA
 * terminal · el banco lo APROBÓ (aunque no haya Payment) · o, sin vínculo, no se puede atribuir a nadie y no es un rechazo
 * acreditado (r5-6). Antes el CAS sólo llevaba `sinEvidenciaPositivaSql`, cuyo aprobado exige venue PROPIO y
 * `send_transaction`: un aprobado de este intento recibido bajo otro negocio que el fallback persistiera entre la
 * comprobación y la escritura no lo veía nadie, y se escribía `FAILED / OPERATOR_RECONCILED_NO_CHARGE`. Se había unificado
 * la pregunta sobre el Payment, no la regla completa.
 */
const eventoQueVetaSql = (attemptId: string, venueId: string, terminalId: string, hayVinculo: boolean): Prisma.Sql => Prisma.sql`
    SELECT e."id" FROM "ProviderEventLog" e
    WHERE e."attemptId" = ${attemptId} AND e."provider" = 'PAYMENT_PROCESSOR'
      AND (e."venueId" IS DISTINCT FROM ${venueId}
        OR e."errorReason" IN ('LINK_TERMINAL_MISMATCH', 'LINK_VENUE_MISMATCH')
        OR (nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') IS NOT NULL
          AND lower(regexp_replace(regexp_replace(e."payload"->'payload'->>'terminalSerial', ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '^AVQD-', '', 'i')) <> ${terminalId})
        OR ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} = 'APROBADO'
        -- 🔴 Codex r5-6: un evento que no se puede atribuir a nadie —sin vínculo y sin serial— y que NO es un rechazo
        -- acreditado también veta: aceptar una declaración y poder usarla tienen que decir lo mismo.
        OR (${!hayVinculo}
          AND nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') IS NULL
          AND ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} IS DISTINCT FROM 'RECHAZADO'))`

/** La LECTURA de esa regla: los eventos que vetan (la comprobación previa del POST), acotada. */
export function eventosQueVetanSql(attemptId: string, venueId: string, terminalId: string, hayVinculo: boolean): Prisma.Sql {
  return Prisma.sql`${eventoQueVetaSql(attemptId, venueId, terminalId, hayVinculo)} LIMIT 1`
}

/** La misma regla como condición de ESCRITURA: va en el `WHERE` del UPDATE que declara «no se cobró». */
export function sinEventoQueVetaSql(attemptId: string, venueId: string, terminalId: string, hayVinculo: boolean): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (${eventoQueVetaSql(attemptId, venueId, terminalId, hayVinculo)})`
}

/** «No consta un APROBADO de ningún intento vinculado HOY a la solicitud» (Codex r2 P1-A: el `NOT EXISTS` del negativo acreditado). */
export function sinAprobadoVinculadoSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (${aprobadoVinculadoSql(requestId, venueId)})`
}

/**
 * Revisión final (17-sep, B): el POSITIVO del mismo veto — «consta un APROBADO de un intento vinculado HOY a la solicitud, del
 * venue de la solicitud». Lo exige el CAS que RE-RETIENE una solicitud ya liberada (ventana o cajero) cuando el banco aprobó
 * después sin que naciera el Payment: es exactamente lo que `sinAprobadoVinculadoSql` habría vetado un instante antes.
 */
export function hayAprobadoVinculadoSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (${aprobadoVinculadoSql(requestId, venueId)})`
}

/** «No hay Payment con tarjeta COMPLETED ligado a la solicitud por puntero, etiqueta legacy o llave de intento». */
export function sinPagoLigadoSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (${pagoLigadoSql(bind(requestId), bind(venueId))})`
}

/**
 * Revisión final · ronda 2 (17-sep, P1): el POSITIVO del veto por Payment — «hay un cobro con tarjeta COMPLETED ligado a la solicitud
 * por puntero, etiqueta legacy o llave de intento». Lo exige el CAS que RE-RETIENE una solicitud ya liberada cuando ese Payment llegó
 * DESPUÉS y el cierre común no lo pudo LIGAR: es exactamente lo que `sinPagoLigadoSql` (y la guarda G1 de la ventana) habría vetado un
 * instante antes de liberar.
 */
export function hayPagoLigadoSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (${pagoLigadoSql(bind(requestId), bind(venueId))})`
}

/**
 * Ronda 3 (17-sep, P1-A): el MISMO cuerpo, CORRELACIONADO con las columnas de una fila de `TerminalPaymentRequest` de alias
 * `alias`, y sin envolver: así el barrido lo usa como `JOIN LATERAL` y obtiene de una vez el FILTRO («sólo las liberadas que
 * tienen un cobro ligado») y el ID del cobro. Es lo que convierte la red durable en UNA consulta por lote —el barrido no
 * pregunta fila por fila— y por tanto en un coste acotado aunque el horizonte sea de días. El cuerpo es EL de arriba: si
 * divergieran, el barrido y el CAS dirían cosas distintas sobre el mismo cobro (hay una prueba que compara los textos).
 */
export function pagoLigadoDeLaFilaSql(alias: string): Prisma.Sql {
  return pagoLigadoSql(columna(alias, 'requestId'), columna(alias, 'venueId'))
}

/**
 * Ronda 3 (17-sep, P1-B): «existe EVIDENCIA DE CONCILIACIÓN pendiente apuntada a esta solicitud» — el Payment `PENDING`
 * que el registrador crea cuando la referencia colisiona con un cobro que CONTRADICE al entrante
 * (`POSSIBLE_REFERENCE_COLLISION`), o cuando la solicitud ya tenía ganador (`POSSIBLE_SECOND_CAPTURE`).
 *
 * 🔴 No se puede usar `hayPagoLigadoSql` para esto: esa evidencia NO liga por ninguna de las tres identidades (no es
 * COMPLETED), y es exactamente por eso que una solicitud liberada se quedaba intacta con una colisión encima. La fila la
 * escribe el SERVIDOR dentro de la transacción del registro, así que es evidencia durable y no un dato del cuerpo del
 * cliente; quién puede usarla para re-retener lo decide aparte la identidad acreditada del llamador (regla T10).
 */
const evidenciaDeConciliacionSql = (requestId: Prisma.Sql, venueId: Prisma.Sql): Prisma.Sql => Prisma.sql`
      SELECT p."id" FROM "Payment" p
      WHERE p."venueId" = ${venueId} AND p."status" = 'PENDING' AND p."terminalPaymentRequestId" = ${requestId}
        AND p."processorData"->'reconciliation'->>'kind' IN ('POSSIBLE_REFERENCE_COLLISION', 'POSSIBLE_SECOND_CAPTURE')`

export function hayEvidenciaDeConciliacionSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (${evidenciaDeConciliacionSql(bind(requestId), bind(venueId))})`
}

/**
 * Ronda 4 (17-sep, P1-B): el MISMO cuerpo, CORRELACIONADO con las columnas de una fila de `TerminalPaymentRequest` de alias
 * `alias` — lo que le permite a la RED DURABLE recoger en su recorrido, además de las liberadas con un cobro ligado, las que
 * sólo tienen esta evidencia (una colisión de referencia cuya re-retención se difirió no producía ningún Payment COMPLETED,
 * así que ningún barrido la volvía a mirar). Es EL de arriba, no una copia: si divergieran, el selector del barrido y el CAS
 * dirían cosas distintas de la misma evidencia (hay una prueba que compara los textos).
 */
export function evidenciaDeConciliacionDeLaFilaSql(alias: string): Prisma.Sql {
  return evidenciaDeConciliacionSql(columna(alias, 'requestId'), columna(alias, 'venueId'))
}

/** Las dos a la vez: el CAS de la LIBERACIÓN por ventana y el de la DECLARACIÓN del cajero. */
export function sinEvidenciaPositivaSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`${sinAprobadoVinculadoSql(requestId, venueId)} AND ${sinPagoLigadoSql(requestId, venueId)}`
}

/** Los Payments ligados a la solicitud (los que `sinPagoLigadoSql` vetaría), los más antiguos primero; acotado. */
export async function pagosLigados(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  requestId: string,
  venueId: string,
): Promise<{ id: string }[]> {
  return db.$queryRaw<
    { id: string }[]
  >`SELECT "id" FROM (${pagoLigadoSql(bind(requestId), bind(venueId))}) ligados ORDER BY "id" ASC LIMIT 5`
}

/** Diagnóstico para el log cuando el UPDATE condicional devolvió 0: qué evidencia positiva lo frenó (o ninguna: la fila cambió). */
export async function porQueHayEvidenciaPositiva(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  requestId: string,
  venueId: string,
): Promise<'APROBADO_VINCULADO' | 'PAYMENT_LIGADO' | 'NINGUNA'> {
  const [fila] = await db.$queryRaw<{ aprobado: boolean; pago: boolean }[]>`
    SELECT EXISTS (${aprobadoVinculadoSql(requestId, venueId)}) AS "aprobado", EXISTS (${pagoLigadoSql(bind(requestId), bind(venueId))}) AS "pago"`
  return fila?.aprobado ? 'APROBADO_VINCULADO' : fila?.pago ? 'PAYMENT_LIGADO' : 'NINGUNA'
}
