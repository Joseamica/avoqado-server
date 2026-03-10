/**
 * Reservation & ClassSession Table Definitions
 */

import type { TableDefinition } from '../types'

export const RESERVATION_TABLE: TableDefinition = {
  name: 'Reservation',
  description: 'Reservations for tables, classes, and resources. Includes guest info, deposit tracking, and status management.',
  category: 'operations',

  accessLevel: 'RESTRICTED',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'],

  tenant: {
    field: 'venueId',
    required: true,
    autoInject: true,
  },

  columns: [
    { name: 'id', type: 'string', description: 'Reservation identifier', isPrimaryKey: true },
    { name: 'venueId', type: 'string', description: 'Venue ID', isForeignKey: true, foreignKeyTable: 'Venue', isFilterable: true },
    { name: 'confirmationCode', type: 'string', description: 'Human-readable confirmation code (e.g., RES-A3X7K2)' },
    {
      name: 'status',
      type: 'enum',
      description: 'Reservation status',
      enumValues: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
      isFilterable: true,
      aliases: ['estado'],
    },
    {
      name: 'channel',
      type: 'enum',
      description: 'Booking channel',
      enumValues: ['DASHBOARD', 'WEB', 'PHONE', 'WALK_IN'],
      isFilterable: true,
      aliases: ['canal'],
    },
    {
      name: 'startsAt',
      type: 'datetime',
      description: 'Reservation start time (UTC)',
      isFilterable: true,
      isSortable: true,
      aliases: ['fecha', 'hora', 'inicio'],
    },
    { name: 'endsAt', type: 'datetime', description: 'Reservation end time (UTC)', isFilterable: true },
    { name: 'duration', type: 'integer', description: 'Duration in minutes', isAggregatable: true },
    {
      name: 'customerId',
      type: 'string',
      description: 'Linked customer',
      isForeignKey: true,
      foreignKeyTable: 'Customer',
      isNullable: true,
      isFilterable: true,
    },
    {
      name: 'guestName',
      type: 'string',
      description: 'Guest name (for walk-ins without customer record)',
      isNullable: true,
      aliases: ['nombre', 'invitado'],
    },
    { name: 'partySize', type: 'integer', description: 'Number of guests', isAggregatable: true, aliases: ['personas', 'comensales'] },
    {
      name: 'tableId',
      type: 'string',
      description: 'Reserved table',
      isForeignKey: true,
      foreignKeyTable: 'Table',
      isNullable: true,
      isFilterable: true,
    },
    {
      name: 'productId',
      type: 'string',
      description: 'Reserved product/resource',
      isForeignKey: true,
      foreignKeyTable: 'Product',
      isNullable: true,
      isFilterable: true,
    },
    {
      name: 'classSessionId',
      type: 'string',
      description: 'Class session (if class reservation)',
      isForeignKey: true,
      foreignKeyTable: 'ClassSession',
      isNullable: true,
      isFilterable: true,
      aliases: ['clase', 'sesion'],
    },
    {
      name: 'assignedStaffId',
      type: 'string',
      description: 'Staff assigned to reservation',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isNullable: true,
      isFilterable: true,
    },
    {
      name: 'depositAmount',
      type: 'decimal',
      description: 'Deposit amount',
      isNullable: true,
      isAggregatable: true,
      aliases: ['deposito', 'anticipo'],
    },
    {
      name: 'depositStatus',
      type: 'enum',
      description: 'Deposit payment status',
      enumValues: ['PENDING', 'PAID', 'REFUNDED', 'WAIVED'],
      isNullable: true,
      isFilterable: true,
    },
    {
      name: 'createdById',
      type: 'string',
      description: 'Staff who created the reservation',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isNullable: true,
    },
    { name: 'createdAt', type: 'datetime', description: 'Creation date', isFilterable: true, isSortable: true },
  ],

  relations: [
    { name: 'customer', targetTable: 'Customer', type: 'one-to-one', foreignKey: 'customerId', description: 'Guest customer record' },
    {
      name: 'classSession',
      targetTable: 'ClassSession',
      type: 'one-to-one',
      foreignKey: 'classSessionId',
      description: 'Class session for class reservations',
    },
    {
      name: 'assignedStaff',
      targetTable: 'Staff',
      type: 'one-to-one',
      foreignKey: 'assignedStaffId',
      description: 'Staff assigned to this reservation',
    },
  ],

  semanticMappings: [
    {
      pattern: 'reservaciones|reservas|bookings',
      intent: 'reservations',
      columns: ['guestName', 'partySize', 'startsAt', 'status'],
      examples: ['reservaciones de hoy', 'cuantas reservaciones hay manana'],
    },
    {
      pattern: 'clases reservadas|reservaciones de clase|class bookings',
      intent: 'classReservations',
      columns: ['classSessionId', 'guestName', 'status'],
      examples: ['cuantas clases tengo reservadas', 'reservaciones de clases esta semana'],
    },
    {
      pattern: 'no show|no llegaron|cancelaciones',
      intent: 'noShows',
      columns: ['guestName', 'status', 'startsAt'],
      examples: ['cuantos no shows hoy', 'cancelaciones del mes'],
    },
    {
      pattern: 'depositos|anticipos',
      intent: 'deposits',
      columns: ['depositAmount', 'depositStatus', 'guestName'],
      aggregation: 'SUM',
      examples: ['total de depositos cobrados', 'depositos pendientes'],
    },
  ],

  commonQueries: [
    `SELECT COUNT(*) FROM "Reservation" WHERE "venueId" = $1 AND "startsAt" >= CURRENT_DATE AND "startsAt" < CURRENT_DATE + INTERVAL '1 day'`,
    `SELECT COUNT(*) FROM "Reservation" WHERE "venueId" = $1 AND "classSessionId" IS NOT NULL AND "status" != 'CANCELLED'`,
    `SELECT "status", COUNT(*) FROM "Reservation" WHERE "venueId" = $1 GROUP BY "status"`,
  ],
}

