/**
 * Adjusting stock requires `inventory:adjust`, not `inventory:update`.
 *
 * Both adjust-stock routes used to be gated on `inventory:update`, which meant anyone who
 * could rename a raw material could also move its stock. Those are different authorities:
 * one is catalogue, the other is money sitting in the warehouse.
 *
 * The dashboard was ALREADY gating its menu entry on `inventory:adjust` — so the UI hid the
 * button while the API happily accepted the call. That gap is the whole point of this test.
 *
 * Grandfathering was checked against production on 2026-08-07: zero VenueRolePermission
 * rows grant `inventory:update` without `inventory:adjust`, so nobody lost access.
 */

import * as fs from 'fs'
import * as path from 'path'

const source = fs.readFileSync(path.join(__dirname, '../../../src/routes/dashboard/inventory.routes.ts'), 'utf8')

const gateFor = (route: string): string => {
  const at = source.indexOf(`'${route}'`)
  expect(at).toBeGreaterThan(-1)
  return source.slice(at, at + 300)
}

describe('adjust-stock permission', () => {
  it.each([
    ['raw materials', '/raw-materials/:rawMaterialId/adjust-stock'],
    ['resale products', '/products/:productId/adjust-stock'],
  ])('🔴 %s adjust-stock is gated on inventory:adjust', (_label, route) => {
    const block = gateFor(route)
    expect(block).toContain("checkPermission('inventory:adjust')")
    expect(block).not.toContain("checkPermission('inventory:update')")
  })

  it('editing the raw material record still only needs inventory:update', () => {
    // The split is the point: tightening the adjust gate must not drag catalogue edits
    // along with it, or every venue's manager loses the ability to fix a typo.
    const block = source.slice(source.indexOf("'/raw-materials/:rawMaterialId/presentations'"))
    expect(block.slice(0, 600)).toContain("checkPermission('inventory:update')")
  })
})
