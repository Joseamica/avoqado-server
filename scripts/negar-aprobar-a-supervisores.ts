/**
 * Quitarle a los supervisores (MANAGER) de PlayTelecom el aprobar ventas (spec 2026-10-30 §5.8, plan A10). En seco por defecto.
 *
 *   npx tsx scripts/negar-aprobar-a-supervisores.ts --org-id=<id>                    # simulación, base local
 *   npx tsx scripts/negar-aprobar-a-supervisores.ts --org-id=<id> --base render      # simulación contra RENDER_DATABASE_URL
 *   npx tsx scripts/negar-aprobar-a-supervisores.ts --org-id=<id> --base render --apply --confirm-host=<host> --modified-by=<staffId>
 *
 * Agrega `sale-verifications:approve` a `VenueRolePermission.deniedPermissions` de MANAGER en CADA tienda de la organización
 * (el permiso se revisa contra la tienda de la venta, y cualquiera puede serlo), sin borrar lo que ya tenía negado; la tienda
 * sin fila de MANAGER la recibe nueva. `review` sigue: el supervisor ve las ventas. Es configuración, no código (verticales a
 * la medida). Se puede repetir.
 *
 * Un MANAGER con `PermissionSet` propio no usa los permisos del rol: si su conjunto concede `approve` o `review`, la negación no
 * lo alcanza. El script lo REPORTA y no lo toca (decide el negocio).
 *
 * También REPORTA, sin tocar, al MANAGER que tenga `manual-sales:create` (en la fila de su rol o en su `PermissionSet`): Ventas
 * externas crea ventas ya aprobadas, así que por ahí sigue aprobando aunque `approve` esté negado.
 *
 * `--modified-by` es quien firma el cambio (`VenueRolePermission.modifiedBy` es obligatorio). Escribir en producción pide el
 * «sí, en prod» del founder (Parte D del plan).
 */
import 'dotenv/config'

import { correr, elegirBase, exigirHostConfirmado, hostDeLaBase, leerValor, Rechazo } from './lib/linkingNumbers/baseCli'

export const APPROVE = 'sale-verifications:approve'
const REVIEW = 'sale-verifications:review'
const TOPE_TIENDAS = 1_000
const TOPE_CONJUNTOS = 5_000

/** Por tienda: crear la fila de MANAGER, agregarle `approve` a lo que ya niega, o nada (ya lo niega). */
export function planDenyApprove(
  venueIds: string[],
  rows: { venueId: string; role: string; deniedPermissions: string[] }[],
): { toCreate: string[]; toUpdate: { venueId: string; deniedPermissions: string[] }[]; alreadyDenied: string[] } {
  const negadosDeManager = new Map(rows.filter(r => r.role === 'MANAGER').map(r => [r.venueId, r.deniedPermissions]))
  const plan: ReturnType<typeof planDenyApprove> = { toCreate: [], toUpdate: [], alreadyDenied: [] }
  for (const venueId of venueIds) {
    const negados = negadosDeManager.get(venueId)
    if (!negados) plan.toCreate.push(venueId)
    else if (negados.includes(APPROVE)) plan.alreadyDenied.push(venueId)
    else plan.toUpdate.push({ venueId, deniedPermissions: [...negados, APPROVE] })
  }
  return plan
}

/** Los MANAGER cuyo `PermissionSet` concede `approve` o `review`. `grants` = `evaluatePermissionList` (la regla de comodines). */
export function managersWithApproveSet<T extends { role: string; permissionSet: { permissions: string[] } | null }>(
  rows: T[],
  grants: (permissions: string[], required: string) => boolean,
): T[] {
  return rows.filter(r => r.role === 'MANAGER' && !!r.permissionSet && [APPROVE, REVIEW].some(p => grants(r.permissionSet!.permissions, p)))
}

export const MANUAL_SALES = 'manual-sales:create'

/**
 * Por dónde un MANAGER aún crea ventas ya aprobadas (Ventas externas): las tiendas cuya fila de MANAGER concede
 * `manual-sales:create` (`hasRole` = `hasPermission`, rol + lo que la tienda agrega y quita) y los MANAGER cuyo conjunto
 * propio lo concede (`grants` = `evaluatePermissionList`). Sólo se reporta.
 */
