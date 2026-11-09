/**
 * Desvincular el celular de campo (App de campo, bloque 1, Tarea 6). Lo usan el panel, el propio celular y el MCP.
 * Suelta a la persona (el único `staffIdVinculado`), congela la foto del último latido y mata SÓLO las sesiones del
 * celular: la PAX de la misma persona sigue. La gracia de 24 h la cuenta el latido a partir de `desvinculadoAt`.
 */
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { sucursalesDeLaPersona } from './personasDeCampo'
import { revocarSesionesDelCelular } from './sesionDeCelular'

const GRACIA_MS = 24 * 60 * 60 * 1000

export async function desvincularCelular(p: {
  celularId: string
  organizationId: string
  motivo: 'PANEL' | 'CELULAR' | 'MCP'
  porStaffId: string | null
  /** S8: lo perdió o se lo robaron. La gracia ya no aplica nada sola: todo lo que llegue queda «por revisar». */
  perdidoORobado?: boolean
  /** El alcance de quien desvincula (el MCP, S3): la persona tiene que tener una sucursal dentro. El panel no lo pasa. */
  venueIds?: string[]
}): Promise<{
  desvinculadoAt: string
  graciaHasta: string
  porSubir: number
  huellasReportadas: number
  yaEstaba: boolean
  perdidoORobado: boolean
  sinGracia: boolean
}> {
  const ahora = new Date()
  const noEncontrado = () => new NotFoundError('Celular no encontrado.', 'CELULAR_NO_ENCONTRADO')
  if (p.venueIds) {
    const alcance = p.venueIds
    const cel = await prisma.celularDeCampo.findFirst({
      where: { id: p.celularId, organizationId: p.organizationId },
      select: { staffId: true },
    })
    const suyas = cel ? await sucursalesDeLaPersona(cel.staffId, p.organizationId) : []
    if (!suyas.some(s => alcance.includes(s.venueId))) throw noEncontrado()
  }
  // El CAS decide quién desvincula; quien llega después sólo ve lo que ya había (yaEstaba).
  const { count } = await prisma.celularDeCampo.updateMany({
    where: { id: p.celularId, organizationId: p.organizationId, staffIdVinculado: { not: null } },
    data: {
      staffIdVinculado: null,
      sesionId: null,
      desvinculadoAt: ahora,
      desvinculadoPor: p.porStaffId,
      motivoDesvinculo: p.motivo,
      ...(p.perdidoORobado && { sinGracia: true }),
    },
  })
  // T4: perdido o robado sobre uno YA desvinculado (normal, por un celular nuevo, u otro operador ganó): un UPDATE aparte
  // corta su gracia, sin tocar fechas ni motivo (el plazo no se reinicia).
  const marcadoPerdido =
    count === 0 && p.perdidoORobado
      ? (
          await prisma.celularDeCampo.updateMany({
            where: { id: p.celularId, organizationId: p.organizationId, staffIdVinculado: null, sinGracia: false },
            data: { sinGracia: true },
          })
        ).count > 0
      : false
  const fila = await prisma.celularDeCampo.findFirst({ where: { id: p.celularId, organizationId: p.organizationId } })
  if (!fila) throw noEncontrado()

  const desvinculadoAt = fila.desvinculadoAt ?? ahora
  const resultado = {
    desvinculadoAt: desvinculadoAt.toISOString(),
    graciaHasta: new Date(desvinculadoAt.getTime() + GRACIA_MS).toISOString(),
    porSubir: fila.porSubir,
    huellasReportadas: fila.huellasPorSubir.length,
    yaEstaba: count === 0,
    perdidoORobado: fila.sinGracia,
    sinGracia: fila.sinGracia,
  }
  if (marcadoPerdido) {
    void logAction({
      staffId: p.porStaffId,
      venueId: null,
      organizationId: p.organizationId,
      action: 'CAMPO_CELULAR_REPORTADO_PERDIDO',
      entity: 'CelularDeCampo',
      entityId: fila.id,
      data: { motivo: p.motivo },
    })
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
    data: {
      motivo: p.motivo,
      porSubir: resultado.porSubir,
      huellasReportadas: resultado.huellasReportadas,
      perdidoORobado: resultado.perdidoORobado,
    },
  })
  return resultado
}
