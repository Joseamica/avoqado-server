import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OrderStatus, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import AppError, { BadRequestError } from '@/errors/AppError'
import { existingId } from '@/schemas/common/existingId.schema'
import { lineRevenueSql, lineUnitsSql } from '@/services/dashboard/lineRevenue'
import {
  assertGroupNameFree,
  assertNoMasterCatalog,
  assertNotDemoCategory,
  createProductWithVariants,
  getProductGroup,
} from '@/services/product-variants/productGroup.service'
import { applyGroupExisting, previewGroupExisting } from '@/services/product-variants/groupExisting.service'
import {
  MAX_OPTIONS,
  MAX_VALUES_PER_OPTION,
  MAX_VARIANTS_PER_GROUP,
  isWholeCents,
  normalizeOptions,
  variantName,
} from '@/services/product-variants/variantNaming'
import { ETIQUETA_DE_IVA } from '@/services/fiscal/ivaTratamiento'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
import { utcTs } from '@/utils/sqlDates'
import { operationHash } from '@/utils/operationHash'
import type { McpScope } from '../scope'
import { ScopeError, createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { auditMcpWrite } from '../audit'

/*
 * Free mode only (`/mcp`): none of these is in the certified directory catalog. The certified tools that touch products
 * (product_sales, top_products, list_menu, menu_item_detail, set_menu_item_*, create_product) keep their behavior and output.
 * No output carries a `variants` key on a product: the per-variant list is `breakdown` / `byVariant`.
 */

// planGateMessage dice «<esto> no está incluido…»: masculino singular (/full-testing I-7).
const CAPABILITY = 'El uso de variantes de producto'
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD')
  // 2025-13-40 and 2025-02-30 match the pattern but are not calendar days (the second would roll over to March).
  .refine(d => {
    const t = new Date(`${d}T00:00:00Z`)
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
  }, 'Esa fecha no existe')
/** The same rounding as product_sales, so both tools give the very same figure for a variant. */
const round2 = (n: number): number => Math.round(n * 100) / 100
const cents = (n: number): number => Math.round(n * 100)
/** Backstop on the per-variant sales rows (a family has ≤ 250 live variants; archived ones accumulate slowly). */
const SALES_ROWS_CAP = 1000
const optionShape = z.object({
  name: z.string().min(1).max(40).describe('Option name, e.g. "Talla"'),
  values: z.array(z.string().min(1).max(40)).min(1).max(MAX_VALUES_PER_OPTION).describe('Its values in order, e.g. ["S","M","L"]'),
})

/** Every combination of the options, in option order (Talla × Color). */
function combinations(options: Array<{ values: string[] }>): string[][] {
  return options.reduce<string[][]>((acc, o) => acc.flatMap(prefix => o.values.map(v => [...prefix, v])), [[]])
}

/**
 * Rejections written for the operator go back as ok:false (instrument.ts logs them as warn, not error; /full-testing I-5): scope and
 * permission (ScopeError) and the service's operational errors, with their code. Anything else is rethrown so instrument.ts redacts it.
 */
function operatorError(err: unknown) {
  if (err instanceof ScopeError) return text({ ok: false, error: err.message })
  if (!(err instanceof AppError) || !err.isOperational) throw err
  return text({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) })
}

interface SalesRow {
  productId: string
  name: string
  sku: string
  archived: boolean
  units: Prisma.Decimal | null
  revenue: Prisma.Decimal | null
  lines: bigint
}

/**
 * Units and revenue per variant of ONE family, plus the family total. Same window, statuses, line formula and rounding as
 * `product_sales`, so each variant here equals what `product_sales` answers for it; the family total is the sum, in whole cents, of
 * the variants already rounded, so it always squares with them.
 */
