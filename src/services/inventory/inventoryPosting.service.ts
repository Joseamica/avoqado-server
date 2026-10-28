/**
 * InventoryPosting — el outbox durable de deducciones de inventario.
 *
 * Fase 2 del plan de remediación (auditoría 2026-08-12 + diseño Codex xhigh):
 * cada transición de venta a PAID crea su posting EN LA MISMA transacción del
 * cobro; el aplicador corre inmediatamente después del commit y el job de
 * respaldo reintenta lo pendiente. Con esto "¿esta venta ya dedujo?" deja de
 * inferirse por logs: se consulta, y un crash entre cobro y deducción deja un
 * posting PENDING visible en vez de una deducción perdida invisible.
 *
 * Invariantes:
 *  - UNIQUE (venueId, sourceKind, sourceId, effectKind): un solo posting SALE
 *    por venta. El duplicado devuelve el existente (idempotencia estructural).
 *  - El aplicador reclama con CAS (PENDING/PARTIAL_FAILED → APPLYING): dos
 *    workers jamás aplican el mismo posting a la vez.
 *  - Reintentable POR LÍNEA: una línea APPLIED nunca se re-deduce; solo las
 *    PENDING/FAILED se reintentan.
 *  - El negativo NO es fallo (Square-parity): la línea queda APPLIED y el
 *    faltante viaja como issue para el aviso del POS.
 *  - Un posting que no aplica lleva skipReason DURABLE — nunca silencio.
 */

import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { deductInventoryForProduct, getProductInventoryMethods } from '../dashboard/productInventoryIntegration.service'
import { esValeRevendido } from '../shared/renglonDeVale'

/** Mismo shape estructural que OrderInventoryWarning['issues'] (payment.tpv). */
export type InventoryPostingIssue = {
  productId: string
  productName: string
  requested: number | null
  available: number | string | null
  reason: string
}

type SalePostingItem = {
  id: string
  productId: string | null
  productName?: string | null
  quantity: number
  weightQuantity?: Prisma.Decimal | number | string | null
  modifiers?: Array<{ quantity: number; modifier: Record<string, unknown> | null }> | null
  /** El renglón vino de un vale por área v7 (puede tener su reserva de inventario ACTIVE). */
  areaTicketLineId?: string | null
  /** D1: el vale de este renglón se volvió a cobrar en otra cuenta (`renglonDeVale.ts`): aquí no se descuenta. */
  releasedAreaTicketLineId?: string | null
}

const itemHasInventoryModifiers = (item: SalePostingItem): boolean =>
  !!item.modifiers?.some(m => (m.modifier as any)?.rawMaterialId && (m.modifier as any)?.quantityPerUnit)

/**
 * La MISMA pregunta del bucle de abajo —«¿a este renglón le nace línea de deducción?»— pero en
 * SQL, para quien no puede ejecutar el bucle: hoy la 7ª invariante del vigilante de dinero
 * («ORDEN SIN VALE DE INVENTARIO», `jobs/money-integrity-watchdog.job.ts`), que necesita saber
 * si una orden YA CERRADA debió descontar stock.
 *
 * 🔴 Vive AQUÍ, pegada al bucle, y no allá, a propósito: son dos copias de una misma regla y lo
 * único que las mantiene juntas es que quien toque una VEA la otra. Y la deriva peligrosa va
 * hacia el SILENCIO — si el camino del cobro se ensancha (un modo de inventario nuevo, un
 * modificador que descuenta de otra forma) y esto no, el vigilante deja de ver pérdidas reales
 * sin que nada falle. Si cambias `createSalePostingInTx`, cambia esto en el MISMO trabajo.
 *
 * Espeja, línea por línea, lo que hace el bucle:
 *  · `if (!item.productId) continue` — sin producto NO hay línea, **ni siquiera por modificador**;
 *  · producto deducible (`getProductInventoryMethods`) = del MISMO venue —el aislamiento por
 *    tenant que pide su `venueId`—, con `trackInventory`, y con `inventoryMethod` explícito o
 *    —fallback de los productos legacy— una `Recipe`;
 *  · o el renglón trae un modificador con materia prima (`itemHasInventoryModifiers` exige
 *    `rawMaterialId` Y `quantityPerUnit`), que descuenta aunque el producto no lleve inventario.
 *  · D1: el renglón de un vale que se volvió a cobrar en otra cuenta (`esValeRevendido`) no descuenta aquí.
 *
 * ⚠️ Falso NEGATIVO conocido, y va hacia el silencio: `OrderItemModifier.modifierId` es
 * `onDelete: SetNull`, así que borrar el modificador del menú deja el renglón sin con qué
 * probar que descontaba y la venta deja de vigilarse. El bucle del cobro no lo sufre —congela
 * los modificadores en `payloadSnapshot` al cobrar, justo por esto—, pero esta consulta mira la
 * relación VIVA. Cubrirlo pediría leer el snapshot… que es lo que falta cuando el vale no nació.
 *
 * `alias` es texto de confianza (código propio), nunca entrada de usuario: se interpola sin
 * parametrizar y acaba dentro de un `$queryRawUnsafe`. Mismo contrato que
 * `baseQueDebeCubrirseSql` en `shared/pagadaPeroAbierta.ts`.
 */
