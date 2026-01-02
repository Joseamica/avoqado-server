/**
 * Customer Table Definitions
 * Customer records and reviews
 */

import type { TableDefinition } from '../types'

export const CUSTOMER_TABLE: TableDefinition = {
  name: 'Customer',
  description: 'Registered customers with loyalty tracking, visit history, and spending stats',
  category: 'customer',

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
      description: 'Customer identifier',
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
      name: 'firstName',
      type: 'string',
      description: 'First name',
      isNullable: true,
      aliases: ['nombre'],
    },
    {
      name: 'lastName',
      type: 'string',
      description: 'Last name',
      isNullable: true,
      aliases: ['apellido'],
    },
    // PII columns
    {
      name: 'email',
      type: 'string',
      description: 'Email address',
      isNullable: true,
      isPII: true,
      aliases: ['correo'],
    },
    {
      name: 'phone',
      type: 'string',
      description: 'Phone number',
      isNullable: true,
      isPII: true,
      aliases: ['telefono'],
    },
    // Loyalty & Analytics
    {
      name: 'loyaltyPoints',
      type: 'integer',
      description: 'Accumulated loyalty points',
      isAggregatable: true,
      aliases: ['puntos', 'puntos de lealtad'],
    },
    {
      name: 'totalVisits',
      type: 'integer',
      description: 'Total number of visits',
      isAggregatable: true,
      isSortable: true,
      aliases: ['visitas', 'veces que vino'],
    },
    {
      name: 'totalSpent',
      type: 'decimal',
      description: 'Total lifetime spending',
      isAggregatable: true,
      isSortable: true,
      aliases: ['total gastado', 'gastado', 'lifetime value'],
    },
    {
      name: 'averageOrderValue',
      type: 'decimal',
      description: 'Average order value',
      isAggregatable: true,
      aliases: ['ticket promedio', 'promedio'],
    },
    {
      name: 'lastVisitAt',
      type: 'datetime',
      description: 'Last visit timestamp',
      isFilterable: true,
      isSortable: true,
      aliases: ['ultima visita', 'cuando vino'],
    },
    {
      name: 'firstVisitAt',
      type: 'datetime',
      description: 'First visit timestamp',
      isFilterable: true,
      aliases: ['primera visita'],
    },
    {
      name: 'birthDate',
      type: 'date',
      description: 'Birthday for promotions',
      isNullable: true,
      isFilterable: true,
      aliases: ['cumpleanos', 'fecha de nacimiento'],
    },
    {
      name: 'tags',
      type: 'json',
      description: 'Customer tags/labels (VIP, Allergic-Nuts, etc.)',
      aliases: ['etiquetas'],
    },
    {
      name: 'customerGroupId',
      type: 'string',
      description: 'Customer segment/group',
      isForeignKey: true,
      foreignKeyTable: 'CustomerGroup',
      isNullable: true,
      isFilterable: true,
      aliases: ['grupo', 'segmento'],
    },
    {
      name: 'marketingConsent',
      type: 'boolean',
      description: 'Has opted in for marketing',
      isFilterable: true,
    },
    {
      name: 'active',
      type: 'boolean',
      description: 'Is customer active',
      isFilterable: true,
    },
    {
      name: 'notes',
      type: 'string',
      description: 'Staff notes about customer',
      isNullable: true,
    },
    {
      name: 'createdAt',
      type: 'datetime',
      description: 'Registration date',
      isFilterable: true,
      isSortable: true,
    },
  ],

  relations: [
    {
      name: 'orders',
      targetTable: 'Order',
      type: 'one-to-many',
      foreignKey: 'customerId',
      description: 'Orders placed by this customer',
    },
    {
      name: 'reviews',
      targetTable: 'Review',
      type: 'one-to-many',
      foreignKey: 'customerId',
      description: 'Reviews left by this customer',
    },
    {
      name: 'customerGroup',
      targetTable: 'CustomerGroup',
      type: 'one-to-one',
      foreignKey: 'customerGroupId',
      description: 'Customer segment membership',
    },
  ],

  semanticMappings: [
    {
      pattern: 'clientes|customers',
      intent: 'customers',
      columns: ['firstName', 'lastName', 'totalSpent', 'totalVisits'],
      examples: ['lista de clientes', 'cuantos clientes tengo'],
    },
    {
      pattern: 'mejor cliente|top cliente|cliente mas|mayor gasto',
      intent: 'topCustomer',
      columns: ['firstName', 'lastName', 'totalSpent', 'totalVisits'],
      aggregation: 'MAX',
      examples: ['quien es mi mejor cliente', 'cliente que mas gasta'],
    },
    {
      pattern: 'dejo de venir|no ha vuelto|cliente perdido|inactivo',
      intent: 'churningCustomer',
      columns: ['firstName', 'lastName', 'lastVisitAt', 'totalVisits'],
      examples: ['clientes que dejaron de venir', 'quien no ha vuelto'],
    },
    {
      pattern: 'clientes nuevos|nuevos clientes|registros',
      intent: 'newCustomers',
      columns: ['firstName', 'createdAt'],
      aggregation: 'COUNT',
      examples: ['clientes nuevos este mes', 'cuantos se registraron'],
    },
    {
      pattern: 'cumpleanos|birthday|cumple',
      intent: 'customerBirthdays',
      columns: ['firstName', 'birthDate'],
      examples: ['cumpleanos de hoy', 'cumpleanos esta semana'],
    },
    {
      pattern: 'vip|premium|top',
      intent: 'vipCustomers',
      columns: ['firstName', 'totalSpent', 'tags'],
      examples: ['clientes VIP', 'lista premium'],
    },
    {
      pattern: 'frecuencia|visitas|recurrente',
      intent: 'customerFrequency',
      columns: ['firstName', 'totalVisits', 'averageOrderValue'],
      examples: ['clientes mas frecuentes', 'quien viene mas seguido'],
    },
  ],

  commonQueries: [
    // Best customer by spend
    `SELECT "firstName", "lastName", "totalSpent", "totalVisits" FROM "Customer" WHERE "venueId" = $1 ORDER BY "totalSpent" DESC LIMIT 1`,
    // Churning customers (no visit in 30 days with >3 previous visits)
    `SELECT "firstName", "lastName", "lastVisitAt", "totalVisits" FROM "Customer" WHERE "venueId" = $1 AND "totalVisits" > 3 AND "lastVisitAt" < NOW() - INTERVAL '30 days' ORDER BY "totalSpent" DESC`,
    // New customers this month
    `SELECT COUNT(*) FROM "Customer" WHERE "venueId" = $1 AND "createdAt" >= DATE_TRUNC('month', CURRENT_DATE)`,
    // Customer lifetime value distribution
    `SELECT CASE WHEN "totalSpent" < 500 THEN 'Low' WHEN "totalSpent" < 2000 THEN 'Medium' ELSE 'High' END as segment, COUNT(*) FROM "Customer" WHERE "venueId" = $1 GROUP BY 1`,
  ],

  industries: {
    telecom: {
      enabled: true,
      hiddenColumns: ['loyaltyPoints'],
      customDescription: 'Customers who purchase telecom products',
    },
  },
}

