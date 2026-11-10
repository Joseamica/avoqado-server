import { readFileSync } from 'fs'
import { join } from 'path'

// D18: el script corre `main()` al importarse y escribe en la base, así que se revisa su fuente. Lo que escribe en
// `specialRequests` es lo que lee la cajera arriba del detalle de la cuenta: igual que `cancelOrder` tras D15.
describe('scripts/cancelar-ordenes-fantasma.ts', () => {
  const fuente = readFileSync(join(__dirname, '../../../scripts/cancelar-ordenes-fantasma.ts'), 'utf8')

  it('anota «Cancelada: <motivo>» en español', () => {
    expect(fuente).toContain('specialRequests: `Cancelada: ${motivo}`')
    expect(fuente).not.toContain('Cancelled: ')
  })
})
