/**
 * Inventory Table Definitions
 * Raw materials, stock batches, and recipes
 */

import type { TableDefinition } from '../types'

export const RAW_MATERIAL_TABLE: TableDefinition = {
  name: 'RawMaterial',
  description: 'Inventory raw materials/ingredients with stock levels and alerts',
  category: 'inventory',

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
      description: 'Raw material identifier',
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
      name: 'sku',
      type: 'string',
      description: 'Stock Keeping Unit',
      aliases: ['codigo'],
    },
    {
      name: 'name',
      type: 'string',
      description: 'Material name',
      aliases: ['nombre', 'ingrediente', 'material'],
    },
    {
      name: 'description',
      type: 'string',
      description: 'Material description',
      isNullable: true,
    },
    {
      name: 'unit',
      type: 'enum',
      description: 'Measurement unit',
      enumValues: ['PIECE', 'KG', 'G', 'L', 'ML', 'OZ', 'LB', 'GAL', 'DOZEN', 'BOX', 'BAG', 'BOTTLE', 'CAN', 'PACK'],
      aliases: ['unidad'],
    },
    {
      name: 'currentStock',
      type: 'decimal',
      description: 'Current stock quantity (calculated from batches)',
      isAggregatable: true,
      aliases: ['stock', 'inventario', 'cantidad'],
    },
    {
      name: 'minStock',
      type: 'decimal',
      description: 'Minimum stock threshold for alerts',
      aliases: ['minimo', 'stock minimo'],
    },
    {
      name: 'maxStock',
      type: 'decimal',
      description: 'Maximum stock capacity',
      isNullable: true,
      aliases: ['maximo'],
    },
    {
      name: 'reorderPoint',
      type: 'decimal',
      description: 'Point at which to reorder',
      isNullable: true,
    },
    {
      name: 'avgCost',
      type: 'decimal',
      description: 'Average cost per unit',
      isAggregatable: true,
      isConfidential: true,
      aliases: ['costo', 'costo promedio'],
    },
    {
      name: 'lastCost',
      type: 'decimal',
      description: 'Last purchase cost per unit',
      isNullable: true,
      isConfidential: true,
    },
    {
      name: 'categoryId',
      type: 'string',
      description: 'Inventory category',
      isForeignKey: true,
      foreignKeyTable: 'InventoryCategory',
      isNullable: true,
      isFilterable: true,
      aliases: ['categoria'],
    },
    {
      name: 'supplierId',
      type: 'string',
      description: 'Primary supplier',
      isForeignKey: true,
      foreignKeyTable: 'Supplier',
      isNullable: true,
      isFilterable: true,
      aliases: ['proveedor'],
    },
    {
      name: 'active',
      type: 'boolean',
      description: 'Is material active',
      isFilterable: true,
    },
  ],

  relations: [
    {
      name: 'batches',
      targetTable: 'StockBatch',
      type: 'one-to-many',
      foreignKey: 'rawMaterialId',
      description: 'Stock batches of this material',
    },
    {
      name: 'recipes',
      targetTable: 'RecipeLine',
      type: 'one-to-many',
      foreignKey: 'rawMaterialId',
      description: 'Recipes using this material',
    },
  ],

  semanticMappings: [
    {
      pattern: 'inventario|stock|ingredientes|materiales',
      intent: 'inventory',
      columns: ['name', 'currentStock', 'unit'],
      examples: ['inventario actual', 'stock de ingredientes'],
    },
    {
      pattern: 'bajo stock|stock bajo|falta|agotado|se acabo',
      intent: 'lowStock',
      columns: ['name', 'currentStock', 'minStock'],
      examples: ['que ingredientes estan bajos', 'alertas de inventario'],
    },
    {
      pattern: 'valor.*inventario|costo.*inventario',
      intent: 'inventoryValue',
      columns: ['name', 'currentStock', 'avgCost'],
      aggregation: 'SUM',
      examples: ['valor total del inventario', 'cuanto tengo en inventario'],
    },
  ],

  commonQueries: [
    `SELECT "name", "currentStock", "minStock", "unit" FROM "RawMaterial" WHERE "venueId" = $1 AND "currentStock" < "minStock" AND "active" = true`,
    `SELECT SUM("currentStock" * "avgCost") as total_value FROM "RawMaterial" WHERE "venueId" = $1`,
    `SELECT "name", "currentStock", "unit" FROM "RawMaterial" WHERE "venueId" = $1 ORDER BY "currentStock" ASC LIMIT 10`,
  ],

  industries: {
    telecom: {
      enabled: false, // Telecom doesn't use raw material inventory
    },
  },
}

