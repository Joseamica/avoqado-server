import { z } from 'zod'

/**
 * Zod schemas for the superadmin platform-billing endpoints (Avoqado → cliente).
 *
 * Shape/format ONLY — business rules live in the services. Zod messages MUST be in
 * Spanish; the validation middleware shows them to the user raw.
 */

const rfc = z
  .string({ required_error: 'El RFC es requerido' })
  .trim()
  .min(12, 'El RFC debe tener 12 o 13 caracteres')
  .max(13, 'El RFC debe tener 12 o 13 caracteres')

const cp = z
  .string({ required_error: 'El código postal es requerido' })
  .trim()
  .regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos')

const regimen = z
  .string({ required_error: 'El régimen fiscal es requerido' })
  .trim()
  .regex(/^\d{3}$/, 'El régimen fiscal debe ser un código de 3 dígitos')

export const upsertEmisorSchema = z.object({
  body: z.object({
    rfc,
    legalName: z.string({ required_error: 'La razón social es requerida' }).trim().min(1, 'La razón social es requerida'),
    regimenFiscal: regimen,
    lugarExpedicion: cp,
    serie: z.string().trim().max(10, 'La serie no puede exceder 10 caracteres').optional(),
    defaultUsoCfdi: z.string().trim().optional(),
  }),
})

/** Provision in Facturapi (auto) OR bind an existing org/key created in the panel (manual). */
export const provisionEmisorSchema = z.object({
  body: z
    .object({
      providerOrgId: z.string().trim().min(1).optional(),
      liveKey: z.string().trim().min(1).optional(),
    })
    .refine(b => (b.providerOrgId == null) === (b.liveKey == null), {
      message: 'Para el alta manual debes enviar providerOrgId y liveKey juntos (o ninguno para provisionar automático)',
    }),
})

export const uploadCsdSchema = z.object({
  body: z.object({
    cerBase64: z.string({ required_error: 'El archivo .cer es requerido' }).min(1, 'El archivo .cer es requerido'),
    keyBase64: z.string({ required_error: 'El archivo .key es requerido' }).min(1, 'El archivo .key es requerido'),
    csdPassword: z.string({ required_error: 'La contraseña del CSD es requerida' }).min(1, 'La contraseña del CSD es requerida'),
  }),
})

const customerType = z.enum(['ORGANIZATION', 'VENUE', 'STANDALONE'], {
  errorMap: () => ({ message: 'El tipo de cliente debe ser ORGANIZATION, VENUE o STANDALONE' }),
})

export const upsertTaxProfileSchema = z.object({
  body: z.object({
    customerType,
    organizationId: z.string().trim().min(1).optional(),
    venueId: z.string().trim().min(1).optional(),
    displayName: z.string().trim().max(120).optional(),
    rfc,
    razonSocial: z.string({ required_error: 'La razón social es requerida' }).trim().min(1, 'La razón social es requerida'),
    regimenFiscal: regimen,
    codigoPostal: cp,
    defaultUsoCfdi: z.string().trim().optional(),
    email: z.string().trim().email('El correo no es válido').optional(),
  }),
})

export const attachConstanciaSchema = z.object({
  body: z.object({
    constanciaUrl: z.string({ required_error: 'La URL de la constancia es requerida' }).trim().url('La URL de la constancia no es válida'),
  }),
})

const lineSchema = z.object({
  description: z
    .string({ required_error: 'La descripción del concepto es requerida' })
    .trim()
    .min(1, 'La descripción del concepto es requerida'),
  satProductKey: z
    .string({ required_error: 'La clave de producto SAT es requerida' })
    .trim()
    .min(1, 'La clave de producto SAT es requerida'),
  satUnitKey: z.string({ required_error: 'La clave de unidad SAT es requerida' }).trim().min(1, 'La clave de unidad SAT es requerida'),
  quantity: z.number({ required_error: 'La cantidad es requerida' }).positive('La cantidad debe ser mayor a 0'),
  unitPriceCents: z
    .number({ required_error: 'El precio unitario es requerido' })
    .int('El precio debe estar en centavos enteros')
    .min(0, 'El precio no puede ser negativo'),
  discountCents: z.number().int('El descuento debe estar en centavos enteros').min(0, 'El descuento no puede ser negativo').optional(),
  taxRate: z
    .number()
    .min(0, 'La tasa de IVA no puede ser negativa')
    .max(1, 'La tasa de IVA se expresa como fracción (ej. 0.16)')
    .optional(),
  taxExempt: z.boolean().optional(),
})

export const issueInvoiceSchema = z.object({
  body: z.object({
    billingTaxProfileId: z
      .string({ required_error: 'El perfil fiscal del receptor es requerido' })
      .trim()
      .min(1, 'El perfil fiscal del receptor es requerido'),
    lines: z.array(lineSchema).min(1, 'La factura requiere al menos un concepto'),
    formaPago: z.string({ required_error: 'La forma de pago es requerida' }).trim().min(1, 'La forma de pago es requerida'),
    metodoPago: z.enum(['PUE', 'PPD'], { errorMap: () => ({ message: 'El método de pago debe ser PUE o PPD' }) }),
    serie: z.string().trim().max(10).optional(),
    usoCfdi: z.string().trim().optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
    sandbox: z.boolean().optional(),
  }),
})

export const listInvoicesSchema = z.object({
  query: z.object({
    status: z.string().trim().optional(),
    type: z.enum(['INGRESO', 'PAGO']).optional(),
    organizationId: z.string().trim().optional(),
    venueId: z.string().trim().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
})

export const cancelInvoiceSchema = z.object({
  body: z.object({
    motivo: z.enum(['01', '02', '03', '04'], { errorMap: () => ({ message: 'El motivo de cancelación debe ser 01, 02, 03 o 04' }) }),
    substituteUuid: z.string().trim().optional(),
  }),
})

export const registerPaymentSchema = z.object({
  body: z.object({
    paymentDate: z.string({ required_error: 'La fecha de pago es requerida' }).trim().min(1, 'La fecha de pago es requerida'),
    formaPago: z.string({ required_error: 'La forma de pago es requerida' }).trim().min(1, 'La forma de pago es requerida'),
    // Monto del abono en centavos enteros. Omitir = pago total del saldo (parcialidad).
    amountCents: z.number().int('El monto debe estar en centavos enteros').positive('El monto debe ser mayor a 0').optional(),
    idempotencyKey: z.string().trim().min(1).optional(),
  }),
})

export const sendEmailSchema = z.object({
  body: z.object({
    email: z.string().trim().email('El correo no es válido').optional(),
  }),
})
