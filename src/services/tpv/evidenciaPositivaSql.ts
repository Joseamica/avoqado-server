/**
 * Codex r1 (P1-C, ventana de confirmación): el veto por EVIDENCIA POSITIVA revalidado EN LA ESCRITURA.
 *
 * La consulta del veto y el CAS son dos sentencias: un escritor que no toma el candado —el fallback del webhook cuya espera
 * venció, un Payment etiquetado sólo en `processorData` por una cola vieja— cabe entre las dos, y un `updatedAt` sin tocar no
 * lo delata. Por eso el UPDATE condicional que LIBERA una solicitud (la ventana) o la DECLARA sin cobro (el cajero) lleva
 * además este par de `NOT EXISTS` sobre lo durable en ese instante:
 *
 *  · ningún `send_transaction` APROBADO (`estadoBancarioSql`) de un intento vinculado a la solicitud — por los vínculos ACTUALES
 *    (subconsulta sobre `TerminalPaymentAttemptLink`, no una lista en memoria);
 *  · ningún cobro con tarjeta COMPLETED (no reembolso, NULL-seguro sobre `type`) del venue ligado a la solicitud por CUALQUIERA
 *    de sus tres identidades: el puntero `terminalPaymentRequestId`, la etiqueta legacy `processorData.terminalPaymentRequestId`
 *    o la llave de intento (`idempotencyKey` = `attemptId` de un vínculo actual).
 *
 * Un UPDATE que devuelve 0 es «no elegible»: nunca «nada que hacer».
 */
import { Prisma } from '@prisma/client'
import { estadoBancarioSql } from './estadoBancario'

export function sinEvidenciaPositivaSql(requestId: string, venueId: string): Prisma.Sql {
  const vinculos = Prisma.sql`SELECT l."attemptId" FROM "TerminalPaymentAttemptLink" l WHERE l."requestId" = ${requestId} AND l."venueId" = ${venueId}`
  return Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "ProviderEventLog" e
      WHERE e."provider" = 'PAYMENT_PROCESSOR' AND e."venueId" = ${venueId} AND e."type" = 'send_transaction'
        AND e."attemptId" IN (${vinculos})
        AND ${estadoBancarioSql(Prisma.sql`e."payload"->'payload'->'status'`)} = 'APROBADO')
    AND NOT EXISTS (
      SELECT 1 FROM "Payment" p
      WHERE p."venueId" = ${venueId} AND p."status" = 'COMPLETED' AND p."method" IN ('CREDIT_CARD', 'DEBIT_CARD')
        AND (p."type" IS NULL OR p."type" <> 'REFUND')
        AND (p."terminalPaymentRequestId" = ${requestId}
          OR p."processorData"->>'terminalPaymentRequestId' = ${requestId}
          OR p."idempotencyKey" IN (${vinculos})))`
}

/** Diagnóstico para el log cuando el UPDATE condicional devolvió 0: qué evidencia positiva lo frenó (o ninguna: la fila cambió). */
export async function porQueHayEvidenciaPositiva(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  requestId: string,
  venueId: string,
): Promise<'APROBADO_VINCULADO' | 'PAYMENT_LIGADO' | 'NINGUNA'> {
  const vinculos = Prisma.sql`SELECT l."attemptId" FROM "TerminalPaymentAttemptLink" l WHERE l."requestId" = ${requestId} AND l."venueId" = ${venueId}`
  const [fila] = await db.$queryRaw<{ aprobado: boolean; pago: boolean }[]>`
    SELECT
      EXISTS (SELECT 1 FROM "ProviderEventLog" e
        WHERE e."provider" = 'PAYMENT_PROCESSOR' AND e."venueId" = ${venueId} AND e."type" = 'send_transaction'
          AND e."attemptId" IN (${vinculos})
          AND ${estadoBancarioSql(Prisma.sql`e."payload"->'payload'->'status'`)} = 'APROBADO') AS "aprobado",
      EXISTS (SELECT 1 FROM "Payment" p
        WHERE p."venueId" = ${venueId} AND p."status" = 'COMPLETED' AND p."method" IN ('CREDIT_CARD', 'DEBIT_CARD')
          AND (p."type" IS NULL OR p."type" <> 'REFUND')
          AND (p."terminalPaymentRequestId" = ${requestId}
            OR p."processorData"->>'terminalPaymentRequestId' = ${requestId}
            OR p."idempotencyKey" IN (${vinculos}))) AS "pago"`
  return fila?.aprobado ? 'APROBADO_VINCULADO' : fila?.pago ? 'PAYMENT_LIGADO' : 'NINGUNA'
}
