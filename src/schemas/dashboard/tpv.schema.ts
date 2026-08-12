import { Terminal, TerminalStatus, TerminalType } from '@prisma/client'

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

// Define el tipo para actualizar un TPV (basado en el schema real de Prisma)
export type UpdateTpvBody = {
  name?: string
  serialNumber?: string
  type?: TerminalType
  status?: TerminalStatus
  brand?: string // Hardware manufacturer (PAX, Ingenico, etc.)
  model?: string // Hardware model (A910S, D220, etc.)
  lastHeartbeat?: Date
  config?: any // JSON field in Prisma
  /** Mostrador invertido: el cliente ve la pantalla grande y el cajero la chica. Por dispositivo. */
  customerDisplayInverted?: boolean
}

// Create TPV body payload
export type CreateTpvBody = {
  name: string
  serialNumber?: string // Optional: can be added later via activation
  type?: TerminalType
  status?: TerminalStatus // Optional: defaults to PENDING_ACTIVATION if no serialNumber
  config?: any
}
