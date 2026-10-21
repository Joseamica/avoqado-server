import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { updateProduct, createProduct, getProduct } from '@/services/dashboard/product.dashboard.service'
import { createMenuCategory, createModifierGroup } from '@/services/dashboard/menu.dashboard.service'
import { MODIFIER_SKU_FORMAT_MESSAGE, MODIFIER_SKU_MAX, SKU_REGEX } from '@/schemas/dashboard/menu.schema'
import { auditMcpWrite } from '../audit'
import { ProductType, type IvaTratamiento } from '@prisma/client'
import { operationHash } from '@/utils/operationHash'
import AppError from '@/errors/AppError'
import logger from '@/config/logger'
import { estadoIvaPorProducto } from '@/services/fiscal/encendidoIva.service'
import { DONDE_SE_CAMBIA_EL_IVA } from '@/services/fiscal/normalizarIvaDeProducto'

const round2 = (n: number): number => Math.round(n * 100) / 100

/** IVA por producto (plan 6b): el IVA como lo dice la ficha del dashboard. */
const ETIQUETA_IVA: Record<IvaTratamiento, string> = {
  IVA_16: '16 %',
  IVA_8: '8 %',
  IVA_0: '0 %',
  EXENTO: 'Exento',
  NO_OBJETO: 'No objeto de IVA',
  BLOQUEADO_03: 'Por revisar',
  BLOQUEADO_04: 'Por revisar',
}

/**
 * Item types the booking calendar schedules. These MUST carry a duration —
 * `Reservation.duration` is summed from them, and a NULL silently contributes
 * zero minutes to the appointment window.
 */
const BOOKABLE_TYPES = new Set(['service', 'class'])

const PRODUCT_TYPE_MAP: Record<string, ProductType> = {
  product: ProductType.REGULAR,
  food_or_beverage: ProductType.FOOD_AND_BEV,
  service: ProductType.APPOINTMENTS_SERVICE,
  class: ProductType.CLASS,
  event: ProductType.EVENT,
  digital: ProductType.DIGITAL,
  donation: ProductType.DONATION,
}

/** Find products in scope by (partial, case-insensitive) name — shared by the menu tools. */
async function matchProductsByName(venueWhere: { venueId: { in: string[] } }, name: string, resolvedId?: string) {
  return prisma.product.findMany({
    // Plan 5 (D6): un producto archivado no se busca ni se «des-86»; regresa importándolo.
    where: {
      ...venueWhere,
      deletedAt: null,
      ...(resolvedId ? { id: resolvedId } : { name: { contains: name, mode: 'insensitive' as const } }),
    },
    select: { id: true, name: true, active: true, price: true, ivaTratamiento: true },
    take: 10,
  })
}

