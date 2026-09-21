// Catálogo único de motivos de merma. Los códigos son los mismos 20 que usa el
// dashboard (avoqado-web-dashboard/src/lib/inventory-constants.ts) más UNSPECIFIED,
// y se guardan tal cual en la base: son estables, no se renombran.
// `pos` marca los que se ofrecen como chip en el mostrador.
export const WASTE_REASON_CODES = [
  'EXPIRED',
  'SPOILED',
  'CONTAMINATED',
  'DEFECTIVE',
  'OVERPRODUCTION',
  'PREP_ERROR',
  'BURNT',
  'UNDERCOOKED',
  'DROPPED',
  'CUSTOMER_RETURN',
  'WRONG_ORDER',
  'CUSTOMER_CHANGE',
  'TESTING',
  'STAFF_MEAL',
  'PROMOTION',
  'DONATION',
  'THEFT',
  'MISSING',
  'PEST_DAMAGE',
  'OTHER',
  'UNSPECIFIED',
] as const

export type WasteReasonCode = (typeof WASTE_REASON_CODES)[number]
export type WasteReasonCategory = 'quality' | 'operational' | 'customer' | 'intentional' | 'loss' | 'other'

export interface WasteReason {
  category: WasteReasonCategory
  label: string
  pos: boolean
}

export const WASTE_REASONS: Record<WasteReasonCode, WasteReason> = {
  EXPIRED: { category: 'quality', label: 'Caducó', pos: true },
  SPOILED: { category: 'quality', label: 'Se echó a perder', pos: true },
  CONTAMINATED: { category: 'quality', label: 'Contaminado', pos: false },
  DEFECTIVE: { category: 'quality', label: 'Dañado / roto', pos: true },

  OVERPRODUCTION: { category: 'operational', label: 'Sobreproducción', pos: false },
  PREP_ERROR: { category: 'operational', label: 'Error de preparación', pos: true },
  BURNT: { category: 'operational', label: 'Quemado / sobrecocido', pos: false },
  UNDERCOOKED: { category: 'operational', label: 'Cocción insuficiente', pos: false },
  DROPPED: { category: 'operational', label: 'Se cayó / derramó', pos: true },

  CUSTOMER_RETURN: { category: 'customer', label: 'Devolución del cliente', pos: false },
  WRONG_ORDER: { category: 'customer', label: 'Pedido incorrecto', pos: false },
  CUSTOMER_CHANGE: { category: 'customer', label: 'Cambio de opinión del cliente', pos: false },

  TESTING: { category: 'intentional', label: 'Pruebas / muestras', pos: false },
  STAFF_MEAL: { category: 'intentional', label: 'Consumo del personal', pos: false },
  PROMOTION: { category: 'intentional', label: 'Promoción / cortesía', pos: false },
  DONATION: { category: 'intentional', label: 'Donación', pos: false },

  // En el mostrador un solo chip «Robo o faltante» cubre los dos casos y guarda
  // MISSING. THEFT no se ofrece en el POS.
  THEFT: { category: 'loss', label: 'Robo', pos: false },
  MISSING: { category: 'loss', label: 'Robo o faltante', pos: true },
  PEST_DAMAGE: { category: 'loss', label: 'Daño por plagas', pos: false },

  OTHER: { category: 'other', label: 'Otro', pos: true },
  // Sólo lo usa el adaptador del dashboard para registros sin motivo; nunca se ofrece.
  UNSPECIFIED: { category: 'other', label: 'Sin especificar', pos: false },
}

// hasOwnProperty y no `in`: 'toString' o '__proto__' no son motivos válidos.
export function isWasteReasonCode(value: string): value is WasteReasonCode {
  return Object.prototype.hasOwnProperty.call(WASTE_REASONS, value)
}