export const STOCK_BATCH_TABLE: TableDefinition = {
  name: 'StockBatch',
  description: 'FIFO inventory batches with expiration tracking',
  category: 'inventory',

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
      description: 'Batch identifier',
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
      name: 'rawMaterialId',
      type: 'string',
      description: 'Raw material this batch contains',
      isForeignKey: true,
      foreignKeyTable: 'RawMaterial',
      isFilterable: true,
    },
    {
      name: 'batchNumber',
      type: 'string',
      description: 'Batch/lot number',
      aliases: ['lote', 'numero de lote'],
    },
    {
      name: 'initialQuantity',
      type: 'decimal',
      description: 'Quantity received',
      isAggregatable: true,
    },
    {
      name: 'remainingQuantity',
      type: 'decimal',
      description: 'Quantity remaining',
      isAggregatable: true,
      aliases: ['cantidad', 'disponible'],
    },
    {
      name: 'unitCost',
      type: 'decimal',
      description: 'Cost per unit for this batch',
      isAggregatable: true,
      isConfidential: true,
      aliases: ['costo'],
    },
    {
      name: 'expirationDate',
      type: 'date',
      description: 'Expiration date',
      isFilterable: true,
      isSortable: true,
      aliases: ['caducidad', 'expira', 'vencimiento'],
    },
    {
      name: 'receivedAt',
      type: 'datetime',
      description: 'When batch was received',
      isFilterable: true,
      isSortable: true,
      aliases: ['fecha recepcion'],
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Batch status',
      enumValues: ['ACTIVE', 'DEPLETED', 'EXPIRED', 'WASTED'],
      isFilterable: true,
    },
    {
      name: 'supplierId',
      type: 'string',
      description: 'Supplier for this batch',
      isForeignKey: true,
      foreignKeyTable: 'Supplier',
      isNullable: true,
      isFilterable: true,
    },
  ],

  relations: [
    {
      name: 'rawMaterial',
      targetTable: 'RawMaterial',
      type: 'one-to-one',
      foreignKey: 'rawMaterialId',
      description: 'Raw material',
    },
    {
      name: 'supplier',
      targetTable: 'Supplier',
      type: 'one-to-one',
      foreignKey: 'supplierId',
      description: 'Supplier',
    },
  ],

  semanticMappings: [
    {
      pattern: 'lotes|batches',
      intent: 'batches',
      columns: ['batchNumber', 'remainingQuantity', 'expirationDate'],
      examples: ['lotes activos', 'batches por vencer'],
    },
    {
      pattern: 'por vencer|expira|caducidad|vencimiento',
      intent: 'expiring',
      columns: ['batchNumber', 'expirationDate', 'remainingQuantity'],
      examples: ['que va a caducar', 'lotes por vencer esta semana'],
    },
    {
      pattern: 'desperdicio|waste|merma',
      intent: 'waste',
      columns: ['status', 'remainingQuantity'],
      examples: ['cuanto desperdicio hubo', 'lotes perdidos'],
    },
  ],

  commonQueries: [
    `SELECT rm."name", sb."batchNumber", sb."expirationDate", sb."remainingQuantity" FROM "StockBatch" sb JOIN "RawMaterial" rm ON sb."rawMaterialId" = rm.id WHERE sb."venueId" = $1 AND sb."expirationDate" <= CURRENT_DATE + INTERVAL '7 days' AND sb."status" = 'ACTIVE'`,
    `SELECT COUNT(*), SUM("remainingQuantity" * "unitCost") as value FROM "StockBatch" WHERE "venueId" = $1 AND "status" = 'WASTED'`,
  ],

  industries: {
    telecom: {
      enabled: false,
    },
  },
}

export const RECIPE_TABLE: TableDefinition = {
  name: 'Recipe',
  description: 'Product recipes linking products to raw materials',
  category: 'inventory',

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
      description: 'Recipe identifier',
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
      name: 'productId',
      type: 'string',
      description: 'Product this recipe is for',
      isForeignKey: true,
      foreignKeyTable: 'Product',
      isFilterable: true,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Recipe name (usually same as product)',
      aliases: ['nombre', 'receta'],
    },
    {
      name: 'yield',
      type: 'decimal',
      description: 'Number of servings/units this recipe makes',
      aliases: ['rendimiento', 'porciones'],
    },
    {
      name: 'totalCost',
      type: 'decimal',
      description: 'Total cost of ingredients',
      isAggregatable: true,
      isConfidential: true,
      aliases: ['costo total'],
    },
    {
      name: 'costPerUnit',
      type: 'decimal',
      description: 'Cost per serving/unit',
      isAggregatable: true,
      isConfidential: true,
      aliases: ['costo unitario'],
    },
    {
      name: 'active',
      type: 'boolean',
      description: 'Is recipe active',
      isFilterable: true,
    },
  ],

  relations: [
    {
      name: 'product',
      targetTable: 'Product',
      type: 'one-to-one',
      foreignKey: 'productId',
      description: 'Product this recipe makes',
    },
    {
      name: 'lines',
      targetTable: 'RecipeLine',
      type: 'one-to-many',
      foreignKey: 'recipeId',
      description: 'Recipe ingredients',
    },
  ],

  semanticMappings: [
    {
      pattern: 'recetas|recipes',
      intent: 'recipes',
      columns: ['name', 'totalCost'],
      examples: ['listado de recetas', 'recetas activas'],
    },
    {
      pattern: 'costo.*receta|food cost',
      intent: 'recipeCost',
      columns: ['name', 'costPerUnit', 'totalCost'],
      examples: ['costo de recetas', 'food cost por producto'],
    },
  ],

  commonQueries: [
    `SELECT r."name", r."costPerUnit", p."price", (r."costPerUnit" / p."price" * 100) as food_cost_pct FROM "Recipe" r JOIN "Product" p ON r."productId" = p.id WHERE r."venueId" = $1`,
  ],

  industries: {
    telecom: {
      enabled: false,
    },
  },
}
