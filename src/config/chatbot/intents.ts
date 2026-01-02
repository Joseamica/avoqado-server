/**
 * Chatbot Intent Definitions
 *
 * Maps natural language patterns to query intents and shared query methods.
 * Supports both Spanish and English keywords.
 */

import type { IntentDefinition } from './types'

const DEFAULT_INTENTS: IntentDefinition[] = [
  // ============================================
  // SALES & REVENUE
  // ============================================
  {
    name: 'sales',
    description: 'Total sales/revenue queries',
    keywords: {
      es: ['vendi', 'ventas', 'venta', 'vendido', 'ingresos', 'facturado', 'facturacion', 'revenue'],
      en: ['revenue', 'sales', 'sold', 'earnings', 'income'],
    },
    tables: ['Order', 'Payment'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getSalesForPeriod',
    priority: 10,
  },
  {
    name: 'averageTicket',
    description: 'Average order value queries',
    keywords: {
      es: ['ticket promedio', 'promedio orden', 'ticket medio', 'valor promedio', 'cheque promedio'],
      en: ['average ticket', 'avg ticket', 'average order', 'avg order value'],
    },
    tables: ['Order'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getSalesForPeriod',
    priority: 8,
  },
  {
    name: 'salesTimeSeries',
    description: 'Sales over time (daily/weekly/monthly)',
    keywords: {
      es: ['ventas por dia', 'ventas por semana', 'tendencia', 'historico', 'evolucion', 'ventas diarias'],
      en: ['sales by day', 'sales trend', 'daily sales', 'sales history', 'sales over time'],
    },
    tables: ['Order'],
    requiresDateRange: true,
    defaultDateRange: 'lastMonth',
    sharedQueryMethod: 'getSalesTimeSeries',
    priority: 7,
  },

  // ============================================
  // STAFF PERFORMANCE
  // ============================================
  {
    name: 'staffPerformance',
    description: 'Staff/waiter performance and sales queries',
    keywords: {
      es: ['mesero', 'mesera', 'staff', 'personal', 'empleado', 'mejor mesero', 'vendieron mas', 'quien vendio', 'performance'],
      en: ['waiter', 'waitress', 'staff', 'best staff', 'top seller', 'who sold', 'performance'],
    },
    tables: ['Order', 'Staff', 'Shift'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getStaffPerformance',
    priority: 9,
  },
  {
    name: 'tips',
    description: 'Tip-related queries',
    keywords: {
      es: ['propinas', 'propina', 'tips', 'tip total'],
      en: ['tips', 'tip', 'gratuity'],
    },
    tables: ['Order', 'Payment'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getTipsForPeriod',
    priority: 7,
  },

  // ============================================
  // PRODUCTS
  // ============================================
  {
    name: 'topProducts',
    description: 'Best selling products queries',
    keywords: {
      es: ['productos mas vendidos', 'top productos', 'mejores productos', 'mas vendido', 'producto estrella', 'que se vende mas'],
      en: ['best sellers', 'top products', 'most sold', 'best selling', 'popular items'],
    },
    tables: ['Product', 'OrderItem'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getTopProducts',
    priority: 9,
  },
  {
    name: 'productSales',
    description: 'Sales for specific product',
    keywords: {
      es: ['cuantos vendi de', 'unidades de', 'ventas de producto'],
      en: ['how many sold', 'units of', 'product sales'],
    },
    tables: ['Product', 'OrderItem'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    priority: 6,
  },
  {
    name: 'categoryBreakdown',
    description: 'Sales by category',
    keywords: {
      es: ['ventas por categoria', 'desglose por categoria', 'que categoria'],
      en: ['sales by category', 'category breakdown', 'category sales'],
    },
    tables: ['Product', 'MenuCategory', 'OrderItem'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getSalesByCategory',
    priority: 7,
  },

  // ============================================
  // CUSTOMERS
  // ============================================
  {
    name: 'topCustomers',
    description: 'Best customer queries',
    keywords: {
      es: ['mejor cliente', 'top cliente', 'cliente mas', 'cliente vip', 'clientes frecuentes', 'clientes importantes'],
      en: ['best customer', 'top customer', 'vip customer', 'frequent customers'],
    },
    tables: ['Customer', 'Order'],
    requiresDateRange: false,
    sharedQueryMethod: 'getTopCustomers',
    priority: 9,
  },
  {
    name: 'churningCustomers',
    description: 'Customers who stopped visiting',
    keywords: {
      es: ['dejo de venir', 'no ha vuelto', 'cliente perdido', 'clientes inactivos', 'dejaron de venir', 'porque no viene'],
      en: ['churning', 'lost customer', 'stopped coming', 'inactive customers'],
    },
    tables: ['Customer'],
    requiresDateRange: false,
    sharedQueryMethod: 'getChurningCustomers',
    priority: 8,
  },
  {
    name: 'newCustomers',
    description: 'New customer registrations',
    keywords: {
      es: ['clientes nuevos', 'nuevos clientes', 'registros', 'nuevos registros'],
      en: ['new customers', 'new registrations', 'customer signups'],
    },
    tables: ['Customer'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getNewCustomers',
    priority: 7,
  },

  // ============================================
  // REVIEWS & RATINGS
  // ============================================
  {
    name: 'reviews',
    description: 'Customer review analysis',
    keywords: {
      es: ['resenas', 'reviews', 'calificaciones', 'rating', 'estrellas', 'opiniones', 'comentarios'],
      en: ['reviews', 'ratings', 'stars', 'feedback', 'comments'],
    },
    tables: ['Review'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getReviewStats',
    priority: 7,
  },
  {
    name: 'averageRating',
    description: 'Average rating queries',
    keywords: {
      es: ['calificacion promedio', 'rating promedio', 'promedio estrellas', 'cuantas estrellas'],
      en: ['average rating', 'avg rating', 'star average'],
    },
    tables: ['Review'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getReviewStats',
    priority: 6,
  },

  // ============================================
  // PAYMENTS
  // ============================================
  {
    name: 'paymentMethods',
    description: 'Payment method distribution',
    keywords: {
      es: ['metodos de pago', 'formas de pago', 'efectivo', 'tarjeta', 'como pagaron', 'desglose pagos'],
      en: ['payment methods', 'cash vs card', 'payment breakdown', 'how paid'],
    },
    tables: ['Payment'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getPaymentMethodBreakdown',
    priority: 7,
  },

  // ============================================
  // INVENTORY
  // ============================================
  {
    name: 'inventoryAlerts',
    description: 'Low stock alerts (real-time)',
    keywords: {
      es: ['inventario bajo', 'stock bajo', 'alertas inventario', 'falta', 'ingredientes bajos', 'se acabo', 'agotado'],
      en: ['low stock', 'inventory alerts', 'out of stock', 'running low'],
    },
    tables: ['RawMaterial', 'StockBatch'],
    requiresDateRange: false,
    sharedQueryMethod: 'getInventoryAlerts',
    priority: 8,
  },
  {
    name: 'expiringStock',
    description: 'Soon-to-expire inventory',
    keywords: {
      es: ['por vencer', 'caducidad', 'expira', 'vencimiento', 'proximos a caducar'],
      en: ['expiring', 'expiration', 'about to expire', 'soon to expire'],
    },
    tables: ['StockBatch', 'RawMaterial'],
    requiresDateRange: false,
    sharedQueryMethod: 'getExpiringStock',
    priority: 7,
  },
  {
    name: 'inventoryValue',
    description: 'Total inventory value',
    keywords: {
      es: ['valor inventario', 'cuanto tengo en inventario', 'costo inventario'],
      en: ['inventory value', 'stock value', 'inventory worth'],
    },
    tables: ['RawMaterial', 'StockBatch'],
    requiresDateRange: false,
    sharedQueryMethod: 'getInventoryValue',
    priority: 6,
  },

  // ============================================
  // REAL-TIME OPERATIONS
  // ============================================
  {
    name: 'pendingOrders',
    description: 'Active/pending orders (real-time)',
    keywords: {
      es: ['ordenes pendientes', 'pedidos pendientes', 'ordenes activas', 'en espera', 'ordenes abiertas'],
      en: ['pending orders', 'active orders', 'open orders', 'waiting orders'],
    },
    tables: ['Order'],
    requiresDateRange: false,
    sharedQueryMethod: 'getPendingOrders',
    priority: 8,
  },
  {
    name: 'activeShifts',
    description: 'Currently working staff (real-time)',
    keywords: {
      es: ['turnos activos', 'quien esta trabajando', 'personal activo', 'turnos abiertos', 'quienes estan'],
      en: ['active shifts', 'working now', 'current staff', 'who is working'],
    },
    tables: ['Shift', 'Staff'],
    requiresDateRange: false,
    sharedQueryMethod: 'getActiveShifts',
    priority: 8,
  },
  {
    name: 'todaySummary',
    description: "Quick summary of today's operations",
    keywords: {
      es: ['resumen de hoy', 'como va hoy', 'resumen del dia', 'que tal hoy'],
      en: ['today summary', 'how is today', "today's performance"],
    },
    tables: ['Order', 'Payment', 'Shift'],
    requiresDateRange: false,
    defaultDateRange: 'today',
    sharedQueryMethod: 'getTodaySummary',
    priority: 9,
  },

  // ============================================
  // FINANCIAL ANALYSIS
  // ============================================
  {
    name: 'profitAnalysis',
    description: 'Profit margin analysis',
    keywords: {
      es: ['rentabilidad', 'margen', 'ganancia', 'utilidad', 'profit', 'food cost'],
      en: ['profit', 'margin', 'profitability', 'food cost', 'gross margin'],
    },
    tables: ['Order', 'OrderItem', 'Product', 'Recipe'],
    requiresDateRange: true,
    defaultDateRange: 'thisMonth',
    sharedQueryMethod: 'getProfitAnalysis',
    priority: 7,
  },
  {
    name: 'comparison',
    description: 'Period comparison queries',
    keywords: {
      es: ['comparar', 'comparacion', 'vs', 'versus', 'diferencia', 'mejor que', 'peor que'],
      en: ['compare', 'comparison', 'vs', 'versus', 'difference', 'better than', 'worse than'],
    },
    tables: ['Order', 'Payment'],
    requiresDateRange: true,
    defaultDateRange: 'lastMonth',
    priority: 5,
  },
]

export default DEFAULT_INTENTS

// Named exports for individual intent access
export const SALES_INTENT = DEFAULT_INTENTS.find(i => i.name === 'sales')!
export const STAFF_PERFORMANCE_INTENT = DEFAULT_INTENTS.find(i => i.name === 'staffPerformance')!
export const TOP_PRODUCTS_INTENT = DEFAULT_INTENTS.find(i => i.name === 'topProducts')!
export const TOP_CUSTOMERS_INTENT = DEFAULT_INTENTS.find(i => i.name === 'topCustomers')!
export const REVIEWS_INTENT = DEFAULT_INTENTS.find(i => i.name === 'reviews')!
export const INVENTORY_ALERTS_INTENT = DEFAULT_INTENTS.find(i => i.name === 'inventoryAlerts')!