export function ordenDescuentaInventarioSql(alias = 'o'): string {
  const o = alias
  return `EXISTS (
            SELECT 1 FROM "OrderItem" oi
            WHERE oi."orderId" = ${o}.id AND oi."productId" IS NOT NULL
              AND NOT (oi."areaTicketLineId" IS NULL AND oi."releasedAreaTicketLineId" IS NOT NULL)
              AND (
                EXISTS (
                  SELECT 1 FROM "Product" pr
                  WHERE pr.id = oi."productId" AND pr."venueId" = ${o}."venueId" AND pr."trackInventory"
                    AND (pr."inventoryMethod" IS NOT NULL OR EXISTS (SELECT 1 FROM "Recipe" rc WHERE rc."productId" = pr.id))
                )
                OR EXISTS (
                  SELECT 1 FROM "OrderItemModifier" oim
                  JOIN "Modifier" m ON m.id = oim."modifierId"
                  WHERE oim."orderItemId" = oi.id AND m."rawMaterialId" IS NOT NULL AND m."quantityPerUnit" IS NOT NULL
                )
              )
          )`
}

/** Kilos para líneas por peso; piezas para el resto. */
const baseQuantity = (item: SalePostingItem): Prisma.Decimal =>
  item.weightQuantity != null ? new Prisma.Decimal(item.weightQuantity as any) : new Prisma.Decimal(item.quantity)

/**
 * Crea el posting SALE de una orden DENTRO de la transacción del cobro.
 * Una línea por item deducible; sin items deducibles → SKIPPED('NO_ITEMS');
 * `skipReason` explícito (p.ej. área-tickets que ya dedujeron en su propia
 * transacción) → SKIPPED sin líneas. El duplicado devuelve el existente.
 */
