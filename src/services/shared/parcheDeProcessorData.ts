/**
 * Codex R12-10 (pasada exhaustiva, 14-sep-2026): parche ATÓMICO sobre `Payment.processorData`.
 *
 * `processorData` lo escriben varios actores sobre la MISMA columna JSON: el registrador (snapshot de tarifa, etiqueta de la
 * solicitud, procedencia), la convergencia del costo (`costPending`), los enriquecimientos y los escritores de Blumon
 * (webhook y auditoría). Un escritor que LEE el JSON, lo fusiona en memoria y lo REEMPLAZA entero repone lo que otro escribió
 * en medio: leía `costPending: true`, la convergencia terminaba (false/DONE) y el reemplazo dejaba el cargo marcado pendiente
 * con su obligación ya terminada — sin trabajador que lo reparara. Un parche `||` de Postgres sobre el valor VIGENTE, limitado
 * a las llaves propias del escritor, no puede pisar las ajenas: es la misma forma que ya usa `marcarCostPending`.
 *
 *  · Nunca reemplaza el objeto: `"processorData" || parche`. Un JSON que no sea objeto (NULL, legacy) se trata como `{}`.
 *  · `soloSiFalta`: el parche se aplica ÚNICAMENTE si esa llave todavía no existe (idempotencia atómica: el «si no lo tenía
 *    ya» se decide en la misma sentencia, no en una lectura anterior).
 *  · Devuelve cuántas filas cambió (0 ⇒ no existía el Payment, o la llave ya estaba).
 */
import type { Prisma } from '@prisma/client'

type Cliente = Pick<Prisma.TransactionClient, '$executeRaw'>

export async function parcharProcessorData(
  db: Cliente,
  paymentId: string,
  parche: Record<string, unknown>,
  opciones: { soloSiFalta?: string } = {},
): Promise<number> {
  const json = JSON.stringify(parche)
  if (opciones.soloSiFalta) {
    return db.$executeRaw`
      UPDATE "Payment"
      SET "processorData" = CASE WHEN jsonb_typeof("processorData") = 'object' THEN "processorData" ELSE '{}'::jsonb END || ${json}::jsonb
      WHERE "id" = ${paymentId}
        AND NOT COALESCE(jsonb_typeof("processorData") = 'object' AND "processorData" ? ${opciones.soloSiFalta}, false)`
  }
  return db.$executeRaw`
    UPDATE "Payment"
    SET "processorData" = CASE WHEN jsonb_typeof("processorData") = 'object' THEN "processorData" ELSE '{}'::jsonb END || ${json}::jsonb
    WHERE "id" = ${paymentId}`
}
