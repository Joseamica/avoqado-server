/**
 * ¿El aviso del banco (el webhook de AngelPay) de un COMERCIO está COMPROBADO? La regla vive aquí, en su propio módulo, porque
 * la usan DOS caminos que tienen que medir lo MISMO:
 *  · la declaración AUTOMÁTICA de la terminal «sin rastro del banco tras la ventana» de un Pago rápido
 *    (`no-instrument-resolution.service`, ronda 20) — de donde se movió TAL CUAL el 21-oct (A8), misma SQL y mismo resultado;
 *  · la VENTANA DE CONFIRMACIÓN de 30 s del cobro del POS (`releaseUnprovenNegative`, A8, founder 21-oct, D2 → «A»): sólo
 *    escribe «no se cobró» por el silencio del banco si TODAS las cuentas con las que pudo cobrar la terminal pasan esta regla.
 * Recibe el cliente de la transacción del llamador: la medición y la escritura que decide son una sola fotografía.
 */
import { Prisma } from '@prisma/client'
import { PATRON_SQL_TRIM_COMO_JS } from '../../utils/terminalSerial'
import { ANGELPAY_WEBHOOK_ERROR_REASONS } from './angelpay-webhook.service'
import { canalDelComercioFalloHacePoco } from './avisosNoGuardados'

/**
 * ¿El aviso del banco del COMERCIO de este cobro está COMPROBADO? Es lo único que vuelve evidencia el silencio (ronda 20).
 * Medido en producción el 23-sep (7 días): de 812 cobros con tarjeta de Nexgo, 790 trajeron su aviso (p99 3.4 s, máximo 4.5 s),
 * y los 22 sin aviso eran TODOS de un comercio cuyo webhook nunca se configuró.
 *
 * `null` ⇒ ese comercio no puede sostener la declaración (no existe, no es AngelPay, o su acceso es de otro negocio).
 *
 * La regla (ronda 21, Codex r19 P1-2): recibió avisos, y CADA UNO de sus últimos 10 cobros con tarjeta completados (no
 * reembolsos, de hace más de 60 s: el aviso del más reciente puede ir en camino) tiene el suyo — ligado al pago, o al intento
 * por la llave del cobro (recortada con la misma regla que la llave canónica, `PATRON_SQL_TRIM_COMO_JS`). La regla de la ronda 20 («ningún cobro posterior al último aviso») se dejaba engañar: un cobro sin
 * aviso a menos de 60 s del último pasaba, y un aviso POSTERIOR de otra terminal del mismo comercio lo volvía a tapar.
 * ⚠️ Declarado: un aviso que se rompe no se detecta hasta el primer cobro con tarjeta que se quede sin el suyo.
 *
 * 🔴 Ronda 22 (Codex r20, P1-2): un cobro cuenta para el comercio CON EL QUE COBRÓ la terminal, no sólo para el de la columna. El
 * registrador deja `merchantAccountId` en null cuando la cuenta recibida está inactiva y no encuentra reemplazo, y conserva la
 * identidad original en `processorData.merchantAccountIdFromApk` (`identidadDelCobro.ts`); contando sólo la columna, ese cobro
 * SIN aviso desaparecía de la medición y el comercio seguía «comprobado». Por lo mismo, un comercio DESACTIVADO no sostiene el
 * silencio. La búsqueda va acotada al negocio (índice `venueId, status, createdAt`).
 */
/**
 * Ronda 23 (Codex r21, P1-3): motivos con que el receptor del webhook conserva un aviso que CONTRADICE su atribución (otro comercio
 * receptor, otro negocio, otra terminal, importe distinto, colisión o segunda captura). Siguen siendo evidencia; no son el aviso
 * propio del cobro al que quedaron ligados.
 */
const MOTIVOS_QUE_NO_SON_EL_AVISO_PROPIO = [
  ANGELPAY_WEBHOOK_ERROR_REASONS.MERCHANT_MISMATCH,
  ANGELPAY_WEBHOOK_ERROR_REASONS.LINK_VENUE_MISMATCH,
  ANGELPAY_WEBHOOK_ERROR_REASONS.LINK_TERMINAL_MISMATCH,
  ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH,
  ANGELPAY_WEBHOOK_ERROR_REASONS.POSSIBLE_REFERENCE_COLLISION,
  ANGELPAY_WEBHOOK_ERROR_REASONS.POSSIBLE_SECOND_CAPTURE,
]

