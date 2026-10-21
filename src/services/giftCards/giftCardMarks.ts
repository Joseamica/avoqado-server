/**
 * Las dos MARCAS con que el resto de la plataforma se entera de las tarjetas de regalo (índice del plan 1a):
 *
 * - **Cuenta de tarjetas** (R11): una `Order` con al menos un `OrderItem.giftCardId` y ninguno sin él. El servidor no deja mezclar
 *   (A5), así que en los reportes basta «tiene un renglón con `giftCardId`»; `leerSiEsCuentaDeTarjetas` comprueba las dos mitades
 *   porque decide dinero (reembolsos, lealtad, comisiones).
 * - **Cobro con saldo** (R4): un `Payment` cuyo tender tiene `systemKind = GIFT_CARD`. Nunca por `method`: `OTHER` también es de
 *   los vales y de los tipos que crea el negocio.
 *
 * 🔴 Una sola definición. Factura, contabilidad, ventas, turno, lealtad, comisiones y la revisión nocturna importan de aquí; una
 * copia local de la regla es cómo nacen dos cifras distintas del mismo dinero.
 */
import { PaymentStatus, Prisma, PrismaClient, TenderSystemKind } from '@prisma/client'

/** ¿La orden es una cuenta de tarjetas? Una consulta para toda venta normal; la segunda sólo si ya apareció una tarjeta. */
export async function leerSiEsCuentaDeTarjetas(db: Prisma.TransactionClient | PrismaClient, orderId: string): Promise<boolean> {
  const conTarjeta = await db.orderItem.findFirst({ where: { orderId, giftCardId: { not: null } }, select: { id: true } })
  if (!conTarjeta) return false
  const sinTarjeta = await db.orderItem.findFirst({ where: { orderId, giftCardId: null }, select: { id: true } })
  return !sinTarjeta
}

/** El renglón que hace de una orden una cuenta de tarjetas. La única definición: las marcas de abajo y el reclamo del turno la usan. */
export const WHERE_RENGLON_DE_TARJETA = { giftCardId: { not: null } } satisfies Prisma.OrderItemWhereInput

export const WHERE_ORDEN_DE_TARJETAS = { items: { some: WHERE_RENGLON_DE_TARJETA } } satisfies Prisma.OrderWhereInput

/**
 * La marca R11 COMPLETA dentro de un `select` de `Order` (⭐ B6 M2 del cierre): un renglón con tarjeta (`take: 1`) y cuántos hay SIN
 * ella. Una sola lectura, sin consulta nueva, para quien decide dinero o premios sobre la orden que ya está leyendo. Se lee con
 * `esCuentaDeTarjetasSeleccionada`.
 */
export const SELECT_MARCA_DE_CUENTA_DE_TARJETAS = {
  items: { where: WHERE_RENGLON_DE_TARJETA, select: { id: true }, take: 1 },
  _count: { select: { items: { where: { giftCardId: null } } } },
} satisfies Prisma.OrderSelect

/** El gemelo en memoria de `leerSiEsCuentaDeTarjetas` sobre `SELECT_MARCA_DE_CUENTA_DE_TARJETAS`. Sin `_count`, la media regla. */
export function esCuentaDeTarjetasSeleccionada(
  orden: { items?: ReadonlyArray<unknown> | null; _count?: { items?: number | null } | null } | null | undefined,
): boolean {
  return (orden?.items?.length ?? 0) > 0 && (orden?._count?.items ?? 0) === 0
}

export const WHERE_ORDEN_SIN_TARJETAS = { items: { none: WHERE_RENGLON_DE_TARJETA } } satisfies Prisma.OrderWhereInput

/**
 * R3 (turnos): la marca para el `select` de la orden de un cobro. Un renglón con `giftCardId` basta para saber que la cuenta es de
 * tarjetas (no se mezclan, A5). Todo `select` que alimente `aggregateShiftPayments` (también el script de reatribución) y el detalle
 * del turno del panel traen la MISMA marca.
 */
