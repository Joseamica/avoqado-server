import { readFileSync } from 'fs'
import { join } from 'path'

const raiz = join(__dirname, '../../../../src/services')
const archivos = [
  'tpv/payment.tpv.service.ts',
  'tpv/refund.tpv.service.ts',
  'tpv/order.tpv.service.ts',
  'dashboard/manualPayment.service.ts',
  'dashboard/refund.dashboard.service.ts',
  'mobile/order.mobile.service.ts',
  'mobile/refund.mobile.service.ts',
]

/**
 * Guarda la decisión «el turno es del negocio» (2-sep-2026): ningún cobro, reembolso ni
 * orden vuelve a buscar el turno abierto filtrando por `staffId`. Si alguien lo necesita
 * de verdad, que cambie esta prueba a conciencia — no por accidente.
 */
describe('nadie resuelve «el turno abierto» filtrando por persona', () => {
  for (const rel of archivos) {
    it(rel, () => {
      const src = readFileSync(join(raiz, rel), 'utf8')
      const lookups = src.match(/shift\.findFirst\(\{[\s\S]*?\}\)/g) ?? []
      for (const l of lookups) expect(l).not.toMatch(/staffId/)
      expect(src).toMatch(/turnoAbiertoDelNegocio\(/)
    })
  }
})
