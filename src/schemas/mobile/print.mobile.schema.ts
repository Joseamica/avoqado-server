/**
 * Zod schemas de PRINT_STATIONS para el namespace /mobile (POS iOS/Android).
 * Mensajes en español; shape/formato aquí, reglas de negocio en el service.
 */
import { z } from 'zod'

const JOB_REASON = ['ORIGINAL', 'ADDITION', 'CANCEL', 'REPRINT'] as const
const JOB_TYPE = ['KITCHEN_TICKET', 'RECEIPT', 'EXPO', 'TEST', 'CASH_CLOSE'] as const
const JOB_STATUS = ['QUEUED', 'SENT', 'DONE', 'UNCERTAIN', 'OPERATOR_CONFIRMED', 'FAILED'] as const
const PRINTER_STATUS = ['ONLINE', 'OFFLINE', 'PAPER_LOW', 'PAPER_OUT', 'ERROR'] as const

export const printConfigParamSchema = z.object({
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
})

/** POST /mobile/venues/:venueId/print-jobs/sync — el gateway replica su outbox durable. */
export const syncPrintJobsSchema = z.object({
  body: z
    .object({
      jobs: z
        .array(
          z
            .object({
              id: z.string().min(1, 'El id del job es requerido').max(64, 'Máximo 64 caracteres'),
              eventId: z.string().min(1, 'El eventId es requerido').max(120, 'Máximo 120 caracteres'),
              reason: z.enum(JOB_REASON, { message: 'Motivo inválido' }),
              seq: z.number({ message: 'Secuencia inválida' }).int('La secuencia debe ser un entero').min(1, 'Mínimo 1'),
              type: z.enum(JOB_TYPE, { message: 'Tipo de job inválido' }),
              status: z.enum(JOB_STATUS, { message: 'Estado inválido' }),
              stationId: z.string().min(1).nullable().optional(),
              printerId: z.string().min(1).nullable().optional(),
              gatewayTerminalId: z.string().min(1).max(120).nullable().optional(),
              originTerminalId: z.string().min(1).max(120).nullable().optional(),
              orderId: z.string().min(1).nullable().optional(),
              orderItemIds: z.array(z.string().min(1)).max(200, 'Máximo 200 líneas por job').optional(),
              attempts: z.number().int().min(0).optional(),
              error: z.string().max(500, 'Máximo 500 caracteres').nullable().optional(),
              payload: z.any().optional(),
            })
            .strict(),
        )
        .min(1, 'Envía al menos un job')
        .max(200, 'Máximo 200 jobs por lote'),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

/** POST /mobile/venues/:venueId/print-gateway/heartbeat — latido del gateway + estado de impresoras. */
export const gatewayHeartbeatSchema = z.object({
  body: z
    .object({
      terminalId: z.string().min(1, 'El dispositivo (gateway) es requerido').max(120, 'Máximo 120 caracteres'),
      address: z.string().max(120, 'Máximo 120 caracteres').nullable().optional(),
      printers: z
        .array(
          z
            .object({
              printerId: z.string().min(1, 'La impresora es requerida'),
              status: z.enum(PRINTER_STATUS, { message: 'Estado de impresora inválido' }),
            })
            .strict(),
        )
        .max(50, 'Máximo 50 impresoras')
        .optional(),
    })
    .strict(),
  params: z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough(),
  query: z.object({}).passthrough().optional(),
})

export type SyncPrintJobsInput = z.infer<typeof syncPrintJobsSchema>['body']
export type GatewayHeartbeatInput = z.infer<typeof gatewayHeartbeatSchema>['body']
