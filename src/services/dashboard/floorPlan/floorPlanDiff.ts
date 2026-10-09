import {
  FLOOR_PLAN_LIMITS,
  type DesiredArea,
  type DesiredElement,
  type DesiredTable,
  type FloorElementTypeCode,
  type FloorShapeCode,
  type PlanArea,
  type PlanElement,
  type PlanTable,
  type TableShapeCode,
} from './floorPlan.types'

export type FloorPlanRuleCode =
  | 'LIMIT_EXCEEDED'
  | 'DUPLICATE_CLIENT_ID'
  | 'DUPLICATE_ID'
  | 'AREA_NAME_DUPLICATED'
  | 'UNKNOWN_AREA'
  | 'UNKNOWN_AREA_REF'
  | 'TABLE_NUMBER_DUPLICATED'
  | 'TABLE_NUMBER_RESERVED'
  | 'UNKNOWN_TABLE'
  | 'UNKNOWN_ELEMENT'
  | 'ELEMENT_SHAPE_INVALID'

/** Regla del plano violada. El servicio la convierte en 400 con el mismo `code`. */
export class FloorPlanRuleError extends Error {
  constructor(
    public readonly code: FloorPlanRuleCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'FloorPlanRuleError'
  }
}

export type AreaTarget = { kind: 'existing'; id: string } | { kind: 'new'; clientId: string }

export interface TableLayout {
  number: string
  capacity: number
  shape: TableShapeCode
  rotation: number
  positionX: number | null
  positionY: number | null
  area: AreaTarget | null
}

export interface ElementLayout {
  type: FloorElementTypeCode
  area: AreaTarget
  positionX: number
  positionY: number
  width: number | null
  height: number | null
  rotation: number
  endX: number | null
  endY: number | null
  label: string | null
  color: string | null
}

export interface CurrentFloorPlan {
  areas: PlanArea[]
  activeTables: PlanTable[]
  /** Mesas archivadas (active=false) cuyo número aparece en el plano deseado: número → id. */
  archivedByNumber: Map<string, string>
  elements: PlanElement[]
}

export interface DesiredFloorPlan {
  areas: DesiredArea[]
  tables: DesiredTable[]
  elements: DesiredElement[]
}

export interface FloorPlanDiff {
  areas: {
    create: Array<{ clientId: string; name: string; floorShape: FloorShapeCode; sortOrder: number }>
    update: Array<{ id: string; name: string; floorShape: FloorShapeCode; sortOrder: number }>
    /** ids cuyo nombre cambia: pasan por un nombre temporal para no chocar con @@unique([venueId, name]). */
    rename: string[]
    remove: string[]
  }
  tables: {
    update: Array<{ id: string; data: TableLayout }>
    revive: Array<{ id: string; data: TableLayout }>
    create: Array<{ clientId: string; data: TableLayout }>
    archive: string[]
    /** ids (de update) cuyo número cambia: pasan por un número temporal. */
    renumber: string[]
    /** Filas archivadas o por archivar cuyo número reclama una mesa conservada: se les cambia el número. */
    freeNumbers: Array<{ id: string; number: string }>
  }
  elements: { update: Array<{ id: string; data: ElementLayout }>; create: ElementLayout[]; archive: string[] }
}

const RECT_TYPES: readonly FloorElementTypeCode[] = ['BAR_COUNTER', 'SERVICE_AREA', 'DOOR']

/**
 * Número que recibe una mesa ARCHIVADA cuando una mesa del plano reclama el suyo: «5 (archivada)», «5 (archivada 2)»…
 * Es una etiqueta del sistema, no un número que alguien eligió: una mesa del plano no puede tomarla (`TABLE_NUMBER_RESERVED`).
 */
export const archivedNumberLabel = (number: string, attempt: number): string =>
  attempt === 1 ? `${number} (archivada)` : `${number} (archivada ${attempt})`
const ARCHIVED_LABEL = /\(archivada(?: \d+)?\)$/

