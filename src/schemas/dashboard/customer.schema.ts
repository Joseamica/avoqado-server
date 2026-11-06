import { z } from 'zod'

// ==========================================
// PARAMETER SCHEMAS
// ==========================================

export const CustomerParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Negocio inválido'),
    customerId: z.string().cuid('Cliente inválido'),
  }),
})

export const VenueIdParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Negocio inválido'),
  }),
})

/**
 * Fase 1 — decisión de aprobación de un cliente.
 *
 * `expectedVersion` NO es opcional a propósito: es el write-CAS. Quien decide manda la
 * versión que tenía en pantalla; si alguien más ya decidió, el server responde 409 en vez
 * de pisar la decisión ajena en silencio.
 */
export const CustomerApprovalDecisionSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('ID de negocio inválido'),
    customerId: z.string().cuid('ID de cliente inválido'),
  }),
  body: z.object({
    decision: z.enum(['APPROVED', 'REJECTED'], { errorMap: () => ({ message: 'La decisión debe ser APPROVED o REJECTED' }) }),
    reason: z.string().trim().max(500, 'El motivo no puede exceder 500 caracteres').optional(),
    expectedVersion: z.coerce.number().int().min(0, 'La versión esperada es requerida'),
  }),
})

export const CustomersAwaitingApprovalQuerySchema = z.object({
  params: z.object({
    venueId: z.string().cuid('ID de negocio inválido'),
  }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
})

// ==========================================
// QUERY SCHEMAS
// ==========================================

export const CustomersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    customerGroupId: z.string().cuid().optional(),
    noGroup: z
      .string()
      .optional()
      .transform(val => val === 'true'), // Query params are strings, convert properly
    tags: z.string().optional(), // Comma-separated tags
    sortBy: z.enum(['createdAt', 'totalSpent', 'visitCount', 'lastVisit', 'name']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    hasPendingBalance: z
      .string()
      .optional()
      .transform(val => val === 'true'), // Query params are strings, convert properly
  }),
})

// ==========================================
// BODY SCHEMAS
// ==========================================

/**
 * Fecha civil (cumpleaños) — NUNCA hora.
 *
 * 🔴 `z.coerce.date()` delegaba en el parser de `Date` de JS, que acepta cualquier cosa que
 * V8 sepa adivinar (incl. `10/05/1990` como MM/DD, silenciosamente en la zona del HOST) y
 * normaliza distinto según el formato de entrada. Aquí se exige `YYYY-MM-DD` (o ese mismo
 * prefijo con hora/zona, que se recorta) y SIEMPRE se fija a medianoche UTC de ese día civil
 * — coincide con `Customer.birthDate @db.Date` (Task 1), que no tiene hora.
 */
const FechaCivil = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, 'La fecha debe tener formato YYYY-MM-DD')
  .transform(s => new Date(`${s.slice(0, 10)}T00:00:00.000Z`))
  .refine(d => !Number.isNaN(d.getTime()), 'Fecha inválida')

/**
 * D15 (5-nov-2026): el panel manda el campo vacío ("") cuando la persona no escribió correo o teléfono, y el alta sólo
 * con teléfono tronaba con «Invalid email format». En el alta, "" es «sin ese dato».
 */
const vacioEsAusente = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v)
const Texto = z.string({ invalid_type_error: 'Debe ser texto' })
const Genero = z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'], { errorMap: () => ({ message: 'Género no válido' }) })
const Correo = Texto.email('El correo no es válido')
const Telefono = Texto.regex(/^\+?[0-9]{10,15}$/, 'El teléfono debe tener de 10 a 15 dígitos')

