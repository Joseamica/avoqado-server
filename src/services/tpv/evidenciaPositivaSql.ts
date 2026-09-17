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
import { estadoBancarioSql } from './estadoBancario'

const vinculosSql = (requestId: string, venueId: string): Prisma.Sql =>
  Prisma.sql`SELECT l."attemptId" FROM "TerminalPaymentAttemptLink" l WHERE l."requestId" = ${requestId} AND l."venueId" = ${venueId}`

const aprobadoVinculadoSql = (requestId: string, venueId: string): Prisma.Sql => Prisma.sql`
      SELECT 1 FROM "ProviderEventLog" e
      WHERE e."provider" = 'PAYMENT_PROCESSOR' AND e."venueId" = ${venueId} AND e."type" = 'send_transaction'
        AND e."attemptId" IN (${vinculosSql(requestId, venueId)})
        AND ${estadoBancarioSql(Prisma.sql`e."payload"->'payload'->'status'`)} = 'APROBADO'`

const pagoLigadoSql = (requestId: string, venueId: string): Prisma.Sql => Prisma.sql`
      SELECT p."id" FROM "Payment" p
      WHERE p."venueId" = ${venueId} AND p."status" = 'COMPLETED' AND p."method" IN ('CREDIT_CARD', 'DEBIT_CARD')
        AND (p."type" IS NULL OR p."type" <> 'REFUND')
        AND (p."terminalPaymentRequestId" = ${requestId}
          OR p."processorData"->>'terminalPaymentRequestId' = ${requestId}
          OR p."idempotencyKey" IN (${vinculosSql(requestId, venueId)}))`

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
  return Prisma.sql`NOT EXISTS (${pagoLigadoSql(requestId, venueId)})`
}

/**
 * Revisión final · ronda 2 (17-sep, P1): el POSITIVO del veto por Payment — «hay un cobro con tarjeta COMPLETED ligado a la solicitud
 * por puntero, etiqueta legacy o llave de intento». Lo exige el CAS que RE-RETIENE una solicitud ya liberada cuando ese Payment llegó
 * DESPUÉS y el cierre común no lo pudo LIGAR: es exactamente lo que `sinPagoLigadoSql` (y la guarda G1 de la ventana) habría vetado un
 * instante antes de liberar.
 */
export function hayPagoLigadoSql(requestId: string, venueId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (${pagoLigadoSql(requestId, venueId)})`
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
  return db.$queryRaw<{ id: string }[]>`SELECT "id" FROM (${pagoLigadoSql(requestId, venueId)}) ligados ORDER BY "id" ASC LIMIT 5`
}

/** Diagnóstico para el log cuando el UPDATE condicional devolvió 0: qué evidencia positiva lo frenó (o ninguna: la fila cambió). */
export async function porQueHayEvidenciaPositiva(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  requestId: string,
  venueId: string,
): Promise<'APROBADO_VINCULADO' | 'PAYMENT_LIGADO' | 'NINGUNA'> {
  const [fila] = await db.$queryRaw<{ aprobado: boolean; pago: boolean }[]>`
    SELECT EXISTS (${aprobadoVinculadoSql(requestId, venueId)}) AS "aprobado", EXISTS (${pagoLigadoSql(requestId, venueId)}) AS "pago"`
  return fila?.aprobado ? 'APROBADO_VINCULADO' : fila?.pago ? 'PAYMENT_LIGADO' : 'NINGUNA'
}
