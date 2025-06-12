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
