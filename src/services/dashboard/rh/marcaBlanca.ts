import { ForbiddenError } from '../../../errors/AppError'
import { moduleService, MODULE_CODES } from '../../modules/module.service'

/** Spec RH §5.3: identidad estable = el módulo de marca blanca (la misma regla que oculta Pago al personal). */
export async function pagoGenericoPermitido(venueId: string): Promise<boolean> {
  return !(await moduleService.isModuleEnabled(venueId, MODULE_CODES.WHITE_LABEL_DASHBOARD))
}

export async function asegurarSedeNoMarcaBlanca(venueId: string): Promise<void> {
  if (!(await pagoGenericoPermitido(venueId))) {
    throw new ForbiddenError('Puestos y relación de RH no está disponible en esta sucursal.')
  }
}
