import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Toda orden nueva decide, EXPLÍCITAMENTE, si cae en el turno de caja del negocio.
 *
 * 🔴 El defecto que lo motiva (medido el 3-sep-2026): desde la fase 1 del turno del negocio,
 * `getActiveShifts` (`dashboard/shared-query.service.ts`) cuenta las órdenes de un turno
 * agrupando por `Order.shiftId` — y de los 22 sitios que crean órdenes en `src/services/`,
 * **UNO SOLO** lo escribía (`recordFastPayment`, arreglado el 2-sep) más el upsert de pos-sync.
 * Consecuencia: un turno enseñaba el dinero correcto y «0 órdenes» en TODOS los venues, no sólo
 * en las ventas rápidas.
 *
 * Esta prueba es un TRIPWIRE contra el hueco que reabre el defecto: **un sitio de creación
 * NUEVO que nadie clasificó**. No demuestra que la clasificación sea la correcta —eso lo fijan
 * las pruebas de comportamiento de cada servicio—; demuestra que alguien la tomó a conciencia.
 *
 * Sus límites, escritos para que nadie lea un verde de aquí como «ya no puede pasar»:
 *
 *   1. **Es textual.** Busca `shiftId` dentro del `order.create({…})`. Un sitio que lo estampe
 *      pasando un objeto armado en otra parte (`data: datosDeLaOrden`) contaría como NO estampa
 *      y habría que anotarlo a mano en la lista de abajo.
 *   2. **No juzga el VALOR.** `shiftId: null` literal pasaría como «estampa». La corrección del
 *      valor la fijan las pruebas por servicio.
 *   3. **Sólo mira `src/services/`.** Una orden creada desde un job o un controlador se le
 *      escapa (hoy no existe ninguna: la búsqueda de abajo es la evidencia de eso).
 */

const raizServicios = join(__dirname, '../../../../src/services')

/**
 * Sitios que a propósito NO estampan el turno, con el porqué. La razón vive aquí Y en el propio
 * código: quien venga a «arreglar» uno tiene que borrar su renglón, y eso obliga a leerla.
 *
 * 🔴 El criterio, y es lo único que hay que recordar: **estampa el que nace en el mostrador,
 * con el cajero enfrente; no estampa el que puede nacer otro día o desde el teléfono de un
 * cliente.** Un `shiftId` nulo sólo deja la orden fuera de un conteo; uno equivocado mete
 * dinero ajeno en el corte que una persona firma.
 */
const SIN_TURNO_A_PROPOSITO: Record<string, string> = {
  'dashboard/paymentLink.service.ts':
    'Ligas de pago: paga el cliente desde su teléfono y esto corre en el webhook del procesador. ' +
    'El turno del dinero vive en `Payment.shiftId`, que sí lo resuelve el camino del cobro.',
  'dashboard/venueCheckout.service.ts': 'Checkout en línea (source WEB): webhook de Stripe, sin cajero ni cajón de por medio.',
  'dashboard/manualSale.service.ts':
    'Carga masiva de ventas PASADAS desde el Excel del cliente (`createdAt: soldAt`, de otros ' +
    'días y de otra tienda). Atarlas al turno de hoy metería ventas ajenas en el corte de alguien.',
  'onboarding/demoSeed.service.ts': 'Órdenes de DEMO con fecha inventada, repartidas semanas hacia atrás.',
  'demo/negociosDemo.service.ts': 'Negocios demo de ventas: un mes de órdenes con fecha inventada; no son de ningún turno de caja.',
  'delivery-channels/core/deliveryOrderIngestion.service.ts':
    'Reparto (Uber/Rappi/DiDi): el pedido lo levanta el cliente en la app del marketplace y esto ' +
    'corre en su webhook, sin cajero; `scheduledFor` permite además pedidos para otro día.',
  'online-ordering/order.service.ts':
    'Pedidos en línea: el comensal pide desde su teléfono, sin cajero enfrente. El turno del dinero vive en `Payment.shiftId`, ' +
    'que estampa el cobro al recoger (`payCashOrder`).',
}