async function familySales(
  venueId: string,
  groupId: string,
  live: Array<{ id: string; name: string; sku: string }>,
  fromDate?: string,
  toDate?: string,
) {
  const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
  // Noon anchor keeps the venue's calendar day under any host zone. Without fromDate: the 30 days that END on toDate (product_sales
  // counts them back from today even when toDate is in the past, which leaves an empty window — not copied here).
  const endRef = toDate ? new Date(`${toDate}T12:00:00`) : new Date()
  const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(endRef.getTime() - 30 * 24 * 60 * 60 * 1000))
  const end = venueEndOfDay(tz, endRef)
  if (start > end) throw new BadRequestError('La fecha inicial es posterior a la final.')
  // One row per variant that sold (archived ones included): bounded by the family's own size, plus a backstop LIMIT.
  const rows = await prisma.$queryRaw<SalesRow[]>`
    SELECT
      p.id AS "productId",
      p.name AS name,
      p.sku AS sku,
      (p."deletedAt" IS NOT NULL) AS archived,
      COALESCE(SUM(${Prisma.raw(lineUnitsSql())}), 0) AS units,
      COALESCE(SUM(${Prisma.raw(lineRevenueSql())}), 0) AS revenue,
      COUNT(oi.id)::bigint AS lines
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    INNER JOIN "Product" p ON p.id = oi."productId"
    WHERE p."productGroupId" = ${groupId}
      AND p."venueId" = ${venueId}
      AND o."venueId" = ${venueId}
      AND o."createdAt" >= ${utcTs(start)}
      AND o."createdAt" <= ${utcTs(end)}
      AND o.status NOT IN (${OrderStatus.CANCELLED}::"OrderStatus", ${OrderStatus.DELETED}::"OrderStatus")
      AND oi."removedAt" IS NULL
    GROUP BY p.id, p.name, p.sku, p."deletedAt"
    ORDER BY p.name, p.id
    LIMIT ${SALES_ROWS_CAP}
  `
  const figures = (r?: SalesRow) => ({
    unitsSold: round2(Number(r?.units ?? 0)),
    revenue: round2(Number(r?.revenue ?? 0)),
    timesOrdered: Number(r?.lines ?? 0),
  })
  const byId = new Map(rows.map(r => [r.productId, r]))
  const liveIds = new Set(live.map(v => v.id))
  const lines = [
    ...live.map(v => ({ name: v.name, sku: v.sku, archived: false, ...figures(byId.get(v.id)) })),
    ...rows.filter(r => !liveIds.has(r.productId)).map(r => ({ name: r.name, sku: r.sku, archived: r.archived, ...figures(r) })),
  ]
  const total = (k: 'unitsSold' | 'revenue') => lines.reduce((s, l) => s + cents(l[k]), 0) / 100
  return {
    window: { start: start.toISOString(), end: end.toISOString() },
    timezone: tz,
    unitsSold: total('unitsSold'),
    revenue: total('revenue'),
    timesOrdered: lines.reduce((s, l) => s + l.timesOrdered, 0),
    ...(rows.length === SALES_ROWS_CAP
      ? { incomplete: true, note: `Al menos ${SALES_ROWS_CAP} variantes vendieron en ese periodo: los totales están incompletos.` }
      : {}),
    byVariant: lines.map(({ archived, ...l }) => ({ ...l, ...(archived ? { archived: true } : {}) })),
  }
}

