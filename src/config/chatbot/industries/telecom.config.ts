/**
 * Telecom Industry Chatbot Configuration
 *
 * Configuration for telecom/retail stores (PlayTelecom, etc.)
 * Sales-focused with staff balance tracking, no inventory/recipes.
 */

import type { IndustryChatbotConfig } from '../types'

export const TELECOM_CONFIG: IndustryChatbotConfig = {
  industry: 'telecom',

  // Only sales and staff-focused tables
  enabledTables: [
    // Core sales
    'Order',
    'OrderItem',
    'Payment',

    // Products (SIMs, recharges, accessories)
    'Product',
    'MenuCategory',

    // Staff & attendance (critical for promoters)
    'Staff',
    'Shift',
    'TimeEntry',

    // Customers (limited fields)
    'Customer',

    // NO inventory tables (telecom doesn't need FIFO/recipes)
    // NO Review table (optional - most telecom stores don't use)
  ],

  // Hide restaurant-specific columns
  hiddenColumns: {
    Order: [
      'tipAmount', // Telecom doesn't use tips
      'covers', // No table covers
      'tableId', // No tables
    ],
    Customer: [
      'loyaltyPoints', // May not use loyalty system
    ],
    Product: [
      'calories', // Not relevant
      'allergens', // Not relevant
      'prepTime', // Not relevant
      'cookingNotes', // Not relevant
    ],
  },

  // Telecom-specific intents
  customIntents: [
    {
      name: 'staffBalance',
      description: 'Staff cash/card balance tracking',
      keywords: {
        es: ['saldo', 'balance', 'deposito', 'debe', 'adeuda', 'cuanto tiene', 'corte'],
        en: ['balance', 'deposit', 'owes', 'cash balance'],
      },
      tables: ['StaffVenue', 'StaffDeposit'],
      requiresDateRange: false,
      sharedQueryMethod: 'getStaffBalance',
      priority: 9,
    },
    {
      name: 'dailyDeposits',
      description: 'Daily deposit tracking',
      keywords: {
        es: ['depositos del dia', 'depositos hoy', 'vouchers', 'comprobantes', 'depositos pendientes'],
        en: ['deposits today', 'daily deposits', 'pending deposits'],
      },
      tables: ['StaffDeposit'],
      requiresDateRange: true,
      defaultDateRange: 'today',
      sharedQueryMethod: 'getDailyDeposits',
      priority: 8,
    },
    {
      name: 'storeComparison',
      description: 'Compare sales between stores',
      keywords: {
        es: ['comparar tiendas', 'ventas por tienda', 'mejor tienda', 'sucursales'],
        en: ['compare stores', 'sales by store', 'best store', 'branch comparison'],
      },
      tables: ['Venue', 'Order'],
      requiresDateRange: true,
      defaultDateRange: 'thisMonth',
      sharedQueryMethod: 'getStoreComparison',
      priority: 7,
    },
    {
      name: 'promoterAttendance',
      description: 'Promoter check-in/out with photo verification',
      keywords: {
        es: ['asistencia promotores', 'checkin', 'check-in', 'quien llego', 'quien falto', 'retardos'],
        en: ['promoter attendance', 'check-in', 'who arrived', 'late arrivals'],
      },
      tables: ['TimeEntry', 'Staff'],
      requiresDateRange: true,
      defaultDateRange: 'today',
      sharedQueryMethod: 'getPromoterAttendance',
      priority: 8,
    },
    {
      name: 'simActivations',
      description: 'SIM card activations count',
      keywords: {
        es: ['activaciones', 'sims activadas', 'lineas nuevas', 'altas'],
        en: ['activations', 'new lines', 'sim activations'],
      },
      tables: ['Order', 'OrderItem', 'Product'],
      requiresDateRange: true,
      defaultDateRange: 'today',
      sharedQueryMethod: 'getSimActivations',
      priority: 8,
    },
    {
      name: 'recharges',
      description: 'Phone recharge sales',
      keywords: {
        es: ['recargas', 'recarga', 'tiempo aire'],
        en: ['recharges', 'airtime', 'top-ups'],
      },
      tables: ['Order', 'OrderItem', 'Product'],
      requiresDateRange: true,
      defaultDateRange: 'today',
      sharedQueryMethod: 'getRecharges',
      priority: 8,
    },
  ],

  // Telecom-specific semantic mappings
  additionalSemantics: [
    {
      pattern: 'promotor|promotores|vendedor',
      intent: 'staffPerformance',
      columns: ['firstName', 'lastName'],
      examples: ['mejor promotor', 'ranking promotores'],
    },
    {
      pattern: 'corte|cierre|arqueo',
      intent: 'staffBalance',
      columns: ['cashBalance', 'cardBalance'],
      examples: ['corte del dia', 'arqueo de caja'],
    },
  ],
}