export const REVIEW_TABLE: TableDefinition = {
  name: 'Review',
  description: 'Customer reviews and ratings',
  category: 'customer',

  accessLevel: 'PUBLIC',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'WAITER'],

  tenant: {
    field: 'venueId',
    required: true,
    autoInject: true,
  },

  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'Review identifier',
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
      description: 'Associated order',
      isForeignKey: true,
      foreignKeyTable: 'Order',
      isNullable: true,
      isFilterable: true,
    },
    {
      name: 'customerId',
      type: 'string',
      description: 'Customer who left review',
      isForeignKey: true,
      foreignKeyTable: 'Customer',
      isNullable: true,
      isFilterable: true,
    },
    {
      name: 'staffId',
      type: 'string',
      description: 'Staff member reviewed',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isNullable: true,
      isFilterable: true,
      aliases: ['mesero'],
    },
    {
      name: 'overallRating',
      type: 'integer',
      description: 'Overall rating (1-5 stars)',
      isFilterable: true,
      isAggregatable: true,
      aliases: ['calificacion', 'rating', 'estrellas'],
    },
    {
      name: 'foodRating',
      type: 'integer',
      description: 'Food quality rating (1-5)',
      isNullable: true,
      isAggregatable: true,
      aliases: ['comida'],
    },
    {
      name: 'serviceRating',
      type: 'integer',
      description: 'Service rating (1-5)',
      isNullable: true,
      isAggregatable: true,
      aliases: ['servicio'],
    },
    {
      name: 'ambienceRating',
      type: 'integer',
      description: 'Ambience rating (1-5)',
      isNullable: true,
      isAggregatable: true,
      aliases: ['ambiente'],
    },
    {
      name: 'comment',
      type: 'string',
      description: 'Written review comment',
      isNullable: true,
      aliases: ['comentario', 'opinion'],
    },
    {
      name: 'source',
      type: 'enum',
      description: 'Review source',
      enumValues: ['TPV', 'WEB', 'EMAIL', 'MANUAL'],
      isFilterable: true,
    },
    {
      name: 'createdAt',
      type: 'datetime',
      description: 'Review submission date',
      isFilterable: true,
      isSortable: true,
      aliases: ['fecha'],
    },
  ],

  relations: [
    {
      name: 'customer',
      targetTable: 'Customer',
      type: 'one-to-one',
      foreignKey: 'customerId',
      description: 'Customer who left review',
    },
    {
      name: 'staff',
      targetTable: 'Staff',
      type: 'one-to-one',
      foreignKey: 'staffId',
      description: 'Staff member reviewed',
    },
    {
      name: 'order',
      targetTable: 'Order',
      type: 'one-to-one',
      foreignKey: 'orderId',
      description: 'Associated order',
    },
  ],

  semanticMappings: [
    {
      pattern: 'resenas|reviews|opiniones',
      intent: 'reviews',
      columns: ['overallRating', 'comment'],
      examples: ['ultimas resenas', 'reviews del mes'],
    },
    {
      pattern: 'calificacion promedio|rating promedio|estrellas',
      intent: 'averageRating',
      columns: ['overallRating'],
      aggregation: 'AVG',
      examples: ['calificacion promedio', 'cuantas estrellas tengo'],
    },
    {
      pattern: 'malas resenas|reviews negativos|quejas',
      intent: 'negativeReviews',
      columns: ['overallRating', 'comment'],
      examples: ['reviews de 1 estrella', 'quejas de clientes'],
    },
    {
      pattern: 'calificacion.*mesero|rating.*staff',
      intent: 'staffRating',
      columns: ['serviceRating', 'staffId'],
      aggregation: 'AVG',
      examples: ['rating por mesero', 'calificacion de servicio'],
    },
  ],

  commonQueries: [
    `SELECT AVG("overallRating") as avg_rating FROM "Review" WHERE "venueId" = $1`,
    `SELECT s."firstName", AVG(r."overallRating") as rating FROM "Review" r JOIN "Staff" s ON r."staffId" = s.id WHERE r."venueId" = $1 GROUP BY s.id ORDER BY rating DESC`,
    `SELECT * FROM "Review" WHERE "venueId" = $1 AND "overallRating" <= 2 ORDER BY "createdAt" DESC LIMIT 10`,
  ],
}
