import type { Prisma, PrismaClient } from '@prisma/client'
import { instanteUtcSql, seAcaboElDiaDelNegocioDeSql } from '../shared/pagadaPeroAbierta'

/**
 * D17 (founder, 20-nov-2026; Flautas): lo viejo de la pantalla de cocina se ARCHIVA al cerrar el día. Una comanda deja el tablero
 * sola cuando (a) su día del negocio ya terminó —el de la caja, corte de las 04:00 en la zona del negocio, la MISMA regla «B» del
 * 22-oct que cierra los pedidos de plataforma— y (b) su cuenta ya se cerró (cobrada o anulada) y ningún platillo suyo pertenece hoy
 * a una cuenta abierta (dividir la mesa mueve el renglón a otra cuenta y deja la comanda ligada a la primera — Codex r1 #2).
 *
 * Archivar NO cambia el estado ni los productos (Codex r1 #1 y #3): sólo pone `archivedAt`. La caja sigue viendo en «Servicio y
 * entregas» lo que falte entregar, el aviso de «listo» a las plataformas no la toma (no cambia `status` ni `updatedAt`: es SQL
 * crudo) y los reportes de tiempos no cambian (`completedAt` no se toca). El tablero y «Recientes» la ignoran.
 */

export const ARCHIVO_LOTE = 500

const CUENTA_CERRADA = `('COMPLETED', 'CANCELLED', 'DELETED')`

/** Las condiciones, UNA vez: las usan la lectura (con reintento) y el UPDATE (que las vuelve a medir sobre la fila bloqueada). */
function condiciones(ahora: Date): string {
  // El reloj de pared UTC como literal (`TIMESTAMP '…'`), igual que el barrido de pedidos de plataforma: nunca un Date ligado.
  const nowSql = instanteUtcSql(ahora)
  // Ninguna comanda de las últimas 4 h puede ser de un día ya terminado con el corte de las 04:00: recorta el índice barato.
  return `k."archivedAt" IS NULL
      AND k.status IN ('NEW', 'PREPARING', 'READY')
      AND k."createdAt" < ${nowSql} - INTERVAL '4 hours'
      AND o.status IN ${CUENTA_CERRADA}
      AND NOT EXISTS (
        SELECT 1 FROM "KdsOrderItem" ki
        JOIN "OrderItem" oi ON oi.id = ki."orderItemId"
        JOIN "Order" o2 ON o2.id = oi."orderId"
        WHERE ki."kdsOrderId" = k.id AND o2.status NOT IN ${CUENTA_CERRADA}
      )
      AND ${seAcaboElDiaDelNegocioDeSql('k."createdAt"', 'k."venueId"', nowSql)}`
}

function lote(limite: number): number {
  if (!Number.isSafeInteger(limite) || limite < 1 || limite > ARCHIVO_LOTE)
    throw new Error(`archivo de comandas: lote inválido (${limite})`)
  return limite
}

/** Lectura pura (se puede reintentar): las candidatas más viejas primero. */
export async function comandasPorArchivar(
  db: Pick<PrismaClient, '$queryRawUnsafe'>,
  ahora: Date,
  limite = ARCHIVO_LOTE,
): Promise<Array<{ id: string; venueId: string }>> {
  return db.$queryRawUnsafe<Array<{ id: string; venueId: string }>>(
    `SELECT k.id, k."venueId"
       FROM "KdsOrder" k
       JOIN "Order" o ON o.id = k."orderId" AND o."venueId" = k."venueId"
      WHERE ${condiciones(ahora)}
      ORDER BY k."createdAt", k.id
      LIMIT ${lote(limite)}`,
  )
}

export interface ComandaArchivada {
  id: string
  venueId: string
  orderNumber: string
  status: string
}

/**
 * Archiva SÓLO las ids leídas que todavía cumplen todo (alguien pudo reabrir la cuenta o regresar el platillo entre la lectura y
 * esto), y deja UN renglón de bitácora por negocio con las comandas que archivó. Todo en una transacción: no hay archivo sin
 * rastro. Repetirlo no hace nada (`archivedAt IS NULL`).
 */
export async function archivarComandas(tx: Prisma.TransactionClient, ids: string[], ahora: Date): Promise<ComandaArchivada[]> {
  if (ids.length === 0) return []
  if (ids.length > ARCHIVO_LOTE) throw new Error('archivo de comandas: demasiadas a la vez')
  const lista = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')
  const nowSql = instanteUtcSql(ahora)
  const archivadas = await tx.$queryRawUnsafe<ComandaArchivada[]>(
    `UPDATE "KdsOrder" k SET "archivedAt" = ${nowSql}
       FROM "Order" o
      WHERE k.id IN (${lista})
        AND o.id = k."orderId" AND o."venueId" = k."venueId"
        AND ${condiciones(ahora)}
      RETURNING k.id, k."venueId", k."orderNumber", k.status::text AS status`,
  )
  const porNegocio = new Map<string, ComandaArchivada[]>()
  for (const a of archivadas) porNegocio.set(a.venueId, [...(porNegocio.get(a.venueId) ?? []), a])
  if (porNegocio.size > 0) {
    await tx.activityLog.createMany({
      data: [...porNegocio].map(([venueId, suyas]) => ({
        venueId,
        staffId: null,
        action: 'KDS_ORDERS_ARCHIVED',
        entity: 'KdsOrder',
        entityId: venueId,
        data: {
          motivo: 'Terminó su día del negocio y su cuenta ya se cerró',
          total: suyas.length,
          comandas: suyas.map(s => ({ id: s.id, orderNumber: s.orderNumber, status: s.status })),
        },
      })),
    })
  }
  return archivadas
}
