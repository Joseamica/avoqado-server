/**
 * Product Table Definitions
 * Menu items and categories
 */

import type { TableDefinition } from '../types'

export const PRODUCT_TABLE: TableDefinition = {
  name: 'Product',
  description: 'Menu items with pricing, category, and inventory tracking info',
  category: 'core',

  accessLevel: 'PUBLIC',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER'],

  tenant: {
    field: 'venueId',
    required: true,
    autoInject: true,
  },

  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'Unique product identifier',
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
      description: 'Stock Keeping Unit code',
      aliases: ['codigo', 'code'],
    },
    {
      name: 'name',
      type: 'string',
      description: 'Product display name',
      isFilterable: true,
      aliases: ['nombre', 'producto'],
    },
    {
      name: 'description',
      type: 'string',
      description: 'Product description',
      isNullable: true,
    },
    {
      name: 'categoryId',
      type: 'string',
      description: 'Menu category ID',
      isForeignKey: true,
      foreignKeyTable: 'MenuCategory',
      isFilterable: true,
      aliases: ['categoria'],
    },
    {
      name: 'type',
      type: 'enum',
      description: 'Product type for reporting',
      enumValues: ['FOOD', 'DRINK', 'DESSERT', 'MERCHANDISE', 'SERVICE'],
      isFilterable: true,
      aliases: ['tipo'],
    },
    {
      name: 'price',
      type: 'decimal',
      description: 'Selling price',
      isAggregatable: true,
      aliases: ['precio'],
    },
    {
      name: 'cost',
      type: 'decimal',
      description: 'Cost/COGS',
      isNullable: true,
      isConfidential: true,
      isAggregatable: true,
      aliases: ['costo'],
    },
    {
      name: 'taxRate',
      type: 'decimal',
      description: 'Tax rate (default 0.16 for Mexico)',
      aliases: ['iva', 'impuesto'],
    },
    {
      name: 'featured',
      type: 'boolean',
      description: 'Is product featured/highlighted',
      isFilterable: true,
    },
    {
      name: 'active',
      type: 'boolean',
      description: 'Is product available for sale',
      isFilterable: true,
      aliases: ['activo', 'disponible'],
    },
    {
      name: 'displayOrder',
      type: 'integer',
      description: 'Sort order in menu',
      isSortable: true,
    },
    {
      name: 'createdAt',
      type: 'datetime',
      description: 'Product creation date',
      isFilterable: true,
      isSortable: true,
    },
  ],

  relations: [
    {
      name: 'category',
      targetTable: 'MenuCategory',
      type: 'one-to-one',
      foreignKey: 'categoryId',
      description: 'Product category',
    },
    {
      name: 'orderItems',
      targetTable: 'OrderItem',
      type: 'one-to-many',
      foreignKey: 'productId',
      description: 'Order items featuring this product',
    },
  ],

  semanticMappings: [
    {
      pattern: 'productos|menu|items',
      intent: 'products',
      columns: ['name', 'price', 'type'],
      examples: ['listado de productos', 'menu completo'],
    },
    {
      pattern: 'precio|cuanto cuesta',
      intent: 'productPrice',
      columns: ['name', 'price'],
      examples: ['precio de hamburguesa', 'cuanto cuesta la pizza'],
    },
    {
      pattern: 'margen|rentabilidad|profit',
      intent: 'productMargin',
      columns: ['name', 'price', 'cost'],
      examples: ['margen por producto', 'productos mas rentables'],
    },
  ],

  commonQueries: [
    `SELECT "name", "price", "type" FROM "Product" WHERE "venueId" = $1 AND "active" = true ORDER BY "displayOrder"`,
    `SELECT p."name", ("price" - "cost") / "price" * 100 as margin FROM "Product" p WHERE "venueId" = $1 AND "cost" IS NOT NULL`,
  ],

  industries: {
    telecom: {
      enabled: true,
      hiddenColumns: ['cost'],
      customDescription: 'Telecom products: SIMs, recharges, accessories',
    },
  },
}

export const MENU_CATEGORY_TABLE: TableDefinition = {
  name: 'MenuCategory',
  description: 'Product categories for menu organization',
  category: 'core',

  accessLevel: 'PUBLIC',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER'],

  tenant: {
    field: 'venueId',
    required: true,
    autoInject: true,
  },

  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'Category identifier',
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
      name: 'name',
      type: 'string',
      description: 'Category name',
      aliases: ['nombre', 'categoria'],
    },
    {
      name: 'description',
      type: 'string',
      description: 'Category description',
      isNullable: true,
    },
    {
      name: 'displayOrder',
      type: 'integer',
      description: 'Sort order',
      isSortable: true,
    },
    {
      name: 'active',
      type: 'boolean',
      description: 'Is category visible',
      isFilterable: true,
    },
  ],

  relations: [
    {
      name: 'products',
      targetTable: 'Product',
      type: 'one-to-many',
      foreignKey: 'categoryId',
      description: 'Products in this category',
    },
  ],

  semanticMappings: [
    {
      pattern: 'categorias|tipos de producto',
      intent: 'categories',
      columns: ['name'],
      examples: ['categorias del menu', 'tipos de productos'],
    },
    {
      pattern: 'ventas por categoria',
      intent: 'salesByCategory',
      columns: ['name'],
      aggregation: 'SUM',
      examples: ['ventas por categoria', 'que categoria vende mas'],
    },
  ],

  commonQueries: [
    `SELECT c."name", COUNT(p.id) as products FROM "MenuCategory" c LEFT JOIN "Product" p ON c.id = p."categoryId" WHERE c."venueId" = $1 GROUP BY c.id`,
  ],
}
