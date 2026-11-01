/**
 * Menú del aparato (A2) — «¿Dónde se usa?» al crear, editar y clonar un menú.
 *
 * Cada menú lleva dos casillas: `appliesToDevices` («Aparatos») y `appliesToOnline` («Tienda en línea»). Nacen en true y al
 * menos una debe quedar en true. Esa regla es de NEGOCIO: vive en el servicio (400 `MENU_SIN_USO`) porque al editar depende
 * de lo guardado; el esquema (zod) sólo valida la forma. La base la refuerza con un CHECK (migración A1).
 *
 * Se protege:
 *  1. crear: las dos apagadas dan 400; sin mandarlas nacen en true; la que no se manda queda en true (`??`, nunca `||`).
 *  2. editar: se combina lo que llega con lo guardado y sólo se rechaza el par resultante; un PATCH que no menciona las
 *     casillas (p. ej. `{ active: false }`) pasa y ni las toca.
 *  3. la carta en línea vive en una caché de memoria: se limpia SOLO si una casilla cambió de verdad, y después de escribir.
 *  4. clonar copia las dos casillas del original.
 *  5. el esquema deja pasar las dos casillas (si no, `validateRequest` las borra antes de llegar al servicio) y NO decide la
 *     regla de «al menos una».
 */
import { MenuType } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { CreateMenuSchema, UpdateMenuSchema, type CreateMenuDto } from '@/schemas/dashboard/menu.schema'
import { cloneMenu, createMenu, MENU_SIN_USO_MESSAGE, updateMenu } from '@/services/dashboard/menu.dashboard.service'

// El servicio importa los sockets; aquí no se levantan.
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))
// La caché de la carta en línea es un Map en memoria: se espía qué se limpia y cuándo, sin tocar el resto del módulo.
jest.mock('@/services/online-ordering/menu.service', () => ({
  ...jest.requireActual('@/services/online-ordering/menu.service'),
  clearPublicMenuCache: jest.fn(),
}))

const limpiaCache = clearPublicMenuCache as jest.Mock

const VENUE_ID = 'venue-a'
const MENU_ID = 'menu-1'
/** El texto fijo de la regla (igual en ANDROID, iOS y DASHBOARD): se escribe aquí completo para cazar un error de dedo en la constante. */
const TEXTO_FIJO = 'Elige al menos un lugar donde se usa el menú (Aparatos o Tienda en línea). Para no usarlo en ningún lado, apágalo.'

/** Un menú tal como lo devuelve Prisma (las dos casillas existen desde A1). */
const menuGuardado = (o: Record<string, unknown> = {}) => ({
  id: MENU_ID,
  venueId: VENUE_ID,
  name: 'Desayunos',
  description: null,
  type: MenuType.REGULAR,
  displayOrder: 0,
  isDefault: false,
  active: true,
  startDate: null,
  endDate: null,
  availableFrom: null,
  availableUntil: null,
  availableDays: [] as string[],
  appliesToDevices: true,
  appliesToOnline: true,
  isDemo: false,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...o,
})

beforeEach(() => {
  // Sólo lo que este archivo usa; así una respuesta encolada de otra prueba no se cuela.
  prismaMock.menu.findUnique.mockReset()
  prismaMock.menu.findUniqueOrThrow.mockReset()
  prismaMock.menu.findFirst.mockReset()
  prismaMock.menu.create.mockReset()
  prismaMock.menu.update.mockReset()
  prismaMock.menuCategoryAssignment.deleteMany.mockReset()
  prismaMock.menuCategoryAssignment.createMany.mockReset()
  limpiaCache.mockReset()
})

describe('el texto de la regla', () => {
  it('es el texto fijo, igual en ANDROID, iOS y DASHBOARD', () => {
    expect(MENU_SIN_USO_MESSAGE).toBe(TEXTO_FIJO)
  })
})