export const CLASS_SESSION_TABLE: TableDefinition = {
  name: 'ClassSession',
  description: 'Scheduled class sessions with capacity tracking. Links to Product for class type and Staff for instructor.',
  category: 'operations',

  accessLevel: 'RESTRICTED',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'],

  tenant: {
    field: 'venueId',
    required: true,
    autoInject: true,
  },

  columns: [
    { name: 'id', type: 'string', description: 'Session identifier', isPrimaryKey: true },
    { name: 'venueId', type: 'string', description: 'Venue ID', isForeignKey: true, foreignKeyTable: 'Venue', isFilterable: true },
    {
      name: 'productId',
      type: 'string',
      description: 'Class type (Product)',
      isForeignKey: true,
      foreignKeyTable: 'Product',
      isFilterable: true,
      aliases: ['tipo de clase', 'clase'],
    },
    {
      name: 'startsAt',
      type: 'datetime',
      description: 'Session start time (UTC)',
      isFilterable: true,
      isSortable: true,
      aliases: ['fecha', 'hora', 'inicio'],
    },
    { name: 'endsAt', type: 'datetime', description: 'Session end time (UTC)', isFilterable: true },
    { name: 'duration', type: 'integer', description: 'Duration in minutes', isAggregatable: true },
    {
      name: 'capacity',
      type: 'integer',
      description: 'Max participants for this session',
      isAggregatable: true,
      aliases: ['capacidad', 'cupo'],
    },
    {
      name: 'assignedStaffId',
      type: 'string',
      description: 'Instructor/staff assigned',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isNullable: true,
      isFilterable: true,
      aliases: ['instructor', 'profesor'],
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Session status',
      enumValues: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      isFilterable: true,
      aliases: ['estado'],
    },
    { name: 'internalNotes', type: 'string', description: 'Internal notes', isNullable: true },
    { name: 'createdAt', type: 'datetime', description: 'Creation date', isFilterable: true, isSortable: true },
  ],

  relations: [
    { name: 'product', targetTable: 'Product', type: 'one-to-one', foreignKey: 'productId', description: 'Class type' },
    {
      name: 'reservations',
      targetTable: 'Reservation',
      type: 'one-to-many',
      foreignKey: 'classSessionId',
      description: 'Reservations for this session',
    },
    { name: 'assignedStaff', targetTable: 'Staff', type: 'one-to-one', foreignKey: 'assignedStaffId', description: 'Instructor' },
  ],

  semanticMappings: [
    {
      pattern: 'clases|sesiones|sessions',
      intent: 'classSessions',
      columns: ['startsAt', 'capacity', 'status'],
      examples: ['clases de hoy', 'sesiones programadas'],
    },
    {
      pattern: 'ocupacion|llenas|disponibilidad',
      intent: 'classOccupancy',
      columns: ['capacity', 'startsAt'],
      examples: ['clases llenas', 'disponibilidad de clases'],
    },
  ],

  commonQueries: [
    `SELECT cs.*, p."name" as class_name FROM "ClassSession" cs JOIN "Product" p ON cs."productId" = p.id WHERE cs."venueId" = $1 AND cs."startsAt" >= CURRENT_DATE ORDER BY cs."startsAt"`,
    `SELECT cs.id, p."name", cs."capacity", COUNT(r.id) as booked FROM "ClassSession" cs JOIN "Product" p ON cs."productId" = p.id LEFT JOIN "Reservation" r ON r."classSessionId" = cs.id AND r."status" != 'CANCELLED' WHERE cs."venueId" = $1 GROUP BY cs.id, p."name", cs."capacity"`,
  ],
}
