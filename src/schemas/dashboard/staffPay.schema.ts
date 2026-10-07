import { z } from 'zod'

export const venueParamsSchema = z.object({ venueId: z.string().cuid('Venue ID inválido') })
export const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')
const sedeSchema = z.string().cuid('Sede inválida')

export const levelParamsSchema = venueParamsSchema.extend({ levelId: z.string().cuid('Nivel inválido') })
export const staffParamsSchema = venueParamsSchema.extend({ staffId: z.string().cuid('Persona inválida') })
export const crearNivelSchema = z.object({ name: z.string().trim().min(1, 'Escribe un nombre').max(60, 'Máximo 60 caracteres') })
export const editarNivelSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre').max(60, 'Máximo 60 caracteres').optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
})
export const asignarNivelSchema = z.object({
  staffId: z.string().cuid('Persona inválida'),
  payLevelId: z.string().cuid('Nivel inválido'),
  effectiveFrom: fechaSchema,
  simular: z.boolean().optional(),
})
export const fechaQuerySchema = z.object({ fecha: fechaSchema.optional() })

export const tableParamsSchema = venueParamsSchema.extend({ tableId: z.string().cuid('Tabla inválida') })
export const crearTablaSchema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre').max(80, 'Máximo 80 caracteres'),
  productIds: z.array(z.string().cuid('Producto inválido')).max(200, 'Demasiados productos').default([]),
})
export const publicarVersionSchema = z.object({
  effectiveFrom: fechaSchema,
  countMode: z.enum(['BOOKED', 'ATTENDED'], { errorMap: () => ({ message: 'Modo de conteo inválido' }) }),
  maxCount: z.number().int('Debe ser un número entero').min(0, 'Mínimo 0').max(500, 'Máximo 500 lugares'),
  cells: z
    .array(
      z.object({
        payLevelId: z.string().cuid('Nivel inválido'),
        count: z.number().int('Debe ser un número entero').min(0, 'Mínimo 0'),
        amount: z.number().min(0, 'El monto no puede ser negativo').max(1_000_000, 'Monto demasiado grande'),
      }),
    )
    .max(20_000, 'Demasiadas celdas'),
  // Reglas de clase (spec fase 3 §7.3). Ausente = se hereda de la versión que rige; null = apagada. La pareja la revisa el service.
  coverBonusHours: z
    .number()
    .int('Escribe horas enteras')
    .min(1, 'Mínimo 1 hora')
    .max(168, 'Máximo 168 horas (una semana)')
    .nullable()
    .optional(),
  coverBonusAmount: z.number().gt(0, 'El bono debe ser mayor a $0').max(100_000, 'Máximo $100,000').nullable().optional(),
  lateCancelHours: z
    .number()
    .int('Escribe horas enteras')
    .min(1, 'Mínimo 1 hora')
    .max(168, 'Máximo 168 horas (una semana)')
    .nullable()
    .optional(),
  simular: z.boolean().optional(),
})
export const archivarTablaSchema = z.object({ archivedFrom: fechaSchema })