/** Cada `await <cliente>.order.create(…)` de `src/services/`, con su archivo y su cuerpo. */
function sitiosDeCreacion(): Array<{ rel: string; cuerpo: string }> {
  // `grep -rn` en vez de recorrer el árbol a mano: es la MISMA búsqueda del inventario, así que
  // la prueba y el reporte no pueden divergir.
  // 🔴 `create` Y `upsert`: el 3-sep-2026 el inventario se hizo sólo con `create` y se le
  // escaparon DOS caminos de alta de órdenes — el de pos-sync y el de reparto. Un `upsert` crea
  // órdenes igual que un `create`.
  const salida = execFileSync('grep', ['-rn', '--include=*.ts', String.raw`await \w\+\.order\.\(create\|upsert\)(`, raizServicios], {
    encoding: 'utf8',
  })

  return salida
    .trim()
    .split('\n')
    .map(linea => {
      const [ruta, numero] = linea.split(':')
      const rel = ruta.slice(raizServicios.length + 1)
      const fuente = readFileSync(ruta, 'utf8').split('\n')
      const inicio = Number(numero) - 1

      // Cierre por balance de paréntesis desde `create(`: sin esto, un `create` seguido de otra
      // llamada dentro del mismo archivo se leería como un solo bloque gigante y cualquier
      // `shiftId` posterior (el del `Payment`, por ejemplo) lo daría por estampado — que es
      // exactamente cómo b4bit «parecía» estampar en el inventario del 3-sep.
      let profundidad = 0
      let arrancó = false
      let fin = inicio
      for (let i = inicio; i < fuente.length; i++) {
        for (const car of fuente[i]) {
          if (car === '(') {
            profundidad++
            arrancó = true
          } else if (car === ')') profundidad--
        }
        if (arrancó && profundidad === 0) {
          fin = i
          break
        }
      }
      return { rel, cuerpo: fuente.slice(inicio, fin + 1).join('\n') }
    })
}

