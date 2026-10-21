/**
 * IVA por producto, bloque B4b (Codex B4b r1 P2 #7; r2 N6, N7; r3 R3-4; r4 R4-4; r5 R5-1, R5-2, R5-3, R5-5): los libros de un lote
 * de órdenes, dentro de la transacción del reporte, con topes por orden, sub-lotes con tope de filas y páginas, con el negocio en
 * cada lectura y sólo con lecturas que el freno del MCP reconoce. Recibe la transacción: sólo puede leer con ella.
 */
import { Prisma } from '@prisma/client'
import type { ParteDelLibro } from '../../../../src/services/fiscal/libroDeLaOrden'
import {
  PAGINA_DE_LIBROS,
  REPARTO_FISCAL,
  TOPES_POR_ORDEN,
  TOPE_DE_BYTES_POR_LOTE,
  TOPE_DE_FILAS_POR_LOTE,
  recorrerLibros,
  type MovimientoLeido,
} from '../../../../src/services/fiscal/librosDeOrdenes'
import { isReadOperation } from '../../../../src/utils/requestCancellation'

// Sin `$executeRaw` (Codex r5 R5-3) ni `orderDiscount` (fallo 1 de la ronda 7: los descuentos van por `sqlDeLosDescuentos`): si
// el cargador los llamara, la prueba truena.
const tx = {
  $queryRaw: jest.fn(),
  order: { findMany: jest.fn() },
  orderItem: { findMany: jest.fn() },
  payment: { findMany: jest.fn() },
}
const HASTA = new Date('2026-06-30T23:59:59.999Z')
const T = new Date('2026-06-15T18:00:00.000Z')
const ORDEN = { id: 'o1', orderNumber: 'F-1', discountAmount: 0, contratoDePrecio: 'IVA_INCLUIDO', originSystem: 'AVOQADO' }
const CAFE = {
  id: 'oi-cafe',
  orderId: 'o1',
  quantity: 1,
  unitPrice: 116,
  total: 116,
  discountAmount: 0,
  orderPromotionId: null,
  isCortesia: false,
  ivaTratamiento: null,
  product: { taxRate: 0.16, ivaTratamiento: 'IVA_16' },
}
const GRANO = { ...CAFE, id: 'oi-grano', unitPrice: 100, total: 100, product: { taxRate: 0, ivaTratamiento: 'IVA_0' } }
const cobro = (id: string, amount: number, o: Record<string, unknown> = {}) => ({
  id,
  orderId: 'o1',
  createdAt: T,
  type: 'REGULAR',
  amount,
  tipAmount: 0,
  method: 'CREDIT_CARD',
  merchantAccount: null,
  ecommerceMerchant: null,
  ...o,
})
const vistos = () => {
  const lista: Array<[MovimientoLeido, ParteDelLibro]> = []
  return { lista, alMovimiento: (m: MovimientoLeido, x: ParteDelLibro) => void lista.push([m, x]) }
}
const pedir = (orderIds: string[], alMovimiento: (m: MovimientoLeido, x: ParteDelLibro) => void = jest.fn()) =>
  recorrerLibros(tx as unknown as Prisma.TransactionClient, { venueId: 'v1', orderIds, hasta: HASTA }, alMovimiento)
