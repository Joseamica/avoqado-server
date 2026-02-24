import { z } from 'zod'

// ==========================================
// ORG TERMINAL MANAGEMENT SCHEMAS
// ==========================================

const OrgIdParams = z.object({
  orgId: z.string().cuid('ID de organización inválido'),
})

const OrgTerminalParams = z.object({
  orgId: z.string().cuid('ID de organización inválido'),
  terminalId: z.string().cuid('ID de terminal inválido'),
})

// Commands allowed at org level (excludes high-risk: FACTORY_RESET, SHUTDOWN, FORCE_UPDATE, INSTALL_VERSION)
const OrgAllowedCommands = ['LOCK', 'UNLOCK', 'MAINTENANCE_MODE', 'EXIT_MAINTENANCE', 'RESTART', 'CLEAR_CACHE', 'EXPORT_LOGS'] as const

/**
 * GET /:orgId/terminals/:terminalId
 */
export const GetOrgTerminalSchema = z.object({
  params: OrgTerminalParams,
})

/**
 * POST /:orgId/terminals
 */
export const CreateOrgTerminalSchema = z.object({
  body: z.object({
    venueId: z.string().cuid('ID de sucursal inválido'),
    serialNumber: z.string().min(1, 'El número de serie es requerido'),
    name: z.string().min(1, 'El nombre es requerido').max(255, 'El nombre no puede exceder 255 caracteres'),
    type: z.enum(['TPV_ANDROID', 'TPV_IOS', 'PRINTER_RECEIPT', 'PRINTER_KITCHEN', 'KDS'], {
      errorMap: () => ({ message: 'Tipo de terminal inválido' }),
    }),
    brand: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
    assignedMerchantIds: z.array(z.string().cuid('ID de comercio inválido')).optional(),
    generateActivationCode: z.boolean().optional(),
  }),
  params: OrgIdParams,
})
export type CreateOrgTerminalDto = z.infer<typeof CreateOrgTerminalSchema>['body']

/**
 * PATCH /:orgId/terminals/:terminalId
 */
export const UpdateOrgTerminalSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'El nombre es requerido').max(255, 'El nombre no puede exceder 255 caracteres').optional(),
    status: z
      .enum(['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'RETIRED'], {
        errorMap: () => ({ message: 'Estado inválido' }),
      })
      .optional(),
    brand: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
    assignedMerchantIds: z.array(z.string().cuid('ID de comercio inválido')).optional(),
  }),
  params: OrgTerminalParams,
})
export type UpdateOrgTerminalDto = z.infer<typeof UpdateOrgTerminalSchema>['body']

/**
 * DELETE /:orgId/terminals/:terminalId
 */
export const DeleteOrgTerminalSchema = z.object({
  params: OrgTerminalParams,
})

/**
 * POST /:orgId/terminals/:terminalId/generate-activation-code
 */
export const GenerateActivationCodeSchema = z.object({
  params: OrgTerminalParams,
})

/**
 * POST /:orgId/terminals/:terminalId/remote-activate
 */
export const RemoteActivateSchema = z.object({
  params: OrgTerminalParams,
})

/**
 * POST /:orgId/terminals/:terminalId/command
 */
export const SendOrgCommandSchema = z.object({
  body: z.object({
    command: z.enum(OrgAllowedCommands, {
      errorMap: () => ({
        message: `Comando no permitido. Comandos válidos: ${OrgAllowedCommands.join(', ')}`,
      }),
    }),
  }),
  params: OrgTerminalParams,
})
export type SendOrgCommandDto = z.infer<typeof SendOrgCommandSchema>['body']

/**
 * PUT /:orgId/terminals/:terminalId/merchants
 */
export const AssignMerchantsSchema = z.object({
  body: z.object({
    merchantIds: z.array(z.string().cuid('ID de comercio inválido')),
  }),
  params: OrgTerminalParams,
})
export type AssignMerchantsDto = z.infer<typeof AssignMerchantsSchema>['body']

/**
 * GET /:orgId/merchant-accounts
 */
export const GetOrgMerchantAccountsSchema = z.object({
  params: OrgIdParams,
})
