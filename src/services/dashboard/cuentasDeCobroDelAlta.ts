import { BadRequestError, ForbiddenError } from '../../errors/AppError'

/**
 * D25 (15-nov): el alta avanzada de negocio (`POST /dashboard/venues/enhanced`) liga hasta tres cuentas de cobro a la
 * configuración de pagos del negocio nuevo. Si alguna no existe (id equivocado o borrado), la llave foránea tronaba dentro de
 * la transacción y el alta entera salía como 500 con el texto de Prisma. Aquí se revisa antes, en la MISMA transacción, y sale
 * un 400 en español; como la transacción se deshace, no queda un negocio a medias. (Que falte la principal lo frena antes el
 * esquema, `enhancedCreateVenueSchema`.)
 */
export const TEXTO_CUENTA_DE_COBRO_INEXISTENTE =
  'Una de las cuentas de cobro que elegiste ya no existe. Vuelve a elegir las cuentas e inténtalo otra vez.'

/**
 * hz:nube0000:na5adb84 (1b): `MerchantAccount` no tiene dueño, y el alta ligaba la cuenta que le mandaran: un dueño o
 * administrador con `venues:manage` podía poner la cuenta de cobro de OTRO negocio en el suyo (sus cobros caerían en la cuenta
 * ajena). 🔴 Default pendiente de confirmar con el founder: una cuenta «es de la organización» si ya está en una posición de un
 * negocio de ESA organización o en la configuración de la organización; el superadmin puede usar cualquiera.
 * Límite conocido: esa evidencia vale lo que valen sus escritores (Codex r1 #3: una migración de terminal puede copiar una cuenta
 * ajena que la terminal traía; vive en el PR #452 y se avisó).
 */
export const TEXTO_CUENTA_DE_COBRO_AJENA =
  'Una de las cuentas de cobro que elegiste no es de tu organización. Elige una cuenta que ya cobre en uno de tus negocios, o pide ayuda a soporte de Avoqado.'
export const CUENTA_DE_COBRO_AJENA = 'CUENTA_DE_COBRO_AJENA'

interface CuentasDelAlta {
  primaryAccountId?: string | null
  secondaryAccountId?: string | null
  tertiaryAccountId?: string | null
}

interface TxConCuentas {
  merchantAccount: { findMany: (args: any) => Promise<Array<{ id: string }>> }
}

export async function asegurarCuentasDeCobroDelAlta(
  tx: TxConCuentas,
  cuentas: CuentasDelAlta,
  quien: { organizationId: string; esSuperadmin: boolean },
): Promise<void> {
  // Sin recortar: se busca el MISMO valor que después se guarda (un id con espacios no existe y sale como 400).
  const ids = [
    ...new Set([cuentas.primaryAccountId, cuentas.secondaryAccountId, cuentas.tertiaryAccountId].filter((id): id is string => !!id)),
  ]
  if (ids.length === 0) return

  const encontradas = await tx.merchantAccount.findMany({ where: { id: { in: ids } }, select: { id: true }, take: ids.length })
  if (encontradas.length !== ids.length) throw new BadRequestError(TEXTO_CUENTA_DE_COBRO_INEXISTENTE)
  if (quien.esSuperadmin) return

  const enUnNegocio = { some: { venue: { organizationId: quien.organizationId } } }
  const enLaOrganizacion = { some: { organizationId: quien.organizationId } }
  const deLaOrganizacion = await tx.merchantAccount.findMany({
    where: {
      id: { in: ids },
      OR: [
        { venueConfigsPrimary: enUnNegocio },
        { venueConfigsSecondary: enUnNegocio },
        { venueConfigsTertiary: enUnNegocio },
        { orgConfigsPrimary: enLaOrganizacion },
        { orgConfigsSecondary: enLaOrganizacion },
        { orgConfigsTertiary: enLaOrganizacion },
      ],
    },
    select: { id: true },
    take: ids.length,
  })
  if (deLaOrganizacion.length !== ids.length) throw new ForbiddenError(TEXTO_CUENTA_DE_COBRO_AJENA, CUENTA_DE_COBRO_AJENA)
}
