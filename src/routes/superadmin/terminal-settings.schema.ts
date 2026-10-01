import { z } from 'zod'
import type { TpvSettings } from '../../services/dashboard/tpv.dashboard.service'

const toggle = z.boolean({ invalid_type_error: 'Debe ser verdadero o falso' }).optional()
const integer = z.number({ invalid_type_error: 'Debe ser un número' }).int('Debe ser entero')
const fields = {
  showReviewScreen: toggle,
  showTipScreen: toggle,
  showReceiptScreen: toggle,
  defaultTipPercentage: integer.min(0, 'Mínimo 0').max(100, 'Máximo 100').nullable().optional(),
  tipSuggestions: z
    .array(integer.min(1, 'Mínimo 1').max(100, 'Máximo 100'))
    .min(1, 'Agrega al menos una propina')
    .max(6, 'Máximo 6 propinas')
    .refine(values => new Set(values).size === values.length, 'No repitas porcentajes')
    .optional(),
  requirePinLogin: toggle,
  requireAvoqadoServerForCardPayment: toggle,
  showVerificationScreen: toggle,
  requireVerificationPhoto: toggle,
  requireVerificationBarcode: toggle,
  requireClockInPhoto: toggle,
  requireClockOutPhoto: toggle,
  requireClockInToLogin: toggle,
  kioskModeEnabled: toggle,
  kioskDefaultMerchantId: z.string().cuid('Selecciona un comercio válido').nullable().optional(),
  showQuickPayment: toggle,
  showOrderManagement: toggle,
  showReports: toggle,
  showPayments: toggle,
  showSupport: toggle,
  showGoals: toggle,
  showMessages: toggle,
  showTrainings: toggle,
  showCheckout: toggle,
  requireDepositPhoto: toggle,
  requireFacadePhoto: toggle,
  enableCashPayments: toggle,
  enableCardPayments: toggle,
  enableBarcodeScanner: toggle,
  enableSerializedInventory: toggle,
  attendanceTracking: toggle,
  cellularFailoverMode: z
    .enum(['OFF', 'MANUAL_TOGGLE', 'AUTO_SHADOW', 'AUTO_ENFORCED'], { errorMap: () => ({ message: 'Modo de conexión no válido' }) })
    .optional(),
  cellularFailoverBadReadingsThreshold: integer.min(1, 'Mínimo 1').max(100, 'Máximo 100').optional(),
  cellularFailoverCooldownSeconds: integer.min(0, 'Mínimo 0').max(86400, 'Máximo 86400 segundos').optional(),
  cellularFailoverMinCellHoldSeconds: integer.min(0, 'Mínimo 0').max(86400, 'Máximo 86400 segundos').optional(),
  paymentLedgerMode: z.enum(['OFF', 'SHADOW', 'ACTIVE'], { errorMap: () => ({ message: 'Modo de recuperación no válido' }) }).optional(),
} satisfies Record<keyof TpvSettings, z.ZodTypeAny>

export const terminalSettingsBody = z
  .object({ ...fields, trackPromoterLocation: z.boolean().nullable().optional() })
  .strict('Hay ajustes no reconocidos')
  .refine(value => Object.keys(value).length > 0, 'Selecciona al menos un ajuste')
