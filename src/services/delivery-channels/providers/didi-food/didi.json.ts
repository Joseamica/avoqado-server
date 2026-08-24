/**
 * El ÚNICO parser permitido para cualquier cosa que venga de DiDi Food.
 *
 * 🔴 POR QUÉ EXISTE: DiDi usa enteros de 64 bits para los ids de app, pedidos, tiendas y
 * renglones. `JSON.parse` de Node no los aguanta —los redondea— y no avisa. Su propia
 * documentación trae el caso literal:
 *
 *     order_id 5764607801871631353  →  5764607801871631000
 *
 * Un id corrompido no rompe nada visible: el pedido entra con un folio que no existe, y el
 * callback que llegue después no casa con ninguna venta. Se pierde en silencio, que es la
 * peor forma de perderse — y en un canal de delivery, cada pérdida es un cliente que pagó y
 * un platillo que nadie preparó.
 *
 * Los ids salen como TEXTO a propósito. Un id es un identificador, no un número con el que
 * se hagan cuentas: como texto viaja igual a `Order.externalId` (que ya es string) y se
 * compara sin sorpresas. Un `BigInt` reventaría en el primer `JSON.stringify` del camino.
 *
 * 🔴 REGLA: nada del camino de DiDi llama a `JSON.parse` ni a `JSON.stringify` sobre un
 * payload suyo. Todo pasa por aquí. Hay un test que prueba que `JSON.parse` sí corrompe —
 * está para que nadie "simplifique" esto de vuelta.
 */
import JSONbig from 'json-bigint'

/**
 * `storeAsString` deja los enteros grandes como texto en vez de como objetos BigInt.
 * `useNativeBigInt: false` por lo mismo — el objetivo es que el resto del código no tenga
 * que saber que este parser existe.
 */
const jsonBig = JSONbig({ storeAsString: true, useNativeBigInt: false })

/** Parsea un payload de DiDi conservando los ids de 64 bits. Lanza si el JSON es inválido. */
export function parseDidiPayload<T = unknown>(raw: Buffer | string): T {
  // Acepta Buffer porque así es como llega: los webhooks se montan con `express.raw`
  // (`app.ts`) y el controlador recibe los bytes sin tocar. Si esto sólo tomara string,
  // alguien haría `buf.toString()` y luego `JSON.parse`, que es justo el bug.
  const texto = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
  return jsonBig.parse(texto) as T
}
