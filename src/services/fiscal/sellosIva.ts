/**
 * IVA por producto, plan 3: sellar (congelar el tratamiento de un renglón al facturarlo, y
 * registrar qué CFDI lo usó) y liberar (deshacer ese registro cuando ese CFDI deja de contar —
 * cancelación confirmada, fallo definitivo). Una sola función para cada cosa.
 *
 * Sellar corre DENTRO de la transacción de reserva del CFDI (la misma que toma
 * `pg_advisory_xact_lock_shared` y escribe `Cfdi.protocoloIva`): si diverge, lanza y esa
 * transacción entera revierte — nunca queda un sello a medias.
 */
import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import { IvaTratamiento } from './ivaTratamiento'

export type Tx = Prisma.TransactionClient

export async function sellarRenglones(
  tx: Tx,
  p: { cfdiId: string; intento: number; renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }> },
): Promise<void> {
  for (const r of p.renglones) {
    // Sólo escribe si el renglón sigue sin sellar (NULL). Si ya estaba sellado, esta UPDATE
    // no toca nada — el candado real es la comparación de abajo.
    const actualizadas = await tx.$executeRaw`
      UPDATE "OrderItem"
      SET "ivaTratamiento" = CAST(${r.tratamiento} AS "IvaTratamiento")
      WHERE id = ${r.orderItemId} AND "ivaTratamiento" IS NULL
    `

    if (actualizadas === 0) {
      // Ya estaba sellado (de este mismo CFDI en un reintento, o de un CFDI hermano). Su valor
      // sellado DEBE coincidir con lo que esta entrada resolvió — si no, es un defecto (la
      // entrada se captura bajo el candado de emisión) y no se tapa: se revienta la transacción.
      const actual = await tx.orderItem.findUniqueOrThrow({
        where: { id: r.orderItemId },
        select: { ivaTratamiento: true },
      })
      if (actual.ivaTratamiento !== r.tratamiento) {
        throw new Error('SELLO_DIVERGENTE')
      }
    }

    await tx.$executeRaw`
      INSERT INTO "OrderItemSelloIva" ("id", "orderItemId", "cfdiId", "intento")
      VALUES (${cuid()}, ${r.orderItemId}, ${p.cfdiId}, ${p.intento})
      ON CONFLICT ("orderItemId", "cfdiId") DO NOTHING
    `
  }
}

export async function liberarSellosDe(tx: Tx, cfdiId: string): Promise<{ liberados: number }> {
  // Procesa todos los sellos de UN CFDI sin cargar los sellos de sus sustitutas.
  const filas = await tx.$queryRaw<Array<{ orderItemId: string }>>`
    DELETE FROM "OrderItemSelloIva" WHERE "cfdiId" = ${cfdiId}
    RETURNING "orderItemId"
  `
  if (filas.length === 0) return { liberados: 0 }

  await tx.$executeRaw`
    UPDATE "OrderItem" AS item SET "ivaTratamiento" = NULL
    WHERE item.id = ANY(${filas.map(f => f.orderItemId)}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM "OrderItemSelloIva" AS sello WHERE sello."orderItemId" = item.id
      )
  `
  return { liberados: filas.length }
}

export async function renglonesSellados(
  tx: Tx,
  orderId: string,
): Promise<Array<{ orderItemId: string; tratamiento: IvaTratamiento | null; cfdis: number }>> {
  // El contrato devuelve la orden completa; agrega sus sellos en Postgres, sin hidratarlos.
  return tx.$queryRaw<Array<{ orderItemId: string; tratamiento: IvaTratamiento | null; cfdis: number }>>`
    SELECT item.id AS "orderItemId", item."ivaTratamiento" AS tratamiento,
      COUNT(sello.id)::int AS cfdis
    FROM "OrderItem" AS item
    LEFT JOIN "OrderItemSelloIva" AS sello ON sello."orderItemId" = item.id
    WHERE item."orderId" = ${orderId}
    GROUP BY item.id
    ORDER BY item.id ASC
  `
}
