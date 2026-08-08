/**
 * The batch routes exist and are reachable.
 *
 * Two things this test protects, and both have bitten us separately:
 *
 * 1. The WHOLE batch layer was written and COMPLETELY UNREACHABLE: `fifoBatch.service` had
 *    list, get, stats and quarantine, with their tests green, and there was not a single
 *    route calling any of them. A tested function nobody can call is not a feature.
 *
 * 2. `/batches/stats` MUST be declared before `/batches/:batchId`, or Express swallows
 *    "stats" as if it were an id and the route is born dead. Exactly what happened to
 *    `/purchase-orders/stats`, which sat unreachable without anyone noticing.
 */

import * as fs from 'fs'
import * as path from 'path'

const ROUTES_FILE = path.join(__dirname, '../../../src/routes/dashboard/inventory.routes.ts')
const source = fs.readFileSync(ROUTES_FILE, 'utf8')

const positionOf = (fragment: string) => source.indexOf(fragment)

describe('batch routes', () => {
  it.each([
    ['listing the batches of a raw material', "'/raw-materials/:rawMaterialId/batches'"],
    ['getting one batch', "'/batches/:batchId'"],
    ['batch stats', "'/batches/stats'"],
    ['holding a batch', "'/batches/:batchId/quarantine'"],
    ['releasing a batch', "'/batches/:batchId/release'"],
  ])('the route for %s exists', (_name, route) => {
    expect(source).toContain(route)
  })

  it('🔴 /batches/stats is declared BEFORE /batches/:batchId', () => {
    const stats = positionOf("'/batches/stats'")
    const byId = positionOf("'/batches/:batchId'")
    expect(stats).toBeGreaterThan(-1)
    expect(byId).toBeGreaterThan(-1)
    expect(stats).toBeLessThan(byId)
  })

  it('hold and release use the ADJUST permission, not the read one nor a generic one', () => {
    // Taking goods out of circulation moves available stock: that is an inventory
    // adjustment. Gating it with `inventory:update` would let anyone who can edit a raw
    // material's record put goods on hold.
    for (const route of ['quarantine', 'release']) {
      const i = positionOf(`'/batches/:batchId/${route}'`)
      const block = source.slice(i, i + 400)
      expect(block).toContain("checkPermission('inventory:adjust')")
    }
  })

  it('the mutations validate the body (the reason is mandatory)', () => {
    expect(source.slice(positionOf("'/batches/:batchId/quarantine'"), positionOf("'/batches/:batchId/quarantine'") + 400)).toContain(
      'QuarantineBatchSchema',
    )
    expect(source.slice(positionOf("'/batches/:batchId/release'"), positionOf("'/batches/:batchId/release'") + 400)).toContain(
      'ReleaseBatchSchema',
    )
  })

  it('reading batches requires inventory:read', () => {
    const i = positionOf("'/raw-materials/:rawMaterialId/batches'")
    expect(source.slice(i, i + 400)).toContain("checkPermission('inventory:read')")
  })
})

describe('the MCP reaches the batches too', () => {
  // Repo rule: a capability that is not reachable from the customer MCP is only half done.
  // The MCP is a first-class interface, not an extra.
  const mcp = fs.readFileSync(path.join(__dirname, '../../../src/mcp/tools/inventory.ts'), 'utf8')

  it('exposes batch reads and the hold', () => {
    expect(mcp).toContain("'stock_batches'")
    expect(mcp).toContain("'quarantine_batch'")
  })

  it('🔴 hold/release is two-step: it previews and only applies with confirm', () => {
    // It moves real stock off the back of a natural-language request. Without the two-step
    // confirmation, a misread "put that batch on hold" deducts inventory.
    const block = mcp.slice(mcp.indexOf("'quarantine_batch'"))
    expect(block).toContain('requiresConfirmation: true')
    expect(block).toMatch(/if \(!confirm\)/)
  })

  it('🔴 gates on inventory:adjust, filters by venue and leaves an audit trail', () => {
    const block = mcp.slice(mcp.indexOf("'quarantine_batch'"))
    expect(block).toContain("guard.requirePermission('inventory:adjust', venueId)")
    expect(block).toContain('guard.venueFilter(venueId)')
    expect(block).toContain('auditMcpWrite')
  })

  it('resolves the batch WITHIN the scoped venue before previewing', () => {
    // If the preview were built without filtering by venue, the operator would see another
    // venue's batch number and raw material even though they could never apply it.
    const block = mcp.slice(mcp.indexOf("'quarantine_batch'"))
    expect(block).toMatch(/stockBatch\.findFirst\(\{\s*\n?\s*where: \{ \.\.\.where, id: batchId \}/)
  })
})
