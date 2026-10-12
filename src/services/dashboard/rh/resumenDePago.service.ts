import prisma from '../../../utils/prismaClient'
import { NotFoundError } from '../../../errors/AppError'
import { findActiveCommissionConfigs, findActiveOverride } from '../commission/commission-utils'
import { aplicaALaPersona } from '../commission/personasElegidas'
import { dbDateComoFecha, fechaComoDbDate } from '../staffPay/periodos'
import { hoyDeLaSede } from './vigencias'

export interface ResumenDePagoDto {
  // null / 'SIN_PERMISO' = el usuario no tiene permiso de ver ese bloque (la ficha lo dice; no se muestra vacío)
  comisiones: Array<{
    configId: string
    nombre: string
    alcance: 'SEDE' | 'ORGANIZACION'
    excluida: boolean
    tasaPersonal: number | null
  }> | null
  nivelDeClase: { nombre: string; desde: string } | null | 'SIN_PERMISO'
  propinas: { regla: 'ATIENDE_LUEGO_COBRA' }
}

/**
 * Sólo lee y muestra: los motores siguen siendo la única fuente (spec RH §3.5).
 * Cada bloque conserva el permiso que hoy lo protege: comisiones = `commissions:read`, pago por clase = `staffpay:read`.
 */
export async function resumenDePago(
  venueId: string,
  staffId: string,
  puede: { comisiones: boolean; pagoPorClase: boolean },
): Promise<ResumenDePagoDto> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
  if (!venue) throw new NotFoundError('Sucursal no encontrada')
  // La persona tiene que ser de ESTA sede (no se consultan datos de otra sede de la organización).
  const sv = await prisma.staffVenue.findUnique({ where: { staffId_venueId: { staffId, venueId } }, select: { id: true } })
  if (!sv) throw new NotFoundError('Esa persona no es de esta sucursal.')

  let comisiones: ResumenDePagoDto['comisiones'] = null
  if (puede.comisiones) {
    // Mismo filtro de elegibilidad que el motor: «sólo personas elegidas» (personasElegidas.ts). Sin recortar la lista:
    // los esquemas vigentes de una sede son pocos, y la lista completa es la verdad.
    const configs = (await findActiveCommissionConfigs(venueId)).filter(cfg => aplicaALaPersona(cfg, staffId))
    comisiones = await Promise.all(
      configs.map(async cfg => {
        const ov = await findActiveOverride(cfg.id, staffId)
        return {
          configId: cfg.id,
          nombre: cfg.name,
          alcance: cfg.venueId ? ('SEDE' as const) : ('ORGANIZACION' as const),
          excluida: !!ov?.excludeFromCommissions,
          tasaPersonal: ov?.customRate != null ? Number(ov.customRate) : null,
        }
      }),
    )
  }

  let nivelDeClase: ResumenDePagoDto['nivelDeClase'] = 'SIN_PERMISO'
  if (puede.pagoPorClase) {
    // Igual que niveles.service.ts (historialDeNivel / nivelesVigentes): organización, día civil de la sede, gana la
    // revisión más nueva. Una sola fila: aquí sólo importa la vigente hoy.
    const nivel = await prisma.staffPayLevelAssignment.findFirst({
      where: { staffId, organizationId: venue.organizationId, effectiveFrom: { lte: fechaComoDbDate(hoyDeLaSede(venue.timezone)) } },
      orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
      select: { effectiveFrom: true, payLevel: { select: { name: true } } },
    })
    nivelDeClase = nivel ? { nombre: nivel.payLevel.name, desde: dbDateComoFecha(nivel.effectiveFrom) } : null
  }
  return { comisiones, nivelDeClase, propinas: { regla: 'ATIENDE_LUEGO_COBRA' } }
}
