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
  'delivery-channels/core/deliveryOrderIngestion.service.ts':
    'Reparto (Uber/Rappi/DiDi): el pedido lo levanta el cliente en la app del marketplace y esto ' +
    'corre en su webhook, sin cajero; `scheduledFor` permite además pedidos para otro día.',
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
    } else {
      it(`${rel} — estampa el turno`, () => {
        expect(cuerpo).toMatch(/\bshiftId\b/)
      })
    }
  }

  it('el upsert de pos-sync conecta el turno por RELACIÓN, no por campo plano', () => {
    // El `grep` de arriba ya lo incluye, pero sólo comprueba que la palabra `shiftId` aparezca:
    // aquí se fija la FORMA, porque pos-sync es el único que lo ata por relación (SoftRestaurant
    // manda su propio `shiftId`, resuelto por `posSyncShift.service.ts`).
    const fuente = readFileSync(join(raizServicios, 'pos-sync/posSyncOrder.service.ts'), 'utf8')
    expect(fuente).toMatch(/shift:\s*\{\s*connect:\s*\{\s*id:\s*shiftId\s*\}\s*\}/)
  })
})
