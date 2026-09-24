/**
 * Núcleo del reembolso (spec KDS Uber §3.1): bloquear el cobro original → validar → reclamar o
 * heredar el turno → escribir la fila REFUND. Ésta es la ruta estable para los carriles que no
 * son el dashboard (el ajuste compensatorio de reparto).
 *
 * La implementación vive en `dashboard/refund.dashboard.service.ts` porque el guardia AST de
 * turnos (`tests/unit/services/shared/paymentShiftClaim.callers.guard.test.ts`) exige que el
 * `create` del Payment, su reclamo de turno y su auditoría se rastreen hasta un
 * `prisma.$transaction` del MISMO archivo — el de `issueRefund`.
 */
export { bloquearCobroParaReembolso, writeRefundInTx } from '../dashboard/refund.dashboard.service'
export type { WriteRefundInput } from '../dashboard/refund.dashboard.service'
