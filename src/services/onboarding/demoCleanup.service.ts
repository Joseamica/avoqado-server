/**
 * Demo Cleanup Service
 *
 * Cleans demo/sample data from a venue when converting from demo to real.
 * Called during KYC approval to give the venue a fresh start.
 *
 * IMPORTANT: Uses `isDemo` field to distinguish demo data from user data.
 * Only data with `isDemo: true` will be deleted for business setup items.
 *
 * What gets DELETED (transactional data - ALL):
 * - Orders and OrderItems
 * - Payments
 * - Reviews
 * - Demo MerchantAccounts (if externalMerchantId contains 'demo')
 * - Demo Customers
 *
 * What gets DELETED (business setup - ONLY isDemo: true):
 * - RecipeLine
 * - Recipe
 * - Inventory
 * - Product
 * - Modifier
 * - ModifierGroup
 * - MenuCategory
 * - Menu
 * - Table
 * - Area
 * - CustomerGroup
 * - LoyaltyConfig
 * - RawMaterial
 * - RawMaterialMovement / StockBatch (only those belonging to demo raw materials)
 *
 * What gets DELETED (payment config - ONLY the demo positions, encargo fe2b91):
 * - PRIMARY real → only the SECONDARY/TERTIARY position holding a demo account, and only that position's pricing.
 * - PRIMARY demo → the whole VenuePaymentConfig and every VenuePricingStructure (as always); real accounts in other
 *   positions are kept as accounts (never deleted) and the ActivityLog lists them as unlinked.
 * - ProviderCostStructure + MerchantAccount (only demo accounts no position references anymore)
 *
 * What gets KEPT:
 * - All data created by the user (isDemo: false)
 * - User-captured inventory: Inventory/RawMaterial stock levels, their
 *   StockBatches (FIFO chain) and RawMaterialMovements are NEVER touched.
 *   (A previous version zeroed non-demo stock and deleted all movements
 *   and batches of the venue — that wiped real trial-captured inventory.)
 * - Staff/team members
 * - Real VenuePaymentConfig (post-KYC setup with real merchant accounts)
 * - Real VenuePricingStructure (configured for real accounts)
 * - Real ProviderCostStructure (for real merchant accounts)
 *
 * 🔴 Tarjetas de regalo (⭐ C6 concern 1, legal): si el negocio vendió ALGUNA tarjeta, no se borra NADA. Su saldo es dinero de sus
 * clientes y la libreta es de sólo inserción: borrar las cuentas y cobros del demo dejaría sobres con saldo vivo sin la venta que
 * los respalda. Se regresa con `skippedReason: 'GIFT_CARDS'`, un aviso en el log y en ActivityLog; la conversión sigue.
 */

