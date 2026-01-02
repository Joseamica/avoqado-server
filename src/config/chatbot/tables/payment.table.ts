/**
 * Payment Table Definition
 * Financial records for order payments
 */

import type { TableDefinition } from '../types'

export const PAYMENT_TABLE: TableDefinition = {
  name: 'Payment',
  description: 'Payment records with amount, method, status, and provider info',
  category: 'financial',

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
      description: 'Unique payment identifier',
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
      description: 'Order this payment applies to',
      isForeignKey: true,
      foreignKeyTable: 'Order',
      isFilterable: true,
    },
    {
      name: 'amount',
      type: 'decimal',
      description: 'Payment amount',
      isAggregatable: true,
      aliases: ['monto', 'cantidad', 'pago'],
    },
    {
      name: 'tipAmount',
      type: 'decimal',
      description: 'Tip included in payment',
      isAggregatable: true,
      aliases: ['propina'],
    },
    {
      name: 'method',
      type: 'enum',
      description: 'Payment method used',
      enumValues: ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'TRANSFER', 'DIGITAL_WALLET', 'OTHER'],
      isFilterable: true,
      aliases: ['metodo', 'forma de pago'],
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Payment status',
      enumValues: ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'],
      isFilterable: true,
      aliases: ['estado'],
    },
    {
      name: 'provider',
      type: 'enum',
      description: 'Payment processor',
      enumValues: ['BLUMON', 'STRIPE', 'CASH', 'MANUAL', 'MENTA'],
      isFilterable: true,
    },
    {
      name: 'reference',
      type: 'string',
      description: 'External reference/confirmation number',
      isNullable: true,
    },
    {
      name: 'processedAt',
      type: 'datetime',
      description: 'When payment was processed',
      isFilterable: true,
      isSortable: true,
      aliases: ['fecha', 'cuando'],
    },
    {
      name: 'createdAt',
      type: 'datetime',
      description: 'Payment record creation time',
      isFilterable: true,
      isSortable: true,
    },
    {
      name: 'processedById',
      type: 'string',
      description: 'Staff who processed the payment',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isNullable: true,
      isFilterable: true,
    },
    // Confidential columns - only for OWNER+
    {
      name: 'providerFee',
      type: 'decimal',
      description: 'Fee charged by payment provider',
      isAggregatable: true,
      isConfidential: true,
    },
    {
      name: 'netAmount',
      type: 'decimal',
      description: 'Net amount after fees',
      isAggregatable: true,
      isConfidential: true,
    },
  ],

  relations: [
    {
      name: 'order',
      targetTable: 'Order',
      type: 'one-to-one',
      foreignKey: 'orderId',
      description: 'Order this payment is for',
    },
    {
      name: 'processedBy',
      targetTable: 'Staff',
      type: 'one-to-one',
      foreignKey: 'processedById',
      description: 'Staff who processed payment',
    },
  ],

  semanticMappings: [
    {
      pattern: 'pagos|cobros|payments',
      intent: 'payments',
      columns: ['amount', 'method', 'status'],
      aggregation: 'SUM',
      examples: ['pagos del dia', 'total cobrado'],
    },
    {
      pattern: 'efectivo|cash',
      intent: 'cashPayments',
      columns: ['amount', 'method'],
      aggregation: 'SUM',
      examples: ['pagos en efectivo', 'cuanto en cash'],
    },
    {
      pattern: 'tarjeta|card|credito|debito',
      intent: 'cardPayments',
      columns: ['amount', 'method'],
      aggregation: 'SUM',
      examples: ['pagos con tarjeta', 'ventas con credito'],
    },
    {
      pattern: 'metodos de pago|formas de pago|como pagaron',
      intent: 'paymentMethods',
      columns: ['method', 'amount'],
      aggregation: 'SUM',
      examples: ['desglose por metodo de pago', 'efectivo vs tarjeta'],
    },
    {
      pattern: 'reembolsos|refunds|devoluciones',
      intent: 'refunds',
      columns: ['status', 'amount'],
      aggregation: 'SUM',
      examples: ['reembolsos del mes', 'devoluciones'],
    },
  ],

  commonQueries: [
    `SELECT SUM("amount") FROM "Payment" WHERE "venueId" = $1 AND "status" = 'COMPLETED' AND "processedAt" >= $2`,
    `SELECT "method", SUM("amount") as total FROM "Payment" WHERE "venueId" = $1 AND "status" = 'COMPLETED' GROUP BY "method"`,
    `SELECT COUNT(*), SUM("amount") FROM "Payment" WHERE "venueId" = $1 AND "status" = 'REFUNDED'`,
  ],

  industries: {
    telecom: {
      enabled: true,
      customDescription: 'Payment transactions for telecom sales',
    },
  },
}
