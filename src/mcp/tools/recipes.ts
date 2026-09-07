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

/** Never return an unbounded pantry to the model — a large venue would blow the context. */
const RAW_MATERIAL_PAGE_CAP = 200
const RAW_MATERIAL_PAGE_DEFAULT = 100

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
      select: { id: true, name: true, sku: true, price: true },
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
    'list_raw_materials',
    'The PANTRY of a venue you can access: every active raw material / ingredient with the UNIT it is stored in, its stock and its cost per unit. Read this BEFORE writing a recipe — create_recipe resolves ingredients by name and refuses anything it cannot match to exactly one row, so this is how you learn the real names and units. Answers "¿qué insumos tengo?", "¿en qué unidad está el aguacate?". Pass venueId; optional `search` filters by name. Requires inventory:read. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().describe('Venue whose pantry to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by ingredient name (partial, case-insensitive)'),
      limit: z
        .number()
        .int()
        .positive()
        .max(RAW_MATERIAL_PAGE_CAP)
        .optional()
        .describe(`Max ingredients to return (default ${RAW_MATERIAL_PAGE_DEFAULT})`),
    },
    async ({ venueId, search, limit }) => {
      const denied = await gateV1(venueId, 'inventory:read')
      if (denied) return text(denied)

      const take = Math.min(limit ?? RAW_MATERIAL_PAGE_DEFAULT, RAW_MATERIAL_PAGE_CAP)
      const rows = await prisma.rawMaterial.findMany({
        where: {
          venueId,
          active: true,
          deletedAt: null,
          ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
        },
        select: { id: true, name: true, sku: true, category: true, unit: true, currentStock: true, costPerUnit: true },
        orderBy: { name: 'asc' },
        take,
      })

      return text({
        ok: true,
        venueId,
        total: rows.length,
        // WHY: a page cap that truncates in silence is how an operator concludes an ingredient
        // "doesn't exist" and creates a duplicate. Say it, and say how to narrow the search.
        ...(rows.length === take ? { aviso: `Se muestran los primeros ${take} insumos. Usa "search" para acotar.` } : {}),
        insumos: rows.map(row => ({
          id: row.id,
          nombre: row.name,
          sku: row.sku,
          categoria: row.category,
          unidad: row.unit,
          existencia: num(row.currentStock),
          costoPorUnidad: num(row.costPerUnit),
        })),
      })
    },
  )

  // ---------------------------------------------------------------------------
  server.tool(
    'get_recipe',
    'The RECIPE of one menu product in a venue you can access: which ingredients it consumes, how much of each, the cost per portion and how many portions it yields. This is what makes a sale deduct stock. Name the product (or pass its id). Answers "¿qué lleva el Avo Toast?", "¿cuánto me cuesta cada porción?". Requires inventory:read. PREMIUM (INVENTORY_TRACKING).',
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
    'Create the RECIPE of a menu product in a venue you can access: which ingredients it consumes and how much of each. This is what makes every future sale of that product deduct stock and carry a cost, so read the pantry with list_raw_materials FIRST and use the real ingredient names and units. Ingredients are resolved by name and it is ALL OR NOTHING — if one name matches zero or several ingredients, NOTHING is created and you get the candidates back. By DEFAULT this only PREVIEWS (which ingredient each name resolved to, the unit it is stored in, and the resulting cost per portion); call again with confirm:true to actually create it. Editing or deleting a recipe is done in the dashboard. This WRITES — requires inventory:create. PREMIUM (INVENTORY_TRACKING).',
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
          mensaje: `Así quedaría la receta de "${receta.producto}": ${receta.ingredientes
            .map(i => `${i.cantidad} ${i.unidad} de ${i.insumo}`)
            .join(', ')}. Costo por porción $${receta.costoPorPorcion}. Vuelve a llamar con confirm:true para crearla.`,
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
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