export function managersWithManualSales<
  F extends { venueId: string; role: string; permissions: string[]; deniedPermissions: string[] },
  C extends { role: string; permissionSet: { permissions: string[] } | null },
>(
  roleRows: F[],
  setRows: C[],
  hasRole: (role: 'MANAGER', permissions: string[], required: string, denied: string[]) => boolean,
  grants: (permissions: string[], required: string) => boolean,
): { venueIds: string[]; withSet: C[] } {
  return {
    venueIds: roleRows
      .filter(r => r.role === 'MANAGER' && hasRole('MANAGER', r.permissions, MANUAL_SALES, r.deniedPermissions))
      .map(r => r.venueId),
    withSet: setRows.filter(r => r.role === 'MANAGER' && !!r.permissionSet && grants(r.permissionSet.permissions, MANUAL_SALES)),
  }
}

async function main(): Promise<void> {
  const orgId = leerValor('--org-id')
  if (!orgId) {
    console.error('Uso: --org-id=<id> [--apply --confirm-host=<host> --modified-by=<staffId>] [--base render]')
    throw new Rechazo(2)
  }
  elegirBase()
  const host = hostDeLaBase()
  const aplicar = process.argv.includes('--apply')
  const modifiedBy = leerValor('--modified-by')
  console.log(`Base: ${host}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}  organización: ${orgId}`)
  if (aplicar) {
    exigirHostConfirmado(host)
    if (!modifiedBy) {
      console.error('🔴 No se escribió NADA. Falta --modified-by=<staffId> de quien firma el cambio.')
      throw new Rechazo(2)
    }
  }

  // Imports dinámicos: el cliente de Prisma lee DATABASE_URL al cargarse, y `elegirBase` ya la eligió.
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { evaluatePermissionList, hasPermission } = await import('../src/lib/permissions')
  const { logAction } = await import('../src/services/dashboard/activity-log.service')
  try {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } })
    if (!org) {
      console.error(`No existe la organización «${orgId}».`)
      throw new Rechazo(2)
    }
    const tiendas = await prisma.venue.findMany({
      where: { organizationId: org.id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: TOPE_TIENDAS,
    })
    if (tiendas.length === TOPE_TIENDAS) {
      console.error(`🔴 La organización llegó al tope de ${TOPE_TIENDAS} tiendas: no se hizo nada.`)
      throw new Rechazo(2)
    }
    const ids = tiendas.map(t => t.id)
    const leerFilas = () =>
      prisma.venueRolePermission.findMany({
        where: { venueId: { in: ids }, role: 'MANAGER' },
        select: { venueId: true, role: true, permissions: true, deniedPermissions: true },
        take: ids.length,
      })
    const filas = await leerFilas()
    const plan = planDenyApprove(ids, filas)
    console.log(
      `Organización: ${org.name} · tiendas ${ids.length} · fila nueva ${plan.toCreate.length} · se agrega a la fila ${plan.toUpdate.length} · ya negado ${plan.alreadyDenied.length}`,
    )

    // ¿Con la negación, MANAGER sigue aprobando en alguna tienda? (resolver real, con lo que la tienda le agrega al rol)
    const sigueAprobando = (rows: typeof filas, negadosPlaneados?: Map<string, string[]>) => {
      const porTienda = new Map(rows.map(r => [r.venueId, r]))
      return ids.filter(id => {
        const fila = porTienda.get(id)
        return hasPermission('MANAGER', fila?.permissions ?? null, APPROVE, negadosPlaneados?.get(id) ?? fila?.deniedPermissions ?? null)
      })
    }
    const planeados = new Map(plan.toUpdate.map(u => [u.venueId, u.deniedPermissions]))
    for (const id of plan.toCreate) planeados.set(id, [APPROVE])
    const noMuerde = sigueAprobando(filas, planeados)
    if (noMuerde.length) console.log(`🔴 En ${noMuerde.length} tienda(s) MANAGER seguiría aprobando aun negado: ${noMuerde.join(', ')}`)

    const conConjunto = await prisma.staffVenue.findMany({
      where: { venue: { organizationId: org.id }, role: 'MANAGER', permissionSetId: { not: null } },
      select: {
        role: true,
        active: true,
        venue: { select: { name: true } },
        staff: { select: { id: true, firstName: true, lastName: true } },
        permissionSet: { select: { name: true, permissions: true } },
      },
      take: TOPE_CONJUNTOS,
    })
    const reportados = managersWithApproveSet(conConjunto, evaluatePermissionList)
    console.log(`MANAGER con PermissionSet que concede approve o review (la negación no los alcanza): ${reportados.length}`)
    for (const r of reportados)
      console.log(
        `  ${r.staff.firstName} ${r.staff.lastName} (${r.staff.id}) · ${r.venue.name} · conjunto «${r.permissionSet!.name}»${r.active ? '' : ' · inactivo'}`,
      )

    // Ventas externas crea ventas ya aprobadas: un MANAGER que la usa sigue aprobando por ahí. Sólo se reporta.
    const nombreDe = new Map(tiendas.map(t => [t.id, t.name]))
    const ventasExternas = managersWithManualSales(filas, conConjunto, hasPermission, evaluatePermissionList)
    console.log(
      `MANAGER que puede crear Ventas externas (ya aprobadas; no se toca): ${ventasExternas.venueIds.length} tienda(s) por su rol · ${ventasExternas.withSet.length} con PermissionSet`,
    )
    for (const id of ventasExternas.venueIds) console.log(`  rol MANAGER · ${nombreDe.get(id) ?? id}`)
    for (const r of ventasExternas.withSet)
      console.log(
        `  ${r.staff.firstName} ${r.staff.lastName} (${r.staff.id}) · ${r.venue.name} · conjunto «${r.permissionSet!.name}»${r.active ? '' : ' · inactivo'}`,
      )

    if (!aplicar) {
      console.log('Simulación: no se escribió nada.')
      console.log(
        `Para aplicar:  npx tsx scripts/negar-aprobar-a-supervisores.ts --org-id=${orgId}` +
          `${leerValor('--base') ? ` --base ${leerValor('--base')}` : ''} --apply --confirm-host=${host} --modified-by=<staffId>`,
      )
      return
    }
    const firmante = await prisma.staff.findUnique({ where: { id: modifiedBy! }, select: { id: true } })
    if (!firmante) {
      console.error(`🔴 No se escribió NADA. No existe el staff «${modifiedBy}» de --modified-by.`)
      throw new Rechazo(2)
    }

    // Sin carreras: la fila nueva salta si alguien la creó a la vez, y el `push` agrega a lo que la fila tenga EN ESE momento.
    const r = await prisma.$transaction(async tx => {
      const creadas = await tx.venueRolePermission.createMany({
        data: plan.toCreate.map(venueId => ({
          venueId,
          role: 'MANAGER' as const,
          permissions: [],
          deniedPermissions: [APPROVE],
          modifiedBy: firmante.id,
        })),
        skipDuplicates: true,
      })
      const agregadas = await tx.venueRolePermission.updateMany({
        where: { venueId: { in: ids }, role: 'MANAGER', NOT: { deniedPermissions: { has: APPROVE } } },
        data: { deniedPermissions: { push: APPROVE }, modifiedBy: firmante.id },
      })
      return { creadas: creadas.count, agregadas: agregadas.count }
    })
    console.log(`✅ Filas nuevas ${r.creadas} · approve agregado a ${r.agregadas} fila(s).`)

    // Bitácora DESPUÉS del commit: `logAction` usa el cliente global y nunca lanza.
    for (const venueId of planeados.keys())
      await logAction({
        staffId: firmante.id,
        venueId,
        organizationId: org.id,
        action: 'ROLE_PERMISSIONS_UPDATED',
        entity: 'VenueRolePermission',
        data: { role: 'MANAGER', denied: APPROVE, script: 'scripts/negar-aprobar-a-supervisores.ts' },
      })

    const despues = sigueAprobando(await leerFilas())
    console.log(
      despues.length
        ? `🔴 MANAGER sigue aprobando en ${despues.length} tienda(s): ${despues.join(', ')}`
        : 'MANAGER ya no aprueba en ninguna tienda.',
    )
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

if (require.main === module) correr(main)
