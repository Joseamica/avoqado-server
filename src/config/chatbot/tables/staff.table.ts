/**
 * Staff Table Definitions
 * Employee records, shifts, and time tracking
 */

import type { TableDefinition } from '../types'

export const STAFF_TABLE: TableDefinition = {
  name: 'Staff',
  description: 'Employee records with profile info and authentication',
  category: 'operations',

  accessLevel: 'RESTRICTED',
  allowedRoles: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'],

  tenant: {
    field: 'id',
    required: true,
    autoInject: false, // Staff uses StaffOrganization junction table for org membership
    // To filter by org: JOIN StaffOrganization ON staffId = Staff.id WHERE organizationId = $orgId
  },

  columns: [
    {
      name: 'id',
      type: 'string',
      description: 'Staff member identifier',
      isPrimaryKey: true,
    },
    {
      name: 'firstName',
      type: 'string',
      description: 'First name',
      aliases: ['nombre'],
    },
    {
      name: 'lastName',
      type: 'string',
      description: 'Last name',
      aliases: ['apellido'],
    },
    {
      name: 'email',
      type: 'string',
      description: 'Email address (globally unique)',
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
    {
      name: 'employeeCode',
      type: 'string',
      description: 'Internal employee ID/code',
      isNullable: true,
      aliases: ['codigo empleado'],
    },
    {
      name: 'active',
      type: 'boolean',
      description: 'Is employee currently active',
      isFilterable: true,
      aliases: ['activo'],
    },
    {
      name: 'createdAt',
      type: 'datetime',
      description: 'Hire date / record creation',
      isFilterable: true,
      isSortable: true,
    },
    // Security - never expose
    {
      name: 'password',
      type: 'string',
      description: 'Hashed password',
      accessLevel: 'FORBIDDEN',
    },
    {
      name: 'googleId',
      type: 'string',
      description: 'Google OAuth ID',
      accessLevel: 'FORBIDDEN',
    },
  ],

  relations: [
    {
      name: 'venues',
      targetTable: 'StaffVenue',
      type: 'one-to-many',
      foreignKey: 'staffId',
      description: 'Venues this staff works at',
    },
    {
      name: 'shifts',
      targetTable: 'Shift',
      type: 'one-to-many',
      foreignKey: 'staffId',
      description: 'Shifts worked by this staff',
    },
    {
      name: 'ordersCreated',
      targetTable: 'Order',
      type: 'one-to-many',
      foreignKey: 'createdById',
      description: 'Orders created by this staff',
    },
    {
      name: 'timeEntries',
      targetTable: 'TimeEntry',
      type: 'one-to-many',
      foreignKey: 'staffId',
      description: 'Clock in/out records',
    },
  ],

  semanticMappings: [
    {
      pattern: 'empleados|staff|personal|meseros',
      intent: 'staff',
      columns: ['firstName', 'lastName', 'active'],
      examples: ['lista de empleados', 'personal activo'],
    },
    {
      pattern: 'mejor mesero|top staff|mejor empleado',
      intent: 'topStaff',
      columns: ['firstName', 'lastName'],
      examples: ['quien es el mejor mesero', 'top vendedores'],
    },
  ],

  commonQueries: [
    `SELECT s."firstName", s."lastName", COUNT(o.id) as orders, SUM(o."total") as sales FROM "Staff" s JOIN "Order" o ON s.id = o."createdById" WHERE o."venueId" = $1 GROUP BY s.id ORDER BY sales DESC`,
  ],

  industries: {
    telecom: {
      enabled: true,
      customDescription: 'Sales promoters and store staff',
    },
  },
}

export const SHIFT_TABLE: TableDefinition = {
  name: 'Shift',
  description: 'Staff work shifts with sales and cash tracking',
  category: 'operations',

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
      description: 'Shift identifier',
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
      name: 'staffId',
      type: 'string',
      description: 'Staff member working this shift',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isFilterable: true,
      aliases: ['empleado', 'mesero'],
    },
    {
      name: 'startTime',
      type: 'datetime',
      description: 'Shift start time',
      isFilterable: true,
      isSortable: true,
      aliases: ['inicio', 'entrada'],
    },
    {
      name: 'endTime',
      type: 'datetime',
      description: 'Shift end time',
      isNullable: true,
      isFilterable: true,
      aliases: ['fin', 'salida'],
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Shift status',
      enumValues: ['ACTIVE', 'COMPLETED', 'CANCELLED'],
      isFilterable: true,
      aliases: ['estado'],
    },
    {
      name: 'openingCash',
      type: 'decimal',
      description: 'Cash in drawer at shift start',
      isAggregatable: true,
      aliases: ['fondo inicial'],
    },
    {
      name: 'closingCash',
      type: 'decimal',
      description: 'Cash in drawer at shift end',
      isNullable: true,
      isAggregatable: true,
      aliases: ['efectivo final'],
    },
    {
      name: 'totalSales',
      type: 'decimal',
      description: 'Total sales during shift',
      isAggregatable: true,
      aliases: ['ventas', 'total vendido'],
    },
    {
      name: 'totalOrders',
      type: 'integer',
      description: 'Number of orders during shift',
      isAggregatable: true,
      aliases: ['ordenes'],
    },
    {
      name: 'notes',
      type: 'string',
      description: 'Shift notes',
      isNullable: true,
    },
  ],

  relations: [
    {
      name: 'staff',
      targetTable: 'Staff',
      type: 'one-to-one',
      foreignKey: 'staffId',
      description: 'Staff working the shift',
    },
    {
      name: 'orders',
      targetTable: 'Order',
      type: 'one-to-many',
      foreignKey: 'shiftId',
      description: 'Orders during this shift',
    },
  ],

  semanticMappings: [
    {
      pattern: 'turnos|shifts',
      intent: 'shifts',
      columns: ['startTime', 'status', 'totalSales'],
      examples: ['turnos de hoy', 'shifts activos'],
    },
    {
      pattern: 'turnos activos|quien esta trabajando|personal activo',
      intent: 'activeShifts',
      columns: ['status', 'staffId'],
      examples: ['quien esta trabajando ahora', 'turnos abiertos'],
    },
    {
      pattern: 'ventas por turno',
      intent: 'salesByShift',
      columns: ['totalSales', 'staffId'],
      aggregation: 'SUM',
      examples: ['ventas por turno', 'comparar turnos'],
    },
  ],

  commonQueries: [
    `SELECT s."firstName", sh."startTime", sh."totalSales" FROM "Shift" sh JOIN "Staff" s ON sh."staffId" = s.id WHERE sh."venueId" = $1 AND sh."status" = 'ACTIVE'`,
    `SELECT DATE(sh."startTime"), SUM(sh."totalSales") FROM "Shift" sh WHERE sh."venueId" = $1 GROUP BY DATE(sh."startTime")`,
  ],
}

