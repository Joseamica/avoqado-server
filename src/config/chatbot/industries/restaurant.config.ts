/**
 * Restaurant Industry Chatbot Configuration
 *
 * Default configuration for restaurant/food service venues.
 * Full access to all tables including inventory and recipes.
 */

import type { IndustryChatbotConfig } from '../types'

export const RESTAURANT_CONFIG: IndustryChatbotConfig = {
  industry: 'restaurant',

  // All core tables enabled (default behavior)
  enabledTables: [
    // Core operations
    'Order',
    'OrderItem',
    'Payment',

    // Menu
    'Product',
    'MenuCategory',

    // Staff
    'Staff',
    'Shift',
    'TimeEntry',

    // Customers
    'Customer',
    'Review',

    // Inventory (restaurant-specific)
    'RawMaterial',
    'StockBatch',
    'Recipe',
  ],

  // No columns hidden for restaurant (full access)
  hiddenColumns: {},

  // Restaurant-specific intents (most are already in defaults)
  customIntents: [
    {
      name: 'tableStatus',
      description: 'Restaurant table status',
      keywords: {
        es: ['mesas disponibles', 'mesas ocupadas', 'disponibilidad', 'estado mesas'],
        en: ['available tables', 'table status', 'table availability'],
      },
      tables: ['Table', 'Order'],
      requiresDateRange: false,
      sharedQueryMethod: 'getTableStatus',
      priority: 6,
    },
    {
      name: 'kitchenQueue',
      description: 'Kitchen order queue',
      keywords: {
        es: ['cola cocina', 'pedidos cocina', 'ordenes en preparacion', 'que falta'],
        en: ['kitchen queue', 'pending kitchen', 'orders preparing'],
      },
      tables: ['Order', 'OrderItem'],
      requiresDateRange: false,
      sharedQueryMethod: 'getKitchenQueue',
      priority: 7,
    },
  ],

  // Additional semantic mappings for restaurant context
  additionalSemantics: [
    {
      pattern: 'comensales|covers|personas',
      intent: 'covers',
      columns: ['covers'],
      examples: ['cuantos comensales', 'personas atendidas'],
    },
  ],
}
