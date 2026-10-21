import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { createRecipe, getRecipe } from '@/services/dashboard/recipe.service'
import {
  calculateRecipeCostV1,
  MIN_STORABLE_RECIPE_QUANTITY,
  RecipeCostCalculationError,
  storesAsNonzeroRecipeQuantityV1,
} from '@/services/dashboard/recipe-cost-calculator'
import { areUnitsCompatible } from '@/utils/unitConversion'
import { recipeInventoryFingerprint, setProductInventoryMethod } from '@/services/dashboard/productInventoryIntegration.service'

/** Never return an unbounded pantry to the model — a large venue would blow the context. */
const RAW_MATERIAL_PAGE_CAP = 100
const RAW_MATERIAL_PAGE_DEFAULT = 50

/** Enough rows to prove a name is ambiguous without reading the whole pantry. */
const RESOLUTION_POOL_CAP = 200

const PLAN_FEATURE = 'INVENTORY_TRACKING'
const PLAN_CAPABILITY = 'El control de inventario'

export type MatchResultV1<T> = { kind: 'match'; item: T } | { kind: 'ambiguous'; candidates: T[] } | { kind: 'none' }

/**
 * Resolve one operator-typed name (or id) to exactly ONE row — or refuse.
 *
 * The dashboard chatbot resolves ingredients with a pg_trgm `similarity > 0.2` and, failing
 * that, `continue // Skip unresolvable ingredients`. Both are wrong for a write: a 0.2
 * threshold happily matches "Aguacate" to "Aguardiente", and skipping means the recipe is
 * born missing a line — from then on it costs less than it should and under-deducts stock on
 * every single sale, silently. So this refuses instead of guessing, and the caller aborts the
 * whole write and hands the candidates back for the operator to disambiguate.
 *
 * An exact name beats rows that merely contain it, because "Aguacate" alongside "Aguacate
 * Hass" is not genuinely ambiguous — the operator named one of them exactly.
 */
export function pickMatchV1<T extends { id: string; name: string }>(query: string, candidates: readonly T[]): MatchResultV1<T> {
  const trimmed = query.trim()
  if (!trimmed) return { kind: 'none' }

  const byId = candidates.filter(candidate => candidate.id === trimmed)
  if (byId.length === 1) return { kind: 'match', item: byId[0] }

  const lowered = trimmed.toLowerCase()
  const exact = candidates.filter(candidate => candidate.name.trim().toLowerCase() === lowered)
  if (exact.length === 1) return { kind: 'match', item: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact }

  const partial = candidates.filter(candidate => candidate.name.toLowerCase().includes(lowered))
  if (partial.length === 1) return { kind: 'match', item: partial[0] }
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial }
  return { kind: 'none' }
}

/** Prisma filter that finds every row a name COULD mean, so ambiguity is provable in memory. */
function nameOrIdFilterV1(queries: readonly string[]) {
  return queries.flatMap(query => [{ id: query }, { name: { contains: query, mode: 'insensitive' as const } }])
}

const num = (value: unknown): number => Number(value ?? 0)

function normalizeUnitV1(raw: string): Unit | null {
  const upper = raw.trim().toUpperCase()
  return (Object.values(Unit) as string[]).includes(upper) ? (upper as Unit) : null
}

