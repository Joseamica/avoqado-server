import { execFileSync } from 'child_process'

// Un ticket, recibo o reporte de una venta pasada debe mostrar el nombre que tenía AL VENDERSE (OrderItem.productName).
// Con variantes, renombrar «Playera» renombra sus tallas: leer el nombre vivo primero cambiaba ventas viejas.
const ROOT = `${__dirname}/../../..`

function grepSrc(pattern: string, ...paths: string[]): string {
  try {
    return execFileSync('/usr/bin/grep', ['-rnE', pattern, ...paths], { cwd: ROOT, encoding: 'utf8' }).toString()
  } catch (e: any) {
    if (e.status === 1) return '' // grep sale con 1 cuando no hay coincidencias
    throw e
  }
}

describe('el renglón de una venta pasada muestra el nombre con el que se vendió', () => {
  it('🔴 nadie lee primero el nombre vivo del producto para un renglón de venta', () => {
    // Cualquier variable (item, it, line, oi, orderItem…) y tanto `||` como `??` antes de `.productName`.
    const out = grepSrc('product\\??\\.name\\s*(\\|\\||\\?\\?)\\s*[A-Za-z_$][A-Za-z0-9_$.?]*\\.productName', 'src')
    expect(out.trim()).toBe('')
  })

  it('🔴 el reporte del turno del dashboard tampoco lee sólo el nombre vivo', () => {
    // Estos dos renglones no traían respaldo (`item.product?.name || 'Unknown Product'`): cada uno debe pedir primero productName.
    const lines = grepSrc("'Unknown Product'", 'src/services/dashboard/shift.dashboard.service.ts').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const sinSnapshot = lines.filter(
      l => !/\.productName\s*\|\|\s*[A-Za-z_$][A-Za-z0-9_$.?]*product\??\.name\s*\|\|\s*'Unknown Product'/.test(l),
    )
    expect(sinSnapshot).toEqual([])
  })
})