type Llave = keyof typeof TOPES_POR_ORDEN
/** Lo que contesta `sqlDelConteo` de una orden (todo en cero salvo lo que se diga). */
const conteo = (orderId: string, o: Partial<Record<Llave, number>> = {}) => ({
  orderId,
  folio: orderId.replace('o', 'F-'), // o1 ⇒ F-1, como el orderNumber de ORDEN
  renglones: 0,
  descuentos: 0,
  destinos: 0,
  movimientos: 0,
  articulos: 0,
  articulosPorDevolucion: 0,
  bytesDelCongelado: 0,
  bytesDeRepartos: 0,
  ...o,
})
/** El `$queryRaw` del cargador: el conteo, los descuentos o los campos de las devoluciones, según el SQL. */
let conteos: ReturnType<typeof conteo>[] = []
let devoluciones: Array<Record<string, unknown>> = []
let descuentos: Array<Record<string, unknown>> = []
// El conteo también lleva `jsonb_array_elements` (dentro de REPARTO_FISCAL): se distinguen por lo que sólo tiene cada uno.
const esDevoluciones = (s: Prisma.Sql) => s.sql.includes('WITH ORDINALITY')
const esDescuentos = (s: Prisma.Sql) => s.sql.includes('AS reparto')
const crudas = (que: (s: Prisma.Sql) => boolean) => tx.$queryRaw.mock.calls.map(c => c[0] as Prisma.Sql).filter(que)

beforeEach(() => {
  jest.clearAllMocks()
  conteos = [conteo('o1', { renglones: 2, movimientos: 1 })]
  devoluciones = []
  descuentos = []
  tx.order.findMany.mockResolvedValue([ORDEN])
  tx.$queryRaw.mockImplementation(async (s: Prisma.Sql) => (esDevoluciones(s) ? devoluciones : esDescuentos(s) ? descuentos : conteos))
  tx.orderItem.findMany.mockResolvedValue([CAFE, GRANO])
  tx.payment.findMany.mockResolvedValue([])
})

it('sin órdenes no consulta nada', async () => {
  expect(await pedir([])).toEqual({ consultas: 0, filas: 0 })
  expect(tx.order.findMany).not.toHaveBeenCalled()
})

it('🔴 Codex r2 N7, r5 R5-2 · cada lectura lleva el negocio; los cobros, hasta el cierre; las fechas crudas, con utcTs', async () => {
  // La base sólo devuelve o1: o2 es de otro negocio. Una orden repetida se pide una vez.
  await pedir(['o1', 'o2', 'o1'])
  expect(tx.order.findMany.mock.calls[0][0]).toMatchObject({
    take: 2,
    where: { id: { in: ['o1', 'o2'] }, venueId: 'v1', status: { not: 'CANCELLED' } },
  })
  expect(tx.orderItem.findMany.mock.calls[0][0]).toMatchObject({
    take: PAGINA_DE_LIBROS,
    orderBy: { id: 'asc' },
    where: { orderId: { in: ['o1'] } },
  })
  expect(tx.payment.findMany.mock.calls[0][0]).toMatchObject({
    take: PAGINA_DE_LIBROS,
    where: { orderId: { in: ['o1'] }, venueId: 'v1', status: 'COMPLETED', createdAt: { lte: HASTA } },
  })
  const s = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
  expect(s.sql).toContain('p."venueId" = ?')
  expect(s.sql).toContain('o."venueId" = ?')
  expect(s.sql).toContain(`AT TIME ZONE 'UTC'`) // R5-2: la fecha del cierre, por utcTs
  expect(s.values).toEqual(expect.arrayContaining(['v1', HASTA]))
  // Los descuentos, sólo de las órdenes ya autorizadas del lote (T8-A: en una consulta por sub-lote, sin llave ni página).
  expect(crudas(esDescuentos)[0].values).toEqual(['o1'])
})

it('🔴 T8-A · los descuentos de un sub-lote salen en UNA consulta sin LIMIT ni llave `d.id >`, ordenados por (orderId, id) y sólo de sus órdenes', async () => {
  // La medición de la Tarea 8: con la llave `d.id > $x ORDER BY d.id LIMIT $n`, el plan GENÉRICO de la sentencia preparada recorría
  // `OrderDiscount_pkey` filtrando por orderId (la tabla ENTERA, de todos los negocios) en cada lote. El conteo ya acota el sub-lote.
  tx.order.findMany.mockResolvedValue([ORDEN, { ...ORDEN, id: 'o2', orderNumber: 'F-2' }])
  conteos = [conteo('o1', { renglones: 2, descuentos: 1 }), conteo('o2', { renglones: 1, descuentos: 1 })]
  await pedir(['o1', 'o2'])
  const ds = crudas(esDescuentos)
  expect(ds).toHaveLength(1)
  expect(ds[0].sql).not.toMatch(/\bLIMIT\b/i)
  expect(ds[0].sql).not.toMatch(/d\.id\s*>/)
  expect(ds[0].sql).toMatch(/ORDER BY d\."orderId", d\.id\s*$/)
  expect(ds[0].sql).toMatch(/WHERE d\."orderId" IN \(\?,\s*\?\)/)
  expect(ds[0].values).toEqual(['o1', 'o2'])
  expect(isReadOperation('$queryRaw', ds[0])).toBe(true) // sigue siendo lectura para el freno del MCP
})

