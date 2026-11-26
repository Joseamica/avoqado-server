/**
 * hz:960ee149:D1: el orden de los grupos de modificadores de un producto, de punta a punta contra Postgres REAL.
 * Editar guarda el orden recibido (no el de la base), asignar sin orden va al final y un orden explícito se respeta;
 * las lecturas del panel y del POS (`getProduct`, `getProducts`) los devuelven en ese orden. Los casos van en secuencia
 * sobre el mismo producto: cada uno parte de lo que dejó el anterior.
 */
import { assignModifierGroupToProduct } from '@/services/dashboard/menu.dashboard.service'
import { getProduct, getProducts, updateProduct } from '@/services/dashboard/product.dashboard.service'
import prisma from '@/utils/prismaClient'
import { conProducto, limpiarNegocios, nuevoNegocio, type Negocio } from '../fiscal/exclusionContable.fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

jest.setTimeout(120_000)

const SERVICIO = { type: 'SERVICE' as const, servicePrincipalId: 'D1_ORDEN_PRUEBA' }

let x: Negocio
let productId: string
const g: Record<'A' | 'B' | 'C' | 'D' | 'E', string> = { A: '', B: '', C: '', D: '', E: '' }

/** Lo que quedó en la base: id del grupo → su `displayOrder`. */
const enLaBase = async () =>
  Object.fromEntries(
    (await prisma.productModifierGroup.findMany({ where: { productId }, select: { groupId: true, displayOrder: true }, take: 100 })).map(
      u => [u.groupId, u.displayOrder],
    ),
  )
const nombre = (id: string) => Object.entries(g).find(([, v]) => v === id)?.[0]
/** El orden que ven el panel (`getProduct`) y la lista de productos (`getProducts`, la de `GET …/products`). */
const leidos = async () => {
  const uno = (await getProduct(x.venueId, productId)).modifierGroups.map((u: { groupId: string }) => nombre(u.groupId))
  const lista = (await getProducts(x.venueId))
    .find(p => p.id === productId)!
    .modifierGroups.map((u: { groupId: string }) => nombre(u.groupId))
  expect(lista).toEqual(uno)
  return uno
}

beforeAll(async () => {
  x = await nuevoNegocio({ contabilidad: false })
  productId = (await conProducto(x)).productId
  for (const k of ['A', 'B', 'C', 'D', 'E'] as const) {
    g[k] = (await prisma.modifierGroup.create({ data: { venueId: x.venueId, name: `Grupo ${k}` } })).id // creados en este orden
  }
})

afterAll(async () => {
  if (!x?.venueId) return
  await limpiarNegocios()
})

describe('Orden de los grupos de modificadores de un producto', () => {
  it('editar con [C, A, B] guarda C=0, A=1, B=2 y así se lee', async () => {
    await updateProduct(x.venueId, productId, { modifierGroupIds: [g.C, g.A, g.B] }, SERVICIO)

    expect(await enLaBase()).toEqual({ [g.C]: 0, [g.A]: 1, [g.B]: 2 })
    expect(await leidos()).toEqual(['C', 'A', 'B'])
  })

  it('editar otra vez con [B, C, A] da B, C, A (no depende del orden físico de las filas)', async () => {
    await updateProduct(x.venueId, productId, { modifierGroupIds: [g.B, g.C, g.A] }, SERVICIO)

    expect(await enLaBase()).toEqual({ [g.B]: 0, [g.C]: 1, [g.A]: 2 })
    expect(await leidos()).toEqual(['B', 'C', 'A'])
  })

  it('asignar D desde el menú sin orden lo pone al final (3)', async () => {
    await assignModifierGroupToProduct(x.venueId, productId, { modifierGroupId: g.D })

    expect((await enLaBase())[g.D]).toBe(3)
    expect(await leidos()).toEqual(['B', 'C', 'A', 'D'])
  })

  it('asignar con displayOrder: 0 explícito guarda 0', async () => {
    await assignModifierGroupToProduct(x.venueId, productId, { modifierGroupId: g.E, displayOrder: 0 })

    expect(await enLaBase()).toEqual({ [g.B]: 0, [g.C]: 1, [g.A]: 2, [g.D]: 3, [g.E]: 0 })
  })
})