describe('createMenu — «¿Dónde se usa?»', () => {
  const alta = (o: Partial<CreateMenuDto> = {}): CreateMenuDto => ({ name: 'Desayunos', type: MenuType.REGULAR, ...o })

  beforeEach(() => {
    prismaMock.menu.create.mockResolvedValue(menuGuardado({ id: 'menu-nuevo' }))
  })

  it('crear con las dos apagadas da 400 MENU_SIN_USO', async () => {
    await expect(createMenu(VENUE_ID, alta({ appliesToDevices: false, appliesToOnline: false }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'MENU_SIN_USO',
      message: TEXTO_FIJO,
    })
    expect(prismaMock.menu.create).not.toHaveBeenCalled()
  })

  it('crear sin las casillas las deja en true', async () => {
    await createMenu(VENUE_ID, alta())

    expect(prismaMock.menu.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.menu.create.mock.calls[0][0].data).toMatchObject({ appliesToDevices: true, appliesToOnline: true })
  })

  const unaSola: Array<[string, Partial<CreateMenuDto>, { appliesToDevices: boolean; appliesToOnline: boolean }]> = [
    ['Sólo aparatos', { appliesToOnline: false }, { appliesToDevices: true, appliesToOnline: false }],
    ['Sólo tienda en línea', { appliesToDevices: false }, { appliesToDevices: false, appliesToOnline: true }],
  ]
  it.each(unaSola)(
    'crear «%s» pasa: la casilla que no se manda queda en true y la que se manda se respeta',
    async (_nombre, mandado, esperado) => {
      await createMenu(VENUE_ID, alta(mandado))

      expect(prismaMock.menu.create.mock.calls[0][0].data).toMatchObject(esperado)
    },
  )
})

describe('updateMenu — «¿Dónde se usa?»', () => {
  beforeEach(() => {
    prismaMock.menu.findUnique.mockResolvedValue(menuGuardado())
    prismaMock.menu.update.mockResolvedValue(menuGuardado())
  })

  it('editar sólo active no revisa las casillas: el PATCH {active:false} pasa y no las toca', async () => {
    await expect(updateMenu(VENUE_ID, MENU_ID, { active: false })).resolves.toBeDefined()

    expect(prismaMock.menu.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.menu.update.mock.calls[0][0].data).toEqual({ active: false })
  })

  it('editar apagando Tienda en línea en un menú sin Aparatos da 400: se combina con lo guardado antes de validar', async () => {
    prismaMock.menu.findUnique.mockResolvedValue(menuGuardado({ appliesToDevices: false, appliesToOnline: true }))

    await expect(updateMenu(VENUE_ID, MENU_ID, { appliesToOnline: false })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MENU_SIN_USO',
      message: TEXTO_FIJO,
    })

    // Lo guardado se lee acotado por negocio (el menú de otro negocio no cuenta) y nada se escribe ni se limpia.
    expect(prismaMock.menu.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: MENU_ID, venueId: VENUE_ID } }))
    expect(prismaMock.menu.update).not.toHaveBeenCalled()
    expect(limpiaCache).not.toHaveBeenCalled()
  })

  it('mandar las dos apagadas en el mismo PATCH da 400 aunque lo guardado sea válido', async () => {
    await expect(updateMenu(VENUE_ID, MENU_ID, { appliesToDevices: false, appliesToOnline: false })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MENU_SIN_USO',
    })
    expect(prismaMock.menu.update).not.toHaveBeenCalled()
  })

  it('apagar una casilla cuando la otra sigue prendida pasa, y sólo escribe la que se mandó', async () => {
    prismaMock.menu.findUnique.mockResolvedValue(menuGuardado({ appliesToDevices: true, appliesToOnline: true }))

    await expect(updateMenu(VENUE_ID, MENU_ID, { appliesToDevices: false })).resolves.toBeDefined()

    expect(prismaMock.menu.update.mock.calls[0][0].data).toEqual({ appliesToDevices: false })
  })

  it('prender una casilla en un menú de una sola casilla pasa', async () => {
    prismaMock.menu.findUnique.mockResolvedValue(menuGuardado({ appliesToDevices: false, appliesToOnline: true }))

    await expect(updateMenu(VENUE_ID, MENU_ID, { appliesToDevices: true, appliesToOnline: false })).resolves.toBeDefined()

    expect(prismaMock.menu.update.mock.calls[0][0].data).toEqual({ appliesToDevices: true, appliesToOnline: false })
  })

  describe('la bitácora MENU_UPDATED', () => {
    const ultimoRegistro = () => (logAction as jest.Mock).mock.calls.at(-1)?.[0]

    it('cambiar una casilla registra antes y después de las dos (la tienda en línea cambia su horario)', async () => {
      await updateMenu(VENUE_ID, MENU_ID, { appliesToOnline: false })

      expect(ultimoRegistro()).toMatchObject({
        action: 'MENU_UPDATED',
        entityId: MENU_ID,
        data: {
          name: 'Desayunos',
          antes: { appliesToDevices: true, appliesToOnline: true },
          despues: { appliesToDevices: true, appliesToOnline: false },
        },
      })
    })

    it('también con categoryIds (la edición en transacción)', async () => {
      prismaMock.menu.findUniqueOrThrow.mockResolvedValue(menuGuardado({ appliesToDevices: false }))

      await updateMenu(VENUE_ID, MENU_ID, { appliesToDevices: false, categoryIds: ['cat-1'] })

      expect(ultimoRegistro().data).toEqual({
        name: 'Desayunos',
        antes: { appliesToDevices: true, appliesToOnline: true },
        despues: { appliesToDevices: false, appliesToOnline: true },
      })
    })

    it('lleva a quien editó (Codex r3 #6): el cambio de «¿Dónde se usa?» ya no queda anónimo', async () => {
      await updateMenu(VENUE_ID, MENU_ID, { appliesToOnline: false }, 'staff-1')
      expect(ultimoRegistro()).toMatchObject({ staffId: 'staff-1', action: 'MENU_UPDATED' })
    })

    it('también lleva a quien editó en la edición con categoryIds', async () => {
      prismaMock.menu.findUniqueOrThrow.mockResolvedValue(menuGuardado())
      await updateMenu(VENUE_ID, MENU_ID, { categoryIds: ['cat-1'] }, 'staff-1')
      expect(ultimoRegistro()).toMatchObject({ staffId: 'staff-1', action: 'MENU_UPDATED' })
    })

    it('sin actor (quien llama no lo pasa) sigue registrando, sin staffId', async () => {
      await updateMenu(VENUE_ID, MENU_ID, { name: 'Desayunos' })
      expect(ultimoRegistro().staffId ?? null).toBeNull()
    })

    it('sin cambio de casillas sólo registra el nombre, como antes', async () => {
      await updateMenu(VENUE_ID, MENU_ID, { name: 'Desayunos', appliesToDevices: true, appliesToOnline: true })

      expect(ultimoRegistro().data).toEqual({ name: 'Desayunos' })
    })
  })

  describe('la caché de la carta en línea', () => {
    it('cambiar una casilla limpia la caché de la carta: clearPublicMenuCache(venueId), ya escrito el cambio', async () => {
      await updateMenu(VENUE_ID, MENU_ID, { appliesToOnline: false })

      expect(limpiaCache).toHaveBeenCalledTimes(1)
      expect(limpiaCache).toHaveBeenCalledWith(VENUE_ID)
      // Después de guardar: si se limpiara antes, una lectura en vuelo podría volver a guardar la carta vieja.
      expect(prismaMock.menu.update.mock.invocationCallOrder[0]).toBeLessThan(limpiaCache.mock.invocationCallOrder[0])
    })

    it('editar el nombre no limpia la caché', async () => {
      await updateMenu(VENUE_ID, MENU_ID, { name: 'Desayunos de lujo' })

      expect(prismaMock.menu.update).toHaveBeenCalledTimes(1)
      expect(limpiaCache).not.toHaveBeenCalled()
    })

    it('mandar las casillas con los mismos valores que ya tenía no limpia la caché: nada cambió', async () => {
      prismaMock.menu.findUnique.mockResolvedValue(menuGuardado({ appliesToDevices: true, appliesToOnline: false }))

      await updateMenu(VENUE_ID, MENU_ID, { name: 'Cena', appliesToDevices: true, appliesToOnline: false })

      expect(prismaMock.menu.update).toHaveBeenCalledTimes(1)
      expect(limpiaCache).not.toHaveBeenCalled()
    })

    describe('con categoryIds (la edición va en una transacción)', () => {
      beforeEach(() => {
        prismaMock.menu.findUniqueOrThrow.mockResolvedValue(menuGuardado({ appliesToOnline: false }))
      })

      it('cambiar una casilla también limpia la caché, después de escribir', async () => {
        await updateMenu(VENUE_ID, MENU_ID, { appliesToOnline: false, categoryIds: ['cat-1'] })

        expect(prismaMock.menuCategoryAssignment.createMany).toHaveBeenCalledTimes(1)
        expect(limpiaCache).toHaveBeenCalledTimes(1)
        expect(limpiaCache).toHaveBeenCalledWith(VENUE_ID)
        expect(prismaMock.menuCategoryAssignment.createMany.mock.invocationCallOrder[0]).toBeLessThan(
          limpiaCache.mock.invocationCallOrder[0],
        )
      })

      it('cambiar sólo las categorías no limpia la caché', async () => {
        await updateMenu(VENUE_ID, MENU_ID, { categoryIds: ['cat-1'] })

        expect(prismaMock.menuCategoryAssignment.createMany).toHaveBeenCalledTimes(1)
        expect(limpiaCache).not.toHaveBeenCalled()
      })
    })
  })
})