it('🔴 T8-A · un sub-lote con más de PAGINA_DE_LIBROS descuentos se lee entero en una sola consulta: lo acota el conteo, no una página', async () => {
  const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']
  tx.order.findMany.mockResolvedValue(ids.map(id => ({ ...ORDEN, id, orderNumber: id })))
  // 6 × 200 = 1,200 filas de descuento (el tope por orden), un solo sub-lote de 1,206 filas ≤ TOPE_DE_FILAS_POR_LOTE.
  conteos = ids.map(id => conteo(id, { renglones: 1, descuentos: TOPES_POR_ORDEN.descuentos }))
  tx.orderItem.findMany.mockResolvedValue([])
  const todos = ids.flatMap(orderId =>
    Array.from({ length: TOPES_POR_ORDEN.descuentos }, (_, i) => ({
      id: `d-${orderId}-${String(i).padStart(3, '0')}`,
      orderId,
      amount: 0,
      reparto: null,
    })),
  )
  let lecturas = 0
  tx.$queryRaw.mockImplementation(async (s: Prisma.Sql) => {
    if (esDevoluciones(s)) return devoluciones
    if (!esDescuentos(s)) return conteos
    lecturas += 1
    return lecturas === 1 ? todos : [] // una segunda consulta ya no traería nada nuevo
  })
  const leido = await pedir(ids)
  expect(todos.length).toBeGreaterThan(PAGINA_DE_LIBROS)
  expect(crudas(esDescuentos)).toHaveLength(1)
  // La orden, el conteo, una página de renglones, UNA de descuentos y una de movimientos.
  expect(leido).toEqual({ consultas: 5, filas: ids.length + ids.length + 0 + todos.length + 0 })
})

