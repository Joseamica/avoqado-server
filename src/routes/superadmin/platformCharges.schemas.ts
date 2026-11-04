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

const CUSTOMER_TYPE_MESSAGE = 'El tipo de cliente debe ser ORGANIZATION, VENUE o STANDALONE'
const customerType = z.enum(['ORGANIZATION', 'VENUE', 'STANDALONE'], { errorMap: () => ({ message: CUSTOMER_TYPE_MESSAGE }) })
const FREQUENCY_MESSAGE = 'La periodicidad debe ser WEEKLY, BIWEEKLY, MONTHLY o ONE_TIME'
const INVOICE_MODE_MESSAGE = 'El modo de factura debe ser AUTOMATIC, MANUAL o NONE'
const CONCEPTS_MESSAGE = 'Agrega al menos un concepto al cobro'
const INVOICE_ID_MESSAGE = 'Elige la factura de la que sale el cobro'

const frequency = z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ONE_TIME'], { errorMap: () => ({ message: FREQUENCY_MESSAGE }) })
const invoiceMode = z.enum(['AUTOMATIC', 'MANUAL', 'NONE'], { errorMap: () => ({ message: INVOICE_MODE_MESSAGE }) })
const ivaMode = z.enum(['WITHOUT_IVA', 'WITH_IVA'], {
  errorMap: () => ({ message: 'El IVA del concepto debe ser WITHOUT_IVA o WITH_IVA' }),
})

const anchorDate = z
  .string({ required_error: 'La fecha de inicio es requerida', invalid_type_error: 'La fecha de inicio no es válida' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato AAAA-MM-DD')

const concept = z.object({
  // El límite del SAT: lo que pase de ahí lo rechaza al timbrar, y ya en la factura la descripción no se puede corregir.
  description: text('La descripción del concepto es requerida').max(1000, 'La descripción no puede pasar de 1,000 letras'),
  amountCents: z
    .number({ required_error: 'El monto del concepto es requerido', invalid_type_error: 'El monto del concepto debe ser un número' })
    .int('El monto debe estar en centavos enteros'),
  ivaMode,
  // Opcionales en la FORMA: un cobro sin factura (NONE) no las pide y el formulario las manda vacías («»). Que MANUAL o AUTOMATIC sí las
  // necesiten es regla de negocio y la decide el servicio con el modo que queda tras combinar los cambios (`assertConceptKeys`).
  satProductKey: z.string({ invalid_type_error: 'La clave del SAT del concepto debe ser texto' }).optional(),
  satUnitKey: z.string({ invalid_type_error: 'La unidad del SAT del concepto debe ser texto' }).optional(),
})

const concepts = z.array(concept, {
  required_error: CONCEPTS_MESSAGE,
  invalid_type_error: 'Los conceptos deben ser una lista',
})

const chargeFields = {
  customerType,
  organizationId: optionalId,
  venueId: optionalId,
  customerName: text('Escribe el nombre del cliente').max(120, 'El nombre no puede pasar de 120 letras'),
  billingTaxProfileId: optionalId,
  frequency,
  anchorDate,
  concepts,
  invoiceMode,
}

/**
 * Dar de alta. Con `invoiceId` (una factura de «Facturas CFDI») la periodicidad, los conceptos y el modo no hacen falta: el servidor los deriva de la
 * factura (conceptos de ella, una sola vez, MANUAL) y, si el cuerpo los trae, los ignora. Sin `invoiceId` siguen siendo obligatorios, con los mismos
 * mensajes de siempre. Es una regla de FORMA entre campos del mismo cuerpo; lo que diga la factura (si cabe, de quién es) lo decide el servicio.
 * Zod revisa esta regla cuando lo demás ya es válido: con un cuerpo roto de otra forma, salen primero esos errores.
 */
const createChargeBody = z
  .object({
    ...chargeFields,
    frequency: frequency.optional(),
    concepts: concepts.optional(),
    invoiceMode: invoiceMode.optional(),
    invoiceId: z.string({ invalid_type_error: INVOICE_ID_MESSAGE }).min(1, INVOICE_ID_MESSAGE).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.invoiceId !== undefined) return
    const required = [
      ['frequency', body.frequency, FREQUENCY_MESSAGE],
      ['concepts', body.concepts, CONCEPTS_MESSAGE],
      ['invoiceMode', body.invoiceMode, INVOICE_MODE_MESSAGE],
    ] as const
    for (const [path, value, message] of required) {
      if (value === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })
    }
  })

export const createChargeSchema = z.object({ body: createChargeBody })

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

