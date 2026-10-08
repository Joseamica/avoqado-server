import type { Prisma } from '@prisma/client'

/** Una respuesta incierta sigue ocupando la venta, aunque el barrido la marque STAMP_FAILED. */
export const CFDI_VIVO: Prisma.CfdiWhereInput = {
  AND: [
    { status: { not: 'VALIDATION_FAILED' } },
    { OR: [{ status: { not: 'STAMP_FAILED' } }, { falloDefinitivo: false }] },
    { OR: [{ status: { not: 'CANCELLED' } }, { cancelStatus: null }, { cancelStatus: { notIn: ['ACCEPTED', 'CANCELLED'] } }] },
  ],
}

/** C1 (Codex C3-15): la llave de toda nota de extracción (C3) empieza así; C3 la importa de aquí. */
export const PREFIJO_EXTRACCION = 'cfdi-extraccion-'
const SUFIJO_COMPLEMENTARIA = /^(.+)-c([1-9]\d*)$/

/**
 * C1 (Tarea 11, C1-P7): la llave de una global COMPLEMENTARIA es la de su principal más `-c<n>` (n = 2, 3, …). Una llave principal nunca termina
 * así (termina en la periodicidad del SAT o en el día `AAAAMMDD`). Vive aquí, junto a la otra convención de llaves, porque la usan el motor de la
 * global y la lista de facturas (`cfdi.service.ts`, que no puede importar del motor).
 */
export function esLlaveComplementaria(llave: unknown): boolean {
  return typeof llave === 'string' && SUFIJO_COMPLEMENTARIA.test(llave)
}
/** La llave de la principal de una complementaria (`<llave>-c<n>` ⇒ `<llave>`), o null si no es de complementaria. */
export function llavePrincipalDe(llave: string): string | null {
  return SUFIJO_COMPLEMENTARIA.exec(llave)?.[1] ?? null
}

/**
 * Una extracción que se timbró y luego se canceló. La cancelada SIN confirmar ya es `CFDI_VIVO`, así que `CFDI_VIVO` ∪ esto equivale a
 * «viva o cancelada confirmada» (el mismo criterio de `extraccionDeLaOrden` en C3).
 */
export const EXTRACCION_CANCELADA: Prisma.CfdiWhereInput = { status: 'CANCELLED' }

/**
 * C1 (v8, Codex C1-45): una venta que ALGUNA vez tuvo una extracción timbrada —viva o ya cancelada— no vuelve sola a ninguna global
 * (ni a una complementaria): se detiene y se avisa («pídelo a soporte»). `CFDI_VIVO` no cambia; sólo esto crece. Una extracción que nunca
 * se timbró (`VALIDATION_FAILED`, o `STAMP_FAILED` definitivo) no cuenta: no documentó ningún ingreso.
 */
export const EXTRAIDO: Prisma.OrderWhereInput = {
  cfdis: { some: { type: 'EGRESO', idempotencyKey: { startsWith: PREFIJO_EXTRACCION }, OR: [CFDI_VIVO, EXTRACCION_CANCELADA] } },
}

/** El llamador tiene bloqueada la orden antes de consultar su pertenencia. */
export async function excluirSiEstaEnGlobal(tx: Prisma.TransactionClient, orderId: string): Promise<string | null> {
  const cfdi = await tx.cfdi.findFirst({
    where: { isGlobal: true, manifiestoGlobal: { some: { orderId } }, ...CFDI_VIVO },
    select: { serie: true, folio: true, globalPeriod: true },
  })
  if (!cfdi) return null
  const period = cfdi.globalPeriod as { meses?: string; anio?: number } | null
  const label =
    [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || [period?.meses, period?.anio].filter(Boolean).join('/') || 'del periodo'
  return `Esta venta ya está incluida en la factura global ${label}; para facturarla aparte primero hay que cancelar esa global.`
}
