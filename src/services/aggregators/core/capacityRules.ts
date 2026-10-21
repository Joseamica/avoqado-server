/**
 * Lugares para pases (spec §6). Tres capas; gana la más específica. Un solo tope compartido por todos los
 * proveedores. «Cupo publicado» es lo que ve UN proveedor: sus reservas activas + lo que aún puede tomar.
 */
export type CapacityRuleInput = {
  scope: 'DEFAULT' | 'WEEKLY' | 'SESSION'
  weekday: number | null
  startMinute: number | null
  classSessionId: string | null
  maxSpots: number
}

export type SessionShape = { id: string; capacity: number; localWeekday: number; localStartMinute: number }

function specificity(rule: CapacityRuleInput, s: SessionShape): number {
  if (rule.scope === 'SESSION') return rule.classSessionId === s.id ? 4 : -1
  if (rule.scope === 'WEEKLY') {
    if (rule.weekday !== s.localWeekday) return -1
    if (rule.startMinute === null) return 2
    return rule.startMinute === s.localStartMinute ? 3 : -1
  }
  return 1
}

export function resolvePassCap(rules: CapacityRuleInput[], s: SessionShape): number {
  let best: { spec: number; maxSpots: number } | null = null
  for (const rule of rules) {
    const spec = specificity(rule, s)
    if (spec < 0) continue
    if (!best || spec > best.spec) best = { spec, maxSpots: rule.maxSpots }
  }
  const cap = best ? best.maxSpots : s.capacity
  return Math.max(0, Math.min(cap, s.capacity))
}

export function spotsToPublish(a: {
  capacity: number
  occupied: number
  passOccupied: number
  cap: number
  providerActive: number
}): number {
  const freeReal = Math.max(0, a.capacity - a.occupied)
  const freeInCap = Math.max(0, a.cap - a.passOccupied)
  return a.providerActive + Math.min(freeReal, freeInCap)
}
