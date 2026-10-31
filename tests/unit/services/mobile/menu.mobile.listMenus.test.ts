import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import { listMenus } from '@/services/mobile/menu.mobile.service'

const V = 'venue-1'
const OTRO_NEGOCIO = 'venue-2'
const TZ = 'America/Mexico_City'
const TODOS_LOS_DIAS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** Un menú tal como está guardado: negocio, si está activo, las dos casillas de «¿Dónde se usa?» (nacen en true), su horario y sus categorías. */
type MenuGuardado = {
  id: string
  venueId: string
  name: string
  description: string | null
  isDefault: boolean
  displayOrder: number
  active: boolean
  appliesToDevices: boolean
  appliesToOnline: boolean
  availableFrom: string | null
  availableUntil: string | null
  availableDays: string[]
  startDate: Date | null
  endDate: Date | null
  categories: Array<{ categoryId: string; displayOrder: number }>
}

type CategoriaGuardada = { id: string; venueId: string; parentId: string | null; active: boolean; displayOrder: number }

const menuGuardado = (id: string, o: Partial<MenuGuardado> = {}): MenuGuardado => ({
  id,
  venueId: V,
  name: id,
  description: null,
  isDefault: false,
  displayOrder: 0,
  active: true,
  appliesToDevices: true,
  appliesToOnline: true,
  availableFrom: null,
  availableUntil: null,
  availableDays: [],
  startDate: null,
  endDate: null,
  categories: [],
  ...o,
})

const categoriaGuardada = (id: string, parentId: string | null = null, o: Partial<CategoriaGuardada> = {}): CategoriaGuardada => ({
  id,
  venueId: V,
  parentId,
  active: true,
  displayOrder: 0,
  ...o,
})

/** Las asignaciones de un menú, en el orden en que se listan (así las devuelve la base, ordenadas por `displayOrder`). */
const asignadas = (...ids: string[]) => ids.map((categoryId, displayOrder) => ({ categoryId, displayOrder }))

type Fila = Record<string, unknown>
type Orden = Record<string, 'asc' | 'desc'>

/** Igualdad por llave. Un operador que el doble no entiende truena en vez de ignorarse: un filtro ignorado volvería verde la prueba. */
function cumple(fila: Fila, where: Fila): boolean {
  return Object.entries(where).every(([campo, valor]) => {
    if (valor !== null && typeof valor === 'object') throw new Error(`El doble de la base no entiende el filtro «${campo}»`)
    return fila[campo] === valor
  })
}

/** El `orderBy` de Prisma (una llave o una lista de llaves) aplicado a las filas, como lo hace Postgres. */
function ordenar<T extends Fila>(filas: T[], orderBy: Orden | Orden[] | undefined): T[] {
  const llaves = ([] as Orden[]).concat(orderBy ?? [])
  return [...filas].sort((x, y) => {
    for (const llave of llaves) {
      const [campo, sentido] = Object.entries(llave)[0]
      const a: any = x[campo]
      const b: any = y[campo]
      if (a === b) continue
      return (a < b ? -1 : 1) * (sentido === 'desc' ? -1 : 1)
    }
    return 0
  })
}

/**
 * La base como la resuelve Postgres: cada consulta se EVALÚA contra estas filas (su `where`, su orden, su `take` y su `select`).
 * Un menú o una categoría que el `where` excluye no llega al servicio; así se prueba lo que la consulta deja fuera y no lo que un
 * `mockResolvedValue` devuelve a ciegas (que pasaría igual con y sin el filtro).
 */
function baseDeDatos(menus: MenuGuardado[], categorias: CategoriaGuardada[]) {
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: TZ })
  prismaMock.menu.findMany.mockImplementation((async (a: any) =>
    ordenar(
      menus.filter(m => cumple(m, a.where)),
      a.orderBy,
    ).map(m => ({ ...m, categories: ordenar(m.categories, a.include.categories.orderBy) }))) as any)
  prismaMock.menuCategory.findMany.mockImplementation((async (a: any) =>
    ordenar(
      categorias.filter(c => cumple(c, a.where)),
      a.orderBy,
    )
      .slice(0, a.take)
      .map(c => Object.fromEntries(Object.keys(a.select).map(campo => [campo, c[campo as keyof CategoriaGuardada]])))) as any)
}

