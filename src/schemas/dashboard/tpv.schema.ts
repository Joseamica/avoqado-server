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
  status?: TerminalStatus
  type?: TerminalType
}

// Define el tipo para actualizar un TPV (basado en el schema real de Prisma)
export type UpdateTpvBody = {
  name?: string
  serialNumber?: string
  type?: TerminalType
  status?: TerminalStatus
  lastHeartbeat?: Date
  config?: any // JSON field in Prisma
}

// Create TPV body payload
export type CreateTpvBody = {
  name: string
  serialNumber: string
  type?: TerminalType
  config?: any
}