/** Cómo se nombra un elemento en un mensaje: «Una pared…», «El letrero «VIP»…». */
const ELEMENT_NAMES: Record<FloorElementTypeCode, readonly [string, string]> = {
  WALL: ['Una pared', 'La pared'],
  BAR_COUNTER: ['Una barra', 'La barra'],
  SERVICE_AREA: ['Un área de servicio', 'El área de servicio'],
  LABEL: ['Un letrero', 'El letrero'],
  DOOR: ['Una puerta', 'La puerta'],
}
const elementName = (e: DesiredElement): string => {
  const [una, la] = ELEMENT_NAMES[e.type]
  const label = e.label?.trim()
  return label ? `${la} «${label}»` : una
}
const nameKey = (s: string) => s.trim().toLocaleLowerCase('es-MX')
const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6)
const targetId = (t: AreaTarget | null): string | null | undefined => (t === null ? null : t.kind === 'existing' ? t.id : undefined)

function tableChanged(cur: PlanTable, d: TableLayout): boolean {
  return (
    cur.number !== d.number ||
    cur.capacity !== d.capacity ||
    cur.shape !== d.shape ||
    cur.rotation !== d.rotation ||
    !same(cur.positionX, d.positionX) ||
    !same(cur.positionY, d.positionY) ||
    cur.areaId !== targetId(d.area)
  )
}

function elementChanged(cur: PlanElement, d: ElementLayout): boolean {
  return (
    cur.type !== d.type ||
    cur.areaId !== targetId(d.area) ||
    !same(cur.positionX, d.positionX) ||
    !same(cur.positionY, d.positionY) ||
    !same(cur.width, d.width) ||
    !same(cur.height, d.height) ||
    cur.rotation !== d.rotation ||
    !same(cur.endX, d.endX) ||
    !same(cur.endY, d.endY) ||
    cur.label !== d.label ||
    cur.color !== d.color
  )
}

function toElementLayout(e: DesiredElement, area: AreaTarget, index: number): ElementLayout {
  const width = e.width ?? null
  const height = e.height ?? null
  const endX = e.endX ?? null
  const endY = e.endY ?? null
  const label = e.label?.trim() ? e.label.trim() : null
  const invalid = (message: string) => new FloorPlanRuleError('ELEMENT_SHAPE_INVALID', message, { index, type: e.type })
  if (e.type === 'WALL' && (endX === null || endY === null)) throw invalid('Una pared necesita punto final')
  if (RECT_TYPES.includes(e.type) && (width === null || height === null)) throw invalid('Este elemento necesita ancho y alto')
  if (e.type === 'LABEL' && !label) throw invalid('Un letrero necesita texto')
  return {
    type: e.type,
    area,
    positionX: e.positionX,
    positionY: e.positionY,
    width,
    height,
    rotation: e.rotation,
    endX,
    endY,
    label,
    color: e.color ?? null,
  }
}

/** Una misma fila no puede venir dos veces: se colapsaría en silencio y hasta podría archivar otra mesa. */
function assertUniqueIds(items: ReadonlyArray<{ id?: string }>, what: string): void {
  const seen = new Set<string>()
  for (const { id } of items) {
    if (!id) continue
    if (seen.has(id)) throw new FloorPlanRuleError('DUPLICATE_ID', `El plano trae dos veces ${what}. Recarga el plano.`, { id })
    seen.add(id)
  }
}

/** Dos filas nuevas con la misma clave (o una clave igual a un id que ya existe) no se pueden distinguir. */
function assertUniqueClientIds(items: ReadonlyArray<{ clientId?: string }>, message: string, existingIds: ReadonlySet<string>): void {
  const seen = new Set<string>()
  for (const { clientId } of items) {
    if (!clientId) continue
    if (seen.has(clientId) || existingIds.has(clientId)) throw new FloorPlanRuleError('DUPLICATE_CLIENT_ID', message, { clientId })
    seen.add(clientId)
  }
}

/**
 * Compara el plano actual con el que el editor quiere publicar y dice qué crear, cambiar, archivar o
 * revivir. Pura: no toca la base. El servicio aplica el resultado dentro de una transacción.
 */