type Respuesta = Awaited<ReturnType<typeof listMenus>>
const idsDe = (r: Respuesta, menuId: string) => {
  const menu = r.menus.find(m => m.id === menuId)
  if (!menu) throw new Error(`El menú ${menuId} no llegó`)
  return menu.categoryIds
}
/** Separa lo directo (que va primero y en su orden) de lo que se sumó (que se compara sin importar el orden). */
const desglosar = (ids: string[], cuantasDirectas: number) => ({
  directas: ids.slice(0, cuantasDirectas),
  agregadas: ids.slice(cuantasDirectas).sort(),
})

/**
 * Bebidas
 *  ├─ Cafés ─ Fríos
 *  ├─ Tés
 *  ├─ Licores            (apagada: no se suma)
 *  └─ Ajena              (de OTRO negocio: nunca entra)
 * Postres ─ Pasteles
 * Vieja                  (apagada, pero un menú la tiene asignada de todos modos)
 * Snacks                 (de nadie)
 */
const CATEGORIAS = [
  categoriaGuardada('bebidas'),
  categoriaGuardada('cafes', 'bebidas'),
  categoriaGuardada('frios', 'cafes'),
  categoriaGuardada('tes', 'bebidas'),
  categoriaGuardada('licores', 'bebidas', { active: false }),
  categoriaGuardada('ajena', 'bebidas', { venueId: OTRO_NEGOCIO }),
  categoriaGuardada('postres'),
  categoriaGuardada('pasteles', 'postres'),
  categoriaGuardada('vieja', null, { active: false }),
  categoriaGuardada('snacks'),
]

/** `n` categorías activas del negocio: `c0` de primer nivel y las demás colgando de ella. */
const muchasCategorias = (n: number) => Array.from({ length: n }, (_, i) => categoriaGuardada(`c${i}`, i === 0 ? null : 'c0'))