/**
 * Un filtro de varios valores llega por la URL de UNA de dos formas, y las dos se aceptan: el parámetro repetido (`frequency=WEEKLY&frequency=MONTHLY`)
 * o separado por comas (`frequency=WEEKLY,MONTHLY`), también mezclados. Sale siempre como arreglo sin repetidos; vacío o ausente es «sin filtro».
 */
function multi<T extends [string, ...string[]]>(values: T, message: string) {
  return z.preprocess(
    raw => {
      if (raw === undefined) return undefined
      const items = (Array.isArray(raw) ? raw : [raw]).flatMap(item => (typeof item === 'string' ? item.split(',') : [item]))
      return [...new Set(items.map(item => (typeof item === 'string' ? item.trim() : item)).filter(item => item !== ''))]
    },
    z.array(z.enum(values, { errorMap: () => ({ message }) })).optional(),
  )
}

const calendarDay = z
  .string({ invalid_type_error: 'La fecha debe tener el formato AAAA-MM-DD' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato AAAA-MM-DD')
  .optional()

/**
 * Los filtros de la lista de fechas de cobro y de sus grupos (los mismos en los dos). Sólo la FORMA: que un día exista y que «desde» no sea después de
 * «hasta» lo decide el servicio, que también atiende al MCP. `customer` es el nombre EXACTO del cliente (el de un grupo), no una búsqueda.
 */
const occurrenceFilters = {
  view: z.enum(['open', 'paid', 'skipped'], { errorMap: () => ({ message: 'La vista debe ser open, paid o skipped' }) }).optional(),
  q: search,
  frequency: multi(frequency.options, FREQUENCY_MESSAGE),
  invoice: multi(['STAMPED', 'PROBLEM', 'PENDING', 'NONE'], 'El estado de la factura debe ser STAMPED, PROBLEM, PENDING o NONE'),
  customerType: multi(customerType.options, CUSTOMER_TYPE_MESSAGE),
  from: calendarDay,
  to: calendarDay,
  customer: z
    .string({ invalid_type_error: 'El nombre del cliente no es válido' })
    .trim()
    .max(120, 'El nombre del cliente es demasiado largo')
    .optional(),
}

export const listOccurrencesSchema = z.object({ query: z.object({ ...occurrenceFilters, page, pageSize }) })

/** Cuántos cobros y cuánto suman, por cliente, mes, periodicidad o factura, con los mismos filtros que la lista. Un grupo no se pagina. */
export const groupOccurrencesSchema = z.object({
  query: z.object({
    groupBy: z.enum(['customer', 'month', 'frequency', 'invoice'], {
      errorMap: () => ({ message: 'Elige cómo agrupar: customer, month, frequency o invoice' }),
    }),
    ...occurrenceFilters,
  }),
})

/** Las facturas que se le pueden anexar a un cliente. Sin cliente ni RFC es 400: lo decide el servicio, que es quien sabe qué identifica a cada tipo. */
export const listInvoiceCandidatesSchema = z.object({
  query: z.object({
    customerType: customerType.optional(),
    organizationId: z.string({ invalid_type_error: 'El identificador no es válido' }).min(1, 'El identificador no es válido').optional(),
    venueId: z.string({ invalid_type_error: 'El identificador no es válido' }).min(1, 'El identificador no es válido').optional(),
    rfc: z.string({ invalid_type_error: 'El RFC debe ser texto' }).trim().max(13, 'El RFC es demasiado largo').optional(),
    q: search,
    page,
    pageSize,
  }),
})

/** Anexar a una fecha una factura que ya existe en «Facturas CFDI». */
export const linkInvoiceSchema = z.object({
  body: z.object({ cfdiId: text('Elige la factura que vas a anexar') }),
})

/** «Ya me pagó»: la casilla «Timbrar factura ahora» se manda SIEMPRE explícita (omitirla no puede volver manual una automática). */
/** Lo que el operador vio en pantalla al pedir la factura: si viene, es lo único que se puede timbrar. */
const confirmedReceptor = z
  .object({
    rfc: text('El RFC del receptor es requerido'),
    razonSocial: text('La razón social del receptor es requerida'),
    regimenFiscal: text('El régimen fiscal del receptor es requerido'),
    codigoPostal: text('El código postal del receptor es requerido'),
  })
  .optional()

export const payOccurrenceSchema = z.object({
  body: z
    .object({
      invoice: z.boolean({
        required_error: 'Indica si se timbra la factura ahora',
        invalid_type_error: 'invoice debe ser verdadero o falso',
      }),
      receptor: confirmedReceptor,
    })
    .refine(({ invoice, receptor }) => !invoice || receptor !== undefined, {
      message: 'Para timbrar hace falta confirmar a quién se le factura',
      path: ['receptor'],
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
    receptor: confirmedReceptor,
  }),
})
