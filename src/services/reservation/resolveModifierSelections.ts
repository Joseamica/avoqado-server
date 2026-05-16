import { Prisma, type PrismaClient } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'

export interface ModifierSelectionInput {
  productId: string
  modifierId: string
  quantity?: number
}

export interface ResolvedModifierRow {
  productId: string
  modifierId: string
  name: string
  quantity: number
  price: Prisma.Decimal
}

export interface ResolveResult {
  persistRows: ResolvedModifierRow[]
  totalDelta: Prisma.Decimal
  /** Sum of (modifier.durationMin × qty) across all picked modifiers, in
   *  minutes. Zero when no modifier carries a duration. createReservation
   *  adds this to the reservation duration + extends endsAt. */
  totalDurationDelta: number
}

export async function resolveModifierSelections(
  tx: PrismaClient | Prisma.TransactionClient,
  productIds: string[],
  selections: ModifierSelectionInput[],
): Promise<ResolveResult> {
  if (productIds.length === 0) {
    if (selections.length > 0) {
      throw new BadRequestError('No se pueden enviar modificadores sin un servicio')
    }
    return { persistRows: [], totalDelta: new Prisma.Decimal(0), totalDurationDelta: 0 }
  }

  const assignments = await tx.productModifierGroup.findMany({
    where: { productId: { in: productIds } },
    select: {
      productId: true,
      group: {
        select: {
          id: true,
          required: true,
          allowMultiple: true,
          minSelections: true,
          maxSelections: true,
          active: true,
          modifiers: {
            where: { active: true },
            select: { id: true, name: true, price: true, durationMin: true, active: true },
          },
        },
      },
    },
  })

  const productGroups = new Map<string, Map<string, (typeof assignments)[number]['group']>>()
  const modifierIndex = new Map<
    string,
    {
      productId: string
      group: (typeof assignments)[number]['group']
      modifier: { id: string; name: string; price: Prisma.Decimal | string; durationMin: number | null }
    }
  >()

  for (const a of assignments) {
    if (!a.group.active) continue
    let map = productGroups.get(a.productId)
    if (!map) {
      map = new Map()
      productGroups.set(a.productId, map)
    }
    map.set(a.group.id, a.group)
    for (const m of a.group.modifiers) {
      modifierIndex.set(`${a.productId}:${m.id}`, { productId: a.productId, group: a.group, modifier: m })
    }
  }

  const grouped = new Map<string, { groupId: string; productId: string; rows: { modifierId: string; quantity: number }[] }>()
  for (const sel of selections) {
    const qty = sel.quantity ?? 1
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new BadRequestError(`Cantidad inválida para el modificador ${sel.modifierId}`)
    }
    const entry = modifierIndex.get(`${sel.productId}:${sel.modifierId}`)
    if (!entry) {
      throw new BadRequestError(`Modificador ${sel.modifierId} no válido para el servicio seleccionado`)
    }
    const key = `${sel.productId}:${entry.group.id}`
    let bucket = grouped.get(key)
    if (!bucket) {
      bucket = { groupId: entry.group.id, productId: sel.productId, rows: [] }
      grouped.set(key, bucket)
    }
    bucket.rows.push({ modifierId: sel.modifierId, quantity: qty })
  }

  for (const [productId, groupsMap] of productGroups) {
    for (const group of groupsMap.values()) {
      const bucket = grouped.get(`${productId}:${group.id}`)
      const totalCount = bucket ? bucket.rows.reduce((acc, r) => acc + r.quantity, 0) : 0
      const distinctCount = bucket ? bucket.rows.length : 0

      if (group.required && totalCount < Math.max(1, group.minSelections)) {
        throw new BadRequestError(`El grupo de modificadores es requerido`)
      }
      if (!group.allowMultiple && distinctCount > 1) {
        throw new BadRequestError(`Solo puedes elegir una opción en este grupo`)
      }
      if (group.allowMultiple) {
        if (group.minSelections > 0 && totalCount < group.minSelections) {
          throw new BadRequestError(`Debes seleccionar al menos ${group.minSelections} opciones`)
        }
        if (group.maxSelections != null && totalCount > group.maxSelections) {
          throw new BadRequestError(`Máximo ${group.maxSelections} opciones permitidas`)
        }
      }
    }
  }

  let totalDelta = new Prisma.Decimal(0)
  let totalDurationDelta = 0
  const persistRows: ResolvedModifierRow[] = []
  for (const sel of selections) {
    const entry = modifierIndex.get(`${sel.productId}:${sel.modifierId}`)!
    const qty = sel.quantity ?? 1
    const unitPrice = new Prisma.Decimal(entry.modifier.price as any)
    const lineTotal = unitPrice.mul(qty)
    totalDelta = totalDelta.add(lineTotal)
    if (entry.modifier.durationMin != null) {
      totalDurationDelta += entry.modifier.durationMin * qty
    }
    persistRows.push({
      productId: sel.productId,
      modifierId: sel.modifierId,
      name: entry.modifier.name,
      quantity: qty,
      price: unitPrice,
    })
  }

  return { persistRows, totalDelta, totalDurationDelta }
}
