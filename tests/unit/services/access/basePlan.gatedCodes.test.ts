import fs from 'fs'
import path from 'path'
import { elPlanConcede, PAID_PLAN_TIER_CODES } from '@/services/access/basePlan.service'

// The legacy plan list is explicit on purpose (a new code must not inherit a paid tier by omission). The cost of that:
// a code gated after the list was written grants nothing to anyone. KITCHEN_DISPLAY (Pro, founder D-A 27-sep) reached
// develop after the list and, merged, locked every classic Pro venue out of the kitchen display.
const GATE =
  /(?:venueHasFeatureAccess|venuesWithFeatureAccess|checkFeatureAccess|requireFeature|hasFeatureAccess)\([^)]*'([A-Z][A-Z0-9_]+)'/g

function gatedCodes(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return gatedCodes(full)
    if (!entry.name.endsWith('.ts')) return []
    return [...fs.readFileSync(full, 'utf8').matchAll(GATE)].map(match => match[1])
  })
}

describe('every feature code the server gates on can be granted by a plan', () => {
  const codes = [...new Set(gatedCodes(path.join(__dirname, '../../../../src')))].filter(
    code => !(PAID_PLAN_TIER_CODES as readonly string[]).includes(code),
  )

  it('finds the gates (the scan itself works)', () => {
    expect(codes.length).toBeGreaterThan(10)
  })

  it('Premium grants every gated code — none is left out of the plan lists', () => {
    expect(codes.filter(code => !elPlanConcede('PREMIUM', code))).toEqual([])
  })

  it('the kitchen display is Pro (founder D-A, 27-sep)', () => {
    expect(elPlanConcede('PRO', 'KITCHEN_DISPLAY')).toBe(true)
  })
})
