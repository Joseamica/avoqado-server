/**
 * El latido del celular de campo (App de campo, bloque 1, regla A5). En cada contacto el celular dice cuánto tiene por
 * subir y la HUELLA de cada pieza. Mientras está vinculado esa foto se reemplaza; al desvincular se congela (el
 * `updateMany` sólo escribe si sigue vinculado), y la gracia de 24 h sólo aplica lo que traiga una huella de ella.
 */
import { CelularDeCampo } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { AparatoDelCelular } from './activarCelular.service'
import { sucursalesParaElCelular } from './sesionDeCelular'

const GRACIA_MS = 24 * 60 * 60 * 1000

export type Latido = {
  porSubir: { total: number; ventas?: number; fotos?: number; checadas?: number; custodia?: number }
  huellas: string[]
  aparato?: Omit<AparatoDelCelular, 'aparatoId'>
}

export async function registrarLatido(celular: CelularDeCampo, b: Latido) {
  const ahora = new Date()
  const { total, ...detalle } = b.porSubir
  let actual = celular
  if (celular.staffIdVinculado) {
    const { count } = await prisma.celularDeCampo.updateMany({
      where: { id: celular.id, staffIdVinculado: { not: null } },
      data: {
        vistoAt: ahora,
        porSubir: total,
        porSubirDetalle: detalle,
        huellasPorSubir: b.huellas,
        huellasReportadasAt: ahora,
        ...b.aparato,
      },
    })
    // Lo desvincularon entre la credencial y aquí: la foto ya está congelada; contesta con la fila de ahora.
    if (count === 0) actual = await prisma.celularDeCampo.findUniqueOrThrow({ where: { id: celular.id } })
  }
  if (!actual.staffIdVinculado) await prisma.celularDeCampo.update({ where: { id: celular.id }, data: { vistoAt: ahora } })

  const [persona, sucursales] = await Promise.all([
    prisma.staff.findUnique({ where: { id: celular.staffId }, select: { firstName: true, lastName: true } }),
    actual.staffIdVinculado ? sucursalesParaElCelular(actual) : [],
  ])
  const estado = !actual.staffIdVinculado ? 'DESVINCULADO' : sucursales.length === 0 ? 'DADO_DE_BAJA' : 'VINCULADO'
  return {
    estado: estado as 'VINCULADO' | 'DESVINCULADO' | 'DADO_DE_BAJA',
    graciaHasta:
      estado === 'DESVINCULADO' && actual.desvinculadoAt ? new Date(actual.desvinculadoAt.getTime() + GRACIA_MS).toISOString() : null,
    persona: { staffId: celular.staffId, nombre: `${persona?.firstName ?? ''} ${persona?.lastName ?? ''}`.trim() },
    sucursales: estado === 'VINCULADO' ? sucursales : [],
    horaDelServidor: ahora.toISOString(),
  }
}
