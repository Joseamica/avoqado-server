/**
 * Desvincular el celular de campo (App de campo, bloque 1, Tarea 6). Lo usan el panel, el propio celular y el MCP.
 * Suelta a la persona (el único `staffIdVinculado`), congela la foto del último latido y mata SÓLO las sesiones del
 * celular: la PAX de la misma persona sigue. La gracia de 24 h la cuenta el latido a partir de `desvinculadoAt`.
 */
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { revocarSesionesDelCelular } from './sesionDeCelular'

const GRACIA_MS = 24 * 60 * 60 * 1000

export async function desvincularCelular(p: {
  celularId: string
  organizationId: string
  motivo: 'PANEL' | 'CELULAR' | 'MCP'
  porStaffId: string | null
}): Promise<{ desvinculadoAt: string; graciaHasta: string; porSubir: number; huellasReportadas: number; yaEstaba: boolean }> {
  const ahora = new Date()
  // El CAS decide quién desvincula; quien llega después sólo ve lo que ya había (yaEstaba).
  const { count } = await prisma.celularDeCampo.updateMany({
    where: { id: p.celularId, organizationId: p.organizationId, staffIdVinculado: { not: null } },
    data: { staffIdVinculado: null, sesionId: null, desvinculadoAt: ahora, desvinculadoPor: p.porStaffId, motivoDesvinculo: p.motivo },
  })
  const fila = await prisma.celularDeCampo.findFirst({ where: { id: p.celularId, organizationId: p.organizationId } })
  if (!fila) throw new NotFoundError('Celular no encontrado.', 'CELULAR_NO_ENCONTRADO')

  const desvinculadoAt = fila.desvinculadoAt ?? ahora
  const resultado = {
    desvinculadoAt: desvinculadoAt.toISOString(),
    graciaHasta: new Date(desvinculadoAt.getTime() + GRACIA_MS).toISOString(),
    porSubir: fila.porSubir,
    huellasReportadas: fila.huellasPorSubir.length,
    yaEstaba: count === 0,
  }
  if (count === 0) return resultado

  await revocarSesionesDelCelular(fila.id, 'campo_desvinculado')
  void logAction({
    staffId: p.porStaffId,
    venueId: null,
    organizationId: p.organizationId,
    action: 'CAMPO_CELULAR_DESVINCULADO',
    entity: 'CelularDeCampo',
    entityId: fila.id,
    data: { motivo: p.motivo, porSubir: resultado.porSubir, huellasReportadas: resultado.huellasReportadas },
  })
  return resultado
}
