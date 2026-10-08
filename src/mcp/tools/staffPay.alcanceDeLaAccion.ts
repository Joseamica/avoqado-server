// src/mcp/tools/staffPay.alcanceDeLaAccion.ts — fase 3, B14-fix2 (decisión del founder, 7-oct): lo que el MCP LEE para saber
// qué sedes abarca cada acción de toda la organización —las MISMAS en que el service exige `staffpay:close`—, sus nombres y si
// quien pide es dueño. Sólo lecturas, aparte de la regla (`staffPay.conexion.ts`) para que las pruebas del MCP las simulen.
import prisma from '@/utils/prismaClient'
import { sedesConServicePay } from '@/services/dashboard/staffPay/acceso'
import { sedesConVentana } from '@/services/dashboard/staffPay/participacion'
import { alcanceDelPreview } from '@/services/dashboard/staffPay/cierre.alcance'
import { sedesDeRecibo } from '@/services/dashboard/staffPay/recibos.service'
import { esDuenoDeLaOrganizacion } from '@/services/staffOrganization.service'
import type { McpScope } from '../scope'

const organizacionDe = async (venueId: string): Promise<string | null> =>
  (await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } }))?.organizationId ?? null

/**
 * Cerrar el periodo de `fecha`: el alcance de su periodo con la MISMA regla que la vista previa y el cierre (`alcanceDelPreview`:
 * guardadas ∪ con el plan ∪ con ventana desde el inicio). Si una sede entra entre esto y el cierre, la huella del service
 * (cuya cabecera lleva las sedes) también cambia.
 */
export async function sedesDelCierre(venueId: string, fecha: string): Promise<string[]> {
  const organizationId = await organizacionDe(venueId)
  if (!organizationId) return []
  const [activas, conVentana] = await Promise.all([sedesConServicePay(organizationId), sedesConVentana(prisma, organizationId)])
  return (await alcanceDelPreview(prisma, organizationId, fecha, { activas, conVentana })).venueIds
}

/** Marcar pagado: con persona, las sedes de SU recibo (entero); sin persona, las del periodo (como `previewPagado`). */
export async function sedesDelPagado(venueId: string, periodId: string, staffId?: string): Promise<string[]> {
  const organizationId = await organizacionDe(venueId)
  if (!organizationId) return []
  const p = await prisma.servicePayPeriod.findFirst({ where: { id: periodId, organizationId }, select: { id: true, venueIds: true } })
  if (!p) return []
  return staffId ? sedesDeRecibo(prisma, p.id, staffId) : p.venueIds
}

/** Cambiar las propinas: es de toda la organización; el service exige el permiso en las sedes con el plan. */
export const sedesDeLasPropinas = (organizationId: string): Promise<string[]> => sedesConServicePay(organizationId)

/** Los nombres de `ids`, leídos acotados a la organización (una sede de otra no trae nombre). */
export async function nombresDeSedes(organizationId: string, ids: string[]): Promise<Map<string, string>> {
  const unicos = [...new Set(ids)]
  if (!unicos.length) return new Map()
  const vs = await prisma.venue.findMany({
    where: { organizationId, id: { in: unicos } },
    select: { id: true, name: true },
    take: unicos.length,
  })
  return new Map(vs.map(v => [v.id, v.name]))
}

/**
 * ¿Es DUEÑO para una acción que abarca `venueIds`? SUPERADMIN; o dueño de la organización activa de la conexión con la regla
 * ÚNICA de la plataforma (`esDuenoDeLaOrganizacion`: `StaffOrganization` OWNER activa, o una sucursal propia OWNER en ella); o
 * —B14-fix ronda 1 (R5), intención del founder «si es owner, que avise»— OWNER activa en TODAS las sedes que la acción abarca, aunque
 * no tenga membresía de la organización (las cuentas viejas sólo de sucursal, como la de Mindform). No basta el `orgRole` del
 * scope. Se lee en cada llamada: al confirmar se revalida.
 */
export async function esDueno(scope: McpScope, venueIds: readonly string[]): Promise<boolean> {
  if (scope.isSuperAdmin === true) return true
  if (await esDuenoDeLaOrganizacion(scope.staffId, scope.activeOrg)) return true
  return ownerEnTodas(scope.staffId, scope.activeOrg, venueIds)
}

/** R5: rol OWNER activo en cada una de `venueIds`, todas de la organización. Una lista vacía nunca cuenta como «todas». */
async function ownerEnTodas(staffId: string, organizationId: string, venueIds: readonly string[]): Promise<boolean> {
  const ids = [...new Set(venueIds)]
  if (!ids.length) return false
  // `@@unique([staffId, venueId])`: una fila por sede, así que contar = cuántas de ellas tiene como OWNER.
  const n = await prisma.staffVenue.count({
    where: { staffId, active: true, role: 'OWNER', venueId: { in: ids }, venue: { organizationId } },
  })
  return n === ids.length
}