export function registerProductVariantTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  const actor = { type: 'HUMAN' as const, staffId: scope.staffId, impersonating: false }

  server.tool(
    'product_variants',
    'A product sold in variants (sizes, colors, presentations) in a venue you can access, found by name: its options and every variant with SKU, barcode, price, cost, stock and whether it is active. Pass fromDate and/or toDate (YYYY-MM-DD, venue calendar; without fromDate, the 30 days ending on toDate or today) to ALSO get units sold and revenue per variant and for the whole product (archived variants that sold are included); with dates an archived product is found too (a live one with that name wins) and comes back marked archived. An exact name wins over partial matches; if it still matches several products it returns them with their category and groupId (pass category or groupId to pick one).',
    {
      venueId: existingId().describe('Venue that owns the product (must be in your scope)'),
      name: z.string().min(1).max(120).describe('Product name or part of it, e.g. "Playera"'),
      category: z.string().min(1).max(120).optional().describe('Category name, only to tell apart two products with the same name'),
      groupId: existingId()
        .optional()
        .describe('Only to pick one of several products with the same name: the groupId the ambiguity answer lists'),
      fromDate: DATE.optional().describe('Sales from this date YYYY-MM-DD (default: 30 days before toDate)'),
      toDate: DATE.optional().describe('Sales up to this date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, name, category, groupId, fromDate, toDate }) => {
      try {
        const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('menu:read', venueId) // reading a family stays open on every plan
        const withSales = Boolean(fromDate || toDate)
        if (withSales) {
          // Sales figures ask for exactly what product_sales and the sales report ask for.
          guard.requirePermission('reports:read', venueId)
          const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados')
          if (gate) return text({ ok: false, planRequired: true, error: gate })
        }
        const query = name.trim()
        // An exact name first, so "Playera" stays reachable next to "Playera básica"; only then a partial match. Within each, a
        // live family first; an archived one only when sales were asked for (its history is still real; Codex #9).
        const search = (byName: { equals: string } | { contains: string }, archived: boolean) =>
          prisma.productGroup.findMany({
            where: {
              ...where,
              ...(groupId ? { id: groupId } : {}),
              deletedAt: archived ? { not: null } : null,
              name: { ...byName, mode: 'insensitive' as const },
              ...(category ? { category: { name: { equals: category.trim(), mode: 'insensitive' as const } } } : {}),
            },
            select: { id: true, name: true, deletedAt: true, category: { select: { name: true } } },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: 10,
          })
        let groups: Awaited<ReturnType<typeof search>> = []
        for (const byName of [{ equals: query }, { contains: query }]) {
          for (const archived of withSales ? [false, true] : [false]) if (!groups.length) groups = await search(byName, archived)
        }
        if (!groups.length)
          return text({ found: false, error: `No hay un producto con variantes que coincida con «${query}» en ese local.` })
        if (groups.length > 1)
          return text({
            found: false,
            ambiguous: true,
            error: `«${query}» coincide con varios productos con variantes; di cuál (su categoría o su groupId).`,
            // groupId: two families may share name AND category (Codex #10); it is the only way to tell them apart.
            matches: groups.map(g => ({
              groupId: g.id,
              name: g.name,
              category: g.category.name,
              ...(g.deletedAt ? { archived: true } : {}),
            })),
          })
        const group = groups[0]
        const d = await getProductGroup(venueId, group.id)
        const product = {
          name: d.name,
          ...(group.deletedAt ? { archived: true } : {}),
          category: group.category.name,
          type: d.type,
          options: d.options.map(o => ({ name: o.name, values: o.values.map(v => v.value) })),
          variantCount: d.variants.length,
          archivedVariantCount: d.archivedCount,
          breakdown: d.variants.map(v => ({
            name: v.name,
            values: v.values,
            sku: v.sku,
            barcode: v.gtin,
            price: v.price,
            cost: v.cost,
            stock: v.stock, // null = stock not tracked for that variant
            active: v.active,
          })),
        }
        if (!withSales) return text({ found: true, product })
        return text({ found: true, product, sales: await familySales(venueId, group.id, d.variants, fromDate, toDate) })
      } catch (err) {
        return operatorError(err)
      }
    },
  )

  server.tool(
    'create_product_with_variants',
    'Create a NEW product sold in variants in a venue you can access (e.g. a T-shirt in sizes and colors): one sellable variant per combination of the options, each with its own SKU and stock, all at the same price (a single variant can be repriced later by its full name, e.g. "Playera · M"). Up to 3 options and 250 combinations; the category must already exist (see menu_categories). By DEFAULT it only PREVIEWS the combinations: show them to the user and, after their OK, call again with confirm:true and the confirmation arguments the preview returns. This WRITES — requires menu:create and a plan that includes product variants.',
    {
      venueId: existingId().describe('Venue to create it in (must be in your scope)'),
      name: z.string().min(1).max(120).describe('Product name, e.g. "Playera básica"'),
      category: z.string().min(1).max(120).describe('Existing category name, e.g. "Ropa"'),
      categoryId: existingId()
        .optional()
        .describe('Only to break a tie when two categories share that name: the categoryId the ambiguity answer lists'),
      options: z
        .array(optionShape)
        .min(1)
        .max(MAX_OPTIONS)
        .describe(
          'Up to 3 options in display order, e.g. [{"name":"Talla","values":["S","M"]},{"name":"Color","values":["Negro","Blanco"]}]',
        ),
      price: z
        .number()
        .positive()
        .max(10_000_000)
        .refine(isWholeCents, 'Hasta 2 decimales')
        .describe('Price of every variant in pesos, tax included, more than 0 and up to 2 decimals (e.g. 299 for $299.00)'),
      trackInventory: z.boolean().optional().describe('true = count stock per variant (each starts at 0)'),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Exact fingerprint returned by the preview'),
      confirm: z.boolean().optional().describe('Must be true to actually create; without it you get a preview'),
    },
    async ({ venueId, name, category, categoryId, options, price, trackInventory, expectedSourceFingerprint, confirm }) => {
      try {
        const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('menu:create', venueId) // same permission as the dashboard
        const gate = await planGateMessage(venueId, 'PRODUCT_VARIANTS', CAPABILITY)
        if (gate) return text({ ok: false, planRequired: true, error: gate })
        const opciones = normalizeOptions(options)
        // Count BEFORE building: 100 × 100 × 100 is never materialized just to be rejected.
        const total = opciones.reduce((n, o) => n * o.values.length, 1)
        if (total > MAX_VARIANTS_PER_GROUP)
          return text({
            ok: false,
            error: `Son ${total.toLocaleString('es-MX')} combinaciones y el máximo es ${MAX_VARIANTS_PER_GROUP}. Quita valores u opciones.`,
          })
        const cats = await prisma.menuCategory.findMany({
          where: { ...where, ...(categoryId ? { id: categoryId } : {}), name: { equals: category.trim(), mode: 'insensitive' } },
          select: { id: true, name: true },
          orderBy: { id: 'asc' },
          take: 2,
        })
        if (!cats.length)
          return text({
            ok: false,
            error: `No encontré la categoría «${category.trim()}» en ese local. Revisa menu_categories o créala primero.`,
          })
        if (cats.length > 1)
          return text({
            ok: false,
            ambiguous: true,
            error: `Hay más de una categoría llamada «${category.trim()}»; di cuál con su categoryId.`,
            matches: cats.map(c => ({ categoryId: c.id, name: c.name })),
          })
        const cat = cats[0]
        const productName = name.trim()
        const combos = combinations(opciones)
        // Binds the RESOLVED category: if it is renamed or recreated between preview and confirm, the preview is repeated.
        const fingerprint = operationHash({
          categoryId: cat.id,
          name: productName,
          options: opciones,
          price,
          trackInventory: trackInventory === true,
        })
        if (!confirm) {
          // The read-only checks the service repeats on confirm, so the preview never promises what confirm would reject.
          await assertNoMasterCatalog(prisma, venueId)
          await assertNotDemoCategory(prisma, cat.id)
          await assertGroupNameFree(prisma, venueId, productName) // repeating a confirmed creation is refused too (I-1)
          return text({
            ok: false,
            requiresConfirmation: true,
            expectedSourceFingerprint: fingerprint,
            preview: {
              product: productName,
              category: cat.name,
              options: opciones,
              trackInventory: trackInventory === true,
              combinations: combos.map(values => ({ name: variantName(productName, values), price })),
            },
            message: `Esto creará «${productName}» en «${cat.name}» con ${combos.length} variantes de $${price} cada una. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
          })
        }
        if (expectedSourceFingerprint !== fingerprint)
          return text({
            ok: false,
            needsInput: true,
            question: 'La categoría o los datos cambiaron desde la vista previa. Pide la vista previa otra vez y confirma.',
          })
        const r = await createProductWithVariants(
          venueId,
          { name: productName, categoryId: cat.id, options: opciones, variants: combos.map(values => ({ values, price })), trackInventory },
          actor,
        )
        await auditMcpWrite(scope, {
          action: 'PRODUCT_GROUP_CREATED',
          entity: 'ProductGroup',
          entityId: r.groupId,
          venueId,
          data: { name: productName, category: cat.name, price, variantCount: r.productIds.length },
        })
        return text({
          ok: true,
          groupId: r.groupId,
          product: productName,
          variantCount: r.productIds.length,
          message: `Listo: «${productName}» quedó con ${r.productIds.length} variantes. Sus SKU se ven con product_variants.`,
        })
      } catch (err) {
        return operatorError(err)
      }
    },
  )

  server.tool(
    'group_products_as_variants',
    'Group products that ALREADY exist in a venue you can access (one per size or color, e.g. "BODY HARBOR - Talla 34" and "BODY HARBOR - Talla 36") as the variants of ONE product. Each keeps its SKU, barcode, price, cost, stock, recipe and sales; its name becomes "<product> · <value>". The resulting product takes its category, tax and extras from the FIRST product listed, and its SAT keys and photo from the first one that has them; the preview shows that product and every change. Identify each existing product by its SKU. By DEFAULT it only PREVIEWS current → new for each product: show it to the user and, after their OK, call again with confirm:true and the confirmation arguments the preview returns. This WRITES — requires menu:update and a plan that includes product variants.',
    {
      venueId: existingId().describe('Venue that owns the products (must be in your scope)'),
      name: z.string().min(1).max(120).describe('Name of the product that groups them, e.g. "BODY HARBOR"'),
      options: z.array(optionShape).min(1).max(MAX_OPTIONS).describe('Its options, e.g. [{"name":"Talla","values":["34","36"]}]'),
      members: z
        .array(
          z.object({
            sku: z.string().min(1).max(64).describe('SKU of an existing product'),
            values: z.array(z.string().min(1).max(40)).min(1).max(MAX_OPTIONS).describe('Its value for each option, in option order'),
          }),
        )
        .min(1)
        .max(MAX_VARIANTS_PER_GROUP)
        .describe('Each existing product, e.g. [{"sku":"BH-34","values":["34"]},{"sku":"BH-36","values":["36"]}]'),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Exact fingerprint returned by the preview'),
      confirm: z.boolean().optional().describe('Must be true to actually group; without it you get a preview'),
    },
    async ({ venueId, name, options, members, expectedSourceFingerprint, confirm }) => {
      try {
        const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('menu:update', venueId) // same permission as the dashboard
        const gate = await planGateMessage(venueId, 'PRODUCT_VARIANTS', CAPABILITY)
        if (gate) return text({ ok: false, planRequired: true, error: gate })
        // SKU is unique per venue, so each one names exactly one product of THIS venue (archived ones too: the service explains why not).
        const skus = [...new Set(members.map(m => m.sku.trim()))]
        const found = await prisma.product.findMany({
          where: { ...where, sku: { in: skus } },
          select: { id: true, sku: true },
          take: skus.length,
        })
        const idBySku = new Map(found.map(p => [p.sku, p.id]))
        const missing = skus.filter(s => !idBySku.has(s))
        if (missing.length) return text({ ok: false, error: `No encontré productos con SKU ${missing.join(', ')} en ese local.` })
        const input = { name, options, members: members.map(m => ({ productId: idBySku.get(m.sku.trim())!, values: m.values })) }
        if (!confirm) {
          const pv = await previewGroupExisting(venueId, input)
          const extraIds = pv.parent.modifierGroupIds
          const [cat, extras] = await Promise.all([
            prisma.menuCategory.findFirst({ where: { ...where, id: pv.parent.categoryId }, select: { name: true } }),
            extraIds.length
              ? prisma.modifierGroup.findMany({
                  where: { ...where, id: { in: extraIds } },
                  select: { id: true, name: true },
                  take: extraIds.length,
                })
              : ([] as Array<{ id: string; name: string }>),
          ])
          const extraName = new Map(extras.map(e => [e.id, e.name]))
          return text({
            ok: false,
            requiresConfirmation: true,
            expectedSourceFingerprint: pv.fingerprint,
            preview: {
              product: name.trim(),
              options: pv.options, // in the fingerprint (Codex #6): what is confirmed is what was shown
              parent: {
                name: pv.parent.name,
                category: cat?.name ?? null,
                iva: ETIQUETA_DE_IVA[pv.parent.ivaTratamiento],
                satProductKey: pv.parent.satProductKey,
                satUnitKey: pv.parent.satUnitKey,
                extrasCount: extraIds.length,
                extras: extraIds.map(id => extraName.get(id)).filter((n): n is string => !!n),
                hasImage: !!pv.parent.imageUrl,
              },
              members: pv.members.map(m => ({ sku: m.sku, from: m.currentName, to: m.newName, changes: m.changes })),
              warnings: pv.warnings,
            },
            message: `Esto agrupará ${pv.members.length} productos como variantes de «${name.trim()}»; conservan SKU, precio, existencias y ventas. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
          })
        }
        if (!expectedSourceFingerprint)
          return text({ ok: false, needsInput: true, question: 'Falta la vista previa. Pídela, muéstrala y confirma.' })
        const r = await applyGroupExisting(venueId, { ...input, expectedFingerprint: expectedSourceFingerprint }, actor)
        await auditMcpWrite(scope, {
          action: 'PRODUCT_GROUP_GROUPED_EXISTING',
          entity: 'ProductGroup',
          entityId: r.groupId,
          venueId,
          data: { name: name.trim(), skus, variantCount: r.productIds.length },
        })
        return text({ ok: true, groupId: r.groupId, product: name.trim(), variantCount: r.productIds.length })
      } catch (err) {
        // Something changed between the preview and the confirmation: ask for a fresh preview instead of failing.
        if (err instanceof AppError && err.code === 'PRODUCT_GROUP_PREVIEW_STALE')
          return text({ ok: false, needsInput: true, code: err.code, question: `${err.message} Pide la vista previa otra vez.` })
        return operatorError(err)
      }
    },
  )
}