import { AccountType, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { tomarCandado as tomarCandadoDePosiciones } from '@/services/shared/candadoDePosiciones'

/** Cómo se reconoce una cuenta de cobro demo (las que siembra `demoSeed`). */
const CUENTA_DEMO_WHERE: Prisma.MerchantAccountWhereInput[] = [
  { externalMerchantId: { contains: 'demo', mode: 'insensitive' } },
  { displayName: { contains: 'Demo', mode: 'insensitive' } },
  { blumonSerialNumber: { startsWith: 'DEMO' } },
]

interface CleanupResult {
  // Transactional data (all deleted)
  deletedOrders: number
  deletedPayments: number
  deletedReviews: number
  deletedMovements: number
  deletedBatches: number
  deletedMerchantAccounts: number
  deletedCustomers: number
  // Business setup (only isDemo: true deleted)
  deletedRecipeLines: number
  deletedRecipes: number
  deletedInventory: number
  deletedProducts: number
  deletedModifiers: number
  deletedModifierGroups: number
  deletedMenuCategories: number
  deletedMenus: number
  deletedTables: number
  deletedAreas: number
  deletedCustomerGroups: number
  deletedLoyaltyConfig: number
  deletedRawMaterials: number
  /** Encargo fe2b91: qué posiciones de cobro se limpiaron. Sin el campo, el negocio no tenía cuentas demo. */
  pagosDemo?: {
    limpiadas: AccountType[]
    configuracionBorrada: boolean
    /** Principal demo junto a cuentas reales: éstas se conservan como cuentas pero quedan sin posición (para volver a ligarlas). */
    cuentasRealesDesligadas: Array<{ posicion: AccountType; id: string }>
  }
  /** ⭐ (C6 concern 1): por qué no se borró nada. `GIFT_CARDS` = el negocio vendió tarjetas de regalo. Sin el campo, se limpió. */
  skippedReason?: 'GIFT_CARDS'
  /** hz:nube0000:na4b2c82: canales en línea (de cualquier negocio) que el borrado dejó sin su tarifa o su costo. */
  canalesEnLineaSinTarifa: CanalSinTarifa[]
}

/** Un canal en línea que perdió el enlace a la tarifa (`pricingStructureId`) o al costo (`costStructureId`) que se borró. */
export interface CanalSinTarifa {
  id: string
  venueId: string
  channelName: string
  perdio: Array<'tarifa' | 'costo'>
  pricingStructureId?: string
  costStructureId?: string
}

const ESTRUCTURA = {
  tarifa: { tabla: Prisma.raw('"VenuePricingStructure"'), columna: Prisma.raw('"pricingStructureId"'), campo: 'pricingStructureId' },
  costo: { tabla: Prisma.raw('"ProviderCostStructure"'), columna: Prisma.raw('"costStructureId"'), campo: 'costStructureId' },
} as const

/**
 * hz:nube0000:na4b2c82: los canales en línea que el `deleteMany` que sigue deja sin tarifa o costo (la llave es SET NULL y antes
 * nadie se enteraba). Codex r1 #11: primero el candado de las estructuras que se van a borrar (un canal ya no puede ligarse a
 * ellas: espera al commit y luego la llave lo rechaza) y luego el de los canales ligados (uno que se mueve a otra estructura al
 * mismo tiempo se relee y ya no sale). Así la lista es lo que la llave pone en null. Una estructura NUEVA no puede colarse
 * entre la lista y el borrado: la tarifa necesita la fila del negocio (ya tomada `FOR UPDATE` al empezar) y el costo la de su
 * cuenta (se toma `FOR UPDATE` antes de llamar aquí; Codex r2 #7).
 */
async function canalesQuePierden(tx: Prisma.TransactionClient, que: 'tarifa' | 'costo', filtro: Prisma.Sql) {
  const { tabla, columna } = ESTRUCTURA[que]
  const ids = (await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM ${tabla} WHERE ${filtro} FOR UPDATE`).map(f => f.id)
  if (ids.length === 0) return []
  return tx.$queryRaw<Array<{ id: string; venueId: string; channelName: string; estructura: string }>>`
    SELECT id, "venueId", "channelName", ${columna} AS estructura FROM "EcommerceMerchant" WHERE ${columna} = ANY(${ids}) FOR UPDATE`
}

/**
 * Cleans all demo/sample data from a venue
 * Call this when converting from demo to real (KYC approval)
 *
 * @param venueId - Venue ID to clean
 * @param staffId - Who converts the venue (actor of the ActivityLog entry when the cleanup is skipped)
 * @returns Cleanup statistics
 */
export async function cleanDemoData(venueId: string, staffId?: string | null): Promise<CleanupResult> {
  logger.info(`🧹 Starting demo data cleanup for venue: ${venueId}`)

  // Use transaction to ensure atomicity. R65 b: el resultado nace DENTRO de cada intento y sale en el retorno; un intento abortado por
  // 40P01 no deja conteos a medias.
  const result = await withDeadlockRetry(
    async tx => {
      const result: CleanupResult = {
        deletedOrders: 0,
        deletedPayments: 0,
        deletedReviews: 0,
        deletedMovements: 0,
        deletedBatches: 0,
        deletedMerchantAccounts: 0,
        deletedCustomers: 0,
        deletedRecipeLines: 0,
        deletedRecipes: 0,
        deletedInventory: 0,
        deletedProducts: 0,
        deletedModifiers: 0,
        deletedModifierGroups: 0,
        deletedMenuCategories: 0,
        deletedMenus: 0,
        deletedTables: 0,
        deletedAreas: 0,
        deletedCustomerGroups: 0,
        deletedLoyaltyConfig: 0,
        deletedRawMaterials: 0,
        canalesEnLineaSinTarifa: [],
      }
      // Canales que pierden su tarifa o costo (na4b2c82), juntados por canal.
      const canalesSinTarifa = new Map<string, CanalSinTarifa>()
      const anotarCanales = (
        que: 'tarifa' | 'costo',
        filas: Array<{ id: string; venueId: string; channelName: string; estructura: string }>,
      ) => {
        for (const f of filas) {
          const canal = canalesSinTarifa.get(f.id) ?? { id: f.id, venueId: f.venueId, channelName: f.channelName, perdio: [] }
          canal.perdio.push(que)
          canal[ESTRUCTURA[que].campo] = f.estructura
          canalesSinTarifa.set(f.id, canal)
        }
      }
      // ⭐ (C6 concern 1): con una sola tarjeta vendida no se borra nada (ver la cabecera). Dentro de la transacción, antes de borrar.
      // r1 (R2): primero la fila del negocio en FOR UPDATE (choca con el KEY SHARE que toma la llave foránea de un sobre que se está
      // vendiendo, como `deleteVenue`); la consulta de tarjetas va en OTRA sentencia y ve la venta que esperamos.
      // fe2b91 (Codex r1 #1): el MISMO candado que los que cambian la cuenta de una posición (tarifa al comercio, paso 1), ANTES
      // de leer la configuración de pagos y en el orden de un traslado (candado de posiciones → fila del negocio): un superadmin
      // que pone una cuenta real en una posición demo mientras se convierte espera a que acabemos y luego ve la pantalla vieja (409).
      await tomarCandadoDePosiciones(tx, { venueId })
      await tx.$queryRaw`SELECT 1 FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
      if (await tx.giftCard.findFirst({ where: { venueId }, select: { id: true } })) {
        result.skippedReason = 'GIFT_CARDS'
        return result
      }

      // ==========================================
      // PHASE 1: Delete ALL transactional data
      // (These are always temporary demo data)
      // ==========================================

      // El crédito restringe sus cobros: el cambio del mismo negocio se elimina primero.
      await tx.exchangeCreditLink.deleteMany({ where: { venueId } })
      await tx.exchange.deleteMany({ where: { venueId } })

      // 1. Delete Payments (must delete before orders due to FK)
      const deletedPayments = await tx.payment.deleteMany({
        where: { venueId },
      })
      result.deletedPayments = deletedPayments.count
      logger.info(`  ✓ Deleted ${deletedPayments.count} payments`)

      // 2. Delete OrderItems (cascade from orders)
      const orders = await tx.order.findMany({
        where: { venueId },
        select: { id: true },
      })
      const orderIds = orders.map(o => o.id)

      if (orderIds.length > 0) {
        await tx.orderItem.deleteMany({
          where: { orderId: { in: orderIds } },
        })
      }

      // 3. Delete Orders
      const deletedOrders = await tx.order.deleteMany({
        where: { venueId },
      })
      result.deletedOrders = deletedOrders.count
      logger.info(`  ✓ Deleted ${deletedOrders.count} orders`)

      // 4. Delete Reviews
      const deletedReviews = await tx.review.deleteMany({
        where: { venueId },
      })
      result.deletedReviews = deletedReviews.count
      logger.info(`  ✓ Deleted ${deletedReviews.count} reviews`)

      // 5. Delete RawMaterialMovements of DEMO raw materials only.
      // Movements of user (non-demo) raw materials are the audit trail of
      // real stock the user captured during the trial — never delete them.
      const deletedMovements = await tx.rawMaterialMovement.deleteMany({
        where: { venueId, rawMaterial: { isDemo: true } },
      })
      result.deletedMovements = deletedMovements.count
      logger.info(`  ✓ Deleted ${deletedMovements.count} demo inventory movements`)

      // 6. Delete StockBatches of DEMO raw materials only.
      // Batches of real raw materials must survive: deleting them while
      // keeping currentStock breaks the FIFO invariant (stock == Σ batches).
      const deletedBatches = await tx.stockBatch.deleteMany({
        where: { venueId, rawMaterial: { isDemo: true } },
      })
      result.deletedBatches = deletedBatches.count
      logger.info(`  ✓ Deleted ${deletedBatches.count} demo stock batches`)

      // 7. Cuentas de cobro demo de ESTE negocio (encargo fe2b91, hz:87f4b879:D7). Antes, con UNA cuenta demo se borraba la
      // configuración entera y todas sus tarifas, y el negocio que ya había dado de alta su cuenta real como principal se quedaba
      // sin cuenta de cobro ni tarifa. Ahora:
      // - Principal REAL: se vacía sólo la secundaria/terciaria demo y se borra SÓLO la tarifa de esa posición.
      // - Principal DEMO (todas demo o junto a una real): como siempre, se borra la configuración y sus tarifas (la principal no
      //   puede quedar vacía y conservarla demo rompe la herencia de la organización). Las cuentas reales se conservan como
      //   cuentas y la bitácora dice cuáles quedaron sueltas. No se mueve una cuenta de posición ni se inventa una tarifa.
      // - Una cuenta demo sólo se borra si ya ninguna configuración (de negocio u organización) la usa.
      // - Codex r2 #1: una tarifa demo se borra aunque la use un canal en línea (como antes). Conservarla haría que el negocio
      //   cobrara esa tarifa sobre la cuenta real que hereda de su organización; el canal pierde el enlace (FK SET NULL).
      const venuePaymentConfig = await tx.venuePaymentConfig.findUnique({
        where: { venueId },
        select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
      })

      const posiciones: Array<{ tipo: AccountType; id: string }> = []
      if (venuePaymentConfig?.primaryAccountId) posiciones.push({ tipo: 'PRIMARY', id: venuePaymentConfig.primaryAccountId })
      if (venuePaymentConfig?.secondaryAccountId) posiciones.push({ tipo: 'SECONDARY', id: venuePaymentConfig.secondaryAccountId })
      if (venuePaymentConfig?.tertiaryAccountId) posiciones.push({ tipo: 'TERTIARY', id: venuePaymentConfig.tertiaryAccountId })
      const venueAccountIds = posiciones.map(p => p.id)

      const demoAccountIds =
        venueAccountIds.length > 0
          ? (
              await tx.merchantAccount.findMany({
                where: { id: { in: venueAccountIds }, OR: CUENTA_DEMO_WHERE },
                select: { id: true },
              })
            ).map(m => m.id)
          : []
      const posicionesDemo = posiciones.filter(p => demoAccountIds.includes(p.id)).map(p => p.tipo)

      if (venuePaymentConfig && posicionesDemo.length > 0) {
        if (posicionesDemo.includes('PRIMARY')) {
          // Principal demo (todas demo, o junto a una real): como siempre, se borra la configuración y todas sus tarifas, y el
          // negocio vuelve a heredar las cuentas de su organización. Codex r3 #1 y #2: conservarla con la principal demo dejaba a
          // una PAX que hereda sin su cuenta real de la organización y tumbaba la aprobación de KYC con procesador. Lo que sí
          // cambia: la cuenta REAL no se borra (sólo se borran demos) y la bitácora dice cuál quedó suelta y en qué posición.
          const cuentasRealesDesligadas = posiciones.filter(p => !demoAccountIds.includes(p.id)).map(p => ({ posicion: p.tipo, id: p.id }))
          await tx.venuePaymentConfig.delete({ where: { venueId } })
          anotarCanales('tarifa', await canalesQuePierden(tx, 'tarifa', Prisma.sql`"venueId" = ${venueId}`))
          await tx.venuePricingStructure.deleteMany({ where: { venueId } })
          result.pagosDemo = { limpiadas: posiciones.map(p => p.tipo), configuracionBorrada: true, cuentasRealesDesligadas }
          logger.info(`  ✓ Deleted demo VenuePaymentConfig and VenuePricingStructures (PRIMARY was demo)`)
          if (cuentasRealesDesligadas.length > 0) {
            logger.warn(`  ⚠️ PRIMARY was demo: real merchant accounts were unlinked (kept, not deleted)`, {
              venueId,
              cuentasRealesDesligadas,
            })
          }
        } else {
          // Principal REAL: se vacía cada secundaria/terciaria demo y se borra SÓLO la tarifa de esa posición.
          const limpiadas = posicionesDemo
          await tx.venuePaymentConfig.update({
            where: { venueId },
            data: {
              ...(limpiadas.includes('SECONDARY') ? { secondaryAccountId: null } : {}),
              ...(limpiadas.includes('TERTIARY') ? { tertiaryAccountId: null } : {}),
            },
          })
          anotarCanales(
            'tarifa',
            await canalesQuePierden(tx, 'tarifa', Prisma.sql`"venueId" = ${venueId} AND "accountType"::text = ANY(${limpiadas})`),
          )
          await tx.venuePricingStructure.deleteMany({ where: { venueId, accountType: { in: limpiadas } } })
          result.pagosDemo = { limpiadas, configuracionBorrada: false, cuentasRealesDesligadas: [] }
          logger.info(`  ⚡ Preserved real merchant positions; cleaned demo positions: ${limpiadas.join(', ')}`)
        }
      } else if (venuePaymentConfig) {
        logger.info(`  ⚡ Preserved real VenuePaymentConfig and VenuePricingStructures (non-demo accounts)`)
      }

      if (demoAccountIds.length > 0) {
        // Una cuenta demo que sigue en una posición (la principal de arriba, otro negocio u otra ORGANIZACIÓN) no se borra: la
        // llave de la organización es RESTRICT y tumbaría toda la limpieza (fe2b91, Codex r1 #2 y r2 #2). Se pregunta por cada
        // cuenta, sin tope: son las ≤3 de este negocio.
        const safeToDeleteIds = (
          await tx.merchantAccount.findMany({
            where: {
              id: { in: demoAccountIds },
              venueConfigsPrimary: { none: {} },
              venueConfigsSecondary: { none: {} },
              venueConfigsTertiary: { none: {} },
              orgConfigsPrimary: { none: {} },
              orgConfigsSecondary: { none: {} },
              orgConfigsTertiary: { none: {} },
            },
            select: { id: true },
            take: demoAccountIds.length, // una fila por cuenta: el tope no corta nada
          })
        ).map(m => m.id)

        if (safeToDeleteIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM "MerchantAccount" WHERE id = ANY(${safeToDeleteIds}) FOR UPDATE`
          anotarCanales('costo', await canalesQuePierden(tx, 'costo', Prisma.sql`"merchantAccountId" = ANY(${safeToDeleteIds})`))
          await tx.providerCostStructure.deleteMany({
            where: { merchantAccountId: { in: safeToDeleteIds } },
          })

          const deletedMerchantAccounts = await tx.merchantAccount.deleteMany({
            where: { id: { in: safeToDeleteIds } },
          })
          result.deletedMerchantAccounts = deletedMerchantAccounts.count
          logger.info(`  ✓ Deleted ${deletedMerchantAccounts.count} demo merchant accounts`)
        }
      }

      // na4b2c82 (Codex r1 #12): una fila de bitácora por canal, DENTRO de la transacción: si se perdiera, se perdería el único
      // rastro de un enlace que ya no existe. Va con el negocio DEL CANAL (la bitácora por negocio filtra por venueId). Sin
      // actor ni el negocio convertido (Codex r2 #9 y #10): el dueño de OTRO negocio no ve quién convirtió qué, y una llave de
      // personal no puede tumbar la limpieza; quién convirtió queda en DEMO_PAYMENT_POSITIONS_CLEANED del negocio convertido.
      result.canalesEnLineaSinTarifa = [...canalesSinTarifa.values()]
      for (const canal of result.canalesEnLineaSinTarifa) {
        await tx.activityLog.create({
          data: {
            staffId: null,
            venueId: canal.venueId,
            action: 'DEMO_CLEANUP_ECOMMERCE_CHANNEL_UNLINKED',
            entity: 'EcommerceMerchant',
            entityId: canal.id,
            data: { ...canal, motivo: 'Se convirtió a real un negocio demo cuya tarifa o costo usaba este canal' },
          },
        })
      }

      // 8. Delete demo Customers (those created by seed)
      const deletedCustomers = await tx.customer.deleteMany({
        where: {
          venueId,
          OR: [{ email: { endsWith: '@demo.com' } }, { email: null, phone: { startsWith: '555' } }],
        },
      })
      result.deletedCustomers = deletedCustomers.count
      logger.info(`  ✓ Deleted ${deletedCustomers.count} demo customers`)

      // 9. Reset remaining customers loyalty data
      await tx.customer.updateMany({
        where: { venueId },
        data: {
          loyaltyPoints: 0,
          totalVisits: 0,
          totalSpent: 0,
          averageOrderValue: 0,
          firstVisitAt: null,
          lastVisitAt: null,
        },
      })
      logger.info(`  ✓ Reset loyalty data for remaining customers`)

      // ==========================================
      // PHASE 2: Delete DEMO business setup data (isDemo: true only)
      // User-created data (isDemo: false) is preserved!
      // ==========================================

      logger.info(`  📦 Cleaning demo business setup data (preserving user data)...`)

      // 10. Delete demo RecipeLines first (FK to Recipe)
      const deletedRecipeLines = await tx.recipeLine.deleteMany({
        where: { isDemo: true, recipe: { product: { venueId } } },
      })
      result.deletedRecipeLines = deletedRecipeLines.count
      logger.info(`  ✓ Deleted ${deletedRecipeLines.count} demo recipe lines`)

      // 11. Delete demo Recipes (FK to Product)
      const deletedRecipes = await tx.recipe.deleteMany({
        where: { isDemo: true, product: { venueId } },
      })
      result.deletedRecipes = deletedRecipes.count
      logger.info(`  ✓ Deleted ${deletedRecipes.count} demo recipes`)

      // 12. Delete demo Inventory (FK to Product)
      const deletedInventory = await tx.inventory.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedInventory = deletedInventory.count
      logger.info(`  ✓ Deleted ${deletedInventory.count} demo inventory records`)

      // 13. Delete ProductModifierGroup links for demo products
      const demoProducts = await tx.product.findMany({
        where: { venueId, isDemo: true },
        select: { id: true },
      })
      if (demoProducts.length > 0) {
        await tx.productModifierGroup.deleteMany({
          where: { productId: { in: demoProducts.map(p => p.id) } },
        })
      }

      // 14. Delete demo Products (FK to MenuCategory)
      const deletedProducts = await tx.product.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedProducts = deletedProducts.count
      logger.info(`  ✓ Deleted ${deletedProducts.count} demo products`)

      // Variantes: un padre que se quedó sin productos (sus variantes eran demo) se borra; los que conservan productos reales
      // siguen la misma regla que esos productos.
      await tx.productGroup.deleteMany({ where: { venueId, products: { none: {} } } })

      // 15. Delete demo Modifiers (FK to ModifierGroup)
      const deletedModifiers = await tx.modifier.deleteMany({
        where: { isDemo: true, group: { venueId } },
      })
      result.deletedModifiers = deletedModifiers.count
      logger.info(`  ✓ Deleted ${deletedModifiers.count} demo modifiers`)

      // 16. Delete demo ModifierGroups
      const deletedModifierGroups = await tx.modifierGroup.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedModifierGroups = deletedModifierGroups.count
      logger.info(`  ✓ Deleted ${deletedModifierGroups.count} demo modifier groups`)

      // 17. Delete MenuCategoryAssignments for demo categories
      const demoCategories = await tx.menuCategory.findMany({
        where: { venueId, isDemo: true },
        select: { id: true },
      })
      if (demoCategories.length > 0) {
        await tx.menuCategoryAssignment.deleteMany({
          where: { categoryId: { in: demoCategories.map(c => c.id) } },
        })
      }

      // 18. Delete demo MenuCategories
      const deletedMenuCategories = await tx.menuCategory.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedMenuCategories = deletedMenuCategories.count
      logger.info(`  ✓ Deleted ${deletedMenuCategories.count} demo menu categories`)

      // 19. Delete MenuCategoryAssignments for demo menus
      const demoMenus = await tx.menu.findMany({
        where: { venueId, isDemo: true },
        select: { id: true },
      })
      if (demoMenus.length > 0) {
        await tx.menuCategoryAssignment.deleteMany({
          where: { menuId: { in: demoMenus.map(m => m.id) } },
        })
      }

      // 20. Delete demo Menus
      const deletedMenus = await tx.menu.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedMenus = deletedMenus.count
      logger.info(`  ✓ Deleted ${deletedMenus.count} demo menus`)

      // 21. Reset tables and delete demo tables
      await tx.table.updateMany({
        where: { venueId },
        data: {
          status: 'AVAILABLE',
          currentOrderId: null,
        },
      })

      const deletedTables = await tx.table.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedTables = deletedTables.count
      logger.info(`  ✓ Deleted ${deletedTables.count} demo tables`)

      // 22. Delete demo Areas
      const deletedAreas = await tx.area.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedAreas = deletedAreas.count
      logger.info(`  ✓ Deleted ${deletedAreas.count} demo areas`)

      // 23. Delete demo CustomerGroups
      const deletedCustomerGroups = await tx.customerGroup.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedCustomerGroups = deletedCustomerGroups.count
      logger.info(`  ✓ Deleted ${deletedCustomerGroups.count} demo customer groups`)

      // 24. Delete demo LoyaltyConfig
      const deletedLoyaltyConfig = await tx.loyaltyConfig.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedLoyaltyConfig = deletedLoyaltyConfig.count
      logger.info(`  ✓ Deleted ${deletedLoyaltyConfig.count} demo loyalty configs`)

      // 25. Delete demo RawMaterials
      const deletedRawMaterials = await tx.rawMaterial.deleteMany({
        where: {
          venueId,
          isDemo: true,
        },
      })
      result.deletedRawMaterials = deletedRawMaterials.count
      logger.info(`  ✓ Deleted ${deletedRawMaterials.count} demo raw materials`)

      // NOTE: non-demo Inventory and RawMaterial stock is intentionally NOT
      // reset. The user captured that stock during the trial — it is real
      // data and must survive the conversion untouched.
      return result
    },
    {
      etiqueta: 'cleanDemoData',
      timeout: 120000, // 2 minute timeout for comprehensive cleanup
    },
  )

  if (result.skippedReason) {
    logger.warn(`⚠️ Demo cleanup skipped for venue ${venueId}: it sold gift cards (their balance is customer money)`, {
      venueId,
      skippedReason: result.skippedReason,
    })
    await logAction({
      staffId: staffId ?? null,
      venueId,
      action: 'DEMO_CLEANUP_SKIPPED',
      entity: 'Venue',
      entityId: venueId,
      data: { reason: result.skippedReason },
    })
    return result
  }

  if (result.pagosDemo) {
    await logAction({
      staffId: staffId ?? null,
      venueId,
      action: 'DEMO_PAYMENT_POSITIONS_CLEANED',
      entity: 'VenuePaymentConfig',
      entityId: venueId,
      data: { ...result.pagosDemo, cuentasDemoBorradas: result.deletedMerchantAccounts },
    })
  }

  logger.info(`🎉 Demo data cleanup complete for venue ${venueId}`)
  logger.info(`   Transactional: ${result.deletedOrders} orders, ${result.deletedPayments} payments`)
  logger.info(
    `   Business Setup: ${result.deletedProducts} products, ${result.deletedMenuCategories} categories, ${result.deletedRecipes} recipes`,
  )
  logger.info(`   User data preserved: non-demo inventory, raw materials, movements and batches untouched`)

  return result
}

/**
 * Check if venue has demo data that needs cleanup
 * Useful for UI to show cleanup option
 *
 * @param venueId - Venue ID to check
 * @returns true if venue has demo data
 */
export async function hasDemoData(venueId: string): Promise<boolean> {
  // Check for demo indicators using isDemo field
  const [demoOrderCount, demoProductCount, demoMenuCount, demoRawMaterialCount, demoCustomerCount] = await Promise.all([
    prisma.order.count({
      where: {
        venueId,
        orderNumber: { startsWith: 'DEMO-' },
      },
    }),
    prisma.product.count({
      where: {
        venueId,
        isDemo: true,
      },
    }),
    prisma.menu.count({
      where: {
        venueId,
        isDemo: true,
      },
    }),
    prisma.rawMaterial.count({
      where: {
        venueId,
        isDemo: true,
      },
    }),
    prisma.customer.count({
      where: {
        venueId,
        email: { endsWith: '@demo.com' },
      },
    }),
  ])

  return demoOrderCount > 0 || demoProductCount > 0 || demoMenuCount > 0 || demoRawMaterialCount > 0 || demoCustomerCount > 0
}