it('🔴 Codex r2 N6 · los movimientos pasan por páginas por UN solo libro por orden (la historia no se recarga ni se acumula)', async () => {
  // Página 1: la venta y 999 movimientos en cero. Página 2: la devolución del grano por artículo. Con el mismo libro, H20 baja sólo
  // el 0 %; con un libro nuevo por página no habría saldo y saldría repartida entre las dos tasas.
  conteos = [conteo('o1', { renglones: 2, movimientos: PAGINA_DE_LIBROS + 1, articulos: 1, articulosPorDevolucion: 1 })]
  const primera = [
    cobro('p0000', 216),
    ...Array.from({ length: PAGINA_DE_LIBROS - 1 }, (_, i) => cobro(`p${String(i + 1).padStart(4, '0')}`, 0)),
  ]
  tx.payment.findMany
    .mockResolvedValueOnce(primera) // página 1 (sin devoluciones: no pide sus campos)
    .mockResolvedValueOnce([cobro('r1', -100, { type: 'REFUND', createdAt: new Date(T.getTime() + 60_000) })]) // página 2
  devoluciones = [
    {
      id: 'r1',
      provenance: 'MANUAL',
      originalMethod: null,
      fiscalByRateCents: null,
      refundedItems: [{ orderItemId: 'oi-grano', quantity: 1, amountCents: 10000, amount: null }],
    },
  ]
  const v = vistos()
  await pedir(['o1'], v.alMovimiento)
  expect(v.lista).toHaveLength(PAGINA_DE_LIBROS + 1)
  expect(v.lista.at(-1)![1]).toMatchObject({ porTratamiento: { IVA_0: { baseCents: -10000, ivaCents: 0 } }, aproximada: false })
  expect(tx.payment.findMany.mock.calls[1][0]).toMatchObject({
    take: PAGINA_DE_LIBROS,
    orderBy: [{ orderId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    cursor: { id: `p${String(PAGINA_DE_LIBROS - 1).padStart(4, '0')}` },
    skip: 1,
  })
  // Los campos de las devoluciones, sólo de las de ESA página y del negocio.
  const campos = crudas(esDevoluciones)
  expect(campos).toHaveLength(1)
  expect(campos[0].values).toEqual(['r1', 'v1'])
})

it('🔴 Codex r5 R5-5 · de una devolución sólo se leen cuatro campos por rutas de jsonb: el processorData entero nunca sale de la base', async () => {
  tx.payment.findMany.mockResolvedValueOnce([cobro('p1', 216), cobro('r1', -100, { type: 'REFUND' })])
  devoluciones = [{ id: 'r1', provenance: 'MANUAL', originalMethod: null, fiscalByRateCents: null, refundedItems: null }]
  await pedir(['o1'])
  const s = crudas(esDevoluciones)[0]
  expect(s.sql.match(/"processorData"(?!\s*->)/g)).toBeNull() // cada mención del JSON lleva una ruta
  for (const campo of [
    'provenance',
    'originalMethod',
    'fiscalByRateCents',
    'refundedItems',
    'orderItemId',
    'quantity',
    'amountCents',
    'amount',
  ]) {
    expect(s.sql).toContain(`'${campo}'`)
  }
  expect(s.sql).toContain('WITH ORDINALITY') // el orden de los artículos se conserva: el escalado de repartirProporcional depende de él
})

it('🔴 Codex r5 R5-3 · todo lo que el cargador manda en crudo es lectura para el freno del MCP', async () => {
  tx.payment.findMany.mockResolvedValueOnce([cobro('p1', 216), cobro('r1', -100, { type: 'REFUND' })])
  devoluciones = [{ id: 'r1', provenance: 'MANUAL', originalMethod: null, fiscalByRateCents: null, refundedItems: null }]
  await pedir(['o1'])
  expect(tx.$queryRaw).toHaveBeenCalledTimes(3) // el conteo, los descuentos y las devoluciones
  for (const [s] of tx.$queryRaw.mock.calls) expect(isReadOperation('$queryRaw', s)).toBe(true)
})

it('🔴 fallo 1 de la ronda 7 · el reparto sale PROYECTADO por la base: el ámbito y las llaves ajenas nunca llegan a Node', async () => {
  await pedir(['o1'])
  const s = crudas(esDescuentos)[0]
  expect(s.sql).toContain(REPARTO_FISCAL.sql) // la misma proyección que cuenta los bytes en el conteo
  expect(s.sql).toContain(`AS reparto`)
  expect(s.sql).not.toMatch(/SELECT[^]*\bd\.reparto\s*(,|AS|FROM)/) // nunca la columna entera
  expect(crudas(c => c.sql.includes('"bytesDeRepartos"'))[0].sql).toContain(REPARTO_FISCAL.sql)
})

it('🔴 fallo 1 de la ronda 7 · los sub-lotes también se cierran por bytes de repartos: nunca más de TOPE_DE_BYTES_POR_LOTE', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `o${i + 1}`)
  tx.order.findMany.mockResolvedValue(ids.map(id => ({ ...ORDEN, id })))
  conteos = ids.map(id => conteo(id, { renglones: 1, bytesDeRepartos: TOPES_POR_ORDEN.bytesDeRepartos }))
  tx.orderItem.findMany.mockResolvedValue([])
  await pedir(ids)
  // 16 × 256 KiB = 4 MiB justos; la 17ª abre otro sub-lote.
  expect(tx.orderItem.findMany.mock.calls.map(c => c[0].where.orderId.in.length)).toEqual([16, 4])
  expect(TOPES_POR_ORDEN.bytesDeRepartos).toBeLessThanOrEqual(TOPE_DE_BYTES_POR_LOTE)
})

