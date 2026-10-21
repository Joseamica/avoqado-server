import { CommissionCalcType } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { NotFoundError } from '../../../errors/AppError'
import { findActiveCommissionConfigs, findActiveOverride, validateStaffForCommission } from '../commission/commission-utils'
import { aplicaALaPersona } from '../commission/personasElegidas'
import { categoriasPropias } from '../commission/duenoDeCategorias'
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
    // La misma regla del motor: sin StaffVenue activo o con el Staff inactivo no se le calcula comisión
    // (validateStaffForCommission, sólo lee) ⇒ lista vacía, no null: el usuario SÍ tiene permiso de verlo.
    const elegible = await validateStaffForCommission(staffId, venueId)
    const configs = elegible ? await findActiveCommissionConfigs(venueId) : []
    // Sólo los esquemas que el motor USARÍA, en su mismo orden (commission-calculation.service.ts,
    // createCommissionForPayment ~:306-345): primero se reparte, sin mirar a la persona —cada esquema por categorías paga
    // sólo las categorías de las que es dueño (`categoriasPropias`) y de los generales sólo paga el primero (`catchAll[0]`)—;
    // después, ya en createCalcForConfig (~:134), «sólo personas elegidas» (`aplicaALaPersona`). Por eso un general
    // ganador que no incluye a la persona NO cede su lugar a otro general. Sin recortar: los esquemas de una sede son pocos.
    const porCategorias = configs.filter(c => c.filterByCategories && c.categoryIds.length > 0)
    const general = configs.find(c => !(c.filterByCategories && c.categoryIds.length > 0))
    const propias = categoriasPropias(porCategorias)
    const usados = configs.filter(c => c === general || (propias.get(c.id) ?? []).length > 0).filter(c => aplicaALaPersona(c, staffId))
    comisiones = await Promise.all(
      usados.map(async cfg => {
        const ov = await findActiveOverride(cfg.id, staffId)
        return {
          configId: cfg.id,
          nombre: cfg.name,
          alcance: cfg.venueId ? ('SEDE' as const) : ('ORGANIZACION' as const),
          excluida: !!ov?.excludeFromCommissions,
          // FIXED paga config.defaultRate e ignora la tasa de la excepción (~:182-184): no se muestra una tasa que no se usa.
          tasaPersonal: cfg.calcType !== CommissionCalcType.FIXED && ov?.customRate != null ? Number(ov.customRate) : null,
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