export const ORDEN_DE_TARJETAS_SELECT = { items: { where: WHERE_RENGLON_DE_TARJETA, select: { id: true }, take: 1 } } as const

/**
 * Cuenta de tarjetas PAGADA: la única que «carga» tarjetas. Un abono a una venta que no se termina de pagar no carga nada (sus sobres
 * siguen PENDING, en $0); los reportes de «tarjetas cargadas» usan esta población (B5 r1, M-1).
 */
export const WHERE_CUENTA_DE_TARJETAS_PAGADA = {
  AND: [WHERE_ORDEN_DE_TARJETAS, { paymentStatus: PaymentStatus.PAID }],
} satisfies Prisma.OrderWhereInput

export const WHERE_COBRO_ES_SALDO_DE_REGALO = {
  tenderType: { is: { systemKind: TenderSystemKind.GIFT_CARD } },
} satisfies Prisma.PaymentWhereInput

/**
 * 🔴 NULL-safe a propósito: `NOT: { tenderType: { is: … } }` sobre una relación opcional puede descartar las filas SIN tender (el
 * efectivo clásico) por la semántica de `NOT IN` con NULL. Así, sin tender o con un tender que no es de sistema, el cobro cuenta.
 */
export const WHERE_COBRO_NO_ES_SALDO_DE_REGALO = {
  OR: [{ tenderTypeId: null }, { tenderType: { is: { systemKind: null } } }],
} satisfies Prisma.PaymentWhereInput

/** Lo que el autoposteo NO postea y el reporte del contador lista como «pendiente de revisión contable» (spec §7). */
export const WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE = {
  OR: [WHERE_COBRO_ES_SALDO_DE_REGALO, { order: WHERE_ORDEN_DE_TARJETAS }],
} satisfies Prisma.PaymentWhereInput

/** Columnas de «id de orden» admitidas en SQL crudo. Lista cerrada: nunca texto que venga de fuera. */
export type ColumnaDeOrden = '"Order".id' | 'o.id' | 'p."orderId"' | '"Payment"."orderId"'

export function sqlOrdenSinTarjetasTexto(columna: ColumnaDeOrden): string {
  return `NOT EXISTS (SELECT 1 FROM "OrderItem" gc_oi WHERE gc_oi."orderId" = ${columna} AND gc_oi."giftCardId" IS NOT NULL)`
}

export function sqlOrdenSinTarjetas(columna: ColumnaDeOrden): Prisma.Sql {
  return Prisma.raw(sqlOrdenSinTarjetasTexto(columna))
}

/** El gemelo en SQL de `leerSiEsCuentaDeTarjetas` (R11 completa: al menos un renglón con tarjeta y ninguno sin ella). */
export function sqlOrdenEsCuentaDeTarjetas(columna: ColumnaDeOrden): Prisma.Sql {
  return Prisma.raw(
    `(EXISTS (SELECT 1 FROM "OrderItem" gc_oi WHERE gc_oi."orderId" = ${columna} AND gc_oi."giftCardId" IS NOT NULL)` +
      ` AND NOT EXISTS (SELECT 1 FROM "OrderItem" gc_ni WHERE gc_ni."orderId" = ${columna} AND gc_ni."giftCardId" IS NULL))`,
  )
}

export function sqlCobroNoEsSaldoDeRegaloTexto(alias: 'p'): string {
  return `NOT EXISTS (SELECT 1 FROM "VenueTenderType" gc_t WHERE gc_t."venueId" = ${alias}."venueId" AND gc_t.id = ${alias}."tenderTypeId" AND gc_t."systemKind" = 'GIFT_CARD')`
}

export function sqlCobroNoEsSaldoDeRegalo(alias: 'p'): Prisma.Sql {
  return Prisma.raw(sqlCobroNoEsSaldoDeRegaloTexto(alias))
}
