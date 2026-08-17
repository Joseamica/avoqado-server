// src/services/fiscal/satCatalog.ts
import { PaymentMethod, VenueType } from '@prisma/client'

/** Avoqado PaymentMethod → SAT c_FormaPago. 99 = "Por definir" (caller flags for review). */
const FORMA_PAGO: Record<PaymentMethod, string> = {
  CASH: '01',
  CREDIT_CARD: '04',
  DEBIT_CARD: '28',
  BANK_TRANSFER: '03',
  DIGITAL_WALLET: '99', // monedero(05) vs wallet(04/06) — disambiguation deferred (spec §10)
  CRYPTOCURRENCY: '99',
  OTHER: '99',
}
/**
 * 🔴 `tenderSatFormaPago` es la forma SAT que el NEGOCIO declaró al dar de alta su tipo de
 * pago ("Vale de despensa = 05"), congelada en el cobro. Gana sobre el mapa por método, y
 * por una razón concreta: un cobro con un tipo del catálogo se guarda con `method = OTHER`,
 * que mapea a **'99' (por definir)** — así que sin este override, un negocio que YA había
 * declarado la forma correcta veía sus facturas salir con "por definir" mientras el dato
 * correcto estaba en la base.
 *
 * Un snapshot '99' NO se aplica: es justo lo que hay que evitar, así que se cae al método.
 */
export function mapFormaPago(method: PaymentMethod, tenderSatFormaPago?: string | null): string {
  const declarada = tenderSatFormaPago?.trim()
  if (declarada && declarada !== '99') return declarada
  return FORMA_PAGO[method] ?? '99'
}
export function isFormaPagoAmbiguous(method: PaymentMethod, tenderSatFormaPago?: string | null): boolean {
  return mapFormaPago(method, tenderSatFormaPago) === '99'
}

/** Per-sector fallback SAT keys (last resort when product + category have none). */
const SECTOR_DEFAULTS: Partial<Record<VenueType, { productKey: string; unitKey: string }>> = {
  RESTAURANT: { productKey: '90101500', unitKey: 'E48' }, // Servicio de restaurante / unidad de servicio
  RETAIL_STORE: { productKey: '01010101', unitKey: 'H87' }, // genérico / pieza
}
const GENERIC_DEFAULT = { productKey: '01010101', unitKey: 'H87' }
export function sectorSatDefaults(venueType: VenueType): { productKey: string; unitKey: string } {
  return SECTOR_DEFAULTS[venueType] ?? GENERIC_DEFAULT
}

/** Shape check only (numeric, 3 digits). Full c_RegimenFiscal validity is the PAC's job at stamp time. */
export function isValidRegimen(code: string): boolean {
  return /^\d{3}$/.test(code)
}
