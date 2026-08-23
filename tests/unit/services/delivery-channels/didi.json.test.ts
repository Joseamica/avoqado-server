/**
 * Los IDs de DiDi son enteros de 64 bits, y `JSON.parse` los ROMPE.
 *
 * No es una precaución teórica: la documentación de DiDi trae el caso literal, con este
 * mismo número, y advierte que en Node hay que usar `json-bigint`. Un id corrompido no
 * truena — el pedido entra con un folio que no existe, y el callback que llegue después no
 * casa con nada. Se pierde en silencio, que es la peor forma de perderse.
 */
import { parseDidiPayload } from '../../../../src/services/delivery-channels/providers/didi-food/didi.json'

// El ejemplo EXACTO de la documentación de DiDi.
const ID_REAL = '5764607801871631353'
const CRUDO = `{"order_id":${ID_REAL},"shop_id":5764660871732268653,"status":2}`

describe('parseDidiPayload — enteros de 64 bits', () => {
  // ── La prueba de que el problema es real, no una suposición ────────────────────────
  it('🔴 JSON.parse SÍ corrompe el id — este test documenta por qué existe el parser', () => {
    const roto = JSON.parse(CRUDO)

    // Redondea los últimos dígitos y ni siquiera avisa.
    expect(String(roto.order_id)).not.toBe(ID_REAL)
    expect(String(roto.order_id)).toBe('5764607801871631000')
  })

  it('el nuestro lo conserva EXACTO, dígito por dígito', () => {
    const ok = parseDidiPayload<{ order_id: string; shop_id: string }>(CRUDO)

    expect(ok.order_id).toBe(ID_REAL)
    expect(ok.shop_id).toBe('5764660871732268653')
  })

  it('los ids llegan como TEXTO, no como number ni BigInt', () => {
    // A propósito: un id es un identificador, no un número con el que se hagan cuentas.
    // Como texto viaja igual a `Order.externalId` (que ya es string) y se compara sin
    // sorpresas. Un BigInt reventaría en cuanto alguien lo pase por `JSON.stringify`.
    const ok = parseDidiPayload<Record<string, unknown>>(CRUDO)

    expect(typeof ok.order_id).toBe('string')
    expect(typeof ok.shop_id).toBe('string')
  })

  it('los números normales SIGUEN siendo números — no se convierte todo a texto', () => {
    const ok = parseDidiPayload<{ status: number }>(CRUDO)
    expect(ok.status).toBe(2)
    expect(typeof ok.status).toBe('number')
  })

  it('acepta el Buffer crudo, que es como llega el webhook', () => {
    // Los webhooks se montan con `express.raw`, así que el controlador recibe un Buffer.
    // Si esto sólo aceptara string, alguien haría `buf.toString()` y luego `JSON.parse`.
    const ok = parseDidiPayload<{ order_id: string }>(Buffer.from(CRUDO, 'utf8'))
    expect(ok.order_id).toBe(ID_REAL)
  })

  it('un JSON inválido LANZA — para poder responder 400 en vez de seguir con basura', () => {
    expect(() => parseDidiPayload('{no soy json')).toThrow()
  })

  it('un id anidado dentro de un arreglo también se conserva', () => {
    // Los pedidos traen renglones; si sólo se cuidara el nivel de arriba, el id de cada
    // producto se rompería igual y nadie lo notaría hasta conciliar.
    const anidado = `{"items":[{"item_id":${ID_REAL},"qty":2}]}`
    const ok = parseDidiPayload<{ items: Array<{ item_id: string; qty: number }> }>(anidado)

    expect(ok.items[0].item_id).toBe(ID_REAL)
    expect(ok.items[0].qty).toBe(2)
  })
})
