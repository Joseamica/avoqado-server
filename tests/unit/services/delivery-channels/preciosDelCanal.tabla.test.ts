/**
 * Tabla exhaustiva de los precios del canal (D1, Codex impl r3: la familia de precios reapareció → pasada exhaustiva).
 *
 * Cada fila: estado guardado × guardado que llega (por el PATCH real: mezcla + normalización, con la fila guardada) × lo que
 * pasa después en el catálogo; y luego se publica con la copia del catálogo de ese momento y el traductor real de Rappi.
 *
 * El invariante: un precio cae sólo en el artículo para el que se eligió; una copia por código nunca decide. Dos excepciones,
 * escritas en el título de su fila:
 *  · «por código, antes de D1»: un canal viejo que nadie ha vuelto a guardar sigue publicando por código (lista y precios pasan
 *    juntos a ids en su primer guardado con precios; antes no hay manera de saber a qué producto se refería un código que cambió
 *    de dueño).
 *  · «llave compartida»: un producto cuyo código es literalmente el `MOD-<id>` de un extra comparte esa llave en el menú del
 *    proveedor (ya era así antes de D1): gana el precio del producto.
 */
import prisma from '@/utils/prismaClient'
import { updateChannelLink } from '@/services/delivery-channels/core/deliveryChannelLink.service'
import { aplicarSeleccion } from '@/services/delivery-channels/core/productosDelCanal'
import type { MenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'
import { construirMenuRappi } from '@/services/delivery-channels/providers/rappi/rappi.menuMapper'

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({ hasAdapter: jest.fn(() => false), adapterFor: jest.fn() }))
jest.mock('@/services/delivery-channels/core/statusDispatcher.service', () => ({ getAdapter: jest.fn() }))

type Id = 'p1' | 'p2'
type Extra = 'm1' | 'm2'
type Estado = keyof typeof ESTADOS
type Pedido = keyof typeof ELECCION
type Evento = keyof typeof CODIGOS

/** Precio de mostrador de cada artículo. Los extras m1 y m2 cuelgan de p2. */
const BASE: Record<Id | Extra, number> = { p1: 50, p2: 40, m1: 5, m2: 3 }

/** El código de cada producto después de cada evento (antes de todos: `A` y `B`). */
const CODIGOS = {
  nada: { p1: 'A', p2: 'B' },
  renombra: { p1: 'Z', p2: 'B' },
  otroTomaElCodigo: { p1: 'Z', p2: 'A' },
  renombraAExtra: { p1: 'MOD-m1', p2: 'B' },
} satisfies Record<string, Record<Id, string>>

const HORARIO = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [
    d,
    { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] },
  ]),
)

/** Lo guardado: el dueño eligió p1 a $79 y el extra m1 a $8 (p2 y m2, a su precio de mostrador). */
const ESTADOS = {
  legado: { productos: ['A', 'B'], precios: { overrides: { A: 79, 'MOD-m1': 8 } } },
  porId: {
    productoIds: ['p1', 'p2'],
    productos: ['A', 'B'],
    precios: { porProducto: { p1: 79 }, porExtra: { m1: 8 }, overrides: { A: 79, 'MOD-m1': 8 } },
  },
}

/** Lo que el dueño eligió después de cada guardado. */
const ELECCION: Record<string, Partial<Record<Id | Extra, number>>> = {
  ninguno: { p1: 79, m1: 8 },
  horario: { p1: 79, m1: 8 },
  panel: { p1: 85, m1: 8 },
  apiVieja: { p1: 85, m1: 9 },
  copiaVieja: { p1: 85, m1: 8 },
  copiaConOtroExtra: { p1: 85, m1: 8 },
}

/** El cuerpo de cada PATCH (con los códigos de antes del evento). `null` = no se guarda nada antes de publicar. */
function pedido(p: Pedido, estado: Estado): Record<string, unknown> | null {
  switch (p) {
    case 'ninguno':
      return null
    case 'horario':
      return { deliveryHours: HORARIO }
    case 'panel':
      // Lo que manda ChannelSettingsDialog: la lista por id sólo si la de al abrir era por código.
      return {
        deliveryHours: HORARIO,
        agotarPorInventario: false,
        precios: { porProducto: { p1: 85 } },
        ...(estado === 'legado' && { productoIds: ['p1', 'p2'] }),
      }
    case 'apiVieja':
      return { precios: { overrides: { A: 85, 'MOD-m1': 9 } } }
    case 'copiaVieja':
      return { precios: { porProducto: { p1: 85 }, overrides: { VIEJO: 1, B: 77, 'MOD-m1': 1, 'MOD-m2': 1 } } }
    case 'copiaConOtroExtra':
      return { precios: { porProducto: { p1: 85 }, overrides: { A: 85, 'MOD-m1': 99 } } }
  }
  throw new Error(p)
}

/** Lo que debe publicarse: precio por código publicado, de productos y de extras. */
function esperado(estado: Estado, p: Pedido, evento: Evento) {
  const codigos: Record<Id, string> = CODIGOS[evento]
  const porCodigo = estado === 'legado' && (p === 'ninguno' || p === 'horario')
  // Un guardado que pasa los precios a ids pasa también la lista: sólo el canal viejo sin guardar sigue por código.
  const listaPorId = !porCodigo
  const publicados = (['p1', 'p2'] as const).filter(id => listaPorId || ['A', 'B'].includes(codigos[id]))
  const eleccion = ELECCION[p]
  const precioDe = (id: Id) => (porCodigo ? (codigos[id] === 'A' ? 79 : BASE[id]) : (eleccion[id] ?? BASE[id]))
  const productos: Record<string, number> = Object.fromEntries(publicados.map(id => [codigos[id], precioDe(id)]))
  const extra = (m: Extra) => productos[`MOD-${m}`] ?? (porCodigo ? (m === 'm1' ? 8 : BASE[m]) : (eleccion[m] ?? BASE[m]))
  const notas = [
    porCodigo && publicados.some(id => codigos[id] === 'A' && id !== 'p1') && 'por código, antes de D1',
    'MOD-m1' in productos && 'llave compartida: gana el producto',
  ].filter(Boolean)
  return { productos, extras: { 'MOD-m1': extra('m1'), 'MOD-m2': extra('m2') }, notas }
}

