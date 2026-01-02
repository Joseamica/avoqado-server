/**
 * Chatbot Table Definitions Index
 *
 * Exports all table definitions as a single array for registration with SchemaRegistry
 */

import type { TableDefinition } from '../types'

// Order & OrderItem
import { ORDER_TABLE, ORDER_ITEM_TABLE } from './order.table'

// Payment
import { PAYMENT_TABLE } from './payment.table'

// Product & Category
import { PRODUCT_TABLE, MENU_CATEGORY_TABLE } from './product.table'

// Staff, Shift, TimeEntry
import { STAFF_TABLE, SHIFT_TABLE, TIME_ENTRY_TABLE } from './staff.table'

// Customer & Review
import { CUSTOMER_TABLE, REVIEW_TABLE } from './customer.table'

// Inventory
import { RAW_MATERIAL_TABLE, STOCK_BATCH_TABLE, RECIPE_TABLE } from './inventory.table'

/**
 * All table definitions for chatbot schema registry
 * Order matters for schema context generation (most important first)
 */
const ALL_TABLES: TableDefinition[] = [
  // Core operations - most commonly queried
  ORDER_TABLE,
  ORDER_ITEM_TABLE,
  PAYMENT_TABLE,

  // Products & Menu
  PRODUCT_TABLE,
  MENU_CATEGORY_TABLE,

  // Staff & Operations
  STAFF_TABLE,
  SHIFT_TABLE,
  TIME_ENTRY_TABLE,

  // Customers
  CUSTOMER_TABLE,
  REVIEW_TABLE,

  // Inventory (restaurant-specific)
  RAW_MATERIAL_TABLE,
  STOCK_BATCH_TABLE,
  RECIPE_TABLE,
]

export default ALL_TABLES

// Named exports for individual table access
export {
  ORDER_TABLE,
  ORDER_ITEM_TABLE,
  PAYMENT_TABLE,
  PRODUCT_TABLE,
  MENU_CATEGORY_TABLE,
  STAFF_TABLE,
  SHIFT_TABLE,
  TIME_ENTRY_TABLE,
  CUSTOMER_TABLE,
  REVIEW_TABLE,
  RAW_MATERIAL_TABLE,
  STOCK_BATCH_TABLE,
  RECIPE_TABLE,
}
