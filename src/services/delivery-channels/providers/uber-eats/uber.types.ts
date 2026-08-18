/**
 * Contrato interno del pedido de Uber, ya normalizado (spec paso 5→7).
 *
 * Separar esto del formato crudo de Uber es lo que permite construir y probar la
 * ingesta SIN tener fixtures del proveedor: el mapper (que sí los necesita) solo
 * traduce a esta forma.
 *
 * 🔴 Todo el dinero viaja como STRING DECIMAL, nunca `number` — regla del repo
 * (`critical-warnings.md`: Money = Decimal, Never Float). El ÷100 de los centavos
 * de Uber ocurre en el mapper, jamás aquí ni en el core.
 */
export interface NormalizedUberModifier {
  /** id del modificador en el menú de Uber (los modificadores son items: `type: ITEM`) */
  externalId: string
  name: string
  quantity: number
  /** precio unitario en PESOS, string decimal. Ya multiplicado por la cantidad del padre si aplica. */
  price: string
}

export interface NormalizedUberItem {
  /** `id` del item en el menú de Uber */
  externalId: string
  /** `external_data` del item: lo que Avoqado escribió al publicar (su `Product.sku`) */
  externalData?: string | null
  name: string
  quantity: number
  /** precio unitario en PESOS, string decimal */
  unitPrice: string
  /** total de la línea en PESOS (unitPrice × quantity + modificadores) */
  total: string
  modifiers?: NormalizedUberModifier[]
}

/**
 * Split explícito de quién cobra qué. Lo entrega el MAPPER; el core NO deduce nada.
 * Invariantes que el mapper garantiza y la ingesta verifica:
 *   saleAmount + merchantFees === externallyPaidSale + cashDueSale
 *   tipAmount                 === externallyPaidTip  + cashDueTip
 */
export interface NormalizedUberPayment {
  currency: 'MXN'
  /** artículos, IVA incluido (México) */
  saleAmount: string
  /** cargos cobrados al cliente que se pagan AL COMERCIO (bolsa, envío propio…) */
  merchantFees: string
  tipAmount: string
  /** parte de (saleAmount + merchantFees) que la plataforma liquida al comercio */
  externallyPaidSale: string
  externallyPaidTip: string
  /** parte que el comercio cobra en efectivo en persona */
  cashDueSale: string
  cashDueTip: string
}

export interface NormalizedUberOrder {
  /** `id` del pedido en Uber. Se namespacea al guardarlo: `UBER_EATS:{externalId}` */
  externalId: string
  /** `display_id` de Uber (5 chars) — es lo que ve el repartidor y va en el ticket */
  displayId: string
  items: NormalizedUberItem[]
  payment: NormalizedUberPayment
  /** JSON crudo del proveedor, para auditoría */
  raw: unknown
}
