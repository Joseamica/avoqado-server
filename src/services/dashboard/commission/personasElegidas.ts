/**
 * «Sólo personas elegidas» en un esquema de comisión (fase 3 de Pago al personal, D-ELEGIDOS, aprobado por el founder el 8-oct).
 *
 * El panel ofrecía «Sólo seleccionados» («La comisión solo aplica a los empleados que agregues»), pero sólo creaba excepciones
 * para los elegidos y el servidor les pagaba a TODOS. El esquema dice ahora a quién aplica, con el mismo patrón que las
 * categorías: `filterByStaff` + `staffIds`. Las excepciones por persona (`CommissionOverride`: tasa propia o excluir) siguen
 * igual y se aplican encima.
 *
 * Quién lo lee: todo lo que decide a quién se le calcula — el cobro normal (`createCalcForConfig`) y la liga de pago dividida
 * (`createSplitCommissionForPayment`). Los reversos no deciden: revierten lo que ya se calculó.
 */
import prisma from '../../../utils/prismaClient'
import { BadRequestError } from '../../../errors/AppError'

/** ¿El esquema le calcula comisión a esta persona? «Todo el equipo» (de fábrica) o sólo quien está en la lista. */
export function aplicaALaPersona(config: { filterByStaff?: boolean | null; staffIds?: string[] | null }, staffId: string): boolean {
  return !config.filterByStaff || (config.staffIds ?? []).includes(staffId)
}

/** De quién es el esquema: de una sede, o de una organización (aplica a las sedes que no tienen esquemas propios). */
export type AlcanceDelEsquema = { venueId: string } | { organizationId: string }

export interface PersonasElegidas {
  filterByStaff?: boolean
  staffIds?: string[]
}

/**
 * Valida y normaliza lo que llega al crear (sin `existente`) o al actualizar (con él), y devuelve SÓLO los campos que vinieron,
 * listos para guardar (la lista sin repetidos). Errores 400 en español:
 * - «sólo elegidos» con la lista vacía (al crear, o lo que QUEDA al actualizar) no le pagaría a nadie;
 * - cada persona elegida tiene que ser del equipo del negocio (una fila de `StaffVenue` en la sede, o en alguna sede de la
 *   organización): nunca se guarda gente de otro negocio.
 * `staffIds: null` se lee como lista vacía (lo que manda un cliente con «todo el equipo»).
 */
export async function personasElegidasAGuardar(
  datos: { filterByStaff?: unknown; staffIds?: unknown },
  alcance: AlcanceDelEsquema,
  existente?: { filterByStaff: boolean; staffIds: string[] },
): Promise<PersonasElegidas> {
  const salida: PersonasElegidas = {}
  if (datos.filterByStaff !== undefined) {
    if (typeof datos.filterByStaff !== 'boolean') throw new BadRequestError('«Sólo personas elegidas» debe ser sí o no.')
    salida.filterByStaff = datos.filterByStaff
  }
  if (datos.staffIds === null) salida.staffIds = []
  else if (datos.staffIds !== undefined) {
    if (!Array.isArray(datos.staffIds) || datos.staffIds.some(id => typeof id !== 'string' || id.length === 0)) {
      throw new BadRequestError('Las personas elegidas deben ser una lista.')
    }
    salida.staffIds = [...new Set(datos.staffIds as string[])]
  }

  const filtra = salida.filterByStaff ?? existente?.filterByStaff ?? false
  const lista = salida.staffIds ?? existente?.staffIds ?? []
  if (filtra && lista.length === 0) throw new BadRequestError('Elige al menos a una persona, o aplica el esquema a todo el equipo.')

  if (salida.staffIds && salida.staffIds.length > 0) {
    const delEquipo = await prisma.staffVenue.findMany({
      where: {
        staffId: { in: salida.staffIds },
        ...('venueId' in alcance ? { venueId: alcance.venueId } : { venue: { organizationId: alcance.organizationId } }),
      },
      select: { staffId: true },
      distinct: ['staffId'],
      take: salida.staffIds.length,
    })
    if (delEquipo.length !== salida.staffIds.length) {
      throw new BadRequestError('Una de las personas elegidas no es del equipo de este negocio.')
    }
  }
  return salida
}
