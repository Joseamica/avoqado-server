import { z } from 'zod'
import { ACTIVE_CURSOR_PATTERN } from '@/services/online-ordering/constants'
import { HHMM_PATTERN, isValidOrderingHours, MAX_RANGES_PER_DAY } from '@/services/online-ordering/hours'
import { safeId } from '@/schemas/public/onlineOrdering.schema'

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
    acceptsCardOnline: z.boolean(),
    requiresAcceptance: z.boolean(),
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
    productIds: z.array(safeId('Platillo inválido')).max(500, 'Máximo 500 platillos por vez').optional(),
    categoryIds: z.array(safeId('Categoría inválida')).max(100, 'Máximo 100 categorías por vez').optional(),
    allProducts: z.boolean().optional(),
  })
  .refine(b => b.allProducts === true || (b.productIds?.length ?? 0) > 0 || (b.categoryIds?.length ?? 0) > 0, {
    message: 'Indica qué platillos cambiar',
  })

/** R12: lo que se puede frenar desde el piso (permiso `online-orders:pause`); `null` reanuda. */
export const floorPauseMinutes = z
  .union([z.literal(15), z.literal(30), z.literal(60)], { errorMap: () => ({ message: 'Elige 15, 30 o 60 minutos' }) })
  .nullable()

/** A8: el `nextCursor` de la página anterior de pedidos activos («<createdAt ISO>_<id>»). */
export const activeCursor = z
  .string()
  .max(80, 'Cursor inválido')
  .regex(ACTIVE_CURSOR_PATTERN, 'Cursor inválido')
  .refine(v => !Number.isNaN(Date.parse(v.slice(0, 24))), 'Cursor inválido')

export const inboxSchema = z.object({
  params: venueParams,
  query: z
    .object({
      status: z.enum(['pending', 'active', 'done', 'all'], { errorMap: () => ({ message: 'Filtro inválido' }) }).optional(),
      // A8: los activos se paginan por llave estable; sin cursor la bandeja responde igual que antes.
      cursor: activeCursor.optional(),
    })
    .refine(q => q.cursor === undefined || q.status === 'active', {
      message: 'El cursor sólo sirve para los pedidos activos (status=active)',
      path: ['cursor'],
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
/** Fase 2 (T10): devolver a la tarjeta. El monto va en PESOS (como todo el panel), con hasta dos decimales. */
/** La llave idempotente de «Devolver a la tarjeta»: en el encabezado `Idempotency-Key` (como la TPV) o, por compatibilidad, en el cuerpo. */
export const cardRefundKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'La llave de idempotencia debe tener de 8 a 64 caracteres alfanuméricos, guiones o guiones bajos')
export const cardRefundSchema = z.object({
  params: orderParams,
  body: z.object({
    amount: z
      .preprocess(
        v => (typeof v === 'number' ? String(v) : v),
        z
          .string({ required_error: 'El monto es obligatorio', invalid_type_error: 'El monto debe ser un número en pesos' })
          .regex(/^\d{1,7}(\.\d{1,2})?$/, 'El monto debe estar en pesos, con hasta dos decimales')
          .refine(v => Number(v) > 0, 'El monto debe ser mayor que cero'),
      )
      .describe('Monto a devolver en PESOS (no centavos), como texto decimal con hasta 2 decimales: "125.50"'),
    reason: z.enum(['RETURNED_GOODS', 'ACCIDENTAL_CHARGE', 'CANCELLED_ORDER', 'FRAUDULENT_CHARGE', 'OTHER'], {
      errorMap: () => ({ message: 'Motivo inválido' }),
    }),
    note: z.string().trim().max(200, 'La nota admite hasta 200 caracteres').optional(),
    // F1: opcional si viene el encabezado `Idempotency-Key`; si vienen los dos deben ser iguales (lo revisa el controlador).
    idempotencyKey: cardRefundKey.optional(),
    // La última devolución que vio el operador (`null`: ninguna). Obligatorio: sin él no se sabe sobre qué decidió.
    expectedLatestRefundId: z
      .string({
        required_error: 'Falta la última devolución que viste (null si no hay ninguna)',
        invalid_type_error: 'La última devolución que viste debe ser un id o null',
      })
      .min(1, 'La última devolución que viste debe ser un id o null')
      .max(64, 'La última devolución que viste debe ser un id o null')
      .nullable(),
  }),
})
/** «Devolver por otro medio» de una devolución a la tarjeta que falló después (sólo efectivo o transferencia). */
export const cardRefundResolveSchema = z.object({
  params: orderParams.extend({ refundId: z.string().min(1, 'Devolución inválida') }),
  body: z.object({
    method: z.enum(['CASH', 'BANK_TRANSFER'], { errorMap: () => ({ message: 'El método debe ser efectivo o transferencia' }) }),
    note: z.string().trim().max(200, 'La nota admite hasta 200 caracteres').optional(),
  }),
})
export const cardRefundsListSchema = z.object({ params: orderParams })
/** Rappi 2b: la lista «Rappi · por cobrar» de la bandeja (sin filtros: el servidor la acota). */
export const deliveryCashSchema = z.object({
  params: venueParams,
  // El `nextCursor` de la página anterior (opaco); sin él, la primera página.
  query: z.object({ cursor: z.string().max(200, 'Cursor inválido').optional() }),
})
/** 1b: el «menú en línea» del panel. El cursor es el `id` del último platillo de la página anterior (`nextCursor`). */
export const menuCategoryId = safeId('Categoría inválida')
export const menuCursor = safeId('Cursor inválido')
export const menuCategoriesSchema = z.object({ params: venueParams })
export const menuProductsSchema = z.object({
  params: venueParams,
  query: z.object({
    categoryId: menuCategoryId.optional(),
    // Postgres no guarda el byte nulo en un texto: sin esto sería un 500 en vez de un 400.
    search: z
      .string()
      .trim()
      .min(1, 'Búsqueda inválida')
      .max(80, 'Búsqueda inválida')
      .refine(s => !s.includes('\u0000'), 'Búsqueda inválida')
      .optional(),
    cursor: menuCursor.optional(),
    // Llega como texto en el query; por omisión 50 (lo pone el servicio).
    limit: z.coerce
      .number({ invalid_type_error: 'Límite inválido' })
      .int('Límite inválido')
      .min(1, 'Límite inválido')
      .max(100, 'Límite inválido')
      .optional(),
  }),
})
export const settingsGetSchema = z.object({ params: venueParams })
export const settingsPatchSchema = z.object({ params: venueParams, body: settingsPatchBody })
export const menuAvailabilitySchema = z.object({ params: venueParams, body: menuAvailabilityBody })
