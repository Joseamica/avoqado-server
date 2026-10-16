import { z } from 'zod'
import { HHMM_PATTERN, isValidOrderingHours, MAX_RANGES_PER_DAY } from '@/services/online-ordering/hours'

const venueParams = z.object({ venueId: z.string().min(1, 'Negocio inválido') })
const orderParams = venueParams.extend({ orderId: z.string().min(1, 'Pedido inválido') })

/** R16: horas 00–23 y minutos 00–59. El cierre PUEDE ser menor que la apertura: es el horario nocturno (20:00–02:00). */
const hhmm = z.string().regex(HHMM_PATTERN, 'Hora inválida: usa HH:MM entre 00:00 y 23:59')
const hoursDay = z.object({
  enabled: z.boolean({ invalid_type_error: 'El estado del día debe ser verdadero o falso' }),
  ranges: z.array(z.object({ open: hhmm, close: hhmm })).max(MAX_RANGES_PER_DAY, `Máximo ${MAX_RANGES_PER_DAY} franjas por día`),
})
/**
 * H5 (r2): la forma la revisa Zod (mensajes por campo y el esquema que ve el MCP); la REGLA la decide `isValidOrderingHours`, la
 * MISMA función que la precarga del horario (tarea 4). Así lo que se puede guardar y lo que se precarga nunca se contradicen.
 */
export const hoursSchema = z
  .object({
    monday: hoursDay,
    tuesday: hoursDay,
    wednesday: hoursDay,
    thursday: hoursDay,
    friday: hoursDay,
    saturday: hoursDay,
    sunday: hoursDay,
  })
  .refine(h => isValidOrderingHours(h), {
    message:
      'Horario inválido: un día abierto necesita al menos una franja y la apertura no puede ser igual al cierre (el cierre sí puede ser de madrugada, p. ej. 20:00–02:00)',
  })

/** Ajustes que se pueden cambiar. El MISMO esquema lo usa la herramienta del MCP (R19). */
export const settingsPatchBody = z
  .object({
    enabled: z.boolean(),
    // Pesos con centavos (columna `Decimal(10, 2)`). Se mira el número tal como llegó: `0.1 + 0.2` o `1e-7` no son centavos.
    minOrderAmount: z
      .number()
      .min(0, 'No puede ser negativo')
      .max(100_000, 'Monto demasiado alto')
      .refine(v => /^\d+(\.\d{1,2})?$/.test(String(v)), 'El monto admite máximo 2 decimales'),
    defaultPrepMinutes: z.number().int('Debe ser un número entero').min(1, 'Mínimo 1 minuto').max(240, 'Máximo 240 minutos'),
    acceptsPayAtPickup: z.boolean(),
    manualPause: z.boolean(),
    // ISO 8601 en UTC (`…Z`) o con desfase (`…-06:00`): el MCP (tarea 14) comparte este esquema y puede mandar hora local.
    pausedUntil: z.string().datetime({ offset: true, message: 'Fecha inválida' }).nullable(),
    hours: hoursSchema.nullable(),
  })
  .partial()
  .strict('Hay un campo que no existe en los ajustes de la tienda en línea')

export const menuAvailabilityBody = z
  .object({
    availableOnline: z.boolean(),
    productIds: z.array(z.string().min(1)).max(500, 'Máximo 500 platillos por vez').optional(),
    categoryIds: z.array(z.string().min(1)).max(100, 'Máximo 100 categorías por vez').optional(),
    allProducts: z.boolean().optional(),
  })
  .refine(b => b.allProducts === true || (b.productIds?.length ?? 0) > 0 || (b.categoryIds?.length ?? 0) > 0, {
    message: 'Indica qué platillos cambiar',
  })

/** R12: lo que se puede frenar desde el piso (permiso `online-orders:pause`); `null` reanuda. */
export const floorPauseMinutes = z
  .union([z.literal(15), z.literal(30), z.literal(60)], { errorMap: () => ({ message: 'Elige 15, 30 o 60 minutos' }) })
  .nullable()

export const inboxSchema = z.object({
  params: venueParams,
  query: z.object({
    status: z.enum(['pending', 'active', 'done', 'all'], { errorMap: () => ({ message: 'Filtro inválido' }) }).optional(),
  }),
})
export const orderActionSchema = z.object({ params: orderParams })
export const acceptSchema = z.object({
  params: orderParams,
  body: z.object({
    estimatedMinutes: z.number().int('Debe ser un número entero').min(1, 'Mínimo 1 minuto').max(240, 'Máximo 240 minutos').optional(),
  }),
})
export const rejectSchema = z.object({
  params: orderParams,
  body: z.object({
    reason: z.enum(['OUT_OF_ITEMS', 'CLOSED', 'TOO_BUSY', 'OTHER'], { errorMap: () => ({ message: 'Motivo inválido' }) }),
    note: z.string().trim().max(200, 'La nota admite hasta 200 caracteres').optional(),
  }),
})
export const pauseSchema = z.object({ params: venueParams, body: z.object({ minutes: floorPauseMinutes }) })
export const settingsGetSchema = z.object({ params: venueParams })
export const settingsPatchSchema = z.object({ params: venueParams, body: settingsPatchBody })
export const menuAvailabilitySchema = z.object({ params: venueParams, body: menuAvailabilityBody })
