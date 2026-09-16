/**
 * Codex R12-7 (pasada exhaustiva, 14-sep-2026): EXCLUSIÓN por REFERENCIA para los registros SIN llave.
 *
 * Un cargo legacy (sin `idempotencyKey` ni solicitud) se deduplica por `referenceNumber` + identidad suficiente
 * (`buscarRegistroPorReferencia`). Esa resolución corría FUERA de la transacción de creación: dos replays simultáneos del
 * mismo cargo veían ausencia los dos, y los dos creaban COMPLETED, venta e ingreso — $200 registrados por $100 cobrados. Con
 * llave lo evita el índice único `(venueId, idempotencyKey)`; sin llave no había nada.
 *
 * La decisión existente se vuelve ATÓMICA sin cambiar la heurística ni el APK: la transacción de creación de un registro sin
 * llave toma como PRIMERA sentencia un candado consultivo transaccional por (venue, referencia) y, ya con el candado, VUELVE A
 * RESOLVER la referencia (READ COMMITTED: fotografía nueva — quien llega segundo ve lo que el primero dejó commiteado). Si
 * ahora existe, la creación se aborta y se devuelve el existente; si es colisión, se registra como evidencia; si sigue sin
 * haber nada, se crea. Dos cargos legítimamente distintos con la misma referencia siguen siendo dos: el candado sólo
 * serializa, los discriminadores son los de siempre — NO se impone `UNIQUE(referenceNumber)`.
 *
 * Orden de candados documentado (compatible con el resto del registrador): referencia → [sesión de vales → tickets →]
 * Order → TerminalPaymentRequest → Payment → Shift. El candado del intento (`candadoDeIntento`) sólo lo toman registros CON
 * llave, que no toman éste; y la consolidación que corre bajo este candado toma el Payment existente en SU propia
 * transacción sin esperar nunca a éste. Nadie sostiene una fila y después espera esta referencia.
 *
 *  · Namespace propio (int4), separado del candado del intento.
 *  · Espera acotada (`lock_timeout`) SÓLO para adquirir: después se restablece a 0 para no cambiar cómo esperan los candados
 *    de fila que vienen detrás en la misma transacción. Si vence, el llamador lo convierte en un error REINTENTABLE (la
 *    terminal vuelve a mandar el mismo cobro; no nace un duplicado).
 *  · El SQL lleva el marcador «referencia» en un comentario SQL para que las pruebas observen la espera en `pg_stat_activity`.
 */
import { Prisma } from '@prisma/client'
import { esperaDeCandadoMs } from './candadoDeIntento'

/** Namespace fijo y reservado del candado por referencia (int4). No reutilizar en otro advisory de dos llaves. */
export const NS_CANDADO_REFERENCIA = 7_310_114

/** La llave del candado: venue + referencia, tal cual se comparan en la búsqueda (sin normalizar de más). */
export function llaveDeReferencia(venueId: string, referenceNumber: string): string {
  return `${venueId}:${referenceNumber}`
}

/**
 * La espera acotada del candado: la del intento (que las pruebas de intercalación acortan) pero nunca por encima de lo que
 * cabe en la transacción de creación del registrador (5 s por defecto en Prisma): si venciera la transacción antes que el
 * candado, el error dejaría de ser el reintentable que aquí se traduce.
 */
export const TOPE_DE_ESPERA_DE_REFERENCIA_MS = 3_500
export function esperaDeCandadoDeReferenciaMs(): number {
  return Math.min(esperaDeCandadoMs(), TOPE_DE_ESPERA_DE_REFERENCIA_MS)
}

/** Código SQLSTATE de Postgres cuando vence `lock_timeout`. */
export const LOCK_NOT_AVAILABLE = '55P03'

export function esVencimientoDeCandado(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta
  const code = meta && typeof meta === 'object' ? (meta as { code?: unknown }).code : undefined
  const message = error instanceof Error ? error.message : String(error)
  return code === LOCK_NOT_AVAILABLE || /lock timeout|canceling statement due to lock timeout|55P03/i.test(message)
}

/**
 * Primera sentencia de la transacción de creación de un registro SIN llave: espera acotada + candado consultivo
 * transaccional por (venue, referencia); la espera se restablece a 0 al adquirirlo.
 */
export async function candadoDeReferencia(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRawUnsafe'>,
  venueId: string,
  referenceNumber: string,
): Promise<void> {
  const llave = llaveDeReferencia(venueId, referenceNumber)
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${esperaDeCandadoDeReferenciaMs()}ms'`)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${NS_CANDADO_REFERENCIA}::int, hashtext(${llave}))::text /* referencia */`
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = 0`)
}
