/**
 * Tarjetas de regalo (R11): toda función que rechaza (o salta) una cuenta IMPORTADA de SoftRestaurant porque reescribe
 * su dinero o sus líneas, rechaza (o salta) también una CUENTA DE TARJETAS. Es el mismo lugar y la misma intención
 * (hechos A § 4.1): una función nueva con `rechazarSiEsImportada` y sin la guardia de tarjetas tumba esta prueba.
 * Más: agregar un artículo serializado, la cocina y las tres cancelaciones de una cuenta sin cobrar.
 *
 * El escáner lee el código VIVO de `src/` (recontado el 14-oct: 25 llamadas en 24 funciones, una de ellas —la unión de
 * cuentas— con dos). Tres redes para que un sitio no se escape en silencio:
 *  1. cada sitio medido sigue apareciendo por su nombre (si una refactorización lo saca del alcance del escáner, truena);
 *  2. toda llamada a la guardia de importadas cae dentro de una función que el escáner reconoce (ninguna queda fuera);
 *  3. cada función encontrada —las medidas y las que aparezcan después— lleva también la guardia de tarjetas.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
/** Funciones de primer nivel: `function`, y también `const nombre = (…) =>` para no pegar una flecha nueva a la anterior. */
const INICIO = /^(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\()/
const IMPORTADA = /rechazarSiEsImportada\(|esOrdenImportada\(/g
const TARJETAS = /rechazarSiEsCuentaDeTarjetas\(|esCuentaDeTarjetas\(|esCuentaDeTarjetasEnTx\(/
const EXCLUIDOS = new Set(['services/shared/ordenImportada.ts', 'services/giftCards/cuentaDeTarjetas.ts'])

/** Recontados contra el código vivo el 14-oct (Tarea A5). */
const SITIOS_MEDIDOS = [
  'services/tpv/discount.tpv.service.ts#applyCouponCode',
  'services/tpv/order.tpv.service.ts#addItemsToOrder',
  'services/tpv/order.tpv.service.ts#removeOrderItem',
  'services/tpv/order.tpv.service.ts#compItems',
  'services/tpv/order.tpv.service.ts#voidItems',
  'services/tpv/order.tpv.service.ts#applyDiscount',
  'services/dashboard/discountEngine.service.ts#applyEvaluatedDiscount',
  'services/dashboard/discountEngine.service.ts#removeDiscountFromOrder',
  'services/dashboard/discountEngine.service.ts#applyAutomaticDiscounts',
  'services/dashboard/discountEngine.service.ts#applyManualDiscount',
  'services/promotions/promotion.service.ts#applyPromotionInTransaction',
  'services/promotions/promotion.service.ts#removePromotionFromOrder',
  'services/mobile/order.mobile.service.ts#applyOrderDiscountInTransaction',
  'services/mobile/order.mobile.service.ts#removeOrderDiscountInTransaction',
  'services/mobile/order.mobile.service.ts#splitOrderItemsInTransaction',
  'services/mobile/order.mobile.service.ts#splitOrderBySeatInTransaction',
  'services/mobile/order.mobile.service.ts#mergeOrdersInTransaction',
  'services/mobile/loyalty.mobile.service.ts#redeemPointsToOrderInTransaction',
  'services/wallet/redeemStampReward.service.ts#redeemStampReward',
  'services/mobile/service-charge.mobile.service.ts#applyServiceChargeInTransaction',
  'services/mobile/service-charge.mobile.service.ts#removeServiceChargeInTransaction',
  'services/mobile/service-charge.mobile.service.ts#syncAutomaticServiceChargesInTransaction',
  'services/mobile/comp-item.mobile.service.ts#compOrderItemInTransaction',
  'services/mobile/comp-item.mobile.service.ts#compWholeOrderInTransaction',
]

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivos(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

const sinComentarios = (lineas: string[]) => lineas.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const llamadasDeImportada = (codigo: string) => (codigo.match(IMPORTADA) ?? []).length

/** Cuerpos de las funciones de primer nivel, sin líneas de comentario. */
function funciones(archivo: string): Map<string, string> {
  const lineas = fs.readFileSync(archivo, 'utf8').split('\n')
  const out = new Map<string, string>()
  let nombre: string | null = null
  let cuerpo: string[] = []
  const cerrar = () => {
    if (nombre) out.set(nombre, sinComentarios(cuerpo))
  }
  for (const linea of lineas) {
    const m = INICIO.exec(linea)
    if (m) {
      cerrar()
      nombre = m[1] ?? m[2]
      cuerpo = []
    }
    if (nombre) cuerpo.push(linea)
  }
  cerrar()
  return out
}

const cuerpoDe = (rel: string, funcion: string) => funciones(path.join(SRC, rel)).get(funcion) ?? ''

describe('cuenta de tarjetas: las guardias acompañan a las de cuentas importadas', () => {
  const sitios: Array<[string, string]> = []
  /** Archivo → [llamadas en todo el archivo, llamadas dentro de funciones reconocidas]. */
  const cobertura: Array<[string, number, number]> = []
  for (const archivo of archivos(SRC)) {
    const rel = path.relative(SRC, archivo).split(path.sep).join('/')
    if (EXCLUIDOS.has(rel)) continue
    const total = llamadasDeImportada(sinComentarios(fs.readFileSync(archivo, 'utf8').split('\n')))
    if (total === 0) continue
    let dentro = 0
    for (const [funcion, cuerpo] of funciones(archivo)) {
      const n = llamadasDeImportada(cuerpo)
      if (n === 0) continue
      dentro += n
      sitios.push([`${rel}#${funcion}`, cuerpo])
    }
    cobertura.push([rel, total, dentro])
  }

  it(`encuentra por su nombre los ${SITIOS_MEDIDOS.length} sitios medidos el 14-oct (si falta uno, el escáner lo perdió)`, () => {
    expect(sitios.map(([s]) => s).sort()).toEqual(expect.arrayContaining(SITIOS_MEDIDOS))
  })

  it('ninguna llamada a la guardia de importadas queda fuera de una función que el escáner reconozca', () => {
    expect(cobertura.filter(([, total, dentro]) => total !== dentro)).toEqual([])
  })

  it.each(sitios.map(([sitio]) => sitio))('%s también rechaza o salta una cuenta de tarjetas', sitio => {
    const cuerpo = sitios.find(([s]) => s === sitio)?.[1] ?? ''
    expect({ sitio, guarda: TARJETAS.test(cuerpo) }).toEqual({ sitio, guarda: true })
  })

  it('agregar un artículo serializado rechaza una cuenta de tarjetas', () => {
    expect(cuerpoDe('services/tpv/order.tpv.service.ts', 'addSerializedItemToOrder')).toContain(
      "rechazarSiEsCuentaDeTarjetas(tx, orderId, 'artículos serializados')",
    )
  })

  it('la cocina no arma renglones de tarjeta (KDS)', () => {
    const cuerpo = cuerpoDe('services/kds/kitchenTicketAuthoring.service.ts', 'authorKitchenTickets')
    expect(cuerpo).toContain('giftCardId: true')
    expect(cuerpo).toContain('!r.giftCardId')
  })

  it.each([
    ['services/mobile/order.mobile.service.ts', 'cancelOrderInTransaction'],
    ['services/dashboard/order.dashboard.service.ts', 'deleteOrder'],
    ['services/dashboard/order.dashboard.service.ts', 'updateOrder'],
  ])('%s#%s desactiva los sobres PENDING de una cuenta cancelada sin cobrar', (rel, funcion) => {
    expect(cuerpoDe(rel, funcion)).toContain('desactivarSobresPendientesDeCuentaEnTx(')
  })
})