describe('cloneMenu — copia las dos casillas', () => {
  const combinaciones: Array<[boolean, boolean]> = [
    [false, true],
    [true, false],
    [true, true],
  ]

  it.each(combinaciones)('clonar copia las dos casillas del original (Aparatos=%s, Tienda en línea=%s)', async (aparatos, enLinea) => {
    const original = menuGuardado({ appliesToDevices: aparatos, appliesToOnline: enLinea, categories: [] })
    // 1ª lectura: el original; 2ª: el clon que devuelve getMenuById.
    prismaMock.menu.findUnique.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, id: 'menu-clon' })
    prismaMock.menu.findFirst.mockResolvedValue({ displayOrder: 3 })
    prismaMock.menu.create.mockResolvedValue({ ...original, id: 'menu-clon' })

    await cloneMenu(VENUE_ID, MENU_ID, { name: 'Copia de Desayunos', copyCategories: true, copyProducts: true, copyModifiers: true })

    expect(prismaMock.menu.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.menu.create.mock.calls[0][0].data).toMatchObject({
      appliesToDevices: aparatos,
      appliesToOnline: enLinea,
      isDefault: false,
    })
  })
})

describe('esquema — las dos casillas son opcionales y sólo de forma', () => {
  const params = { venueId: 'c'.padEnd(25, 'a'), menuId: 'c'.padEnd(25, 'b') }

  it('CreateMenuSchema deja pasar las dos casillas y las conserva (si no, validateRequest las borra)', () => {
    const resultado = CreateMenuSchema.parse({ body: { name: 'Desayunos', appliesToDevices: false, appliesToOnline: true }, params })

    expect(resultado.body.appliesToDevices).toBe(false)
    expect(resultado.body.appliesToOnline).toBe(true)
  })

  it('sin las casillas, el esquema no las inventa: el true por default lo pone el servicio', () => {
    const resultado = CreateMenuSchema.parse({ body: { name: 'Desayunos' }, params })

    expect(resultado.body.appliesToDevices).toBeUndefined()
    expect(resultado.body.appliesToOnline).toBeUndefined()
  })

  it('UpdateMenuSchema hereda las dos casillas: un PATCH con una sola pasa', () => {
    const resultado = UpdateMenuSchema.parse({ body: { appliesToOnline: false }, params })

    expect(resultado.body).toEqual({ appliesToOnline: false })
  })

  it('el esquema NO decide «al menos una»: las dos en false pasan el esquema y el 400 MENU_SIN_USO lo da el servicio', () => {
    const resultado = CreateMenuSchema.safeParse({ body: { name: 'Desayunos', appliesToDevices: false, appliesToOnline: false }, params })

    expect(resultado.success).toBe(true)
  })

  it('un valor que no es booleano da el aviso en español', () => {
    const aparatos = CreateMenuSchema.safeParse({ body: { name: 'Desayunos', appliesToDevices: 'si' }, params })
    const enLinea = CreateMenuSchema.safeParse({ body: { name: 'Desayunos', appliesToOnline: 1 }, params })

    expect(aparatos.success).toBe(false)
    expect(enLinea.success).toBe(false)
    expect(!aparatos.success && aparatos.error.issues[0].message).toBe('Aparatos debe ser verdadero o falso')
    expect(!enLinea.success && enLinea.error.issues[0].message).toBe('Tienda en línea debe ser verdadero o falso')
  })
})