it('🔴 fallo 1 de la ronda 6 · los topes suman menos que un sub-lote: toda orden permitida cabe sola, completa', () => {
  const { renglones, descuentos, destinos, movimientos, articulos } = TOPES_POR_ORDEN
  expect(renglones + descuentos + destinos + movimientos + articulos).toBeLessThanOrEqual(TOPE_DE_FILAS_POR_LOTE)
  // Medido en producción el 5-oct: 62 renglones, 2 descuentos, 1 devolución, 2 artículos por devolución. Margen de más de 30 veces.
  expect(TOPES_POR_ORDEN).toMatchObject({ renglones: 2_000, descuentos: 200, movimientos: 2_000, articulosPorDevolucion: 500 })
})

it.each(Object.keys(TOPES_POR_ORDEN) as Llave[])(
  '🔴 fallo 1 de la ronda 6 · una orden que pasa el tope de %s detiene el reporte con su folio, antes de cargarla',
  async llave => {
    tx.order.findMany.mockResolvedValue([ORDEN, { ...ORDEN, id: 'o2', orderNumber: 'F-2' }])
    conteos = [conteo('o1', { renglones: 2 }), conteo('o2', { [llave]: TOPES_POR_ORDEN[llave] + 1 })]
    const e = await pedir(['o1', 'o2']).catch(x => x)
    expect(e).toMatchObject({
      statusCode: 422,
      code: 'REPORT_TOO_LARGE',
      details: { motivo: 'ORDEN', orderId: 'o2', folio: 'F-2', excede: [llave] },
    })
    expect(e.message).toContain('F-2')
    expect(tx.orderItem.findMany).not.toHaveBeenCalled() // nada se carga ni se aproxima
    expect(tx.payment.findMany).not.toHaveBeenCalled()
  },
)

it('control · justo en el tope se calcula', async () => {
  conteos = [conteo('o1', { renglones: TOPES_POR_ORDEN.renglones, movimientos: 1 })]
  await expect(pedir(['o1'])).resolves.toEqual(expect.objectContaining({ consultas: expect.any(Number) }))
})

it('🔴 Codex r5 R5-1 · la orden más grande que se permite se compone ENTERA: su descuento dirigido se lee y el IVA conocido no se pierde', async () => {
  // El escenario de Codex: café $116 al 16 %, grano $100 al 0 % con $100 de descuento dirigido y guardado, cobro $116, más renglones
  // de importe cero hasta llegar al tope. En la v5 entraba en modo resumen: base $107.41 e IVA $8.59. Bien: base $100 e IVA $16.
  const ceros = Array.from({ length: TOPES_POR_ORDEN.renglones - 2 }, (_, i) => ({
    ...CAFE,
    id: `oi-0-${String(i).padStart(5, '0')}`,
    unitPrice: 0,
    total: 0,
  }))
  const renglones = [CAFE, { ...GRANO, discountAmount: 0 }, ...ceros]
  conteos = [conteo('o1', { renglones: renglones.length, descuentos: 1, destinos: 1, movimientos: 1, bytesDeRepartos: 89 })]
  tx.order.findMany.mockResolvedValue([{ ...ORDEN, discountAmount: 100 }])
  // Dos páginas llenas de 1000 y una vacía que cierra la lectura.
  tx.orderItem.findMany
    .mockResolvedValueOnce(renglones.slice(0, PAGINA_DE_LIBROS))
    .mockResolvedValueOnce(renglones.slice(PAGINA_DE_LIBROS))
    .mockResolvedValueOnce([])
  descuentos = [
    {
      id: 'd1',
      orderId: 'o1',
      amount: 100,
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { 'oi-grano': 10000 } },
    },
  ]
  tx.payment.findMany.mockResolvedValueOnce([cobro('p1', 116)])
  const v = vistos()
  await pedir(['o1'], v.alMovimiento)
  expect(crudas(esDescuentos)).toHaveLength(1)
  expect(v.lista[0][1]).toMatchObject({ porTratamiento: { IVA_16: { baseCents: 10000, ivaCents: 1600 } }, aproximada: false })
})