export function registerRecipeTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  /** Shared prelude: scope → permission → PREMIUM plan. Returns the gate payload, or null. */
  async function gateV1(venueId: string, permission: string): Promise<Record<string, unknown> | null> {
    guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
    guard.requirePermission(permission, venueId)
    const gate = await planGateMessage(venueId, PLAN_FEATURE, PLAN_CAPABILITY)
    return gate ? { ok: false, planRequired: true, error: gate } : null
  }

  /** Resolve the product the operator named. Returns an error payload instead of guessing. */
  async function resolveProductV1(venueId: string, query: string) {
    const candidates = await prisma.product.findMany({
      where: { venueId, active: true, deletedAt: null, OR: nameOrIdFilterV1([query]) },
      select: { id: true, name: true, sku: true, price: true, trackInventory: true, inventoryMethod: true },
      take: RESOLUTION_POOL_CAP,
    })
    const match = pickMatchV1(query, candidates)
    if (match.kind === 'match') return { ok: true as const, product: match.item }
    if (match.kind === 'ambiguous') {
      return {
        ok: false as const,
        payload: {
          ok: false,
          error: `"${query}" coincide con varios productos. Dime cuál exactamente (o pasa su id).`,
          candidatos: match.candidates.map(c => ({ id: c.id, nombre: c.name, sku: c.sku })),
        },
      }
    }
    return {
      ok: false as const,
      payload: {
        ok: false,
        error: `No encontré un producto llamado "${query}" en este local. Usa list_menu para ver los productos y verifica el nombre.`,
      },
    }
  }

  // ---------------------------------------------------------------------------
  server.tool(
    'list_product_recipes',
    'Authoritative recipe coverage and costs for products in ONE venue. manualCost is separate from recipeCostPerPortion: a null manual cost NEVER proves a missing recipe. Shows hasRecipe, recipe cost, tracking state and whether recipe deduction is enabled. Use for menu-wide questions instead of calling get_recipe for every product. Search/filter runs before bounded pagination. Requires inventory:read and PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().min(1),
      search: z.string().optional(),
      hasRecipe: z.boolean().optional(),
      includeInactive: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async ({ venueId, search, hasRecipe, includeInactive, limit = 50, offset = 0 }) => {
      const denied = await gateV1(venueId, 'inventory:read')
      if (denied) return text(denied)
      const where = {
        venueId,
        deletedAt: null,
        ...(includeInactive ? {} : { active: true }),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
        ...(hasRecipe === undefined ? {} : { recipe: hasRecipe ? { isNot: null } : { is: null } }),
      }
      const [total, rows] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            sku: true,
            price: true,
            cost: true,
            active: true,
            trackInventory: true,
            inventoryMethod: true,
            recipe: { select: { id: true, totalCost: true, portionYield: true, _count: { select: { lines: true } } } },
          },
        }),
      ])
      const hasMore = offset + rows.length < total
      return text({
        ok: true,
        venueId,
        total,
        count: rows.length,
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + rows.length : null,
        products: rows.map(p => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          active: p.active,
          price: num(p.price),
          manualCost: p.cost == null ? null : num(p.cost),
          hasRecipe: !!p.recipe,
          recipeId: p.recipe?.id ?? null,
          recipeCostPerPortion: p.recipe ? num(p.recipe.totalCost) : null,
          portionYield: p.recipe?.portionYield ?? null,
          ingredientCount: p.recipe?._count.lines ?? 0,
          inventoryTrackingEnabled: p.trackInventory,
          inventoryMethod: p.inventoryMethod,
          recipeDeductionEnabled: !!p.recipe && p.trackInventory && (p.inventoryMethod === 'RECIPE' || p.inventoryMethod === null),
        })),
      })
    },
  )

  server.tool(
    'enable_recipe_inventory',
    'Enable automatic ingredient deduction for ONE product with an existing recipe. Creating a recipe alone does NOT activate inventory tracking. Obtain the exact productId using list_product_recipes. Preview shows the current method and the change to RECIPE; explicitly confirm it with the operator. This changes future fully paid sales, never historical sales or current stock. Requires inventory:update, mcp:write and PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().min(1),
      productId: z.string().min(1),
      expectedSourceFingerprint: z.string().optional(),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, productId, expectedSourceFingerprint, confirm }) => {
      const denied = await gateV1(venueId, 'inventory:update')
      if (denied) return text(denied)
      const p = await prisma.product.findFirst({
        where: { id: productId, venueId, active: true, deletedAt: null },
        select: {
          id: true,
          name: true,
          updatedAt: true,
          trackInventory: true,
          inventoryMethod: true,
          recipe: { select: { id: true, updatedAt: true, _count: { select: { lines: true } } } },
        },
      })
      if (!p?.recipe || !p.recipe._count.lines)
        return text({
          ok: false,
          needsInput: true,
          error: 'Selecciona un producto de esta sucursal con una receta que tenga ingredientes. Usa list_product_recipes y get_recipe.',
        })
      if (p.trackInventory && (p.inventoryMethod === 'RECIPE' || p.inventoryMethod === null))
        return text({
          ok: true,
          venueId,
          productId,
          changed: false,
          recipeDeductionEnabled: true,
          message: 'El descuento por receta ya está activo.',
        })
      if (!confirm)
        return text({
          ok: true,
          requiresConfirmation: true,
          expectedSourceFingerprint: recipeInventoryFingerprint(p),
          change: {
            productId,
            product: p.name,
            from: { trackInventory: p.trackInventory, inventoryMethod: p.inventoryMethod },
            to: { trackInventory: true, inventoryMethod: 'RECIPE' },
          },
          message: `En esta sucursal, activar el descuento por receta de "${p.name}" para ventas futuras pagadas. No modifica ventas anteriores ni existencias actuales. Confirma este cambio de método.`,
        })
      if (!expectedSourceFingerprint) return text({ ok: false, needsInput: true, error: 'Solicita una nueva vista previa.' })
      const result = await setProductInventoryMethod(venueId, productId, 'RECIPE', {
        staffId: scope.staffId,
        source: 'customer-mcp',
        expectedSourceFingerprint,
      })
      return text({
        ok: result.success,
        venueId,
        productId,
        inventoryMethod: result.inventoryMethod,
        recipeDeductionEnabled: true,
        changed: true,
      })
    },
  )

  server.tool(
    'list_raw_materials',
    'The PANTRY of a venue you can access: every active raw material / ingredient with the UNIT it is stored in, its stock and its cost per unit. Read this BEFORE writing a recipe — create_recipe resolves ingredients by name and refuses anything it cannot match to exactly one row, so this is how you learn the real names and units. Answers "¿qué insumos tengo?", "¿en qué unidad está el aguacate?". Pass venueId; optional `search` filters by name. Requires inventory:read. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().describe('Venue whose pantry to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by ingredient name (partial, case-insensitive)'),
      includeInactive: z.boolean().optional().describe('Include inactive ingredients when checking for existing records'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200) // Accept the previous contract; enforce the smaller page below.
        .optional()
        .describe(`Max ingredients to return (default ${RAW_MATERIAL_PAGE_DEFAULT})`),
      offset: z.number().int().min(0).optional().describe('Continue with nextOffset from the previous page'),
    },
    async ({ venueId, search, includeInactive, limit, offset = 0 }) => {
      const denied = await gateV1(venueId, 'inventory:read')
      if (denied) return text(denied)

      const take = Math.min(limit ?? RAW_MATERIAL_PAGE_DEFAULT, RAW_MATERIAL_PAGE_CAP)
      const where = {
        venueId,
        ...(includeInactive ? {} : { active: true }),
        deletedAt: null,
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      }
      const [total, rows] = await Promise.all([
        prisma.rawMaterial.count({ where }),
        prisma.rawMaterial.findMany({
          where,
          select: { id: true, name: true, sku: true, category: true, unit: true, currentStock: true, costPerUnit: true, active: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take,
          skip: offset,
        }),
      ])
      const hasMore = offset + rows.length < total

      return text({
        ok: true,
        venueId,
        total,
        count: rows.length,
        limit: take,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + rows.length : null,
        // WHY: a page cap that truncates in silence is how an operator concludes an ingredient
        // "doesn't exist" and creates a duplicate. Say it, and say how to narrow the search.
        ...(hasMore ? { aviso: `Hay más insumos. Continúa con nextOffset o usa "search" para acotar.` } : {}),
        insumos: rows.map(row => ({
          id: row.id,
          nombre: row.name,
          sku: row.sku,
          categoria: row.category,
          unidad: row.unit,
          existencia: num(row.currentStock),
          costoPorUnidad: num(row.costPerUnit),
          activo: row.active,
        })),
      })
    },
  )

  // ---------------------------------------------------------------------------
  server.tool(
    'get_recipe',
    'The RECIPE and tracking state of one product: ingredients, quantities, cost per portion and yield. A recipe alone does NOT enable stock deduction; recipeDeductionEnabled reports whether tracking is active. Name the product or use its id. Use list_product_recipes for menu-wide coverage. Requires inventory:read. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().describe('Venue the product belongs to (must be in your scope)'),
      product: z.string().min(1).describe('Product name (or id), e.g. "Avo Toast"'),
    },
    async ({ venueId, product }) => {
      const denied = await gateV1(venueId, 'inventory:read')
      if (denied) return text(denied)

      const resolved = await resolveProductV1(venueId, product)
      if (!resolved.ok) return text(resolved.payload)

      const recipe = await getRecipe(venueId, resolved.product.id)
      if (!recipe) {
        return text({
          ok: true,
          receta: null,
          mensaje: `"${resolved.product.name}" no tiene receta todavía. Puedes crearla con create_recipe.`,
        })
      }

      return text({
        ok: true,
        venueId,
        inventoryTrackingEnabled: recipe.product.trackInventory,
        inventoryMethod: recipe.product.inventoryMethod,
        recipeDeductionEnabled:
          recipe.product.trackInventory && (recipe.product.inventoryMethod === 'RECIPE' || recipe.product.inventoryMethod === null),
        ...(!recipe.product.trackInventory || recipe.product.inventoryMethod === 'QUANTITY'
          ? {
              aviso:
                'La receta existe, pero el descuento por receta no está activo. Usa enable_recipe_inventory con confirmación para activarlo.',
            }
          : {}),
        receta: {
          producto: recipe.product.name,
          productoId: recipe.product.id,
          rindePorciones: recipe.portionYield,
          costoPorPorcion: num(recipe.totalCost),
          minutosPreparacion: recipe.prepTime,
          minutosCoccion: recipe.cookTime,
          notas: recipe.notes,
          ingredientes: recipe.lines.map(line => ({
            insumo: line.rawMaterial.name,
            insumoId: line.rawMaterial.id,
            cantidad: num(line.quantity),
            unidad: line.unit,
            seGuardaEn: line.rawMaterial.unit,
            costoPorPorcion: line.costPerServing === null ? null : num(line.costPerServing),
            opcional: line.isOptional,
          })),
        },
      })
    },
  )

  // ---------------------------------------------------------------------------
  server.tool(
    'create_recipe',
    'Create the RECIPE of a menu product in a venue you can access: which ingredients it consumes and how much of each. A recipe defines its cost and ingredients, but automatic deduction ALSO requires product inventory tracking in RECIPE mode; creating this recipe does NOT activate tracking. Read the pantry with list_raw_materials FIRST and use the real ingredient names and units. Ingredients are resolved by name and it is ALL OR NOTHING — if one name matches zero or several ingredients, NOTHING is created and you get the candidates back. By DEFAULT this only PREVIEWS (which ingredient each name resolved to, the unit it is stored in, and the resulting cost per portion); call again with confirm:true to actually create it. Editing or deleting a recipe is done in the dashboard. This WRITES — requires inventory:create. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().describe('Venue the product belongs to (must be in your scope)'),
      product: z.string().min(1).describe('Product the recipe is for — its name (or id), e.g. "Avo Toast"'),
      portionYield: z.number().int().positive().optional().describe('How many portions the recipe yields (default 1)'),
      prepTime: z.number().int().positive().optional().describe('Prep minutes'),
      cookTime: z.number().int().positive().optional().describe('Cook minutes'),
      notes: z.string().optional().describe('Notes / instructions'),
      lines: z
        .array(
          z.object({
            ingredient: z.string().min(1).describe('Ingredient name (or id) exactly as it appears in list_raw_materials'),
            quantity: z.number().positive().describe(`How much of it PER RECIPE (min ${MIN_STORABLE_RECIPE_QUANTITY})`),
            unit: z
              .string()
              .min(1)
              .describe('Unit of the quantity — must be compatible with how the ingredient is stored (mass↔mass, volume↔volume)'),
            isOptional: z.boolean().optional().describe('Whether the ingredient is optional'),
            substituteNotes: z.string().optional().describe('Substitution note, e.g. "puede ser pollo"'),
          }),
        )
        .min(1)
        .describe('The ingredients. At least one — a recipe with no ingredients deducts nothing and costs nothing.'),
      confirm: z.boolean().optional().describe('Must be true to actually create it; without it you get a preview'),
    },
    async ({ venueId, product, portionYield, prepTime, cookTime, notes, lines, confirm }) => {
      const denied = await gateV1(venueId, 'inventory:create')
      if (denied) return text(denied)

      const yieldPortions = portionYield ?? 1

      // 1. Duplicates by typed name, before touching the database — the service rejects
      //    duplicates by id, but this gives the operator the name they actually typed.
      const seen = new Set<string>()
      for (const line of lines) {
        const key = line.ingredient.trim().toLowerCase()
        if (seen.has(key)) {
          return text({ ok: false, error: `El ingrediente "${line.ingredient}" viene dos veces. Súmalo en un solo renglón.` })
        }
        seen.add(key)
      }

      // 2. Units, before anything else — an unknown unit is a typo, not a missing ingredient.
      const units: Unit[] = []
      for (const line of lines) {
        const unit = normalizeUnitV1(line.unit)
        if (!unit) {
          return text({ ok: false, error: `Unidad "${line.unit}" inválida. Opciones: ${Object.values(Unit).join(', ')}` })
        }
        units.push(unit)
      }

      // 3. The product.
      const resolvedProduct = await resolveProductV1(venueId, product)
      if (!resolvedProduct.ok) return text(resolvedProduct.payload)

      // 4. The ingredients — ALL OR NOTHING.
      const queries = lines.map(line => line.ingredient.trim())
      const pool = await prisma.rawMaterial.findMany({
        where: { venueId, active: true, deletedAt: null, OR: nameOrIdFilterV1(queries) },
        select: { id: true, name: true, unit: true, costPerUnit: true },
        take: RESOLUTION_POOL_CAP,
      })

      const resolvedLines: Array<{
        rawMaterialId: string
        rawMaterialName: string
        rawMaterialUnit: Unit
        costPerUnit: Decimal
        quantity: number
        unit: Unit
        isOptional: boolean
        substituteNotes?: string
      }> = []

      for (const [index, line] of lines.entries()) {
        const match = pickMatchV1(queries[index], pool)
        if (match.kind === 'ambiguous') {
          return text({
            ok: false,
            error: `"${line.ingredient}" coincide con varios insumos. Dime cuál exactamente (o pasa su id). No creé nada.`,
            candidatos: match.candidates.map(c => ({ id: c.id, nombre: c.name, unidad: c.unit })),
          })
        }
        if (match.kind === 'none') {
          return text({
            ok: false,
            error: `No encontré el insumo "${line.ingredient}" en este local. No creé nada — revisa el nombre con list_raw_materials, o dalo de alta con create_raw_material.`,
          })
        }

        const rawMaterial = match.item
        if (resolvedLines.some(existing => existing.rawMaterialId === rawMaterial.id)) {
          return text({
            ok: false,
            error: `"${line.ingredient}" es el mismo insumo que otro renglón ("${rawMaterial.name}"). Súmalo en un solo renglón.`,
          })
        }

        const unit = units[index]
        if (unit !== rawMaterial.unit && !areUnitsCompatible(unit, rawMaterial.unit)) {
          return text({
            ok: false,
            error: `La unidad ${unit} no es compatible con "${rawMaterial.name}", que se guarda en ${rawMaterial.unit}. Usa una unidad del mismo tipo (peso con peso, volumen con volumen).`,
          })
        }
        if (!storesAsNonzeroRecipeQuantityV1(line.quantity)) {
          return text({
            ok: false,
            error: `La cantidad de "${rawMaterial.name}" es demasiado pequeña: se guarda con 3 decimales, así que debe ser al menos ${MIN_STORABLE_RECIPE_QUANTITY}.`,
          })
        }

        resolvedLines.push({
          rawMaterialId: rawMaterial.id,
          rawMaterialName: rawMaterial.name,
          rawMaterialUnit: rawMaterial.unit,
          costPerUnit: new Decimal(rawMaterial.costPerUnit as unknown as Decimal.Value),
          quantity: line.quantity,
          unit,
          isOptional: line.isOptional ?? false,
          ...(line.substituteNotes ? { substituteNotes: line.substituteNotes } : {}),
        })
      }

      // 5. Cost — the SAME calculator the service uses, so the preview cannot disagree with
      //    what actually gets written.
      let cost
      try {
        cost = calculateRecipeCostV1({
          portionYield: yieldPortions,
          lines: resolvedLines.map((line, index) => ({
            id: String(index),
            quantity: new Decimal(line.quantity),
            unit: line.unit,
            rawMaterial: { unit: line.rawMaterialUnit, costPerUnit: line.costPerUnit },
          })),
        })
      } catch (err) {
        const subject =
          err instanceof RecipeCostCalculationError && err.lineId ? ` ("${resolvedLines[Number(err.lineId)]?.rawMaterialName}")` : ''
        return text({
          ok: false,
          error: `No pude calcular el costo de la receta${subject}. Revisa las cantidades y los costos de los insumos.`,
        })
      }
      const costByIndex = new Map(cost.lines.map(line => [Number(line.id), num(line.costPerServing)]))

      const receta = {
        producto: resolvedProduct.product.name,
        productoId: resolvedProduct.product.id,
        rindePorciones: yieldPortions,
        costoPorPorcion: num(cost.costPerPortion),
        ingredientes: resolvedLines.map((line, index) => ({
          insumo: line.rawMaterialName,
          insumoId: line.rawMaterialId,
          cantidad: line.quantity,
          unidad: line.unit,
          seGuardaEn: line.rawMaterialUnit,
          costoPorPorcion: costByIndex.get(index) ?? null,
          opcional: line.isOptional,
        })),
      }

      // 6. Preview unless confirmed. A recipe changes what EVERY future sale deducts from
      //    stock, so the operator gets to see which ingredient each name resolved to — and in
      //    which unit it is stored — before that becomes true.
      if (!confirm) {
        return text({
          ok: true,
          preview: true,
          requiresConfirmation: true,
          mensaje: `Así quedaría la receta de "${receta.producto}": ${receta.ingredientes
            .map(i => `${i.cantidad} ${i.unidad} de ${i.insumo}`)
            .join(
              ', ',
            )}. Costo por porción $${receta.costoPorPorcion}. Vuelve a llamar con confirm:true para crearla. Crear la receta no activa el inventario; verifica get_recipe y usa enable_recipe_inventory con otra confirmación si hace falta.`,
          receta,
        })
      }

      try {
        const created = await createRecipe(
          venueId,
          resolvedProduct.product.id,
          {
            portionYield: yieldPortions,
            prepTime,
            cookTime,
            notes,
            lines: resolvedLines.map(line => ({
              rawMaterialId: line.rawMaterialId,
              quantity: line.quantity,
              unit: line.unit,
              isOptional: line.isOptional,
              ...(line.substituteNotes ? { substituteNotes: line.substituteNotes } : {}),
            })),
          } as Parameters<typeof createRecipe>[2],
          // WHY: the service already writes RECIPE_CREATED; this rides that entry instead of
          // adding a second one through auditMcpWrite. One recipe, one audit row.
          { staffId: scope.staffId, source: 'customer-mcp' },
        )
        return text({
          ok: true,
          mensaje: `Receta de "${receta.producto}" creada. Costo por porción $${num(created.totalCost)}.`,
          receta: { ...receta, id: created.id, costoPorPorcion: num(created.totalCost) },
          inventoryTrackingChanged: false,
          nextStep:
            'Verifica el estado con get_recipe. Si el descuento por receta está apagado, usa enable_recipe_inventory con confirmación explícita.',
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
