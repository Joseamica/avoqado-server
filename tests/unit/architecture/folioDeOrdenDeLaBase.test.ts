/**
 * D30 (17-nov-2026): dos cuentas nuevas nunca reciben el mismo folio completo. Antes cada escritor fabricaba
 * `ORD-${Date.now()}`; en el ensayo del 17-nov la SAMSUNG y la D3 abrieron dos mesas en el mismo milisegundo y las dos
 * quedaron `ORD-1794963374538`. Ahora el folio lo pone PostgreSQL (`order_number_next()`, una secuencia compartida por
 * todos los procesos), como valor por defecto de `Order.orderNumber`.
 *
 * Esta prueba falla si (a) alguien vuelve a armar un folio `ORD-<algo>` en `src/` (reloj, contador o al azar), (b) uno de
 * los doce escritores cubiertos vuelve a mandar su propio `orderNumber`, o (c) se pierde el valor por defecto de la base.
 * Fuera a propósito: `ORD-MANUAL-…`, `ORD-EXT-…`, `FAST-…`, `CRYPTO-…` y los folios que entrega un tercero.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const RAIZ = path.join(__dirname, '../../..')

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivosTs(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

const esComentario = (linea: string) => /^\s*(\/\/|\*|\/\*)/.test(linea)
const DECLARACION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/

/** Cuerpo de la función de primer nivel `nombre`: desde su declaración hasta la siguiente de primer nivel. */
function cuerpoDe(rel: string, nombre: string): string {
  const lineas = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n')
  const inicio = lineas.findIndex(l => {
    const m = l.match(DECLARACION)
    return m && (m[1] ?? m[2]) === nombre
  })
  if (inicio < 0) throw new Error(`No encontré ${rel}#${nombre}`)
  let fin = lineas.length
  for (let j = inicio + 1; j < lineas.length; j++) {
    if (DECLARACION.test(lineas[j])) {
      fin = j
      break
    }
  }
  return lineas
    .slice(inicio, fin)
    .filter(l => !esComentario(l))
    .join('\n')
}

/** Texto de cada `.order.create(...)` del cuerpo, hasta que cierran sus paréntesis. */
function creates(cuerpo: string): string[] {
  const out: string[] = []
  const re = /\.order\s*\.\s*create\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cuerpo))) {
    let prof = 0
    let j = m.index + m[0].length - 1
    for (; j < cuerpo.length; j++) {
      if (cuerpo[j] === '(') prof++
      else if (cuerpo[j] === ')' && --prof === 0) break
    }
    out.push(cuerpo.slice(m.index, j + 1))
  }
  return out
}

/** Manda su propio folio: `orderNumber,` o `orderNumber: <valor>` (pedirlo de vuelta con `orderNumber: true` sí se vale). */
const MANDA_FOLIO = /\borderNumber\s*(,|\}|:(?!\s*true\b))/

/** Los nueve escritores que toman el folio por defecto de la base (diseño v3 de D30, más separar artículos y vales V7). */
const POR_DEFECTO = [
  'services/tpv/table.tpv.service.ts#assignTable',
  'services/tpv/table.tpv.service.ts#cuentaAparteParaRondaTardia',
  'services/tpv/order.tpv.service.ts#createOrder',
  'services/tpv/order.tpv.service.ts#createOrderWithItems',
  // Mostrador, Pagar después y pago con saldo de regalo pasan por aquí.
  'services/mobile/order.mobile.service.ts#crearVentaDeMostradorEnTx',
  'services/mobile/estimate.mobile.service.ts#convertToOrder',
  'services/mobile/areaTicket.mobile.service.ts#openAreaTicket',
  'services/giftCards/giftCardOrder.service.ts#createGiftCardOrder',
  'services/exchanges/exchangeTx.ts#createExchangeSaleInTx',
  'services/mobile/order.mobile.service.ts#splitOrderItemsInTransaction',
  'services/mobile/areaTicketV7.mobile.service.ts#materializeAreaTicketCheckout',
]

describe('D30 · el folio de la orden lo pone la base, no el reloj', () => {
  it('nadie arma un folio `ORD-<algo>` en src/ (ni con el reloj ni con un contador propio)', () => {
    const sitios: string[] = []
    for (const archivo of archivosTs(SRC)) {
      const rel = path.relative(SRC, archivo).split(path.sep).join('/')
      fs.readFileSync(archivo, 'utf8')
        .split('\n')
        .forEach((linea, i) => {
          if (esComentario(linea)) return
          if (/`ORD-\$\{/.test(linea) || /['"`]ORD-['"`]\s*\+/.test(linea)) sitios.push(`${rel}:${i + 1}`)
        })
    }
    expect(sitios).toEqual([])
  })

  it.each(POR_DEFECTO)('%s crea su orden sin mandar folio (lo pone la base)', sitio => {
    const [rel, funcion] = sitio.split('#')
    const llamadas = creates(cuerpoDe(rel, funcion))
    expect(llamadas.length).toBeGreaterThan(0)
    expect(llamadas.filter(c => MANDA_FOLIO.test(c))).toEqual([])
  })

  // Auditoría de apps viejas (18-nov): la TPV nombra la foto de verificación con las últimas 8 cifras del folio SIN letras, y
  // `ORD-0000000000001-S2` daba las mismas que la orden 12 (`00000012`). Cada asiento toma su propio folio de la base, sin sufijo.
  it('dividir por asiento crea cada cuenta sin mandar folio: cada asiento toma el suyo de la base, sin `-S<asiento>`', () => {
    const cuerpo = cuerpoDe('services/mobile/order.mobile.service.ts', 'splitOrderBySeatInTransaction')
    const [llamada, ...otras] = creates(cuerpo)
    expect(otras).toEqual([])
    expect(llamada).not.toMatch(MANDA_FOLIO)
    expect(cuerpo).not.toMatch(/-S\$\{seat\}|order_number_next\(\)/)
    expect(cuerpo).not.toMatch(/Math\.random|randomInt|Date\.now/)
  })

  it('Order.orderNumber tiene por defecto el folio de la base', () => {
    const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8')
    const modelo = schema.slice(schema.indexOf('model Order {'), schema.indexOf('\n}', schema.indexOf('model Order {')))
    expect(modelo).toMatch(/^\s*orderNumber\s+String\s+@default\(dbgenerated\("order_number_next\(\)"\)\)/m)
  })

  it('la secuencia no da la vuelta y arranca por encima del mayor folio que ya existe', () => {
    const dir = path.join(RAIZ, 'prisma/migrations')
    const migraciones = fs
      .readdirSync(dir)
      .filter(d => fs.existsSync(path.join(dir, d, 'migration.sql')))
      .map(d => fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8'))
      .filter(sql => sql.includes('CREATE SEQUENCE "order_number_seq"'))
    expect(migraciones).toHaveLength(1)
    const sql = migraciones[0]
    expect(sql).toMatch(/MAXVALUE 999999999999/)
    expect(sql).toMatch(/NO CYCLE/)
    // El arranque se mide dentro de la propia migración, también en folios con sufijo; sin margen, falla.
    expect(sql).toMatch(/setval\('order_number_seq'/)
    expect(sql).toMatch(/RAISE EXCEPTION/)
    // El valor por defecto va al final: la lectura del máximo no retiene el candado fuerte de la tabla.
    expect(sql.lastIndexOf('SET DEFAULT order_number_next()')).toBeGreaterThan(sql.lastIndexOf('setval('))
  })
})