export const TIME_ENTRY_TABLE: TableDefinition = {
  name: 'TimeEntry',
  description: 'Clock in/out records for attendance tracking',
  category: 'operations',

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
      description: 'Time entry identifier',
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
      name: 'staffId',
      type: 'string',
      description: 'Staff member',
      isForeignKey: true,
      foreignKeyTable: 'Staff',
      isFilterable: true,
    },
    {
      name: 'clockIn',
      type: 'datetime',
      description: 'Clock in time',
      isFilterable: true,
      isSortable: true,
      aliases: ['entrada', 'check-in'],
    },
    {
      name: 'clockOut',
      type: 'datetime',
      description: 'Clock out time',
      isNullable: true,
      isFilterable: true,
      aliases: ['salida', 'check-out'],
    },
    {
      name: 'hoursWorked',
      type: 'decimal',
      description: 'Hours worked (calculated)',
      isNullable: true,
      isAggregatable: true,
      aliases: ['horas', 'horas trabajadas'],
    },
    {
      name: 'status',
      type: 'enum',
      description: 'Entry status',
      enumValues: ['ACTIVE', 'COMPLETED', 'MODIFIED'],
      isFilterable: true,
    },
    {
      name: 'photoUrl',
      type: 'string',
      description: 'Check-in photo URL (for verification)',
      isNullable: true,
    },
    {
      name: 'gpsLatitude',
      type: 'decimal',
      description: 'GPS latitude at check-in',
      isNullable: true,
    },
    {
      name: 'gpsLongitude',
      type: 'decimal',
      description: 'GPS longitude at check-in',
      isNullable: true,
    },
  ],

  relations: [
    {
      name: 'staff',
      targetTable: 'Staff',
      type: 'one-to-one',
      foreignKey: 'staffId',
      description: 'Staff member for this entry',
    },
  ],

  semanticMappings: [
    {
      pattern: 'asistencia|attendance|checkin',
      intent: 'attendance',
      columns: ['clockIn', 'clockOut', 'staffId'],
      examples: ['asistencia de hoy', 'quien llego tarde'],
    },
    {
      pattern: 'horas trabajadas|tiempo trabajado',
      intent: 'hoursWorked',
      columns: ['hoursWorked', 'staffId'],
      aggregation: 'SUM',
      examples: ['horas trabajadas esta semana', 'tiempo de cada empleado'],
    },
  ],

  commonQueries: [
    `SELECT s."firstName", te."clockIn", te."clockOut", te."hoursWorked" FROM "TimeEntry" te JOIN "Staff" s ON te."staffId" = s.id WHERE te."venueId" = $1 AND te."clockIn" >= $2`,
    `SELECT s."firstName", SUM(te."hoursWorked") as total_hours FROM "TimeEntry" te JOIN "Staff" s ON te."staffId" = s.id WHERE te."venueId" = $1 GROUP BY s.id`,
  ],

  industries: {
    telecom: {
      enabled: true,
      customDescription: 'Promoter attendance and GPS-verified check-ins',
    },
  },
}
