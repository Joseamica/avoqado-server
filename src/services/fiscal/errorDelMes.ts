import AppError, { ServiceUnavailableError, ValidationError } from '../../errors/AppError'
import { MENSAJE_MES_NO_CALCULADO } from '../dashboard/accounting.dashboard.service'

/**
 * B4b (T6 M5, revisión final): el IVA en flujo y el ISR son de UN mes; ahí no hay «rango más corto» que elegir. Un `REPORT_TIMEOUT`
 * (también el de un estado de resultados de adentro, que trae el texto del rango) y un `REPORT_TOO_LARGE` del PERIODO (más de
 * 300,000 órdenes) salen con el texto mensual. El `REPORT_TOO_LARGE` de una VENTA (`details.motivo === 'ORDEN'`, lo arma el cargador
 * de libros) conserva su texto: nombra el folio y dice que escriban a soporte. Mismo código, mismo estado HTTP y mismos `details`;
 * sólo cambia el mensaje. Cualquier otro error pasa tal cual.
 */
export function comoErrorDelMes(e: unknown): unknown {
  if (!(e instanceof AppError)) return e
  if (e.code === 'REPORT_TIMEOUT') return new ServiceUnavailableError(MENSAJE_MES_NO_CALCULADO, 'REPORT_TIMEOUT')
  const motivo = (e.details as { motivo?: unknown } | null | undefined)?.motivo
  if (e.code === 'REPORT_TOO_LARGE' && motivo !== 'ORDEN')
    return new ValidationError(MENSAJE_MES_NO_CALCULADO, 'REPORT_TOO_LARGE', e.details)
  return e
}
