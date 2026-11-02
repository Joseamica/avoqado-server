/**
 * Las dos preguntas que se le hacen a un renglón de cuenta sobre vales por área (v7), en un solo lugar.
 *
 * 🔴 D1 (21-oct-2026, tablero hz:11d84b54:D1): el vale de una venta CANCELADA se puede volver a cobrar en otra cuenta. El renglón de la
 * cuenta cancelada se queda ahí (producto, IVA, peso, asignaciones) con la procedencia en `releasedAreaTicketLineId` y suelta el vínculo
 * único `areaTicketLineId`, que toma el renglón de la cuenta nueva (`materializeAreaTicketCheckout`). Si a la cancelada le llega dinero
 * ya capturado, R12-1 la reabre: ese renglón sigue siendo DE VALE para clasificar la cuenta, pero su vale ya es de otra, así que aquí
 * nunca se descuenta ni se cocina (Codex r1 #1 y r2 #1 de `docs/audit/2026-10-21-vale-cancelado-recobrable/`).
 */
type Renglon = { areaTicketLineId?: string | null; releasedAreaTicketLineId?: string | null }

/** El renglón es o fue de un vale: la cuenta es una cuenta con vales (llave obligatoria, saldo, no se separa ni se junta). */
export function esRenglonDeVale(renglon: Renglon): boolean {
  return renglon.areaTicketLineId != null || renglon.releasedAreaTicketLineId != null
}

/** El vale de este renglón ya se cobró en otra cuenta: aquí no se descuenta inventario ni se manda a cocina. */
export function esValeRevendido(renglon: Renglon): boolean {
  return renglon.areaTicketLineId == null && renglon.releasedAreaTicketLineId != null
}
