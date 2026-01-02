/**
 * Order Table Definition
 * Core operations table for customer orders
 */

import type { TableDefinition } from '../types'

export const ORDER_TABLE: TableDefinition = {
  name: 'Order',
  description: 'Customer orders with totals, status, payment tracking, and associated staff',
  category: 'core',

  accessLevel: 'RESTRICTED',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'],

  tenant: {
    field: 'venueId',
    required: true,
    autoInject: true,
  },

  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'Unique order identifier (CUID)',
      isPrimaryKey: true,
    },
    {
      name: 'venueId',
      type: 'string',
      description: 'Venue this order belongs to',
      isForeignKey: true,
      foreignKeyTable: 'Venue',
      isFilterable: true,
    },
    {
      name: 'orderNumber',
      type: 'string',
      description: 'Sequential display order number',
      isSortable: true,
      aliases: ['numero de orden', 'numero', 'folio'],
    },
    {
      name: 'type',
      type: 'enum',
      description: 'Order type',
      enumValues: ['DINE_IN', 'TAKEOUT', 'DELIVERY', 'BAR', 'ROOM_SERVICE'],
      isFilterable: true,
      aliases: ['tipo', 'tipo de orden'],
    },
    {
      name: 'source',
      type: 'enum',
      description: 'Order source system',
      enumValues: ['TPV', 'WEB', 'MOBILE', 'KIOSK', 'THIRD_PARTY'],
      isFilterable: true,
    },
    {
      name: 'subtotal',
      type: 'decimal',
      description: 'Order subtotal before tax and discounts',
      isAggregatable: true,
      aliases: ['subtotal'],
    },
    {
      name: 'discountAmount',
      type: 'decimal',
      description: 'Total discount applied to order',
      isAggregatable: true,
      aliases: ['descuento'],
    },
    {
      name: 'taxAmount',
      type: 'decimal',
      description: 'Tax amount (IVA)',
      isAggregatable: true,
      aliases: ['impuesto', 'iva', 'tax'],
    },
    {
      name: 'tipAmount',
      type: 'decimal',
      description: 'Tip amount',
      isAggregatable: true,
      aliases: ['propina', 'tip'],
    },
    {
      name: 'total',
      type: 'decimal',
      description: 'Final order total including tax and tip',
      isAggregatable: true,
      aliases: ['total', 'monto', 'cantidad', 'venta'],
    },
    {
      name: 'paidAmount',
      type: 'decimal',
      description: 'Amount already paid (for split payments)',
      isAggregatable: true,
    },
    {
      name: 'remainingBalance',
      type: 'decimal',
      description: 'Remaining balance to pay',
      isAggregatable: true,
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Order lifecycle status',
      enumValues: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED', 'DELETED'],
      isFilterable: true,
      aliases: ['estado', 'status'],
    },
    {
      name: 'createdAt',
      type: 'datetime',
      description: 'When order was created',
      isFilterable: true,
      isSortable: true,
      aliases: ['fecha', 'fecha creacion', 'created', 'cuando'],
    },
    {
      name: 'updatedAt',
      type: 'datetime',
      description: 'Last update timestamp',
      isSortable: true,
    },
    {
      name: 'createdById',
      type: 'string',
      description: 'Staff ID who created the order',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isFilterable: true,
      aliases: ['mesero', 'waiter', 'creador'],
    },
    {
      name: 'servedById',
      type: 'string',
      description: 'Staff ID who served the order',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isNullable: true,
    },
    {
      name: 'customerId',
      type: 'string',
      description: 'Registered customer ID',
      isForeignKey: true,
      foreignKeyTable: 'Customer',
      isNullable: true,
      isFilterable: true,
      aliases: ['cliente'],
    },
    {
      name: 'tableId',
      type: 'string',
      description: 'Table ID for dine-in orders',
      isForeignKey: true,
      foreignKeyTable: 'Table',
      isNullable: true,
      isFilterable: true,
      aliases: ['mesa'],
    },
    {
      name: 'shiftId',
      type: 'string',
      description: 'Shift during which order was created',
      isForeignKey: true,
      foreignKeyTable: 'Shift',
      isNullable: true,
      isFilterable: true,
      aliases: ['turno'],
    },
    {
      name: 'covers',
      type: 'integer',
      description: 'Number of people at table',
      isNullable: true,
      isAggregatable: true,
      aliases: ['personas', 'comensales'],
    },
  ],

  relations: [
    {
      name: 'items',
      targetTable: 'OrderItem',
      type: 'one-to-many',
      foreignKey: 'orderId',
      description: 'Line items in this order',
    },
    {
      name: 'payments',
      targetTable: 'Payment',
      type: 'one-to-many',
      foreignKey: 'orderId',
      description: 'Payments for this order',
    },
    {
      name: 'createdBy',
      targetTable: 'Staff',
      type: 'one-to-one',
      foreignKey: 'createdById',
      description: 'Staff who created the order',
    },
    {
      name: 'servedBy',
      targetTable: 'Staff',
      type: 'one-to-one',
      foreignKey: 'servedById',
      description: 'Staff who served the order',
    },
    {
      name: 'customer',
      targetTable: 'Customer',
      type: 'one-to-one',
      foreignKey: 'customerId',
      description: 'Registered customer who placed order',
    },
  ],

  semanticMappings: [
    {
      pattern: 'cuanto vend|ventas|revenue|ingreso',
      intent: 'sales',
      columns: ['total'],
      aggregation: 'SUM',
      examples: ['cuanto vendi hoy', 'ventas del mes', 'revenue de la semana'],
    },
    {
      pattern: 'ticket promedio|promedio|ticket medio',
      intent: 'averageTicket',
      columns: ['total'],
      aggregation: 'AVG',
      examples: ['ticket promedio', 'promedio por orden'],
    },
    {
      pattern: 'ordenes activas|pedidos pendientes|ordenes abiertas',
      intent: 'pendingOrders',
      columns: ['status', 'createdAt'],
      examples: ['ordenes pendientes', 'cuantas ordenes hay abiertas'],
    },
    {
      pattern: 'mesero.*(vend|mas)|mejor mesero|staff.*vend',
      intent: 'staffPerformance',
      columns: ['total', 'createdById'],
      aggregation: 'SUM',
      examples: ['que mesero vendio mas', 'mejor mesero del mes'],
    },
    {
      pattern: 'propinas|tips|propina total',
      intent: 'tips',
      columns: ['tipAmount'],
      aggregation: 'SUM',
      examples: ['cuantas propinas', 'propinas del dia'],
    },
  ],

  commonQueries: [
    `SELECT SUM("total") FROM "Order" WHERE "venueId" = $1 AND "status" = 'COMPLETED' AND "createdAt" >= $2`,
    `SELECT COUNT(*) FROM "Order" WHERE "venueId" = $1 AND "status" IN ('PENDING', 'PREPARING')`,
    `SELECT s."firstName", SUM(o."total") as total FROM "Order" o JOIN "Staff" s ON o."createdById" = s.id WHERE o."venueId" = $1 GROUP BY s.id ORDER BY total DESC`,
    `SELECT AVG("total") FROM "Order" WHERE "venueId" = $1 AND "status" = 'COMPLETED'`,
  ],

  industries: {
    telecom: {
      enabled: true,
      hiddenColumns: ['tipAmount', 'covers', 'tableId'],
      customDescription: 'Sales transactions for telecom products',
    },
  },
}