// Reporte del periodo abierto (spec §6.2): renglones paginados con tope duro de 100.
export const reporteQuerySchema = z.object({
  fecha: fechaSchema.optional(),
  sede: sedeSchema.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export const cursorQuerySchema = z.object({
  fecha: fechaSchema.optional(),
  sede: sedeSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

// Tarjeta y ajustes de una clase (spec §5.4). Sólo forma: la regla de negocio y la sede las revisa el service.
export const sessionPayParamsSchema = venueParamsSchema.extend({ sessionId: z.string().cuid('Clase inválida') })
export const ajusteClaseSchema = z.object({
  payCountOverride: z.number().int('Debe ser un número entero').min(0, 'Mínimo 0').max(500, 'Máximo 500').nullable(),
  payAmountOverride: z
    .number()
    .min(0, 'El monto no puede ser negativo')
    .max(1_000_000, 'Monto demasiado grande')
    .refine(n => Math.round(n * 100) / 100 === n, 'El monto admite hasta 2 decimales')
    .nullable(),
  payExcluded: z.boolean(),
  reason: z.string().trim().min(3, 'Escribe el motivo (mínimo 3 letras)').max(300, 'Máximo 300 caracteres'),
  /** Opcional (full-testing C14): la misma solicitud reintentada no se audita dos veces. */
  clientKey: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{8,100}$/, 'Clave de solicitud inválida')
    .optional(),
})

// ── Fase 2: cerrar y pagar (spec §6.3-6.5). Sólo forma: las reglas de negocio las revisa el service. ──
export const periodicidadSchema = z.object({
  periodicidad: z.enum(['MONTHLY', 'SEMIMONTHLY'], { errorMap: () => ({ message: 'Elige mensual o quincenal' }) }),
})
/** Fase 3 §7.1: activar pago al personal confirma la periodicidad (también la mensual de fábrica) y, opcional, la fecha de
 *  inicio que se mostró: si ya no es ésa, el service contesta 409 INICIO_CAMBIO (Codex bloque B #3).
 *  B11 (diseño r3.3): `sedes` opcional, las que entran desde el inicio (sin ella, todas las que tienen el plan). Que haya
 *  al menos una y que tengan el plan lo revisa el service (FALTA_SEDE, SEDE_SIN_PLAN). Estricto: un campo de más es 400. */
export const activarSchema = periodicidadSchema
  .extend({
    inicioEsperado: fechaSchema.optional(),
    sedes: z.array(sedeSchema).max(500, 'Demasiadas sedes').optional(),
  })
  .strict('Hay un campo que activar no acepta')
/** B11 (diseño r3.3, r4.6, r4.7): activar o desactivar UNA sede, con la fecha que se eligió (por defecto hoy en su zona) y,
 *  opcional, el «hoy» que se vio en la vista previa (`fechaEsperada`: si ya es otro día, 409 FECHA_CAMBIO). */
export const sedeParamsSchema = venueParamsSchema.extend({ sedeId: z.string().cuid('Sede inválida') })
export const activarSedeSchema = z
  .object({ desde: fechaSchema.optional(), fechaEsperada: fechaSchema.optional() })
  .strict('Hay un campo que activar la sede no acepta')
export const desactivarSedeSchema = z
  .object({ hasta: fechaSchema.optional(), fechaEsperada: fechaSchema.optional() })
  .strict('Hay un campo que desactivar la sede no acepta')
export const vistaPreviaSedeQuerySchema = z.object({
  accion: z.enum(['activar', 'desactivar'], { errorMap: () => ({ message: 'Elige activar o desactivar' }) }),
  fecha: fechaSchema.optional(),
})
/** Fase 3 §6.3: «Pagar las propinas en el recibo», sí o no. */
export const propinasSchema = z.object({
  encender: z.boolean({
    required_error: 'Indica si las propinas se pagan en el recibo',
    invalid_type_error: 'Indica si las propinas se pagan en el recibo',
  }),
})
export const fechaRequeridaQuerySchema = z.object({ fecha: fechaSchema })
/** «Ver periodos anteriores»: el listado se pide por páginas de 24; nada se recorta en silencio. */
export const listaPeriodosQuerySchema = z.object({ antesDe: fechaSchema.optional() })
export const cerrarPeriodoSchema = z.object({
  fecha: fechaSchema,
  huellaEsperada: z.string().regex(/^[a-f0-9]{64}$/, 'Revisa el cierre antes de confirmarlo'),
  confirmarHuerfanas: z.boolean().default(false),
})
export const periodParamsSchema = venueParamsSchema.extend({ periodId: z.string().cuid('Periodo inválido') })
/** Cuánto registraría «marcar pagado» (Codex bloque A #6): de todos los pendientes del periodo, o de una persona. */
export const pagadoPreviewQuerySchema = z.object({ staffId: z.string().cuid('Persona inválida').optional() })
export const marcarPagadoSchema = z.object({
  staffId: z.string().cuid('Persona inválida').optional(),
  nota: z.string().trim().max(200, 'Máximo 200 caracteres').optional(),
  /** La del preview (`paid-preview`): confirmar marca exactamente lo mostrado o responde HUELLA_CAMBIO. Opcional: sin ella, como antes. */
  huellaEsperada: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'Revisa la vista previa antes de confirmar')
    .optional(),
})
export const ajusteManualSchema = z.object({
  sede: sedeSchema,
  staffId: z.string().cuid('Persona inválida'),
  amount: z
    .number({ invalid_type_error: 'Escribe un monto' })
    .refine(n => n !== 0, 'El monto no puede ser cero')
    .refine(n => Math.abs(n) <= 1_000_000, 'Monto demasiado grande')
    .refine(n => Math.round(n * 100) / 100 === n, 'El monto admite hasta 2 decimales'),
  reason: z.string().trim().min(3, 'Escribe el motivo (mínimo 3 letras)').max(300, 'Máximo 300 caracteres'),
  fecha: fechaSchema.optional(),
  clientKey: z.string().regex(/^[A-Za-z0-9_.-]{8,120}$/, 'Clave de solicitud inválida'),
})
export const exportReciboQuerySchema = z.object({
  fecha: fechaSchema,
  format: z.enum(['pdf', 'xlsx'], { errorMap: () => ({ message: 'Formato inválido (pdf o xlsx)' }) }),
})
/** El recibo por páginas (Codex R2-R1-20): el cursor lo da la página anterior (`siguiente`). */
export const reciboQuerySchema = z.object({
  fecha: fechaSchema,
  /** Filtro de sede (Codex bloque A #5): el desglose de una sede suma sólo sus renglones, como el encabezado. */
  sede: sedeSchema.optional(),
  cursor: z.string().max(200, 'Cursor inválido').optional(),
  limit: z.coerce.number().int().min(1, 'Mínimo 1').max(500, 'Máximo 500').default(100),
})

// ── Bloque B: diferencias de un periodo cerrado y «Liquidar diferencia» (spec §6.4). ──
/** Lo pendiente de un periodo cerrado, por páginas: `limit` llega como NÚMERO (1-100, 50 por default). */
export const differencesQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export const destinoQuerySchema = z.object({ destinoFecha: fechaSchema.optional() })
export const liquidarSchema = z.object({
  periodoOrigenId: z.string().cuid('Periodo inválido'),
  huellaEsperada: z.string().regex(/^[a-f0-9]{64}$/, 'Revisa la diferencia antes de liquidarla'),
  /** Sin `:`: cada línea guarda `${solicitudId}:${persona}` (la misma regla que el service). */
  solicitudId: z.string().regex(/^[A-Za-z0-9_.-]{8,100}$/, 'Clave de solicitud inválida'),
  destinoFecha: fechaSchema.optional(),
  /** «Sumar la sede y liquidar»: la sede de la clase entra al periodo destino (SEDE_FUERA_DEL_PERIODO). */
  ampliarAlcance: z.boolean().optional(),
})
