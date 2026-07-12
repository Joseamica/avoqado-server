/**
 * Zod schemas del feature MERCHANT_ROUTING_RULES (reglas condicionales de
 * visibilidad/auto-selección de merchants en TPV).
 *
 * Reglas del repo: mensajes SIEMPRE en español; shape/formato aquí, reglas de
 * negocio en el service. Montos en PESOS (unidades mayores, 1:1) — nunca centavos.
 */
import { StaffRole } from '@prisma/client'
import { z } from 'zod'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const scheduleWindowSchema = z
  .object({
    start: z.string().regex(HHMM, 'Hora de inicio inválida (formato HH:mm)'),
    end: z.string().regex(HHMM, 'Hora de fin inválida (formato HH:mm)'),
  })
  .strict()
  .refine(w => w.start !== w.end, { message: 'La ventana no puede iniciar y terminar a la misma hora' })

const scheduleSchema = z
  .object({
    // 0=domingo … 6=sábado (convención JS, igual que el motor)
    days: z
      .array(z.number({ message: 'Día inválido' }).int('Día inválido').min(0, 'Día inválido').max(6, 'Día inválido'))
      .min(1, 'Selecciona al menos un día')
      .max(7, 'Máximo 7 días'),
    windows: z.array(scheduleWindowSchema).min(1, 'Agrega al menos una ventana de horario').max(4, 'Máximo 4 ventanas de horario'),
  })
  .strict()

const geofenceSchema = z
  .object({
    lat: z.number({ message: 'Latitud inválida' }).min(-90, 'Latitud inválida').max(90, 'Latitud inválida'),
    lng: z.number({ message: 'Longitud inválida' }).min(-180, 'Longitud inválida').max(180, 'Longitud inválida'),
    radiusM: z.number({ message: 'Radio inválido' }).min(10, 'El radio mínimo es 10 metros').max(100_000, 'El radio máximo es 100 km'),
  })
  .strict()

const volumeCapSchema = z
  .object({
    period: z.enum(['DAY', 'WEEK', 'MONTH'], { message: 'Período inválido (DAY, WEEK o MONTH)' }),
    // PESOS (unidades mayores)
    maxAmount: z.number({ message: 'Tope de monto inválido' }).positive('El tope de monto debe ser mayor a 0').optional(),
    maxTxCount: z
      .number({ message: 'Tope de transacciones inválido' })
      .int('El tope de transacciones debe ser un entero')
      .positive('El tope de transacciones debe ser mayor a 0')
      .optional(),
  })
  .strict()
  .refine(v => v.maxAmount !== undefined || v.maxTxCount !== undefined, {
    message: 'Define al menos un tope (monto o número de transacciones)',
  })

const ticketAmountSchema = z
  .object({
    // PESOS (unidades mayores)
    min: z.number({ message: 'Monto mínimo inválido' }).nonnegative('El monto mínimo no puede ser negativo').optional(),
    max: z.number({ message: 'Monto máximo inválido' }).positive('El monto máximo debe ser mayor a 0').optional(),
  })
  .strict()
  .refine(t => t.min !== undefined || t.max !== undefined, { message: 'Define al menos un límite de monto (mínimo o máximo)' })
  .refine(t => t.min === undefined || t.max === undefined || t.max >= t.min, {
    message: 'El monto máximo debe ser mayor o igual al mínimo',
  })

const staffSchema = z
  .object({
    staffIds: z.array(z.string().min(1, 'Empleado inválido')).max(200, 'Máximo 200 empleados por regla').optional(),
    roles: z
      .array(z.nativeEnum(StaffRole, { message: 'Rol inválido' }))
      .max(20, 'Máximo 20 roles')
      .optional(),
  })
  .strict()
  .refine(s => (s.staffIds?.length ?? 0) > 0 || (s.roles?.length ?? 0) > 0, {
    message: 'Selecciona al menos un empleado o un rol',
  })

const circuitBreakerSchema = z
  .object({
    consecutiveFailures: z
      .number({ message: 'Número de fallos inválido' })
      .int('El número de fallos debe ser un entero')
      .min(1, 'Mínimo 1 fallo consecutivo')
      .max(20, 'Máximo 20 fallos consecutivos'),
    cooldownMinutes: z
      .number({ message: 'Minutos de espera inválidos' })
      .int('Los minutos de espera deben ser un entero')
      .min(1, 'Mínimo 1 minuto de espera')
      .max(1440, 'Máximo 24 horas (1440 minutos) de espera'),
  })
  .strict()

/** Shape completo del Json `MerchantRoutingRule.conditions`. */
export const merchantRoutingConditionsSchema = z
  .object({
    schedule: scheduleSchema.optional(),
    geofence: geofenceSchema.optional(),
    volumeCap: volumeCapSchema.optional(),
    ticketAmount: ticketAmountSchema.optional(),
    staff: staffSchema.optional(),
    circuitBreaker: circuitBreakerSchema.optional(),
  })
  .strict()
  .refine(c => Object.keys(c).length > 0, { message: 'Configura al menos una condición' })

export type MerchantRoutingConditionsInput = z.infer<typeof merchantRoutingConditionsSchema>

/** PUT /dashboard/venues/:venueId/merchant-routing-rules — upsert por merchant. */
export const upsertMerchantRoutingRuleSchema = z.object({
  body: z
    .object({
      merchantAccountId: z.string().min(1, 'El merchant es requerido'),
      active: z.boolean({ message: 'El estado activo/inactivo es requerido' }),
      conditions: merchantRoutingConditionsSchema,
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

/** DELETE /dashboard/venues/:venueId/merchant-routing-rules/:merchantAccountId */
export const deleteMerchantRoutingRuleSchema = z.object({
  body: z.object({}).passthrough().optional(),
  params: z
    .object({
      venueId: z.string().min(1, 'El venue es requerido'),
      merchantAccountId: z.string().min(1, 'El merchant es requerido'),
    })
    .passthrough(),
  query: z.object({}).passthrough().optional(),
})

/**
 * POST /tpv/venues/:venueId/merchant-eligibility y
 * POST /dashboard/venues/:venueId/merchant-routing-rules/preview (simulador).
 * Montos en PESOS.
 */
export const merchantEligibilityRequestSchema = z.object({
  body: z
    .object({
      amount: z.number({ message: 'El monto es requerido' }).nonnegative('El monto no puede ser negativo'),
      staffId: z.string().min(1).optional(),
      lat: z.number().min(-90, 'Latitud inválida').max(90, 'Latitud inválida').optional(),
      lng: z.number().min(-180, 'Longitud inválida').max(180, 'Longitud inválida').optional(),
      terminalSerial: z.string().min(1).optional(),
      /** Solo simulador (dashboard): evaluar como si fuera esta fecha/hora ISO. */
      simulateAt: z.string().datetime({ message: 'Fecha de simulación inválida (ISO 8601)' }).optional(),
    })
    .strict()
    .refine(b => (b.lat === undefined) === (b.lng === undefined), {
      message: 'Latitud y longitud deben enviarse juntas',
    }),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

export type MerchantEligibilityRequestInput = z.infer<typeof merchantEligibilityRequestSchema>['body']
