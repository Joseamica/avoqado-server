// src/services/shared/beneficiarioDeLaVenta.ts
/**
 * La ÚNICA regla de quién es la clienta de una venta para su lealtad: el PRIMARIO de sus ligas (`OrderCustomer.isPrimary`, lo que
 * escribe la TPV o el POS al ligar) y, sin primario, el heredado (`Order.customerId`). La usan el otorgamiento
 * (`awardLoyaltyForPaidOrder`), la recuperación (`fotoDelBeneficiario`) y lo que la tienda híbrida muestra de la cuenta (S14, Codex
 * r1 #1): ninguna pantalla dice una dueña distinta de la que recibió el sello. Genérica: sirve con el id o con la ficha ya leída.
 */
export function beneficiarioDeLaVenta<T>(primario: T | null | undefined, heredado: T | null | undefined): T | null {
  return primario ?? heredado ?? null
}