/** La copia del catálogo que arma `buildMenuSnapshot` (con ids). */
function menu(codigos: Record<Id, string>): MenuSnapshot {
  const prod = (id: Id, extras: boolean) => ({
    productId: id,
    plu: codigos[id],
    name: `Producto ${id}`,
    description: null,
    price: BASE[id],
    imageUrl: null,
    modifierGroups: extras
      ? [
          {
            id: 'g1',
            name: 'Extras',
            required: false,
            allowMultiple: true,
            minSelections: 0,
            maxSelections: null,
            modifiers: (['m1', 'm2'] as const).map(m => ({ plu: `MOD-${m}`, name: `Extra ${m}`, price: BASE[m] })),
          },
        ]
      : [],
  })
  return { venueId: 'venue1', generatedAt: 'x', categories: [{ name: 'TODO', products: [prod('p1', false), prod('p2', true)] }] }
}

/** La base de mentira, con los códigos de ANTES del evento (cuando llega el PATCH). */
function base(guardado: unknown) {
  const filas = [
    { id: 'p1', sku: 'A' },
    { id: 'p2', sku: 'B' },
  ]
  ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: guardado }])
  ;(prisma.product.findMany as jest.Mock).mockImplementation(async ({ where, take }: any) =>
    where.venueId !== 'venue1'
      ? []
      : filas.filter(f => where.OR.some((c: any) => c.id?.in.includes(f.id) || c.sku?.in.includes(f.sku))).slice(0, take),
  )
  ;(prisma.modifier.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
    where.group.venueId === 'venue1' ? ['m1', 'm2'].filter(id => where.id.in.includes(id)).map(id => ({ id })) : [],
  )
  ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ id: 'link1' })
}

/** Guarda `cuerpo` sobre `guardado` (si hay) y publica con los códigos de después de `evento`. */
async function publicar(guardado: unknown, cuerpo: Record<string, unknown> | null, evento: Evento) {
  let config: unknown = structuredClone(guardado)
  if (cuerpo) {
    base(config)
    await updateChannelLink('venue1', 'link1', { config: cuerpo as never })
    config = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls.at(-1)![0].data.config
  }
  const { snapshot, precios } = aplicarSeleccion(menu(CODIGOS[evento]), config)
  const { payload } = construirMenuRappi(snapshot, 'store1', { precios })
  return {
    config,
    publicado: {
      productos: Object.fromEntries(payload.items.map(i => [i.sku, i.price])),
      extras: Object.fromEntries(payload.items.flatMap(i => i.children ?? []).map(h => [h.sku, h.price])),
    },
  }
}

const FILAS = (Object.keys(ESTADOS) as Estado[]).flatMap(estado =>
  (Object.keys(ELECCION) as Pedido[]).flatMap(p =>
    (Object.keys(CODIGOS) as Evento[]).map(evento => {
      const e = esperado(estado, p, evento)
      const precios = [...Object.entries(e.productos), ...Object.entries(e.extras).map(([c, v]) => [`↳${c}`, v])]
        .map(([c, v]) => `${c}=${v}`)
        .join(' ')
      const nota = e.notas.length ? ` (${e.notas.join('; ')})` : ''
      return { titulo: `${estado} · ${p} · ${evento} ⇒ ${precios}${nota}`, estado, p, evento, e }
    }),
  ),
)

describe('precios del canal: tabla estado × guardado × evento (el precio cae sólo en su artículo)', () => {
  it.each(FILAS.map(f => [f.titulo, f] as const))('%s', async (_titulo, f) => {
    const { publicado } = await publicar(ESTADOS[f.estado], pedido(f.p, f.estado), f.evento)
    expect(publicado).toEqual({ productos: f.e.productos, extras: f.e.extras })
  })
})

describe('canal viejo con un código muerto en su lista: al pasar sus precios a ids, la lista también (sin el código muerto)', () => {
  const CON_VIEJO = { productos: ['A', 'B', 'VIEJO'], precios: { overrides: { A: 79, 'MOD-m1': 8 } } }

  it.each([
    ['apiVieja · renombra ⇒ Z=85 B=40 ↳MOD-m1=9 ↳MOD-m2=3', 'apiVieja', 'renombra', { Z: 85, B: 40 }, { 'MOD-m1': 9, 'MOD-m2': 3 }],
    [
      'copiaConOtroExtra · otroTomaElCodigo ⇒ Z=85 A=40 ↳MOD-m1=8 ↳MOD-m2=3',
      'copiaConOtroExtra',
      'otroTomaElCodigo',
      { Z: 85, A: 40 },
      { 'MOD-m1': 8, 'MOD-m2': 3 },
    ],
  ] as const)('legadoConViejo · %s', async (_titulo, p, evento, productos, extras) => {
    const { config, publicado } = await publicar(CON_VIEJO, pedido(p, 'legado'), evento)
    expect(config).toEqual(expect.objectContaining({ productoIds: ['p1', 'p2'], productos: ['A', 'B'] }))
    expect(publicado).toEqual({ productos, extras })
  })
})