it('🔴 Codex r4 R4-4, r5 R5-5 · el conteo de cada orden suma movimientos y artículos, y los sub-lotes nunca pasan de TOPE_DE_FILAS_POR_LOTE', async () => {
  tx.order.findMany.mockResolvedValue(['o1', 'o2', 'o3', 'o4'].map(id => ({ ...ORDEN, id, orderNumber: id })))
  // o1: 12,000 filas (2,000 renglones + 4,000 destinos + 1,000 movimientos + 5,000 artículos) · o2: 9,000 · o3: 9,000 · o4: 1.
  conteos = [
    conteo('o1', { renglones: 2_000, destinos: 4_000, movimientos: 1_000, articulos: 5_000, articulosPorDevolucion: 500 }),
    conteo('o2', { renglones: 2_000, descuentos: 200, destinos: 1_800, articulos: 5_000, articulosPorDevolucion: 50 }),
    conteo('o3', { renglones: 2_000, movimientos: 1_000, articulos: 6_000, articulosPorDevolucion: 6 }),
    conteo('o4', { renglones: 1 }),
  ]
  tx.orderItem.findMany.mockResolvedValue([])
  await pedir(['o1', 'o2', 'o3', 'o4'])
  // La consulta de filas cuenta descuentos, las llaves de reparto.renglones y los artículos de las devoluciones (verificado en una
  // base propia y desechable).
  const s = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
  expect(s.sql).toContain('jsonb_object_keys')
  expect(s.sql).toContain('jsonb_array_length')
  expect(s.sql).toContain('octet_length')
  // Sub-lotes de ≤ 20,000: [o1] (12,000; o2 ya no cabe), [o2, o3, o4] (18,001).
  expect(tx.orderItem.findMany.mock.calls.map(c => c[0].where.orderId.in)).toEqual([['o1'], ['o2', 'o3', 'o4']])
  expect(tx.payment.findMany.mock.calls.map(c => c[0].where.orderId.in)).toEqual([['o1'], ['o2', 'o3', 'o4']])
})

it('el movimiento sale con todo lo que el estado de resultados suma, de la misma lectura; los de prueba no salen; la lectura se mide', async () => {
  tx.payment.findMany.mockResolvedValueOnce([
    cobro('t1', 99, { type: 'TEST' }),
    cobro('p1', 216, { tipAmount: 10, method: 'CASH', merchantAccount: { fiscalConfig: { includeInAccounting: false } } }),
  ])
  const v = vistos()
  const leido = await pedir(['o1'], v.alMovimiento)
  expect(v.lista.map(([m]) => m)).toEqual([
    {
      id: 'p1',
      orderId: 'o1',
      createdAt: T,
      type: 'REGULAR',
      amountCents: 21600,
      tipCents: 1000,
      method: 'CASH',
      processorData: undefined,
      incluirEnContabilidad: false,
    },
  ])
  expect(v.lista[0][1].taxCents).toBe(1600)
  // La orden, su conteo, una página de renglones, una de descuentos (proyectados) y una de movimientos (sin devoluciones): 5 consultas.
  // Filas: 1 orden + 1 conteo + 2 renglones + 0 descuentos + 2 movimientos = 6.
  expect(leido).toEqual({ consultas: 5, filas: 6 })
})