describe('toda orden nueva decide explícitamente si cae en el turno de caja', () => {
  const sitios = sitiosDeCreacion()

  it('la búsqueda encuentra sitios (si no, el guard estaría en verde por vacío)', () => {
    // Sin esto, cambiar el patrón de `grep` dejaría la prueba pasando sin revisar NADA — el
    // «verde por lista vacía» que ya mordió en otras suites de este repo.
    expect(sitios.length).toBeGreaterThanOrEqual(20)
  })

  for (const { rel, cuerpo } of sitios) {
    const razon = SIN_TURNO_A_PROPOSITO[rel]

    if (razon) {
      it(`${rel} — NO estampa a propósito: ${razon.slice(0, 60)}…`, () => {
        expect(cuerpo).not.toMatch(/\bshiftId\b/)
        // El porqué tiene que estar también en el código, junto al `create`: la lista de arriba
        // no la lee quien está editando el servicio.
        const fuente = readFileSync(join(raizServicios, rel), 'utf8')
        expect(fuente).toMatch(/NO se estampa `shiftId`, y es DELIBERADO/)
      })
    } else if (rel === 'pos-sync/posSyncOrder.service.ts') {
      it(`${rel} — estampa únicamente el turno que ganó el lock`, () => {
        // En pos-sync, `shiftId` es sólo el candidato observado antes de la transacción.
        // El create debe usar el id que ganó el CAS/lock OPEN dentro de esa transacción.
        expect(cuerpo).toMatch(/\bwritableShiftId\b/)
      })
    } else {
      it(`${rel} — estampa el turno`, () => {
        expect(cuerpo).toMatch(/\bshiftId\b/)
      })
    }
  }

  /**
   * 🔴 «Cobrar sin red» (S5, D4): las puertas por las que sube la cola de la terminal reciben `shiftIdDeLaVenta`, el turno en
   * que se VENDIÓ. La orden que nace ahí cae en el turno vivo SÓLO si es el de la venta; si no, queda sin turno (nunca el
   * nuevo, que es justo el que no la vendió). Cada archivo que lo lee se clasifica aquí con la forma en que su orden lo respeta.
   */
  const RESPETAN_EL_TURNO_DE_LA_VENTA: Record<string, RegExp> = {
    // `createOrderWithItems`: el turno vivo se descarta si el de la venta es OTRO turno real del negocio (Codex servidor r1 #1).
    // S3 «Efectivo sin red en el turno correcto»: la regla vive ahora en `turnoDeLaOrdenQueNace` (paymentShiftClaim.ts), compartida
    // con abrir mesa (`assignTable`), y también la alimenta la caja que capturó el POS (`ventaDeLaColaEnTx`). Cambio de forma A
    // PROPÓSITO, misma regla: la orden sólo cae en el vivo si es el de la venta.
    'mobile/order.mobile.service.ts':
      /const ventaDeLaCola = await ventaDeLaColaEnTx\(tx, venueId, \{\s*shiftIdDeLaVenta: input\.shiftIdDeLaVenta,[\s\S]*?\}\)\n\s*const turnoDeLaOrden = await turnoDeLaOrdenQueNace\(tx, venueId, ventaDeLaCola, turnoVivo\)\n[\s\S]*?await tx\.order\.create\(\{[\s\S]*?shiftId: turnoDeLaOrden\?\.id \?\? null/,
    // `recordFastPayment`: la orden toma el turno que GANÓ el claim, y el claim recibe el de la venta (lo clasifica
    // `paymentShiftClaim.callers.guard.test.ts`). `recordOrderPayment` no crea orden: la suya ya existe.
    'tpv/payment.tpv.service.ts': /const order = await tx\.order\.create\(\{[\s\S]*?shiftId: shiftClaim\?\.shiftId \?\? null/,
    // El claim compara y sólo QUITA: si el de la venta (validado) no es el vivo OPEN, devuelve `shiftId: null` antes de tocar totales.
    // y la orden que nace en el replay (S3): con el turno de la venta que no es el vivo, sin turno (`turnoDeLaOrdenQueNace`). Codex
    // r7 código #1: el turno de una caja ya validada no se pone en duda (si lo borraron a media subida, la orden nace sin turno).
    'shared/paymentShiftClaim.ts':
      /if \(!pedido \|\| pedido === turnoVivo\?\.id\) return turnoVivo\n(?:\s*\/\/[^\n]*\n)*\s*if \(venta\.cajaCapturada\) return null\n\s*return \(await esTurnoDelNegocio\(tx, venueId, pedido\)\) \? null : turnoVivo[\s\S]*if \(turnoDeLaVenta && turnoDeLaVenta !== vivoOpenId\) \{\s*return \{\s*shiftId: null,[\s\S]*?pendingReason: 'SALE_SHIFT_CLOSED'[\s\S]*?\n\s*\}\n\n\s*if \(!candidate\)/,
  }

  it('cada servicio que lee shiftIdDeLaVenta está clasificado, y su orden lo respeta', () => {
    const salida = execFileSync('grep', ['-rl', '--include=*.ts', 'shiftIdDeLaVenta', raizServicios], { encoding: 'utf8' })
    const archivos = salida
      .trim()
      .split('\n')
      .map(ruta => ruta.slice(raizServicios.length + 1))
      .sort()
    expect(archivos).toEqual(Object.keys(RESPETAN_EL_TURNO_DE_LA_VENTA).sort())
    for (const [rel, forma] of Object.entries(RESPETAN_EL_TURNO_DE_LA_VENTA)) {
      expect(readFileSync(join(raizServicios, rel), 'utf8')).toMatch(forma)
    }
  })

  it('el upsert de pos-sync conecta por RELACIÓN sólo el turno que ganó el lock', () => {
    // El `grep` de arriba ya lo incluye, pero sólo comprueba que la palabra `shiftId` aparezca:
    // aquí se fija la FORMA, porque pos-sync es el único que lo ata por relación (SoftRestaurant
    // manda su propio `shiftId`, resuelto por `posSyncShift.service.ts`).
    const fuente = readFileSync(join(raizServicios, 'pos-sync/posSyncOrder.service.ts'), 'utf8')
    expect(fuente).toMatch(/shift:\s*\{\s*connect:\s*\{\s*id:\s*writableShiftId\s*\}\s*\}/)
  })
})
