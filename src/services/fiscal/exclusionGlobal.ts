import { Prisma } from '@prisma/client'

/** Una respuesta incierta sigue ocupando la venta, aunque el barrido la marque STAMP_FAILED. */
export const CFDI_VIVO: Prisma.CfdiWhereInput = {
  AND: [
    { status: { not: 'VALIDATION_FAILED' } },
    { OR: [{ status: { not: 'STAMP_FAILED' } }, { falloDefinitivo: false }] },
    { OR: [{ status: { not: 'CANCELLED' } }, { cancelStatus: null }, { cancelStatus: { notIn: ['ACCEPTED', 'CANCELLED'] } }] },
  ],
}

/**
 * C3 (Codex C3-10): `CFDI_VIVO` para SQL crudo —el mismo predicado; `tests/integration/fiscal/cfdiVivoSql.test.ts` compara los dos en cada
 * estado—. `alias` es el alias de la tabla `"Cfdi"` en la consulta (código, nunca entrada del usuario).
 */
export const cfdiVivoSql = (alias: string) => {
  const a = Prisma.raw(`"${alias}"`)
  return Prisma.sql`${a}.status::text <> 'VALIDATION_FAILED'
    AND (${a}.status::text <> 'STAMP_FAILED' OR ${a}."falloDefinitivo" = false)
    AND (${a}.status::text <> 'CANCELLED' OR ${a}."cancelStatus" IS NULL OR ${a}."cancelStatus"::text NOT IN ('ACCEPTED', 'CANCELLED'))`
}

/** C1 (Codex C3-15): la llave de toda nota de extracción (C3) empieza así; C3 la importa de aquí. */
export const PREFIJO_EXTRACCION = 'cfdi-extraccion-'
/**
 * C3 (C3-P9 = B, Codex C3-19): la llave de LA nota de extracción de un ticket de una global: una sola por (global, ticket), sin generaciones.
 * Vive aquí, junto al prefijo, porque la usan el lector de la nota (`cfdiCreditNote.service.ts`) y la extracción sin importarse entre sí.
 */
export const llaveDeExtraccion = (globalCfdiId: string, orderId: string) => `${PREFIJO_EXTRACCION}${globalCfdiId}-${orderId}`
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

/**
 * C3 (D6): la global VIVA cuyo manifiesto tiene la venta (la más reciente). La admisión de la factura individual la lee con la orden bloqueada
 * (ahí DECIDE: un ticket en una global viva sólo se factura aparte con su extracción timbrada); el GET público de la autofactura, sin candado.
 * Sustituye a la regla «primero cancela la global» (C2-pulido · G2).
 */
export const globalVivaDeLaOrden = (db: Pick<Prisma.TransactionClient, 'cfdi'>, orderId: string) =>
  db.cfdi.findFirst({
    where: { isGlobal: true, manifiestoGlobal: { some: { orderId } }, ...CFDI_VIVO },
    orderBy: { createdAt: 'desc' },
    select: { id: true, uuid: true, venueId: true, fiscalEmisorId: true, status: true, cancelStatus: true, serie: true, folio: true },
  })
export type GlobalVivaDeLaOrden = NonNullable<Awaited<ReturnType<typeof globalVivaDeLaOrden>>>