export async function avisoDelBancoComprobado(
  tx: Prisma.TransactionClient,
  venueId: string,
  merchantAccountId: string,
): Promise<boolean | null> {
  const [comercio] = await tx.$queryRaw<{ comprobado: boolean }[]>`
    SELECT (m."active" AND m."angelpayWebhookLastReceivedAt" IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM (
                SELECT p."id", p."idempotencyKey",
                       lower(regexp_replace(regexp_replace(COALESCE(t."serialNumber", p."processorData"->>'deviceSerialNumber', ''),
                             ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '^AVQD-', '', 'i')) AS "serialDelCobro"
                FROM "Payment" p
                LEFT JOIN "Terminal" t ON t."id" = p."terminalId"
                WHERE p."venueId" = ${venueId}
                  AND COALESCE(NULLIF(p."processorData"->>'merchantAccountIdFromApk', ''), p."merchantAccountId") = m."id"
                  AND p."method" IN ('CREDIT_CARD', 'DEBIT_CARD') AND p."status" = 'COMPLETED'
                  AND (p."type" IS NULL OR p."type" <> 'REFUND')
                  AND p."createdAt" < (NOW() AT TIME ZONE 'UTC') - interval '60 seconds'
                ORDER BY p."createdAt" DESC
                LIMIT 10) ultimos
              WHERE NOT EXISTS (
                SELECT 1 FROM "ProviderEventLog" e
                WHERE e."provider" = 'PAYMENT_PROCESSOR'
                  AND (e."paymentId" = ultimos."id"
                       OR (ultimos."idempotencyKey" IS NOT NULL AND e."attemptId" = regexp_replace(ultimos."idempotencyKey", ${PATRON_SQL_TRIM_COMO_JS}, '', 'g')))
                  -- 🔴 Ronda 23 (Codex r21, P1-3): sólo el aviso PROPIO. El receptor liga por referencia avisos de OTRO intento o
                  -- recibidos por OTRO comercio (y los conserva como evidencia, con su motivo); eso no prueba que llegó el de éste.
                  -- 🔴 Codex pasada final (P1-3): SIN llave, el aviso sólo es propio si trae el serial de la terminal que cobró.
                  -- Dos terminales del mismo comercio que cobran igual importe en el mismo segundo comparten la referencia
                  -- yyMMddHHmmss, y el receptor liga el aviso sin llave de una al pago de la otra. Medido el 23-sep (14 días):
                  -- los 1,533 avisos ligados de producción traen el serial y coincide con el del pago en TODOS.
                  AND ((e."attemptId" IS NULL
                        AND ultimos."serialDelCobro" <> ''
                        AND lower(regexp_replace(regexp_replace(e."payload"->'payload'->>'terminalSerial', ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'),
                                  '^AVQD-', '', 'i')) = ultimos."serialDelCobro")
                       OR (ultimos."idempotencyKey" IS NOT NULL AND e."attemptId" = regexp_replace(ultimos."idempotencyKey", ${PATRON_SQL_TRIM_COMO_JS}, '', 'g')))
                  AND (e."errorReason" IS NULL OR e."errorReason" NOT IN (${Prisma.join(MOTIVOS_QUE_NO_SON_EL_AVISO_PROPIO)}))
                  -- 🔴 Ronda 24 (Codex r22, P1-1): y lo RECIBIÓ este comercio (el receptor lo estampa en cada evento desde julio).
                  -- Excluir motivos no alcanzaba: un aviso de M2 con la llave de M1 cuenta ANTES de clasificarse (PENDING, sin
                  -- motivo), y el backfill lo liga sin MERCHANT_MISMATCH cuando la columna del pago quedó vacía.
                  AND e."payload"->'_avoqado'->>'receivedByMerchantAccountId' = m."id"))) AS "comprobado"
    FROM "MerchantAccount" m
    JOIN "PaymentProvider" pp ON pp."id" = m."providerId" AND pp."code" = 'ANGELPAY'
    JOIN "AngelPayUserAccount" a ON a."id" = m."angelpayUserAccountId" AND a."venueId" = ${venueId}
    WHERE m."id" = ${merchantAccountId}`
  // 🔴 Codex pasada final (P1-2): si su canal de avisos acaba de FALLAR (un aviso firmado que no se pudo guardar), su silencio
  // no prueba nada aunque sus últimos diez cobros traigan el suyo: el que se perdió no está en la base para medirlo.
  return comercio ? comercio.comprobado && !canalDelComercioFalloHacePoco(merchantAccountId) : null
}