describe('listMenus (Mesas)', () => {
  describe('A4: Mesas sólo ofrece los menús «Aparatos»', () => {
    it('listMenus pide sólo menús activos para aparatos', async () => {
      baseDeDatos([], [])

      await listMenus(V)

      expect(prismaMock.menu.findMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.menu.findMany.mock.calls[0][0].where).toEqual({ venueId: V, active: true, appliesToDevices: true })
    })

    it('Mesas no recibe un menú «Sólo tienda en línea», ni uno apagado, ni uno de otro negocio', async () => {
      baseDeDatos(
        [
          menuGuardado('principal', { isDefault: true }),
          menuGuardado('barra', { displayOrder: 1, appliesToOnline: false }), // «Sólo aparatos»: sí
          menuGuardado('delivery', { displayOrder: 2, appliesToDevices: false }), // «Sólo tienda en línea»: no
          menuGuardado('viejo', { displayOrder: 3, active: false }), // apagado: no
          menuGuardado('ajeno', { displayOrder: 4, venueId: OTRO_NEGOCIO }), // de otro negocio: no
        ],
        [],
      )

      const r = await listMenus(V)

      expect(r.menus.map(m => m.id)).toEqual(['principal', 'barra'])
    })

    it('si el menú principal es «Sólo tienda en línea», el activo es otro de aparatos (el POS nunca se queda sin cuadrícula)', async () => {
      baseDeDatos([menuGuardado('tienda', { isDefault: true, appliesToDevices: false }), menuGuardado('barra', { displayOrder: 1 })], [])

      const r = await listMenus(V)

      expect(r.menus.map(m => m.id)).toEqual(['barra'])
      expect(r.activeMenuId).toBe('barra')
    })

    it('sin menus para aparatos regresa menus vacío y activeMenuId null', async () => {
      baseDeDatos([menuGuardado('tienda', { isDefault: true, appliesToDevices: false, categories: asignadas('bebidas') })], CATEGORIAS)

      const r = await listMenus(V)

      expect(r).toEqual({ menus: [], activeMenuId: null, timezone: TZ })
    })
  })

  describe('A4: el menú trae las subcategorías activas de sus categorías', () => {
    it('el menú trae las subcategorías activas de sus categorías', async () => {
      baseDeDatos(
        [
          menuGuardado('principal', { isDefault: true, categories: asignadas('bebidas') }),
          menuGuardado('postres', { displayOrder: 1, categories: asignadas('postres', 'vieja') }),
          menuGuardado('barra', { displayOrder: 2, appliesToOnline: false, categories: asignadas('cafes') }),
          menuGuardado('vacio', { displayOrder: 3 }),
        ],
        CATEGORIAS,
      )

      const r = await listMenus(V)

      // Lo directo va primero y en su orden; luego las subcategorías ACTIVAS (a cualquier profundidad) de las suyas.
      expect(desglosar(idsDe(r, 'principal'), 1)).toEqual({ directas: ['bebidas'], agregadas: ['cafes', 'frios', 'tes'] })
      // La asignación apagada se conserva como hoy (es lo que el dueño asignó); sólo lo que SE SUMA sale de las activas.
      expect(desglosar(idsDe(r, 'postres'), 2)).toEqual({ directas: ['postres', 'vieja'], agregadas: ['pasteles'] })
      // Cada menú recibe lo suyo: «Barra» no hereda lo de «Principal» aunque comparta una rama.
      expect(desglosar(idsDe(r, 'barra'), 1)).toEqual({ directas: ['cafes'], agregadas: ['frios'] })
      expect(idsDe(r, 'vacio')).toEqual([])
      // Nunca se repite un id.
      for (const m of r.menus) expect(new Set(m.categoryIds).size).toBe(m.categoryIds.length)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('lee las categorías activas del negocio UNA vez (no una por menú), con tope + 1 y orden fijo', async () => {
      baseDeDatos(
        [
          menuGuardado('a', { isDefault: true, categories: asignadas('bebidas') }),
          menuGuardado('b', { displayOrder: 1, categories: asignadas('postres') }),
          menuGuardado('c', { displayOrder: 2, categories: asignadas('cafes') }),
        ],
        CATEGORIAS,
      )

      await listMenus(V)

      expect(prismaMock.menuCategory.findMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.menuCategory.findMany).toHaveBeenCalledWith({
        where: { venueId: V, active: true },
        select: { id: true, parentId: true },
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        take: 2001,
      })
    })

    it('topeDeCategoriasPasadoDejaLasDirectas: con más de 2000 categorías activas se queda con las directas, como hoy, y avisa', async () => {
      baseDeDatos([menuGuardado('principal', { isDefault: true, categories: asignadas('c0', 'vieja') })], muchasCategorias(2500))

      const r = await listMenus(V)

      // Sin árbol: lo que el dueño asignó, en su orden, y nada más (aunque c0 tenga 2499 hijas).
      expect(idsDe(r, 'principal')).toEqual(['c0', 'vieja'])
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId: V }))
    })

    it('con 2001 categorías activas (justo una de más) también se queda con las directas y avisa', async () => {
      baseDeDatos([menuGuardado('principal', { isDefault: true, categories: asignadas('c0') })], muchasCategorias(2001))

      const r = await listMenus(V)

      expect(idsDe(r, 'principal')).toEqual(['c0'])
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it('con 2000 categorías activas (justo en el tope) todavía suma las subcategorías y no avisa', async () => {
      baseDeDatos([menuGuardado('principal', { isDefault: true, categories: asignadas('c0') })], muchasCategorias(2000))

      const r = await listMenus(V)

      const ids = idsDe(r, 'principal')
      expect(ids[0]).toBe('c0')
      expect(ids).toHaveLength(2000)
      expect(new Set(ids).size).toBe(2000)
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('regresión: lo que no cambia', () => {
    it('la respuesta conserva su forma (las apps viejas la leen tal cual)', async () => {
      baseDeDatos(
        [
          menuGuardado('barra', {
            isDefault: true,
            name: 'Barra',
            description: 'Tés de la barra',
            availableDays: TODOS_LOS_DIAS, // un menú que aplica cualquier día: así la prueba no depende de la fecha de hoy
            categories: asignadas('tes'), // una hoja: la forma no depende de las subcategorías
          }),
        ],
        CATEGORIAS,
      )

      const r = await listMenus(V)

      expect(r).toEqual({
        menus: [
          {
            id: 'barra',
            name: 'Barra',
            description: 'Tés de la barra',
            isDefault: true,
            availableFrom: null,
            availableUntil: null,
            availableDays: TODOS_LOS_DIAS,
            categoryIds: ['tes'],
            appliesNow: true,
          },
        ],
        activeMenuId: 'barra',
        timezone: TZ,
      })
    })

    it('un venue que no existe sigue siendo NotFoundError, sin leer menús ni categorías', async () => {
      prismaMock.venue.findUnique.mockResolvedValue(null)

      await expect(listMenus('no-existe')).rejects.toThrow(NotFoundError)

      expect(prismaMock.menu.findMany).not.toHaveBeenCalled()
      expect(prismaMock.menuCategory.findMany).not.toHaveBeenCalled()
    })
  })
})