export async function createSalePostingInTx(
  tx: Prisma.TransactionClient,
  params: {
    venueId: string
    orderId: string
    items: SalePostingItem[]
    staffId?: string | null
    skipReason?: string
  },
) {
  const { venueId, orderId, skipReason } = params
  const items = params.items ?? []

  // 🔴 El pre-check va ANTES del create, no en un catch de P2002: dentro de una
  // transacción interactiva Postgres ABORTA la tx entera al violar el UNIQUE, y
  // cualquier query posterior (el findUnique del fallback viejo) muere con
  // 25P02 "current transaction is aborted" — tirando el cobro completo en vez
  // de devolver el duplicado. Con el pre-check en la MISMA tx, el replay
  // secuencial (orden re-cobrada tras un refund) encuentra el posting original
  // sin tocar el UNIQUE. Dos cobros verdaderamente concurrentes siguen chocando
  // en el índice, pero esa carrera ya la pierde la transacción del pago misma
  // (idempotencyKey) antes de llegar aquí.
  const existing = await tx.inventoryPosting.findUnique({
    where: {
      venueId_sourceKind_sourceId_effectKind: {
        venueId,
        sourceKind: 'ORDER',
        sourceId: orderId,
        effectKind: 'SALE',
      },
    },
  })
  if (existing) {
    logger.warn('🔄 [InventoryPosting] Posting duplicado — devolviendo el existente', { venueId, orderId })
    return existing
  }

  const lines: Array<{
    effectKey: string
    orderItemId: string
    productId: string
    expectedQuantityBase: Prisma.Decimal
  }> = []

  // 🔴 R12-1 (ronda 12; Codex recheck-16 #1): los renglones de vale v7 cuyo vale NO liberó la cancelación. Cancelar la sesión devuelve
  // sus vales a ISSUED, sin venta (`orderId: null`, el único escritor que lo vacía) y con su reserva ACTIVE; si después llega dinero ya
  // capturado, la venta cancelada se cobra con la regla de nivel venta (se reabre), pero esos vales ya no son suyos: ni se descuentan aquí
  // ni se suelta su reserva. R13-2 (Codex r17 #4): NO se exige que el vale sea de ESTA venta: dividir o fusionar mueve el renglón con su
  // `areaTicketLineId` sin tocar `AreaTicket.orderId`, y ese renglón sí se descuenta en la venta que lo cobra (10 → 9). Salvo que su
  // reserva ya esté CONSUMED: la sesión de la venta de origen ya lo sacó del stock al cobrarse ella primero (sin esto, 10 → 8). Sin
  // renglones de vale (o con `skipReason`) no hay consulta.
  const lineasDeVale = skipReason
    ? []
    : [...new Set(items.map(i => i.areaTicketLineId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const lineasPropias = new Set(
    lineasDeVale.length > 0
      ? (
          await tx.areaTicketLine.findMany({
            where: {
              id: { in: lineasDeVale },
              areaTicket: { venueId, orderId: { not: null } },
              reservations: { none: { status: 'CONSUMED' } },
            },
            select: { id: true, orderItem: { select: { id: true } } },
            take: lineasDeVale.length,
          })
        )
          // D1 (Codex r2 #1 / r3): el renglón tiene que ser el DUEÑO VIVO del vínculo, no una lectura vieja que todavía lo trae. Si el
          // vale se volvió a cobrar en otra cuenta, su vínculo ya es de otro renglón: éste no se descuenta ni suelta la reserva ajena.
          // Dividir o fusionar (R13-2) mueve el MISMO renglón, así que sigue siendo el dueño y sigue descontando.
          .filter(l => l.orderItem != null && items.some(i => i.id === l.orderItem!.id && i.areaTicketLineId === l.id))
          .map(l => l.id)
      : [],
  )

  if (!skipReason) {
    // UNA consulta clasifica todos los productos (antes: un findUnique con
    // includes POR ITEM, secuencial, dentro de la tx del cobro — N+1 contra el
    // timeout de 5s). Se usa la tx para no pedirle otra conexión al pool.
    const productIds = items.map(i => i.productId).filter((id): id is string => !!id)
    // El venueId acota la clasificación al negocio del posting: un producto de
    // OTRO venue nunca queda clasificado y por tanto nunca genera línea de
    // deducción (audit Codex fase 5 — varios caminos aceptan un orderId externo
    // sin verificar a quién pertenece).
    const methods = await getProductInventoryMethods(productIds, tx as any, venueId)
    for (const item of items) {
      if (!item.productId) continue
      if (esValeRevendido(item)) continue
      if (item.areaTicketLineId && !lineasPropias.has(item.areaTicketLineId)) continue
      const method = methods.get(item.productId) ?? null
      if (!method && !itemHasInventoryModifiers(item)) continue
      lines.push({
        effectKey: item.id,
        orderItemId: item.id,
        productId: item.productId,
        expectedQuantityBase: baseQuantity(item),
      })
    }
  }

  // 🔴 El motivo del skip distingue casos que NO son lo mismo (fase 5, audit
  // Codex). "NO_ITEMS" para todo escondía tres realidades:
  //   · NO_ITEMS         — la venta no trae renglones (cobro de puro monto)
  //   · CUSTOM_ITEM      — sólo importes libres, ninguno del catálogo
  //   · NO_TRACKED_ITEMS — sí hay productos, pero ninguno lleva inventario
  // La tercera es la que importa al conciliar: significa "este negocio no
  // rastrea inventario aquí", no "no había qué descontar".
  const resolvedSkip =
    skipReason ??
    (lines.length > 0 ? undefined : items.length === 0 ? 'NO_ITEMS' : items.some(i => i.productId) ? 'NO_TRACKED_ITEMS' : 'CUSTOM_ITEM')

  // 🔴 R10-2 (ronda 10 post-QA de sellos tardíos; Codex recheck-14 #2; de vuelta en R12-2 tras revertir R11-7): este vale toma la
  // obligación de inventario de TODOS los renglones, también los de un vale por área v7 con su reserva ACTIVE (la apartó al emitirse y
  // nadie la consumió: otro canal —pago manual, liquidar desde el panel o el saldo del cliente, cripto— cierra la venta sin conocer la
  // sesión). La reserva se suelta AQUÍ, en la misma transacción del cierre y SIN mover stock (como al cancelar un vale sin cobrar): si se
  // quedaba, restaba disponibilidad para siempre y el siguiente vale se rechazaba con mercancía en el anaquel. También sin líneas (el
  // producto dejó de inventariarse: SKIPPED / NO_TRACKED_ITEMS) y aunque una línea falle después (Codex recheck-16 #2 y #3): la obligación
  // vive en el vale. Con `skipReason` (la sesión o el efectivo del POS que ya consumieron en su propia transacción) no se toca nada.
  if (lineasPropias.size > 0) {
    await tx.areaTicketInventoryReservation.updateMany({
      where: { venueId, areaTicketLineId: { in: [...lineasPropias] }, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    })
  }

  return await tx.inventoryPosting.create({
    data: {
      venueId,
      sourceKind: 'ORDER',
      sourceId: orderId,
      effectKind: 'SALE',
      orderId,
      ...(resolvedSkip ? { status: 'SKIPPED', skipReason: resolvedSkip } : {}),
      payloadSnapshot: {
        items: items.map(i => ({
          id: i.id,
          productId: i.productId,
          quantity: i.quantity,
          weightQuantity: i.weightQuantity != null ? String(i.weightQuantity) : null,
          // Congelado AL COBRAR: la recuperación post-crash clasifica el grupo
          // de efectos con este valor, no con la relación viva — un modificador
          // borrado después (onDelete: SetNull) haría parecer "sin
          // modificadores" a una línea que sí los dedujo a medias.
          hasInventoryModifiers: itemHasInventoryModifiers(i),
          // El PAYLOAD completo de los modificadores, no solo su presencia
          // (audit ronda 4): un apply diferido (sweeper) que dependiera de la
          // relación viva deduciría solo el producto base si el modificador se
          // borró después de la venta — la venta ES un hecho congelado, el
          // aplicador deduce lo que se vendió, no lo que sobrevive en el menú.
          modifiers: (i.modifiers ?? [])
            .filter(m => m.modifier)
            .map(m => ({
              quantity: m.quantity,
              modifier: {
                id: (m.modifier as any).id,
                name: (m.modifier as any).name,
                groupId: (m.modifier as any).groupId,
                rawMaterialId: (m.modifier as any).rawMaterialId ?? null,
                quantityPerUnit: (m.modifier as any).quantityPerUnit != null ? String((m.modifier as any).quantityPerUnit) : null,
                unit: (m.modifier as any).unit ?? null,
                inventoryMode: (m.modifier as any).inventoryMode ?? null,
              },
            })),
        })),
      },
      ...(lines.length > 0 ? { lines: { create: lines } } : {}),
    },
  })
}

/**
 * Aplica un posting SALE: reclama con CAS, deduce línea por línea (solo
 * PENDING/FAILED) y deja el estado final consultable. NUNCA lanza por un fallo
 * de deducción — el fallo queda en la línea y el posting en PARTIAL_FAILED
 * para que el job de respaldo lo reintente.
 *
 * @returns null si otro worker tiene el claim; si no, los issues para el aviso
 *          del POS (negativos y fallos) y si quedó completamente aplicado.
 */
/**
 * Un claim APPLYING más viejo que esto se considera huérfano (el worker murió
 * entre el CAS y el update final) y puede re-reclamarse. 10 min >> cualquier
 * aplicación real (segundos), y la idempotencia por línea + el guard de
 * movimientos hacen seguro el re-claim aunque el worker original siguiera vivo.
 */
const APPLYING_LEASE_MS = 10 * 60 * 1000

async function claimPosting(postingId: string, effectKind: 'SALE' | 'CUSTOMER_RETURN'): Promise<Date | null> {
  // El sello del claim funciona como CERCA COOPERATIVA: si otro worker
  // re-reclama (lease vencido), cambia updatedAt; el dueño original lo detecta
  // antes de cada línea y se retira en vez de deducir en paralelo.
  const claimStamp = new Date()
  const claim = await prisma.inventoryPosting.updateMany({
    where: {
      id: postingId,
      effectKind,
      OR: [
        { status: { in: ['PENDING', 'PARTIAL_FAILED'] } },
        // Rescate de claims huérfanos: un crash entre el CAS y el update final
        // dejaba el posting APPLYING para siempre — ni este predicado ni el job
        // de respaldo podían volver a tocarlo, y la venta quedaba sin deducir.
        { status: 'APPLYING', updatedAt: { lt: new Date(Date.now() - APPLYING_LEASE_MS) } },
      ],
    },
    // El regreso cuenta sólo fallos reales al cerrar; esperar inventario apagado no consume intentos (R33).
    data: { status: 'APPLYING', ...(effectKind === 'SALE' ? { attempts: { increment: 1 } } : {}), updatedAt: claimStamp },
  })
  return claim.count === 0 ? null : claimStamp
}

async function finalizePosting(postingId: string, claimStamp: Date, data: Prisma.InventoryPostingUpdateManyMutationInput) {
  return prisma.inventoryPosting.updateMany({ where: { id: postingId, status: 'APPLYING', updatedAt: claimStamp }, data })
}

export async function applySalePosting(
  postingId: string,
  staffId?: string | null,
): Promise<{ postingId: string; applied: boolean; issues: InventoryPostingIssue[] } | null> {
  const claimStamp = await claimPosting(postingId, 'SALE')
  if (!claimStamp) return null

  const posting = await prisma.inventoryPosting.findUnique({
    where: { id: postingId },
    include: { lines: true },
  })
  if (!posting) return null

  const orderItems = await prisma.orderItem.findMany({
    where: { orderId: posting.sourceId },
    include: { modifiers: { include: { modifier: true } } },
  })
  const itemsById = new Map(orderItems.map(item => [item.id, item]))

  const issues: InventoryPostingIssue[] = []
  let anyFailed = false

  for (const line of posting.lines) {
    if (line.status === 'APPLIED' || line.status === 'SKIPPED') continue

    // 🛡️ Cerca cooperativa: si otro worker re-reclamó este posting (nuestro
    // sello ya no coincide), nos retiramos ANTES de deducir — dos workers
    // deduciendo el mismo posting en paralelo es justo el doble-descuento que
    // el claim existe para impedir. El nuevo dueño termina el trabajo.
    const owner = await prisma.inventoryPosting.findUnique({ where: { id: postingId }, select: { updatedAt: true } })
    if (owner?.updatedAt && owner.updatedAt.getTime() !== claimStamp.getTime()) {
      logger.warn('🛡️ [InventoryPosting] Claim re-reclamado por otro worker — este apply se retira', {
        postingId,
        lineId: line.id,
      })
      return null
    }

    const item = itemsById.get(line.orderItemId ?? line.effectKey)
    // El snapshot congelado al cobrar es la fuente de verdad de la VENTA: si
    // el OrderItem vivo ya no existe (cleanup/edición en la ventana del
    // sweeper), el snapshot basta para deducir — la venta pagada es un hecho.
    const snapshotItem = ((posting.payloadSnapshot as any)?.items ?? []).find((si: any) => si?.id === (line.orderItemId ?? line.effectKey))
    if ((!item && !snapshotItem) || !line.productId) {
      // Ni la tabla viva NI el snapshot conocen esta línea — se marca VISIBLE,
      // no se inventa. (Antes bastaba que faltara el item vivo para SKIPPED:
      // un apply diferido perdía la deducción en silencio.)
      await prisma.inventoryPostingLine.update({
        where: { id: line.id },
        data: { status: 'SKIPPED', reason: 'ORPHAN_LINE' },
      })
      logger.warn('⚠️ [InventoryPosting] Línea huérfana: sin item vivo ni snapshot — SKIPPED', {
        postingId,
        lineId: line.id,
        productId: line.productId,
      })
      continue
    }

    // 🔴 Guard anti doble-deducción: la deducción commitea en SU transacción y
    // el flip de la línea a APPLIED corre DESPUÉS — un crash (o un error
    // transitorio del update) en esa ventana deja la línea PENDING/FAILED con
    // el stock YA descontado, y el reintento volvería a descontarlo. Los
    // movimientos llevan postingLineId (InventoryMovement para QUANTITY,
    // RawMaterialMovement para receta/modificadores): si existen, la deducción
    // ya ocurrió — se recupera el estado en vez de repetir el efecto.
    const [invMovements, rawMovements] = await Promise.all([
      prisma.inventoryMovement.count({ where: { postingLineId: line.id } }),
      prisma.rawMaterialMovement.count({ where: { postingLineId: line.id } }),
    ])
    if (invMovements + rawMovements > 0) {
      // La recuperación exacta SOLO aplica cuando la línea tiene UN grupo
      // atómico de efectos: producto QUANTITY sin modificadores (su movimiento
      // commitea con el stock en una tx) o receta sin modificadores (todo-o-
      // nada en una tx Serializable). Con modificadores inventariables los
      // sub-efectos commitean por separado: ver movimientos NO prueba que TODOS
      // ocurrieron — marcar APPLIED perdería el modificador en silencio, y
      // re-deducir duplicaría el producto. Esa línea va a conciliación manual.
      //
      // Se clasifica con el SNAPSHOT congelado al cobrar (fallback: relación
      // viva, para postings anteriores a este campo): un modificador borrado
      // después del cobro pondría la relación en null y haría pasar por
      // "sin modificadores" una línea con efectos parciales.
      const lineHasInventoryModifiers =
        typeof snapshotItem?.hasInventoryModifiers === 'boolean'
          ? snapshotItem.hasInventoryModifiers
          : item
            ? itemHasInventoryModifiers(item as any)
            : false
      if (lineHasInventoryModifiers) {
        anyFailed = true
        issues.push({
          productId: line.productId,
          productName: (item as any)?.productName || 'Producto',
          requested: Number(line.expectedQuantityBase),
          available: null,
          reason: 'PARTIAL_EFFECTS_MANUAL_RECONCILE',
        })
        await prisma.inventoryPostingLine.update({
          where: { id: line.id },
          data: { status: 'FAILED', reason: 'PARTIAL_EFFECTS_MANUAL_RECONCILE' },
        })
        logger.error('🚨 [InventoryPosting] Línea con efectos PARCIALES (producto+modificadores) — requiere conciliación manual', {
          postingId,
          lineId: line.id,
          productId: line.productId,
          invMovements,
          rawMovements,
        })
        continue
      }

      await prisma.inventoryPostingLine.update({
        where: { id: line.id },
        data: { status: 'APPLIED', appliedQuantityBase: line.expectedQuantityBase, reason: 'RECOVERED_FROM_MOVEMENTS' },
      })
      logger.warn('🩹 [InventoryPosting] Línea recuperada de movimientos existentes — NO se re-deduce', {
        postingId,
        lineId: line.id,
        productId: line.productId,
        invMovements,
        rawMovements,
      })
      continue
    }

    // Los modificadores salen del SNAPSHOT congelado al cobrar (fallback:
    // relación viva, para postings anteriores al campo). La venta es un hecho:
    // el aplicador deduce lo que se vendió, aunque el modificador ya no exista
    // en el menú (onDelete: SetNull dejaba la relación en null y un apply
    // diferido deducía solo el producto base, perdiendo el efecto en silencio).
    const orderModifiers = Array.isArray(snapshotItem?.modifiers)
      ? snapshotItem.modifiers
          .filter((m: any) => m?.modifier)
          .map((m: any) => ({
            quantity: m.quantity,
            modifier: {
              id: m.modifier.id,
              name: m.modifier.name,
              groupId: m.modifier.groupId,
              rawMaterialId: m.modifier.rawMaterialId,
              // El snapshot guarda el Decimal como string — se revive aquí.
              quantityPerUnit: m.modifier.quantityPerUnit != null ? new Prisma.Decimal(m.modifier.quantityPerUnit) : null,
              unit: m.modifier.unit,
              inventoryMode: m.modifier.inventoryMode,
            },
          }))
      : (item?.modifiers
          ?.filter((m: any) => m.modifier)
          .map((m: any) => ({
            quantity: m.quantity,
            modifier: {
              id: m.modifier.id,
              name: m.modifier.name,
              groupId: m.modifier.groupId,
              rawMaterialId: m.modifier.rawMaterialId,
              quantityPerUnit: m.modifier.quantityPerUnit,
              unit: m.modifier.unit,
              inventoryMode: m.modifier.inventoryMode,
            },
          })) ?? [])

    const effectiveQuantity = Number(line.expectedQuantityBase)

    try {
      const result: any = await deductInventoryForProduct(
        posting.venueId,
        line.productId,
        effectiveQuantity,
        posting.orderId ?? posting.sourceId,
        staffId ?? undefined,
        orderModifiers,
        { postingLineId: line.id },
      )
      if (typeof result?.remainingStock === 'number' && result.remainingStock < 0) {
        issues.push({
          productId: line.productId,
          productName: result.productName || (item as any).productName || 'Producto',
          requested: effectiveQuantity,
          available: result.remainingStock,
          reason: 'la venta dejó el stock en negativo',
        })
      }
      await prisma.inventoryPostingLine.update({
        where: { id: line.id },
        data: { status: 'APPLIED', appliedQuantityBase: line.expectedQuantityBase, reason: null },
      })
    } catch (error: any) {
      anyFailed = true
      issues.push({
        productId: line.productId,
        productName: (item as any)?.productName || 'Producto',
        requested: effectiveQuantity,
        available: null,
        reason: error.message,
      })
      await prisma.inventoryPostingLine.update({
        where: { id: line.id },
        data: { status: 'FAILED', reason: error.message },
      })
      logger.error('❌ [InventoryPosting] Línea de posting falló — queda para reintento', {
        postingId,
        lineId: line.id,
        productId: line.productId,
        error: error.message,
      })
    }
  }

  // 🛡️ El cierre también va CERCADO con el sello del claim: un worker que se
  // atoró después de su última línea no puede pisar el resultado de un
  // reemplazo que ya re-reclamó, reintentó la línea fallida y marcó APPLIED —
  // sobreescribirlo con un PARTIAL_FAILED stale re-encolaría trabajo ya hecho.
  const finalized = await finalizePosting(
    postingId,
    claimStamp,
    anyFailed
      ? { status: 'PARTIAL_FAILED', lastError: issues.find(i => i.available === null)?.reason ?? 'línea fallida' }
      : { status: 'APPLIED', appliedAt: new Date(), lastError: null },
  )
  if (finalized.count === 0) {
    logger.warn('🛡️ [InventoryPosting] Cierre perdido: otro worker re-reclamó el posting — el nuevo dueño decide el estado final', {
      postingId,
    })
    return null
  }

  return { postingId, applied: !anyFailed, issues }
}

type CustomerReturnParams = {
  venueId: string
  refundPaymentId: string
  orderId: string
  lines: Array<{
    orderItemId: string
    productId: string
    quantity: number
    eligibility?: { inventoryMethod: string | null; eligible: boolean }
    /**
     * «Regresa lo que salió menos lo que ya regresó» (28-oct): una cantidad ya RESUELTA que no vuelve al estante (prenda dañada,
     * renglón no elegido). Nace SKIPPED con su propia `effectKey` y no entra al snapshot del aplicador.
     */
    noReponer?: { reason: string }
  }>
  staffId?: string | null
  /** El motivo del movimiento de inventario; sin él, el del Cambio. */
  motivo?: string
}

/** Congela la obligación junto al reembolso: ni reintentos ni cambios del catálogo la redefinen. */
export async function createCustomerReturnPostingInTx(
  tx: Prisma.TransactionClient,
  params: CustomerReturnParams,
): Promise<{ id: string } | null> {
  if (params.lines.length === 0) return null
  const { venueId, refundPaymentId, orderId, lines, staffId } = params
  const existing = await tx.inventoryPosting.findUnique({
    where: {
      venueId_sourceKind_sourceId_effectKind: {
        venueId,
        sourceKind: 'REFUND_PAYMENT',
        sourceId: refundPaymentId,
        effectKind: 'CUSTOMER_RETURN',
      },
    },
  })
  if (existing) return existing

  // El cambio ya decidió qué vuelve: releer aquí podría descartar para siempre una pieza al apagar inventario.
  const productIds = [...new Set(lines.filter(l => !l.eligibility && !l.noReponer).map(l => l.productId))]
  const products = productIds.length
    ? await tx.product.findMany({
        where: { venueId, id: { in: productIds } },
        select: { id: true, trackInventory: true, inventoryMethod: true, inventory: { select: { id: true } } },
        take: productIds.length,
      })
    : []
  const byId = new Map(products.map(p => [p.id, p]))
  return tx.inventoryPosting.create({
    data: {
      venueId,
      sourceKind: 'REFUND_PAYMENT',
      sourceId: refundPaymentId,
      effectKind: 'CUSTOMER_RETURN',
      orderId,
      payloadSnapshot: {
        staffId: staffId ?? null,
        ...(params.motivo ? { motivo: params.motivo } : {}),
        lines: lines.filter(l => !l.noReponer).map(l => {
          const p = byId.get(l.productId)
          return {
            orderItemId: l.orderItemId,
            productId: l.productId,
            inventoryMethod: l.eligibility ? l.eligibility.inventoryMethod : (p?.inventoryMethod ?? null),
            eligible: l.eligibility ? l.eligibility.eligible : !!(p?.trackInventory && p.inventoryMethod === 'QUANTITY' && p.inventory),
          }
        }),
      },
      lines: {
        create: lines.map(l => ({
          effectKey: l.noReponer ? l.orderItemId + NO_REPONER : l.orderItemId,
          orderItemId: l.orderItemId,
          productId: l.productId,
          expectedQuantityBase: new Prisma.Decimal(l.quantity),
          ...(l.noReponer ? { status: 'SKIPPED' as const, reason: l.noReponer.reason } : {}),
        })),
      },
    },
    select: { id: true },
  })
}

const INVENTORY_DISABLED_AFTER_EXCHANGE = 'INVENTORY_DISABLED_AFTER_EXCHANGE'
/** Sufijo de la `effectKey` de una cantidad resuelta que no vuelve al estante (ver `noReponer`). */
export const NO_REPONER = '#NO_REPONER'

/** La ficha reactivada despierta sólo sus regresos detenidos, sin tocar un worker en curso. */
export async function rearmCustomerReturnPostingsInTx(
  tx: Prisma.TransactionClient,
  product: { id: string; venueId: string; trackInventory: boolean; inventoryMethod: string | null },
): Promise<void> {
  if (!product.trackInventory || product.inventoryMethod !== 'QUANTITY') return
  await tx.inventoryPosting.updateMany({
    where: {
      venueId: product.venueId,
      effectKind: 'CUSTOMER_RETURN',
      status: { in: ['PENDING', 'PARTIAL_FAILED'] },
      lines: { some: { productId: product.id, status: { in: ['PENDING', 'FAILED'] }, reason: INVENTORY_DISABLED_AFTER_EXCHANGE } },
    },
    data: { attempts: 0, updatedAt: new Date(0) },
  })
}

// ponytail: sólo piezas (QUANTITY); una receta no se reingresa — ampliar con postingLineId en adjustStock si una tienda lo pide
export async function applyCustomerReturnPosting(
  postingId: string,
  staffId?: string | null,
): Promise<{ postingId: string; applied: boolean } | null> {
  const claimStamp = await claimPosting(postingId, 'CUSTOMER_RETURN')
  if (!claimStamp) return null
  const posting = await prisma.inventoryPosting.findUnique({ where: { id: postingId }, include: { lines: true } })
  if (!posting) return null
  const snapshot = posting.payloadSnapshot as {
    staffId?: string | null
    motivo?: string
    lines?: Array<{ orderItemId: string; eligible: boolean }>
  } | null
  let waiting = false
  let failure: string | null = null

  for (const line of posting.lines) {
    if (line.status === 'APPLIED' || line.status === 'SKIPPED') continue
    try {
      const result = await prisma.$transaction(async tx => {
        // Orden compartido con la ficha: Product → posting → Inventory. La configuración no cambia a media devolución.
        if (line.productId)
          await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${line.productId} AND "venueId" = ${posting.venueId} FOR NO KEY UPDATE`
        // El cerco se bloquea hasta el commit: ni un lease vencido permite dos incrementos de la misma línea.
        const owned = await tx.inventoryPosting.updateMany({
          where: { id: postingId, venueId: posting.venueId, status: 'APPLYING', updatedAt: claimStamp },
          data: { updatedAt: claimStamp },
        })
        if (!owned.count) return 'LOST'
        const current = await tx.inventoryPostingLine.findFirst({
          where: { id: line.id, postingId, status: { in: ['PENDING', 'FAILED'] } },
        })
        if (!current) return 'DONE'
        if (await tx.inventoryMovement.count({ where: { postingLineId: line.id, inventory: { venueId: posting.venueId } } })) {
          await tx.inventoryPostingLine.update({
            where: { id: line.id },
            data: { status: 'APPLIED', appliedQuantityBase: line.expectedQuantityBase, reason: 'RECOVERED_FROM_MOVEMENTS' },
          })
          return 'DONE'
        }
        const frozen = snapshot?.lines?.find(l => l.orderItemId === line.effectKey)
        if (!frozen) throw new Error('RETURN_SNAPSHOT_MISSING')
        if (!frozen.eligible) {
          await tx.inventoryPostingLine.update({ where: { id: line.id }, data: { status: 'SKIPPED', reason: 'NOT_QUANTITY_METHOD' } })
          return 'DONE'
        }
        const product = await tx.product.findFirst({
          where: { id: line.productId!, venueId: posting.venueId },
          select: { trackInventory: true, inventoryMethod: true, inventory: { select: { id: true } } },
        })
        if (!product?.trackInventory || product.inventoryMethod !== 'QUANTITY' || !product.inventory) {
          await tx.inventoryPostingLine.update({
            where: { id: line.id },
            data: { status: 'PENDING', reason: INVENTORY_DISABLED_AFTER_EXCHANGE },
          })
          return 'WAITING'
        }
        const inventory = await tx.inventory.update({
          where: { id: product.inventory.id, venueId: posting.venueId },
          data: { currentStock: { increment: line.expectedQuantityBase } },
        })
        await tx.inventoryMovement.create({
          data: {
            inventoryId: inventory.id,
            type: 'ADJUSTMENT',
            quantity: line.expectedQuantityBase,
            previousStock: inventory.currentStock.minus(line.expectedQuantityBase),
            newStock: inventory.currentStock,
            reason: snapshot?.motivo ?? 'Cambio de producto: regresa al inventario',
            reference: posting.sourceId,
            postingLineId: line.id,
            createdBy: staffId ?? snapshot?.staffId ?? null,
          },
        })
        await tx.inventoryPostingLine.update({
          where: { id: line.id },
          data: { status: 'APPLIED', appliedQuantityBase: line.expectedQuantityBase, reason: null },
        })
        return 'DONE'
      })
      if (result === 'LOST') return null
      if (result === 'WAITING') waiting = true
    } catch (error) {
      failure = error instanceof Error ? error.message : 'CUSTOMER_RETURN_FAILED'
      // También el cierre de falla se cerca: un dueño viejo no pisa al que lo reemplazó.
      await prisma.inventoryPostingLine.updateMany({
        where: {
          id: line.id,
          status: { in: ['PENDING', 'FAILED'] },
          posting: { id: postingId, status: 'APPLYING', updatedAt: claimStamp },
        },
        data: { status: 'FAILED', reason: failure },
      })
      logger.error('Customer return posting line failed', { postingId, lineId: line.id, venueId: posting.venueId, error: failure })
    }
  }
  const applied = !waiting && !failure
  const finalized = await finalizePosting(postingId, claimStamp, {
    status: applied ? 'APPLIED' : 'PARTIAL_FAILED',
    appliedAt: applied ? new Date() : null,
    lastError: failure ?? (waiting ? INVENTORY_DISABLED_AFTER_EXCHANGE : null),
    ...(failure ? { attempts: { increment: 1 } } : {}),
  })
  return finalized.count ? { postingId, applied } : null
}