export const CreateCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Negocio inválido'),
  }),
  body: z
    .object({
      email: z.preprocess(vacioEsAusente, Correo.optional()),
      phone: z.preprocess(vacioEsAusente, Telefono.optional()),
      firstName: Texto.min(1, 'El nombre no puede quedar vacío').max(50, 'El nombre es demasiado largo').optional(),
      lastName: Texto.min(1, 'El apellido no puede quedar vacío').max(50, 'El apellido es demasiado largo').optional(),
      birthDate: FechaCivil.optional(),
      gender: Genero.optional(),
      customerGroupId: z.string().cuid('Grupo de clientes inválido').optional(),
      notes: Texto.max(1000, 'Las notas no pueden pasar de 1000 caracteres').optional(),
      tags: z.array(z.string().max(50, 'Cada etiqueta puede tener hasta 50 caracteres')).optional(),
      marketingConsent: z.boolean().default(false),
    })
    .refine(data => data.email || data.phone, {
      message: 'Se requiere email o teléfono',
      path: ['email'], // Show error on email field
    }),
})

export const UpdateCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Negocio inválido'),
    customerId: z.string().cuid('Cliente inválido'),
  }),
  body: z
    .object({
      // Al editar, "" pasa tal cual: `updateCustomer` decide (sin ese dato antes = no cambia; con dato = no se borra).
      email: z.union([z.literal(''), Correo], { errorMap: () => ({ message: 'El correo no es válido' }) }).optional(),
      phone: z.union([z.literal(''), Telefono], { errorMap: () => ({ message: 'El teléfono debe tener de 10 a 15 dígitos' }) }).optional(),
      firstName: Texto.min(1, 'El nombre no puede quedar vacío').max(50, 'El nombre es demasiado largo').optional(),
      lastName: Texto.min(1, 'El apellido no puede quedar vacío').max(50, 'El apellido es demasiado largo').optional(),
      birthDate: FechaCivil.optional(),
      gender: Genero.optional(),
      customerGroupId: z.string().cuid('Grupo de clientes inválido').nullable().optional(),
      notes: Texto.max(1000, 'Las notas no pueden pasar de 1000 caracteres').optional(),
      tags: z.array(z.string().max(50, 'Cada etiqueta puede tener hasta 50 caracteres')).optional(),
      marketingConsent: z.boolean().optional(),
      active: z.boolean().optional(),
    })
    .refine(data => Object.keys(data).length > 0, {
      message: 'Cambia al menos un dato del cliente',
    }),
})

/**
 * Editar cliente desde el POS (ANDROID e iOS, 26-oct-2026). Mismo permiso que el dashboard (`customers:update`),
 * pero la puerta de las apps SÓLO cambia datos de contacto: `.strict()` rechaza `active`, `tags`, consentimiento, etc.
 * Mismos formatos que `UpdateCustomerSchema`; los mensajes van en español porque las apps los muestran.
 */
export const MobileUpdateCustomerSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Negocio inválido'),
    customerId: z.string().cuid('Cliente inválido'),
  }),
  body: z
    .object({
      firstName: z.string().min(1, 'El nombre no puede quedar vacío').max(50, 'El nombre es demasiado largo').optional(),
      lastName: z.string().min(1, 'El apellido no puede quedar vacío').max(50, 'El apellido es demasiado largo').optional(),
      phone: z
        .string()
        .regex(/^\+?[0-9]{10,15}$/, 'El teléfono debe tener de 10 a 15 dígitos')
        .optional(),
      email: z.string().email('El correo no es válido').optional(),
    })
    .strict('Desde el POS sólo se edita nombre, apellido, teléfono y correo')
    .refine(data => Object.keys(data).length > 0, { message: 'Cambia al menos un dato del cliente' }),
})

// ==========================================
// TYPE EXPORTS
// ==========================================

export type CreateCustomerDTO = z.infer<typeof CreateCustomerSchema>['body']
export type UpdateCustomerDTO = z.infer<typeof UpdateCustomerSchema>['body']
export type CustomersQueryDTO = z.infer<typeof CustomersQuerySchema>['query']
export type CustomerParamsDTO = z.infer<typeof CustomerParamsSchema>['params']