export function computeFloorPlanDiff(
  current: CurrentFloorPlan,
  desired: DesiredFloorPlan,
  // Tipo ancho a propósito: FLOOR_PLAN_LIMITS es `as const` (literales 30/500/1500) y el default no debe fijar esos literales.
  limits: Record<keyof typeof FLOOR_PLAN_LIMITS, number> = FLOOR_PLAN_LIMITS,
): FloorPlanDiff {
  if (desired.areas.length > limits.areas)
    throw new FloorPlanRuleError('LIMIT_EXCEEDED', `Máximo ${limits.areas} áreas por sucursal`, { kind: 'areas', limit: limits.areas })
  if (desired.tables.length > limits.tables)
    throw new FloorPlanRuleError('LIMIT_EXCEEDED', `Máximo ${limits.tables} mesas por sucursal`, { kind: 'tables', limit: limits.tables })
  if (desired.elements.length > limits.elements)
    throw new FloorPlanRuleError('LIMIT_EXCEEDED', `Máximo ${limits.elements} elementos en el plano`, {
      kind: 'elements',
      limit: limits.elements,
    })

  // Primero las claves repetidas, de cualquier tipo: sin ellas no se sabe de qué fila habla el resto de las reglas.
  assertUniqueIds(desired.areas, 'la misma área')
  assertUniqueIds(desired.tables, 'la misma mesa')
  assertUniqueIds(desired.elements, 'el mismo elemento')
  // Una clave de área nueva tampoco puede ser el id de un área que ya existe: las mesas y elementos la usarían de referencia.
  assertUniqueClientIds(desired.areas, 'El plano trae dos áreas con la misma clave', new Set(current.areas.map(a => a.id)))
  assertUniqueClientIds(desired.tables, 'El plano trae dos mesas con la misma clave', new Set())

  const diff: FloorPlanDiff = {
    areas: { create: [], update: [], rename: [], remove: [] },
    tables: { update: [], revive: [], create: [], archive: [], renumber: [], freeNumbers: [] },
    elements: { update: [], create: [], archive: [] },
  }

  // ---- Áreas
  const currentAreas = new Map(current.areas.map(a => [a.id, a]))
  const refs = new Map<string, AreaTarget>()
  const names = new Set<string>()
  for (const a of desired.areas) {
    const name = a.name.trim()
    if (names.has(nameKey(name))) throw new FloorPlanRuleError('AREA_NAME_DUPLICATED', `Ya hay un área llamada «${name}»`, { name })
    names.add(nameKey(name))
    if (a.id) {
      const prev = currentAreas.get(a.id)
      if (!prev) throw new FloorPlanRuleError('UNKNOWN_AREA', 'Un área del plano ya no existe. Recarga el plano.', { id: a.id })
      refs.set(a.id, { kind: 'existing', id: a.id })
      if (prev.name !== name || prev.floorShape !== a.floorShape || prev.sortOrder !== a.sortOrder) {
        diff.areas.update.push({ id: a.id, name, floorShape: a.floorShape, sortOrder: a.sortOrder })
        if (prev.name !== name) diff.areas.rename.push(a.id)
      }
      continue
    }
    const clientId = a.clientId as string
    refs.set(clientId, { kind: 'new', clientId })
    diff.areas.create.push({ clientId, name, floorShape: a.floorShape, sortOrder: a.sortOrder })
  }
  const keptAreaIds = new Set(desired.areas.flatMap(a => (a.id ? [a.id] : [])))
  diff.areas.remove = current.areas.filter(a => !keptAreaIds.has(a.id)).map(a => a.id)

  // `who` nombra a quien apunta mal («La mesa 4», «Una pared»): borrar un área que todavía tiene mesas cae aquí.
  const resolveArea = (ref: string, who: string, details: Record<string, unknown>): AreaTarget => {
    const target = refs.get(ref)
    if (!target) throw new FloorPlanRuleError('UNKNOWN_AREA_REF', `${who} apunta a un área que no existe en el plano.`, { ref, ...details })
    return target
  }

  // ---- Elementos
  const currentElements = new Map(current.elements.map(e => [e.id, e]))
  const keptElements = new Set<string>()
  desired.elements.forEach((e, index) => {
    const prev = e.id ? currentElements.get(e.id) : undefined
    if (e.id && !prev)
      throw new FloorPlanRuleError('UNKNOWN_ELEMENT', 'Un elemento del plano ya no existe. Recarga el plano.', { id: e.id })
    const layout = toElementLayout(e, resolveArea(e.areaRef, elementName(e), { index, type: e.type }), index)
    if (prev) {
      keptElements.add(prev.id)
      if (elementChanged(prev, layout)) diff.elements.update.push({ id: prev.id, data: layout })
    } else diff.elements.create.push(layout)
  })
  diff.elements.archive = current.elements.filter(e => !keptElements.has(e.id)).map(e => e.id)

  // ---- Mesas
  const active = new Map(current.activeTables.map(t => [t.id, t]))
  const numbers = new Set<string>()
  for (const t of desired.tables) {
    const n = t.number.trim()
    if (numbers.has(n)) throw new FloorPlanRuleError('TABLE_NUMBER_DUPLICATED', `Hay dos mesas con el número ${n}`, { number: n })
    numbers.add(n)
    const prev = t.id ? active.get(t.id) : undefined
    if (t.id && !prev) throw new FloorPlanRuleError('UNKNOWN_TABLE', 'Una mesa del plano ya no existe. Recarga el plano.', { id: t.id })
    // Un número que la mesa no tenía y que es la etiqueta de una ARCHIVADA: crearla revivía la mesa vieja (con su
    // historial y su QR) y renombrarla le cambiaba la etiqueta a la archivada. Se pide otro número antes de escribir.
    if (prev?.number !== n && ARCHIVED_LABEL.test(n) && current.archivedByNumber.has(n))
      throw new FloorPlanRuleError('TABLE_NUMBER_RESERVED', `El número «${n}» está reservado para una mesa archivada. Usa otro.`, {
        number: n,
      })
  }
  const keptIds = new Set(desired.tables.flatMap(t => (t.id ? [t.id] : [])))
  // Mesas que el plano ya no trae: se archivan, salvo que una mesa NUEVA con su mismo número las reutilice.
  const omittedByNumber = new Map(current.activeTables.filter(t => !keptIds.has(t.id)).map(t => [t.number, t.id]))
  for (const t of desired.tables) {
    const data: TableLayout = {
      number: t.number.trim(),
      capacity: t.capacity,
      shape: t.shape,
      rotation: t.rotation,
      positionX: t.positionX,
      positionY: t.positionY,
      area: t.areaRef === null ? null : resolveArea(t.areaRef, `La mesa ${t.number.trim()}`, { number: t.number.trim() }),
    }
    if (t.id) {
      const prev = active.get(t.id) as PlanTable
      if (tableChanged(prev, data)) {
        diff.tables.update.push({ id: t.id, data })
        if (prev.number !== data.number) diff.tables.renumber.push(t.id)
      }
      continue
    }
    const reusable = omittedByNumber.get(data.number)
    if (reusable) {
      omittedByNumber.delete(data.number)
      // Sólo se reescribe si cambió algo (menos escrituras y menos candados en la publicación).
      if (tableChanged(active.get(reusable) as PlanTable, data)) diff.tables.update.push({ id: reusable, data })
      continue
    }
    const archived = current.archivedByNumber.get(data.number)
    if (archived) {
      diff.tables.revive.push({ id: archived, data })
      continue
    }
    diff.tables.create.push({ clientId: t.clientId as string, data })
  }
  diff.tables.archive = [...omittedByNumber.values()]

  // Una mesa conservada que toma el número de una archivada (o por archivar) obliga a liberar ese número.
  const claimed = new Set(diff.tables.update.filter(u => diff.tables.renumber.includes(u.id)).map(u => u.data.number))
  for (const [number, id] of omittedByNumber) if (claimed.has(number)) diff.tables.freeNumbers.push({ id, number })
  // Una archivada reclamada nunca es también revivida: eso exigiría dos mesas del plano con su número (TABLE_NUMBER_DUPLICATED).
  for (const [number, id] of current.archivedByNumber) if (claimed.has(number)) diff.tables.freeNumbers.push({ id, number })

  return diff
}
