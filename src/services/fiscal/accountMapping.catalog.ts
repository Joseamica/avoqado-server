/**
 * Configuración contable — defaults "tipo de movimiento → cuenta del catálogo".
 *
 * Es el mapa que hace que el motor de pólizas "dicte" los asientos sin que un humano
 * escoja cuenta cada vez. Verificado por workflow multi-agente (account-mapping-defaults,
 * 2026-06-16): 3 contadores proponen → reconcilian → verificación adversaria por mapeo →
 * crítico de completitud (que cazó TIPS_PAYABLE, un gap que rompía el balance de las
 * pólizas de pago con propina). Cada `defaultCode` existe en el catálogo base (BASE_CHART).
 *
 * `side` es informativo (lado típico del asiento); el IVA y las retenciones se configuran
 * en la sección de Impuestos (IVA/DIOT), APARTE — por eso no aparecen aquí.
 */

export type MovementSide = 'DEBIT' | 'CREDIT' | 'BOTH'
export type MovementGroup = 'INGRESOS' | 'TESORERIA' | 'CARTERA' | 'INVENTARIO' | 'COSTOS_GASTOS' | 'RESULTADO'

export interface MovementTypeDef {
  /** Coincide con el enum Prisma AccountMovementType. */
  movementType: string
  label: string
  /** Código SAT (cuenta afectable del catálogo) al que postea por defecto. */
  defaultCode: string
  side: MovementSide
  group: MovementGroup
}

/** Los 16 movimientos OPERATIVOS (no IVA/retenciones). El orden define el orden en la UI. */
export const MOVEMENT_TYPES: MovementTypeDef[] = [
  // Ingresos
  { movementType: 'SALES_REVENUE', label: 'Ingreso por ventas / servicios', defaultCode: '401.01', side: 'CREDIT', group: 'INGRESOS' },
  {
    movementType: 'SALES_RETURN',
    label: 'Devoluciones / reembolsos sobre ventas',
    defaultCode: '402.01',
    side: 'DEBIT',
    group: 'INGRESOS',
  },
  { movementType: 'IVA_OUTPUT', label: 'IVA trasladado cobrado (de ventas)', defaultCode: '208.01', side: 'CREDIT', group: 'INGRESOS' },
  // Tesorería
  { movementType: 'CASH_RECEIPT', label: 'Cobro en efectivo (caja)', defaultCode: '101.01', side: 'BOTH', group: 'TESORERIA' },
  { movementType: 'BANK_RECEIPT', label: 'Cobro electrónico / depósito en banco', defaultCode: '102.01', side: 'BOTH', group: 'TESORERIA' },
  { movementType: 'PETTY_CASH', label: 'Caja chica (fondo fijo)', defaultCode: '101.02', side: 'DEBIT', group: 'TESORERIA' },
  { movementType: 'TIPS_PAYABLE', label: 'Propinas por pagar al personal', defaultCode: '205.06', side: 'CREDIT', group: 'TESORERIA' },
  // Cartera
  { movementType: 'ACCOUNTS_RECEIVABLE', label: 'Clientes / cuentas por cobrar', defaultCode: '105.01', side: 'BOTH', group: 'CARTERA' },
  { movementType: 'ACCOUNTS_PAYABLE', label: 'Proveedores / cuentas por pagar', defaultCode: '201.01', side: 'BOTH', group: 'CARTERA' },
  // Inventario
  { movementType: 'INVENTORY', label: 'Inventario (mercancías)', defaultCode: '115.01', side: 'BOTH', group: 'INVENTARIO' },
  {
    movementType: 'INVENTORY_ADJUSTMENT',
    label: 'Ajuste de inventario (merma / sobrante)',
    defaultCode: '115.01',
    side: 'BOTH',
    group: 'INVENTARIO',
  },
  // Costos y gastos
  { movementType: 'COST_OF_GOODS_SOLD', label: 'Costo de venta (COGS)', defaultCode: '501.01', side: 'DEBIT', group: 'COSTOS_GASTOS' },
  {
    movementType: 'PROCESSOR_FEE',
    label: 'Comisión del procesador de pagos',
    defaultCode: '701.10',
    side: 'DEBIT',
    group: 'COSTOS_GASTOS',
  },
  {
    movementType: 'ROUNDING_DIFFERENCE',
    label: 'Diferencia de redondeo / centavos',
    defaultCode: '703',
    side: 'BOTH',
    group: 'COSTOS_GASTOS',
  },
  // Resultado / patrimonio
  {
    movementType: 'NET_INCOME_PROFIT',
    label: 'Utilidad del ejercicio (cierre)',
    defaultCode: '305.01',
    side: 'CREDIT',
    group: 'RESULTADO',
  },
  { movementType: 'NET_INCOME_LOSS', label: 'Pérdida del ejercicio (cierre)', defaultCode: '305.02', side: 'DEBIT', group: 'RESULTADO' },
  {
    movementType: 'RETAINED_EARNINGS',
    label: 'Resultados acumulados (ejercicios anteriores)',
    defaultCode: '304.01',
    side: 'BOTH',
    group: 'RESULTADO',
  },
]

/** Los valores válidos del enum (para validación). */
export const MOVEMENT_TYPE_CODES = MOVEMENT_TYPES.map(m => m.movementType)