export function registerMenuTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_menu',
    'List the menu items of a venue you can access: name, price, its VAT (IVA: 16 %, 0 %, Exento), whether it is active ("86" = disabled), category and type. Optionally filter by name or only available items. Pass venueId. Handy to look up exact names/prices before changing them.',
    {
      venueId: z.string().describe('Venue whose menu to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by item name (partial, case-insensitive)'),
      activeOnly: z.boolean().optional().describe('Only available items (exclude "86"/disabled)'),
      limit: z.number().int().positive().max(200).optional().describe('Max items to return (default 100)'),
      offset: z.number().int().min(0).optional().describe('Offset from the previous page'),
    },
    async ({ venueId, search, activeOnly, limit, offset = 0 }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('menu:read', venueId)
      const filter = {
        ...where,
        deletedAt: null, // Plan 5 (D6): los archivados no son parte del menú
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
        ...(activeOnly ? { active: true } : {}),
      }
      const total = await prisma.product.count({ where: filter })
      const products = await prisma.product.findMany({
        where: filter,
        select: {
          name: true,
          price: true,
          ivaTratamiento: true,
          active: true,
          type: true,
          soldByWeight: true,
          unit: true,
          category: { select: { name: true } },
        },
        orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
        skip: offset,
        take: limit ?? 100,
      })
      return text({
        venueId,
        count: products.length,
        total,
        hasMore: offset + products.length < total,
        nextOffset: offset + products.length < total ? offset + products.length : null,
        items: products.map(p => ({
          name: p.name,
          price: Number(p.price),
          iva: ETIQUETA_IVA[p.ivaTratamiento],
          active: p.active,
          type: p.type,
          category: p.category?.name ?? null,
          // Venta por peso: price is per KILOGRAM for these items.
          ...(p.soldByWeight ? { soldByWeight: true, unit: p.unit } : {}),
        })),
      })
    },
  )

  server.tool(
    'set_menu_item_active',
    'Enable or disable ("86") a menu item in a venue you can access, found by name. Disabled items stop showing/selling — a customer-visible change, so by DEFAULT it only PREVIEWS (current → new state); call again with confirm:true to apply. This WRITES — requires products:update. If the name matches several items it returns the matches so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      name: z.string().min(1).describe('Menu item name or part of it, e.g. "Carnitas"'),
      active: z.boolean().describe('true = available; false = "86" (disabled / out of stock)'),
      resolvedProductId: z.string().optional().describe('ID exacto devuelto por la vista previa'),
      expectedSourceFingerprint: z.string().optional().describe('Huella exacta devuelta por la vista previa'),
      confirm: z.boolean().optional().describe('Must be true to actually change availability; without it you get a preview'),
    },
    async ({ venueId, name, active, confirm, resolvedProductId, expectedSourceFingerprint }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('products:update', venueId) // write gate (per-venue role)
      const matches = await matchProductsByName(where, name, confirm ? resolvedProductId : undefined)
      if (matches.length === 0) return text({ ok: false, error: `No menu item matching "${name}" in that venue.` })
      if (matches.length > 1)
        return text({
          ok: false,
          ambiguous: true,
          error: `"${name}" matches several items — be more specific.`,
          matches: matches.map(m => m.name),
        })
      const product = matches[0]
      const expectedState = { name: product.name, price: product.price, active: product.active }
      const fingerprint = operationHash({ id: product.id, ...expectedState, price: Number(product.price) })
      if (confirm && (!resolvedProductId || resolvedProductId !== product.id || expectedSourceFingerprint !== fingerprint)) {
        return text({
          ok: false,
          needsInput: true,
          question: 'El producto cambió o falta la vista previa. Vuelve a consultar y confirma el cambio actualizado.',
        })
      }
      if (!confirm) {
        const wasActive = matches[0].active
        return text({
          ok: false,
          requiresConfirmation: true,
          resolvedProductId: product.id,
          expectedSourceFingerprint: fingerprint,
          change: {
            item: matches[0].name,
            label: 'Disponibilidad',
            from: wasActive ? 'disponible' : '86 (deshabilitado)',
            to: active ? 'disponible' : '86 (deshabilitado)',
          },
          message: `Esto ${active ? 'HABILITARÁ' : 'deshabilitará ("86")'} "${matches[0].name}" (visible al cliente). Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const updated = await updateProduct(
          venueId,
          matches[0].id,
          { active },
          {
            type: 'HUMAN',
            staffId: scope.staffId,
            impersonating: false,
          },
          expectedState,
        )
        await auditMcpWrite(scope, {
          action: 'MENU_ITEM_ACTIVE_SET',
          entity: 'Product',
          entityId: matches[0].id,
          venueId,
          data: { name: updated.name, active: updated.active },
        })
        return text({ ok: true, item: { name: updated.name, active: updated.active } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'set_menu_item_price',
    'Change the price of a menu item in a venue you can access, found by name. Price is in the venue currency (major units, e.g. 120 = $120.00). This is a customer-visible change, so by DEFAULT it only PREVIEWS (current price → new price); call again with confirm:true to actually change it. This WRITES — requires products:update. If the name matches several items it returns the matches so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      name: z.string().min(1).describe('Menu item name or part of it, e.g. "Carnitas"'),
      price: z.number().positive().describe('New price in major units (e.g. 120 for $120.00)'),
      resolvedProductId: z.string().optional().describe('ID exacto devuelto por la vista previa'),
      expectedSourceFingerprint: z.string().optional().describe('Huella exacta devuelta por la vista previa'),
      confirm: z.boolean().optional().describe('Must be true to actually change the price; without it you get a preview'),
    },
    async ({ venueId, name, price, confirm, resolvedProductId, expectedSourceFingerprint }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('products:update', venueId) // write gate (per-venue role)
      const matches = await matchProductsByName(where, name, confirm ? resolvedProductId : undefined)
      if (matches.length === 0) return text({ ok: false, error: `No menu item matching "${name}" in that venue.` })
      if (matches.length > 1)
        return text({
          ok: false,
          ambiguous: true,
          error: `"${name}" matches several items — be more specific.`,
          matches: matches.map(m => m.name),
        })
      const currentPrice = Number(matches[0].price)
      const product = matches[0]
      const expectedState = { name: product.name, price: product.price, active: product.active }
      const fingerprint = operationHash({ id: product.id, ...expectedState, price: Number(product.price) })
      if (confirm && (!resolvedProductId || resolvedProductId !== product.id || expectedSourceFingerprint !== fingerprint)) {
        return text({
          ok: false,
          needsInput: true,
          question: 'El producto cambió o falta la vista previa. Vuelve a consultar y confirma el cambio actualizado.',
        })
      }
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          resolvedProductId: product.id,
          expectedSourceFingerprint: fingerprint,
          change: { item: matches[0].name, label: 'Precio', from: currentPrice, to: price },
          message: `Esto cambiará el precio de "${matches[0].name}": $${currentPrice} → $${price}. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const updated = await updateProduct(
          venueId,
          matches[0].id,
          { price },
          {
            type: 'HUMAN',
            staffId: scope.staffId,
            impersonating: false,
          },
          expectedState,
        )
        await auditMcpWrite(scope, {
          action: 'MENU_ITEM_PRICE_SET',
          entity: 'Product',
          entityId: matches[0].id,
          venueId,
          data: { name: updated.name, price: Number(updated.price) },
        })
        return text({ ok: true, item: { name: updated.name, price: Number(updated.price) } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'set_product_iva',
    'IVA por producto (16 %, 0 % o Exento) de un local a tu alcance; todos los planes. Con SÓLO venueId es el DIAGNÓSTICO: si el IVA por producto está encendido, qué impediría encenderlo hoy (bloqueos, cada uno con cómo arreglarlo), los avisos de aparatos que imprimen el IVA mal y las facturas viejas por revisar. Con name + iva cambia el IVA de ese producto: por defecto sólo PREVISUALIZA (actual → nuevo; si el local está apagado, que lo encenderá y lo que la revisión diría hoy); con confirm:true lo cambia. La primera vez que un producto pasa a 0 % o Exento, Avoqado revisa todo y enciende el local solo, o responde lo que falta. El precio NO cambia. Cambiar requiere products:update.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      name: z.string().min(1).optional().describe('Nombre del producto o parte de él. Sin name ni iva: diagnóstico'),
      iva: z
        .enum(['IVA_16', 'IVA_0', 'EXENTO'])
        .optional()
        .describe(
          'IVA_16 = 16 % (normal); IVA_0 = 0 % (alimentos sin preparar como café en grano o fruta, medicinas); EXENTO = exento (p. ej. servicios médicos, colegiaturas)',
        ),
      resolvedProductId: z.string().optional().describe('ID exacto devuelto por la vista previa'),
      expectedSourceFingerprint: z.string().optional().describe('Huella exacta devuelta por la vista previa'),
      confirm: z.boolean().optional().describe('true para cambiarlo; sin él, vista previa'),
    },
    async ({ venueId, name, iva, confirm, resolvedProductId, expectedSourceFingerprint }) => {
      const where = guard.venueFilter(venueId)
      // T5-a: el MCP es diagnóstico bajo demanda, así que pide la revisión completa (por omisión el estado NO revisa).
      if (!name || !iva) {
        guard.requirePermission('menu:read', venueId)
        return text({
          ok: true,
          diagnostico: true,
          ...(await estadoIvaPorProducto(venueId, new Date(), { conRevision: true })),
          dondeSeCambia: DONDE_SE_CAMBIA_EL_IVA,
        })
      }
      guard.requirePermission('products:update', venueId)
      const matches = await matchProductsByName(where, name, confirm ? resolvedProductId : undefined)
      if (matches.length === 0) return text({ ok: false, error: `No hay un producto que coincida con "${name}" en ese local.` })
      if (matches.length > 1)
        return text({
          ok: false,
          ambiguous: true,
          error: `"${name}" coincide con varios productos: sé más específico.`,
          matches: matches.map(m => m.name),
        })
      const product = matches[0]
      // Codex r1 P2-5: el IVA visto entra al UPDATE condicionado (`expectedState`, Tarea 6): un cambio de IVA entre la vista previa y la
      // confirmación responde «El producto cambió…» en vez de pisarlo.
      const expectedState = { name: product.name, price: product.price, active: product.active, ivaTratamiento: product.ivaTratamiento }
      // Codex código r1 #5 (Ruling CX-5): la huella también lleva el IVA SOLICITADO: la confirmación vale sólo para el cambio que se mostró.
      const fingerprint = operationHash({ id: product.id, ...expectedState, price: Number(product.price), ivaSolicitado: iva })
      if (confirm && (!resolvedProductId || resolvedProductId !== product.id || expectedSourceFingerprint !== fingerprint))
        return text({
          ok: false,
          needsInput: true,
          question: 'El producto cambió o falta la vista previa. Vuelve a consultar y confirma el cambio actualizado.',
        })
      if (!confirm) {
        const estado = await estadoIvaPorProducto(venueId, new Date(), { conRevision: true })
        const enciende = !estado.encendido && iva !== 'IVA_16' && iva !== product.ivaTratamiento
        return text({
          ok: false,
          requiresConfirmation: true,
          resolvedProductId: product.id,
          expectedSourceFingerprint: fingerprint,
          change: { item: product.name, label: 'IVA', from: ETIQUETA_IVA[product.ivaTratamiento], to: ETIQUETA_IVA[iva] },
          ...(enciende ? { encenderaElNegocio: true, soloDuenoOAdministrador: true, bloqueos: estado.bloqueos } : {}),
          message: `Esto cambiará el IVA de "${product.name}": ${ETIQUETA_IVA[product.ivaTratamiento]} → ${ETIQUETA_IVA[iva]}. El precio no cambia; las ventas ya facturadas se quedan como están.${enciende ? ' Es el primer producto con un IVA distinto de 16 %: Avoqado revisará el local y lo encenderá, y la contabilidad automática de TODA la organización quedará en pausa. Sólo lo puede confirmar el dueño o un administrador.' : ''} Confirma con el operador; luego vuelve a llamar con confirm:true.`,
        })
      }
      try {
        const updated = await updateProduct(
          venueId,
          product.id,
          { ivaTratamiento: iva },
          { type: 'HUMAN', staffId: scope.staffId, impersonating: false },
          expectedState,
          { origen: 'MCP' },
        )
        await auditMcpWrite(scope, {
          action: 'PRODUCT_IVA_SET',
          entity: 'Product',
          entityId: product.id,
          venueId,
          data: { name: updated.name, iva },
        })
        return text({ ok: true, item: { name: updated.name, iva: ETIQUETA_IVA[updated.ivaTratamiento] } })
      } catch (err) {
        // 403 IVA_ENCENDIDO_SOLO_DUENO (decisión del founder, 12-oct) y los 409 llegan con su mensaje en español. Lo inesperado (un P2028
        // de Prisma) queda en el log y al asistente le llega un texto genérico, nunca el de Prisma (revisión final, Minor nuevo 1).
        const e = err instanceof AppError ? err : null
        const esperado = !!e && e.statusCode >= 400 && e.statusCode < 500
        logger[esperado ? 'warn' : 'error']('[MCP] set_product_iva: no se pudo cambiar el IVA', {
          venueId,
          productId: product.id,
          code: e?.code,
          error: err instanceof Error ? err.message : String(err),
        })
        if (!e)
          return text({
            ok: false,
            error: 'No se pudo cambiar el IVA por un error inesperado. Vuelve a intentarlo en un momento; si sigue, avisa a soporte.',
          })
        return text({
          ok: false,
          error: e.message,
          ...(e.code ? { code: e.code } : {}),
          ...(e.code === 'IVA_ENCENDIDO_BLOQUEADO' ? { bloqueos: (e.details as { bloqueos?: unknown } | undefined)?.bloqueos } : {}),
        })
      }
    },
  )

  server.tool(
    'menu_item_detail',
    'Full detail of ONE menu item in a venue you can access, found by name: description, category, type, price, cost & margin (ONLY if a real cost is set on the item — never estimated), prep time, calories, whether it is active ("86"), how its stock is tracked, and its modifier/option groups (each option with its extra price). The drill-down after list_menu — answers "¿qué lleva / qué opciones tiene / cuánto me deja la X?". If the name matches several items it returns them so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      name: z.string().min(1).describe('Menu item name or part of it, e.g. "Hamburguesa"'),
    },
    async ({ venueId, name }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('menu:read', venueId)
      const matches = await matchProductsByName(where, name)
      if (matches.length === 0) return text({ found: false, error: `No menu item matching "${name}" in that venue.` })
      if (matches.length > 1)
        return text({
          found: false,
          ambiguous: true,
          error: `"${name}" matches several items — be more specific.`,
          matches: matches.map(m => m.name),
        })

      const p = await prisma.product.findFirst({
        where: { id: matches[0].id, ...where },
        select: {
          name: true,
          sku: true,
          description: true,
          type: true,
          price: true,
          ivaTratamiento: true,
          cost: true,
          active: true,
          prepTime: true,
          calories: true,
          imageUrl: true,
          trackInventory: true,
          inventoryMethod: true,
          soldByWeight: true,
          unit: true,
          duration: true,
          bufferAfterMin: true,
          category: { select: { name: true } },
          modifierGroups: {
            select: {
              group: {
                select: {
                  name: true,
                  required: true,
                  allowMultiple: true,
                  minSelections: true,
                  maxSelections: true,
                  modifiers: { where: { active: true }, select: { name: true, price: true, sku: true }, orderBy: { name: 'asc' } },
                },
              },
            },
            orderBy: { displayOrder: 'asc' },
          },
        },
      })
      if (!p) return text({ found: false, error: 'Item not found, or it is outside your venues' })

      // Live availability + WHICH raw material is short (RECIPE) — reuses the same
      // computation the POS/TPV uses, so answers "¿por qué está agotada la X?".
      const avail = await getProduct(venueId, matches[0].id)
      const availability = p.trackInventory
        ? {
            availableQuantity: avail?.availableQuantity ?? null, // QUANTITY: stock; RECIPE: est. portions
            isAvailable: (avail?.availableQuantity ?? 1) > 0,
            limitingIngredient: avail?.limitingIngredient
              ? {
                  name: avail.limitingIngredient.name,
                  available: avail.limitingIngredient.available,
                  required: avail.limitingIngredient.required,
                  unit: avail.limitingIngredient.unit,
                }
              : null,
            insufficientIngredients: (avail?.insufficientIngredients ?? []).map(
              (i: { name: string; available: number; required: number; unit: string }) => ({
                name: i.name,
                available: i.available,
                required: i.required,
                unit: i.unit,
              }),
            ),
          }
        : null

      const price = Number(p.price)
      const cost = p.cost == null ? null : Number(p.cost)
      return text({
        found: true,
        item: {
          name: p.name,
          sku: p.sku,
          description: p.description,
          type: p.type,
          category: p.category?.name ?? null,
          price,
          iva: ETIQUETA_IVA[p.ivaTratamiento],
          ivaSeCambiaEn: DONDE_SE_CAMBIA_EL_IVA,
          cost, // legacy manual product cost, separate from Recipe.totalCost
          costSource: 'manual_product',
          recipeStatus: 'not_checked',
          recipeGuidance:
            'Un costo manual vacío o el inventario apagado no significan que falte una receta. Usa get_recipe o list_product_recipes para verificar su existencia y costo (según permisos y plan).',
          margin: cost != null && price > 0 ? { amount: round2(price - cost), percent: round2(((price - cost) / price) * 100) } : null,
          active: p.active,
          prepTimeMinutes: p.prepTime,
          calories: p.calories,
          hasImage: !!p.imageUrl,
          inventoryTracking: p.trackInventory ? p.inventoryMethod : null,
          // Venta por peso: when true, `price` is the price PER KILOGRAM and the
          // POS captures the weight (kg) at sale time.
          soldByWeight: p.soldByWeight,
          ...(p.soldByWeight ? { unit: p.unit } : {}),
          // Agenda: `durationMinutes` es lo que dura el servicio para el CLIENTE;
          // `bufferAfterMin` es el tiempo de limpieza que se aparta después y que
          // el cliente nunca ve en su comprobante.
          durationMinutes: p.duration,
          bufferAfterMin: p.bufferAfterMin,
          availability, // live stock + limiting/insufficient raw materials (RECIPE), null if not tracked
          modifierGroups: p.modifierGroups.map(mg => ({
            name: mg.group.name,
            required: mg.group.required,
            allowMultiple: mg.group.allowMultiple,
            min: mg.group.minSelections,
            max: mg.group.maxSelections,
            options: mg.group.modifiers.map(m => ({ name: m.name, extraPrice: Number(m.price), ...(m.sku ? { sku: m.sku } : {}) })),
          })),
        },
      })
    },
  )

  server.tool(
    'menu_categories',
    'The menu categories of a venue you can access: name, description, whether active, and how many products are in each. Defaults to active categories. Answers "¿qué categorías de menú tengo?". Pass venueId. (For the items themselves use list_menu.)',
    {
      venueId: z.string().describe('Venue whose menu categories to list (must be in your scope)'),
      includeInactive: z.boolean().optional().describe('Also include inactive categories'),
    },
    async ({ venueId, includeInactive }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('menu:read', venueId)
      const cats = await prisma.menuCategory.findMany({
        where: { ...where, ...(includeInactive ? {} : { active: true }) },
        select: { name: true, description: true, active: true, _count: { select: { products: { where: { deletedAt: null } } } } },
        orderBy: { displayOrder: 'asc' },
      })
      return text({
        venueId,
        count: cats.length,
        categories: cats.map(c => ({ name: c.name, description: c.description, active: c.active, products: c._count.products })),
      })
    },
  )

  server.tool(
    'create_product',
    'Create a NEW product / service / class in a venue you can access: name, price, type (product / food_or_beverage / service / class / event / digital / donation) and the category it belongs to (BY NAME — must already exist; see menu_categories). Optionally description, SKU (auto-generated from the name if omitted), durationMinutes (for services/classes), isAlcoholic (for food_or_beverage). This WRITES — requires products:create. If a required type-specific field is missing the service says so.',
    {
      venueId: z.string().describe('Venue to create the item in (must be in your scope)'),
      name: z.string().min(1).describe('Item name, e.g. "Corte de cabello"'),
      price: z.number().nonnegative().describe('Price in major units (e.g. 250 for $250.00; 0 allowed for donations)'),
      type: z.enum(['product', 'food_or_beverage', 'service', 'class', 'event', 'digital', 'donation']).describe('What kind of item it is'),
      category: z.string().min(1).describe('Existing category name it belongs to (see menu_categories)'),
      description: z.string().optional().describe('Description'),
      sku: z.string().optional().describe('Stock code (auto-generated from the name if omitted)'),
      durationMinutes: z
        .number()
        .int()
        .positive()
        .max(1440)
        .optional()
        .describe('Duration in minutes. REQUIRED for service / class — the booking calendar sizes the appointment from it'),
      isAlcoholic: z.boolean().optional().describe('Only for food_or_beverage'),
      soldByWeight: z
        .boolean()
        .optional()
        .describe('Venta por peso (charcutería/granel): price becomes the price PER KILOGRAM and the POS captures the weight at sale time'),
    },
    async ({ venueId, name, price, type, category, description, sku, durationMinutes, isAlcoholic, soldByWeight }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('products:create', venueId) // write gate (per-venue role)

      // A bookable item with no duration is silently destructive: the booking
      // flow sums service durations to size the appointment, so a NULL one adds
      // ZERO minutes. The calendar then blocks less time than the service really
      // takes and staff double-book the slot behind it. Resolve-don't-guess: ask
      // for it instead of inventing a number the venue never agreed to.
      if (BOOKABLE_TYPES.has(type) && durationMinutes === undefined) {
        return text({
          ok: false,
          error:
            `"${name}" es un ${type === 'class' ? 'clase' : 'servicio'} agendable, así que necesito su duración en minutos ` +
            `(durationMinutes) para poder crearlo. Sin ella la agenda aparta menos tiempo del que realmente toma y se ` +
            `empalman las citas siguientes. ¿Cuánto dura "${name}"?`,
        })
      }

      const cat = await prisma.menuCategory.findFirst({
        where: { ...where, name: { equals: category, mode: 'insensitive' } },
        select: { id: true },
      })
      if (!cat) {
        const cats = await prisma.menuCategory.findMany({ where: { ...where, active: true }, select: { name: true }, take: 30 })
        return text({
          ok: false,
          error: `No encontré la categoría "${category}". Disponibles: ${cats.map(c => c.name).join(', ') || '(ninguna — créala primero)'}`,
        })
      }
      const finalSku =
        sku?.trim() ||
        `${
          name
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 8) || 'PROD'
        }-${Date.now().toString(36).slice(-5).toUpperCase()}`

      try {
        const product = await createProduct(
          venueId,
          {
            name,
            price,
            type: PRODUCT_TYPE_MAP[type],
            sku: finalSku,
            categoryId: cat.id,
            ...(description ? { description } : {}),
            ...(durationMinutes ? { duration: durationMinutes } : {}),
            ...(isAlcoholic !== undefined ? { isAlcoholic } : {}),
            ...(soldByWeight !== undefined ? { soldByWeight } : {}),
          },
          { type: 'HUMAN', staffId: scope.staffId, impersonating: false },
        )
        await auditMcpWrite(scope, {
          action: 'PRODUCT_CREATED',
          entity: 'Product',
          entityId: product.id,
          venueId,
          data: {
            name,
            type: PRODUCT_TYPE_MAP[type],
            price,
            category,
            ...(durationMinutes !== undefined ? { durationMinutes } : {}),
            ...(soldByWeight ? { soldByWeight } : {}),
          },
        })
        return text({
          ok: true,
          product: {
            id: product.id,
            name: product.name,
            sku: product.sku,
            type: product.type,
            price: Number(product.price),
            ...(durationMinutes !== undefined ? { durationMinutes } : {}),
            soldByWeight: (product as { soldByWeight?: boolean }).soldByWeight ?? false,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'create_category',
    'Create a NEW menu category in a venue you can access (e.g. "Entradas", "Bebidas", "Servicios"). Products are organized into categories. Optionally a description and display order. This WRITES — requires menu:create.',
    {
      venueId: z.string().describe('Venue to create the category in (must be in your scope)'),
      name: z.string().min(1).describe('Category name, e.g. "Bebidas"'),
      description: z.string().optional().describe('Description'),
      displayOrder: z.number().int().min(0).optional().describe('Sort order (lower shows first)'),
    },
    async ({ venueId, name, description, displayOrder }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('menu:create', venueId) // write gate (per-venue role)
      try {
        const cat = await createMenuCategory(venueId, {
          name,
          ...(description ? { description } : {}),
          ...(displayOrder !== undefined ? { displayOrder } : {}),
        })
        await auditMcpWrite(scope, { action: 'MENU_CATEGORY_CREATED', entity: 'MenuCategory', entityId: cat.id, venueId, data: { name } })
        return text({ ok: true, category: { id: cat.id, name: cat.name } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'create_modifier_group',
    'Create a NEW modifier / option group in a venue you can access (e.g. "Extras", "Término de la carne") with its options — each option has a name and an optional extra price. Set whether a selection is required, whether multiple are allowed, and min/max selections. Attach it to products afterward. This WRITES — requires menu:create.',
    {
      venueId: z.string().describe('Venue to create the group in (must be in your scope)'),
      name: z.string().min(1).describe('Group name, e.g. "Extras"'),
      options: z
        .array(
          z.object({
            name: z.string().min(1),
            extraPrice: z.number().min(0).optional(),
            sku: z
              .string()
              .trim()
              .min(1)
              .max(MODIFIER_SKU_MAX)
              .regex(SKU_REGEX, MODIFIER_SKU_FORMAT_MESSAGE)
              .optional()
              .describe(
                'Optional code of this option in the venue\'s OTHER cashier system (external cashier), e.g. "P000672": letters, digits, - and _ only. Several options may share it.',
              ),
          }),
        )
        .min(1)
        .describe('The options, e.g. [{name:"Queso extra", extraPrice:15}]'),
      required: z.boolean().optional().describe('Must the customer pick one? (default no)'),
      allowMultiple: z.boolean().optional().describe('Can the customer pick more than one? (default no)'),
      minSelections: z.number().int().min(0).optional().describe('Minimum options to select'),
      maxSelections: z.number().int().positive().optional().describe('Maximum options to select'),
    },
    async ({ venueId, name, options, required, allowMultiple, minSelections, maxSelections }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('menu:create', venueId) // write gate (per-venue role)
      try {
        const group = await createModifierGroup(venueId, {
          name,
          ...(required !== undefined ? { required } : {}),
          ...(allowMultiple !== undefined ? { allowMultiple } : {}),
          ...(minSelections !== undefined ? { minSelections } : {}),
          ...(maxSelections !== undefined ? { maxSelections } : {}),
          modifiers: options.map(o => ({ name: o.name, price: o.extraPrice ?? 0, ...(o.sku ? { sku: o.sku } : {}) })),
        })
        await auditMcpWrite(scope, {
          action: 'MODIFIER_GROUP_CREATED',
          entity: 'ModifierGroup',
          entityId: group.id,
          venueId,
          data: { name, options: options.length },
        })
        return text({ ok: true, modifierGroup: { id: group.id, name: group.name, options: options.length } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
