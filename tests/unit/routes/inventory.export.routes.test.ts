/**
 * Export routes are reachable.
 *
 * `/raw-materials/export` MUST be declared before `/raw-materials/:rawMaterialId`, or Express
 * matches "export" as the id and the endpoint is born dead. `/purchase-orders/stats` shipped
 * that way and nobody noticed until someone went looking.
 */
import * as fs from 'fs'
import * as path from 'path'

const source = fs.readFileSync(path.join(__dirname, '../../../src/routes/dashboard/inventory.routes.ts'), 'utf8')

describe('export routes', () => {
  it('🔴 /raw-materials/export is declared before /raw-materials/:rawMaterialId', () => {
    expect(source.indexOf("'/raw-materials/export'")).toBeGreaterThan(-1)
    expect(source.indexOf("'/raw-materials/export'")).toBeLessThan(source.indexOf("'/raw-materials/:rawMaterialId'"))
  })

  it('requires inventory:read', () => {
    const at = source.indexOf("'/raw-materials/export'")
    expect(source.slice(at, at + 200)).toContain("checkPermission('inventory:read')")
  })

  it('🔴 /purchase-orders/export is declared before /purchase-orders/:purchaseOrderId', () => {
    expect(source.indexOf("'/purchase-orders/export'")).toBeGreaterThan(-1)
    expect(source.indexOf("'/purchase-orders/export'")).toBeLessThan(source.indexOf("'/purchase-orders/:purchaseOrderId'"))
  })

  it('/purchase-orders/export requires inventory:read', () => {
    const at = source.indexOf("'/purchase-orders/export'")
    expect(source.slice(at, at + 200)).toContain("checkPermission('inventory:read')")
  })

  it('🔴 /suppliers/export is declared before /suppliers/:supplierId', () => {
    expect(source.indexOf("'/suppliers/export'")).toBeGreaterThan(-1)
    expect(source.indexOf("'/suppliers/export'")).toBeLessThan(source.indexOf("'/suppliers/:supplierId'"))
  })

  it('/suppliers/export requires inventory:read', () => {
    const at = source.indexOf("'/suppliers/export'")
    expect(source.slice(at, at + 200)).toContain("checkPermission('inventory:read')")
  })

  it('🔴 the kardex export is declared before the movements listing it exports', () => {
    // Same discipline as the three above. The path has one more segment so Express would not
    // actually confuse them today, but a `/movements/:movementId` added later would — and the
    // ordering is what keeps that from being a silent regression.
    expect(source.indexOf("'/raw-materials/:rawMaterialId/movements/export'")).toBeGreaterThan(-1)
    expect(source.indexOf("'/raw-materials/:rawMaterialId/movements/export'")).toBeLessThan(
      source.indexOf("'/raw-materials/:rawMaterialId/movements'"),
    )
  })

  it('the kardex export requires inventory:read', () => {
    const at = source.indexOf("'/raw-materials/:rawMaterialId/movements/export'")
    expect(source.slice(at, at + 200)).toContain("checkPermission('inventory:read')")
  })
})