// ─── Ajustes del controlador (6-oct): los bordes de la composición (menor M6 de la Tarea 2) y las precondiciones del libro (revisión
//     de la Tarea 3) que el cargador garantiza ───
describe('lo que el cargador le da a la composición y al libro', () => {
  it('🔴 menor M6 · los renglones se piden con id, total, orderPromotionId e isCortesia, y la orden con todo lo de su cuenta', async () => {
    await pedir(['o1'])
    expect(tx.orderItem.findMany.mock.calls[0][0].select).toMatchObject({
      id: true,
      orderId: true,
      quantity: true,
      unitPrice: true,
      total: true,
      discountAmount: true,
      orderPromotionId: true,
      isCortesia: true,
      ivaTratamiento: true,
      product: { select: { taxRate: true, ivaTratamiento: true } },
    })
    expect(tx.order.findMany.mock.calls[0][0].select).toMatchObject({
      id: true,
      discountAmount: true,
      contratoDePrecio: true,
      originSystem: true,
    })
  })

  it('🔴 menor M6 · el total del renglón llega a la composición: el grano de $50 con $50 de extra pesa $100 (IVA 1600 sobre $216)', async () => {
    tx.orderItem.findMany.mockResolvedValue([CAFE, { ...GRANO, unitPrice: 50, total: 100 }])
    tx.payment.findMany.mockResolvedValueOnce([cobro('p1', 216)])
    const v = vistos()
    await pedir(['o1'], v.alMovimiento)
    expect(v.lista[0][1]).toMatchObject({
      taxCents: 1600,
      porTratamiento: { IVA_16: { baseCents: 10000, ivaCents: 1600 }, IVA_0: { baseCents: 10000, ivaCents: 0 } },
    })
  })

  it('🔴 menor M6 · la cuenta llega a la composición: $30 de cabecera sin reparto, con dos IVA, vuelve aproximada la venta', async () => {
    // Sin la cuenta, `mezclaDeLaOrden(items)` diría `aproximada: false` aunque la orden tenga descuento de cabecera.
    tx.order.findMany.mockResolvedValue([{ ...ORDEN, discountAmount: 30 }])
    conteos = [conteo('o1', { renglones: 2, descuentos: 1, movimientos: 1 })]
    descuentos = [{ id: 'd1', orderId: 'o1', amount: 30, reparto: null }]
    tx.payment.findMany.mockResolvedValueOnce([cobro('p1', 186)])
    const v = vistos()
    await pedir(['o1'], v.alMovimiento)
    expect(v.lista[0][1]).toMatchObject({ aproximada: true })
  })

  it('🔴 precondición del libro (revisión T3) · un monto con fracción de centavo llega como ENTERO de centavos y el libro no lanza', async () => {
    // −12.345 ⇒ centavos() = Math.round(−1234.5) = −1234 (el .5 va hacia +∞, como en todo el servidor). Un monto fraccionario haría que
    // `repartirConTopes` lanzara RangeError en la devolución por importe de una orden con dos IVA.
    tx.payment.findMany.mockResolvedValueOnce([
      cobro('p1', 216),
      cobro('r1', -12.345, { type: 'REFUND', createdAt: new Date(T.getTime() + 60_000) }),
    ])
    devoluciones = [{ id: 'r1', provenance: 'MANUAL', originalMethod: null, fiscalByRateCents: null, refundedItems: null }]
    const v = vistos()
    await expect(pedir(['o1'], v.alMovimiento)).resolves.toBeDefined()
    expect(v.lista.map(([m]) => m.amountCents)).toEqual([21600, -1234])
    for (const [m, parte] of v.lista) {
      expect(Number.isInteger(m.amountCents)).toBe(true)
      expect(parte.netCents + parte.taxCents).toBe(m.amountCents)
    }
  })

  it('🔴 precondición del libro (revisión T3) · los movimientos se piden en orden (orderId, createdAt, id) desde la PRIMERA página', async () => {
    await pedir(['o1'])
    expect(tx.payment.findMany.mock.calls[0][0]).toMatchObject({ orderBy: [{ orderId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
    expect(tx.payment.findMany.mock.calls[0][0]).not.toHaveProperty('cursor')
  })
})