export const ORDER_ITEM_TABLE: TableDefinition = {
  name: 'OrderItem',
  description: 'Individual line items within an order',
  category: 'core',

  accessLevel: 'RESTRICTED',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'],

  tenant: {
    field: 'venueId',
    required: true,
    autoInject: true,
  },

  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'Unique item identifier',
      isPrimaryKey: true,
    },
    {
      name: 'venueId',
      type: 'string',
      description: 'Venue ID',
      isForeignKey: true,
      foreignKeyTable: 'Venue',
      isFilterable: true,
    },
    {
      name: 'orderId',
      type: 'string',
      description: 'Parent order ID',
      isForeignKey: true,
      foreignKeyTable: 'Order',
      isFilterable: true,
    },
    {
      name: 'productId',
      type: 'string',
      description: 'Product ID',
      isForeignKey: true,
      foreignKeyTable: 'Product',
      isFilterable: true,
      aliases: ['producto'],
    },
    {
      name: 'productName',
      type: 'string',
      description: 'Product name at time of order (denormalized)',
      aliases: ['nombre', 'producto'],
    },
    {
      name: 'quantity',
      type: 'integer',
      description: 'Quantity ordered',
      isAggregatable: true,
      aliases: ['cantidad', 'qty'],
    },
    {
      name: 'unitPrice',
      type: 'decimal',
      description: 'Price per unit at time of order',
      isAggregatable: true,
      aliases: ['precio', 'precio unitario'],
    },
    {
      name: 'subtotal',
      type: 'decimal',
      description: 'Line item subtotal (quantity * unitPrice)',
      isAggregatable: true,
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Item status in kitchen workflow',
      enumValues: ['PENDING', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'],
      isFilterable: true,
    },
    {
      name: 'createdAt',
      type: 'datetime',
      description: 'When item was added',
      isFilterable: true,
      isSortable: true,
    },
  ],

  relations: [
    {
      name: 'order',
      targetTable: 'Order',
      type: 'one-to-one',
      foreignKey: 'orderId',
      description: 'Parent order',
    },
    {
      name: 'product',
      targetTable: 'Product',
      type: 'one-to-one',
      foreignKey: 'productId',
      description: 'Product reference',
    },
  ],

  semanticMappings: [
    {
      pattern: 'productos mas vendidos|top productos|best seller',
      intent: 'topProducts',
      columns: ['productName', 'quantity'],
      aggregation: 'SUM',
      examples: ['productos mas vendidos', 'top 10 productos'],
    },
    {
      pattern: 'cuantos.*vendi|unidades vendidas',
      intent: 'productQuantity',
      columns: ['productName', 'quantity'],
      aggregation: 'SUM',
      examples: ['cuantas hamburguesas vendi', 'unidades de pizza vendidas'],
    },
  ],

  commonQueries: [
    `SELECT "productName", SUM("quantity") as qty, SUM("subtotal") as revenue FROM "OrderItem" WHERE "venueId" = $1 GROUP BY "productName" ORDER BY qty DESC LIMIT 10`,
    `SELECT "productName", COUNT(*) FROM "OrderItem" WHERE "venueId" = $1 AND "status" = 'CANCELLED' GROUP BY "productName"`,
  ],
}
