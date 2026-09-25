/**
 * ¿Puede esta persona ADMINISTRAR los cobros en línea (conectar/desconectar Mercado Pago) de este
 * negocio?
 *
 * 🔴 Antes bastaba PERTENECER al negocio (`userHasVenueAccess`): un mesero podía conectar la cuenta
 * de Mercado Pago de otra persona o desconectar la del negocio (Codex gpt-6-astra, 24-sep). Ahora
 * se exige `venues:manage` en ESE negocio — el mismo permiso que protege el resto de la
 * administración de comercios en línea (`/venues/:venueId/ecommerce-merchants`).
 */
import { esSuperadminReal } from './rolVigente'
import { getUserAccess, hasPermission } from './access.service'
import { userHasVenueAccess } from '../staffOrganization.service'

export async function puedeAdministrarCobros(staffId: string, venueId: string): Promise<boolean> {
  if (await esSuperadminReal(staffId)) return true
  if (!(await userHasVenueAccess(staffId, venueId))) return false
  try {
    return hasPermission(await getUserAccess(staffId, venueId), 'venues:manage')
  } catch {
    return false // si no se pueden resolver sus permisos, no se administra nada (falla cerrado)
  }
}
