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
 * 🔴 Quita comentarios ANTES de buscar: la aserción de abajo tiene que poder describir el
 * hueco del 3-sep («`refundData.shiftId` ganaba») sin dispararse a sí misma. Un comentario
 * NUNCA satisface el guard; sólo lo satisface código real.
 *
 * Bloques `/* … *\/` completos, y de cada línea lo que va después de `//` — respetando el
 * `//` de una URL (`https://…`), que es el único caso que aparece de verdad en estos archivos.
 */
function sinComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(linea => {
      const corte = linea.search(/(?<!:)\/\//)
      return corte === -1 ? linea : linea.slice(0, corte)
    })
    .join('\n')
}

/**
 * 🔴 Cómo se lee el turno del INPUT DEL CLIENTE. Dos formas, porque contar llamadas al
 * helper NO ve un override: el 3-sep-2026 `tpv/refund.tpv.service.ts` llamaba al helper
 * (esta prueba en verde, 1 de 1) y aun así el reembolso caía en el turno que mandaba la
 * TERMINAL — el código era `refundData.shiftId ?? helper`, y la PAX SIEMPRE lo mandaba
 * (`RefundRequest.kt` → `RefundRecorder.kt:265`; la ruta valida con un esquema que declara
 * sólo `params`, así que `validateRequest` deja el body crudo). La Fase 1 quedaba anulada
 * justo ahí, con el guard sin enterarse.
 *
 * `original.shiftId` / `payment.shiftId` NO entran: ésos son filas de la BASE (dato del
 * servidor), no del cuerpo de la petición. Lo que se prohíbe es que lo elija el cliente.
 *
 * 🔴 SUS DOS LÍMITES, verificados — esto es un TRIPWIRE, no una demostración. Caza el error
 * de copiar-pegar, que es como volvió a aparecer el hueco; no caza a quien lo esquive:
 *
 *   1. **Una variable intermedia lo evade.** `const cuerpo = refundData; … cuerpo.shiftId`
 *      no dispara ninguno de los tres patrones: el nombre `cuerpo` no está en la lista de
 *      fuentes, y seguirle el rastro pediría analizar el AST, no texto.
 *   2. **Un `//` dentro de un literal de cadena trunca el resto de esa línea** antes de
 *      comparar (`sinComentarios` sólo protege el `://` de una URL). Una lectura del cliente
 *      escrita después de una cadena con `//` en la MISMA línea pasaría inadvertida.
 *
 * Se dejan sin arreglar a propósito: cerrarlos pide un parser, y el costo no lo justifica
 * mientras la verdad de verdad la fijen las pruebas de comportamiento
 * (`tests/unit/services/tpv/refund.turnoDelNegocio.test.ts`). Están escritos para que nadie
 * lea un verde de este archivo como «ya no puede pasar».
 */
const FUENTES_DEL_CLIENTE = String.raw`refundData|paymentData|orderData|input|payload|body|params|dto|req\.body`
const LECTURAS_DEL_CLIENTE = [
  // `refundData.shiftId`, `input?.shiftId`, `req.body.shiftId`…
  new RegExp(String.raw`\b(${FUENTES_DEL_CLIENTE})\s*\??\.\s*shiftId\b`),
  // `const { shiftId } = refundData` / `= input` / `= req.body`
  new RegExp(String.raw`\{[^}]*\bshiftId\b[^}]*\}\s*=\s*(${FUENTES_DEL_CLIENTE})\b`),
  // La red ancha del brief: `shiftId` y una fuente del cliente en la MISMA sentencia.
  new RegExp(String.raw`\bshiftId\b[^;\n]*\b(${FUENTES_DEL_CLIENTE})\b`),
]

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

/**
 * Y la mitad que faltaba: llamar al helper no basta si además se le hace caso al cliente.
 * Contar llamadas mide que el helper ESTÉ; esto mide que sea el ÚNICO que decide.
 */
describe('nadie toma el turno del INPUT DEL CLIENTE (hueco del 3-sep-2026)', () => {
  for (const rel of Object.keys(esperado)) {
    it(`${rel}`, () => {
      const codigo = sinComentarios(readFileSync(join(raiz, rel), 'utf8'))
      for (const patron of LECTURAS_DEL_CLIENTE) {
        expect(codigo).not.toMatch(patron)
      }
    })
  }
})
