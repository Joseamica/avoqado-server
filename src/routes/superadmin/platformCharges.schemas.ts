import { z } from 'zod'

/**
 * Zod de «Por cobrar» (cobros recurrentes de Avoqado a un cliente, spec 2026-11-02-por-cobrar-superadmin §5).
 *
 * SÓLO la forma de lo que llega: tipos, formato y qué campos existen (un campo que no esté aquí se descarta, así que nadie puede
 * escribir `pausedAt` ni `createdById` por el cuerpo). Las reglas —montos, fechas reales del calendario, tope de conceptos, perfil
 * fiscal del cliente— son del servicio (`charges.service.ts`). Los mensajes SON en español: el middleware se los enseña al operador.
 *
 * El tope de página NO se pone aquí: lo impone el servidor (`pageParams`), así que un `pageSize=500` se recorta a 100 y la
 * respuesta dice cuál usó.
 */

const text = (requiredMessage: string) =>
  z.string({ required_error: requiredMessage, invalid_type_error: requiredMessage }).min(1, requiredMessage)

/** Id opcional que también puede venir `null` (para quitarlo al editar). */
const optionalId = z.string({ invalid_type_error: 'El identificador no es válido' }).min(1, 'El identificador no es válido').nullish()

const customerType = z.enum(['ORGANIZATION', 'VENUE', 'STANDALONE'], {
  errorMap: () => ({ message: 'El tipo de cliente debe ser ORGANIZATION, VENUE o STANDALONE' }),
})
const frequency = z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY'], {
  errorMap: () => ({ message: 'La periodicidad debe ser WEEKLY, BIWEEKLY o MONTHLY' }),
})
const invoiceMode = z.enum(['AUTOMATIC', 'MANUAL'], {
  errorMap: () => ({ message: 'El modo de factura debe ser AUTOMATIC o MANUAL' }),
})
const ivaMode = z.enum(['WITHOUT_IVA', 'WITH_IVA'], {
  errorMap: () => ({ message: 'El IVA del concepto debe ser WITHOUT_IVA o WITH_IVA' }),
})

const anchorDate = z
  .string({ required_error: 'La fecha de inicio es requerida', invalid_type_error: 'La fecha de inicio no es válida' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato AAAA-MM-DD')

const concept = z.object({
  description: text('La descripción del concepto es requerida'),
  amountCents: z
    .number({ required_error: 'El monto del concepto es requerido', invalid_type_error: 'El monto del concepto debe ser un número' })
    .int('El monto debe estar en centavos enteros'),
  ivaMode,
  satProductKey: text('La clave del SAT del concepto es requerida'),
  satUnitKey: text('La unidad del SAT del concepto es requerida'),
})

const concepts = z.array(concept, {
  required_error: 'Agrega al menos un concepto al cobro',
  invalid_type_error: 'Los conceptos deben ser una lista',
})

const chargeFields = {
  customerType,
  organizationId: optionalId,
  venueId: optionalId,
  customerName: text('Escribe el nombre del cliente'),
  billingTaxProfileId: optionalId,
  frequency,
  anchorDate,
  concepts,
  invoiceMode,
}

export const createChargeSchema = z.object({ body: z.object(chargeFields) })

/** Editar manda sólo lo que cambia; lo que no viene no se toca. */
export const updateChargeSchema = z.object({ body: z.object(chargeFields).partial() })

export const pauseChargeSchema = z.object({
  body: z.object({
    /** «Omitirlo»: lo vencido y lo de hoy pasa a omitido de una vez. Sin esto se queda por cobrar. */
    skipOverdue: z.boolean({ invalid_type_error: 'skipOverdue debe ser verdadero o falso' }).default(false),
  }),
})

const page = z.coerce
  .number({ invalid_type_error: 'La página debe ser un número' })
  .int('La página debe ser un número entero')
  .min(1, 'La página debe ser al menos 1')
  .optional()
const pageSize = z.coerce
  .number({ invalid_type_error: 'El tamaño de página debe ser un número' })
  .int('El tamaño de página debe ser un número entero')
  .min(1, 'El tamaño de página debe ser al menos 1')
  .optional()
const search = z.string({ invalid_type_error: 'La búsqueda debe ser texto' }).trim().max(120, 'La búsqueda es demasiado larga').optional()

export const listChargesSchema = z.object({
  query: z.object({
    status: z.enum(['active', 'paused'], { errorMap: () => ({ message: 'El estado debe ser active o paused' }) }).optional(),
    q: search,
    page,
    pageSize,
  }),
})

export const listOccurrencesSchema = z.object({
  query: z.object({
    view: z.enum(['open', 'paid', 'skipped'], { errorMap: () => ({ message: 'La vista debe ser open, paid o skipped' }) }).optional(),
    q: search,
    page,
    pageSize,
  }),
})

/** «Ya me pagó»: la casilla «Timbrar factura ahora» se manda SIEMPRE explícita (omitirla no puede volver manual una automática). */
export const payOccurrenceSchema = z.object({
  body: z.object({
    invoice: z.boolean({
      required_error: 'Indica si se timbra la factura ahora',
      invalid_type_error: 'invoice debe ser verdadero o falso',
    }),
  }),
})

/** Facturar, reintentar o consultar el estado: los dos campos son para corregir el perfil fiscal o las claves del SAT. */
export const invoiceOccurrenceSchema = z.object({
  body: z.object({
    billingTaxProfileId: text('El perfil fiscal no es válido').optional(),
    conceptKeys: z
      .array(
        z.object({
          satProductKey: text('La clave del SAT del concepto es requerida'),
          satUnitKey: text('La unidad del SAT del concepto es requerida'),
        }),
        { invalid_type_error: 'Las claves del SAT deben ser una lista, un par por concepto' },
      )
      .optional(),
    // Lo que el operador vio en pantalla al pedir la factura: si viene, es lo único que se puede timbrar.
    receptor: z
      .object({
        rfc: text('El RFC del receptor es requerido'),
        razonSocial: text('La razón social del receptor es requerida'),
        regimenFiscal: text('El régimen fiscal del receptor es requerido'),
        codigoPostal: text('El código postal del receptor es requerido'),
      })
      .optional(),
  }),
})
