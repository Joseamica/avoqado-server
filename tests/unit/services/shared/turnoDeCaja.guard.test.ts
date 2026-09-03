import { readFileSync } from 'fs'
import { join } from 'path'

const raiz = join(__dirname, '../../../../src/services')
/**
 * Archivo → cuántas veces DEBE llamarse al helper. Es un mapa y no una lista porque
 * `payment.tpv.service.ts` tiene DOS sitios (`recordOrderPayment` y `recordFastPayment`):
 * con un simple «¿aparece el helper?», uno de los dos podría volver a filtrar por persona
 * mientras el otro mantiene la aserción en verde.
 */
const esperado: Record<string, number> = {
  'tpv/payment.tpv.service.ts': 2,
  'tpv/refund.tpv.service.ts': 1,
  'tpv/order.tpv.service.ts': 1,
  'dashboard/manualPayment.service.ts': 1,
  'dashboard/refund.dashboard.service.ts': 1,
  'mobile/order.mobile.service.ts': 1,
  'mobile/refund.mobile.service.ts': 1,
}

/**
 * Guarda la decisión «el turno es del negocio» (2-sep-2026): ningún cobro, reembolso ni
 * orden vuelve a buscar el turno abierto filtrando por `staffId`. Si alguien lo necesita
 * de verdad, que cambie esta prueba a conciencia — no por accidente.
 */
describe('nadie resuelve «el turno abierto» filtrando por persona', () => {
  for (const [rel, llamadas] of Object.entries(esperado)) {
    it(`${rel} (${llamadas} sitio${llamadas > 1 ? 's' : ''})`, () => {
      const src = readFileSync(join(raiz, rel), 'utf8')
      const lookups = src.match(/shift\.findFirst\(\{[\s\S]*?\}\)/g) ?? []
      for (const l of lookups) expect(l).not.toMatch(/staffId/)
      expect((src.match(/turnoAbiertoDelNegocio\(/g) ?? []).length).toBe(llamadas)
    })
  }
})
