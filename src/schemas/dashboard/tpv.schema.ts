import { Terminal, TerminalStatus, TerminalType } from '@prisma/client'
import { z } from 'zod'

// Define la estructura de la respuesta paginada para las terminales
export type PaginatedTerminalsResponse = {
  data: Terminal[] // El array de terminales obtenidas
  meta: {
    total: number
    page: number
    pageSize: number
    pageCount: number
  }
}

// Opcional: Define los tipos para los filtros del query
export type GetTerminalsQuery = {
  page?: string
  pageSize?: string
  // Legacy single-value filters (backward compat)
  status?: TerminalStatus
  type?: TerminalType
  // Multi-select arrays serialized as comma-separated strings
  statuses?: string
  types?: string
  versions?: string
  /** Clase de aparato (device registry): PHONE, TABLET, HANDHELD_POS… */
  formFactors?: string
  connections?: string
  activations?: string
  /** provisioned | selfRegistered — hardware dado de alta por admin vs auto-registrado. */
  origins?: string
  search?: string
}

/**
 * 🔴 Lo ÚNICO que el dashboard puede cambiar de una terminal por `PUT /venues/:venueId/tpv/:tpvId`.
 *
 * Antes el cuerpo entero llegaba a Prisma (auditoría de Codex del spec «pantalla del cliente», 3ª ronda,
 * 2026-09-16, D1): con `tpv:update` en su negocio, un gerente podía mandar `venueId` (mover su terminal a
 * otro negocio), `assignedMerchantIds` (conectarla a cuentas de cobro ajenas) o `deviceUid`. Mover una
 * terminal o asignarle comercios vive en la consola de superadmin, que tiene su propia validación.
 *
 * El servicio escribe SÓLO estos campos, venga de donde venga la llamada: la lista vive aquí para que la
 * ruta, el controlador y el servicio no puedan divergir.
 */
export const UPDATABLE_TPV_FIELDS = [
  'name',
  'serialNumber',
  'type',
  'status',
  'brand',
  'model',
  'config',
  'customerDisplayInverted',
] as const

export type UpdateTpvBody = {
  name?: string
  serialNumber?: string
  type?: TerminalType
  status?: TerminalStatus
  brand?: string // Hardware manufacturer (PAX, Ingenico, etc.)
  model?: string // Hardware model (A910S, D220, etc.)
  /** JSON de la terminal: objeto, o el texto JSON que manda el formulario del dashboard. */
  config?: unknown
  /** Mostrador invertido: el cliente ve la pantalla grande y el cajero la chica. Por dispositivo. */
  customerDisplayInverted?: boolean
}

/** El formulario del dashboard manda '' en los campos opcionales vacíos: eso significa «sin cambio». */
const vacioEsSinCambio = (value: unknown) => (value === '' ? undefined : value)

const textoEditable = (campo: string) => z.string({ invalid_type_error: `${campo} debe ser texto` }).max(255, `${campo} es demasiado largo`)

export const updateTpvSchema = z.object({
  body: z
    .object({
      name: z
        .string({ invalid_type_error: 'El nombre debe ser texto' })
        .trim()
        .min(1, 'El nombre es requerido')
        .max(255, 'El nombre es demasiado largo')
        .optional(),
      serialNumber: z.preprocess(vacioEsSinCambio, textoEditable('La serie').trim().min(1, 'La serie es requerida').optional()),
      type: z.preprocess(
        vacioEsSinCambio,
        z.nativeEnum(TerminalType, { errorMap: () => ({ message: 'El tipo de terminal no es válido' }) }).optional(),
      ),
      status: z.preprocess(
        vacioEsSinCambio,
        z.nativeEnum(TerminalStatus, { errorMap: () => ({ message: 'El estado de la terminal no es válido' }) }).optional(),
      ),
      brand: textoEditable('La marca').optional(),
      model: textoEditable('El modelo').optional(),
      config: z.preprocess(
        vacioEsSinCambio,
        z
          .union([z.string(), z.record(z.string(), z.unknown())], {
            errorMap: () => ({ message: 'La configuración debe ser un objeto JSON' }),
          })
          .optional(),
      ),
      customerDisplayInverted: z.boolean({ invalid_type_error: 'La pantalla invertida debe ser verdadero o falso' }).optional(),
    })
    // Las llaves que no están arriba NO se rechazan: un cliente viejo puede mandar de más. Pasan hasta el
    // controlador, que deja constancia en el log, y el servicio las descarta.
    .passthrough(),
})

// Create TPV body payload
export type CreateTpvBody = {
  name: string
  serialNumber?: string // Optional: can be added later via activation
  type?: TerminalType
  status?: TerminalStatus // Optional: defaults to PENDING_ACTIVATION if no serialNumber
  config?: any
}
