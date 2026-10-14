// tests/unit/services/customer-display/customerDisplayDesign.save.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  designValuesOf,
  getEffectiveDesign,
  resetCustomerDisplayDesign,
  saveCustomerDisplayDesign,
} from '@/services/customer-display/customerDisplayDesign.service'
import { FACTORY_DESIGN } from '@/services/customer-display/customerDisplayDesign.validation'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

/**
 * La prueba de integración demuestra el comportamiento; ésta fija la FORMA de las consultas, que es lo que alguien puede
 * «simplificar» sin que nada se ponga rojo. El mock compartido ejecuta `$transaction(cb)` con el mismo cliente simulado.
 */

const DISENO = {
  id: 'd1',
  terminalId: 't',
  revision: 4,
  updatedById: null,
  theme: 'LIGHT',
  accentColor: null,
  logoAssetId: null,
  welcomeText: null,
  thanksText: null,
  slides: [],
  slideSeconds: 8,
  showPromotions: false,
  schemaVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const TERMINAL = {
  id: 't',
  venueId: 'v',
  name: 'Caja',
  type: 'POS_ANDROID',
  customerDisplayDesignVersion: 2,
  venue: { logo: null, updatedAt: new Date() },
  customerDisplayDesign: DISENO,
}

beforeEach(() => {
  prismaMock.terminal.findFirst.mockResolvedValue(TERMINAL as any)
  prismaMock.$queryRaw.mockResolvedValue([{ id: 't', venueId: 'v' }] as any) // lockTerminalRow
  prismaMock.customerDisplayDesign.findUnique.mockResolvedValue(DISENO as any)
  prismaMock.customerDisplayDesign.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.customerDisplayAsset.findMany.mockResolvedValue([{ id: 'lg', kind: 'LOGO' }] as any)
})

it('el updateMany del CAS condiciona por id, terminal y revisión — los tres', async () => {
  await saveCustomerDisplayDesign({
    venueId: 'v',
    terminalId: 't',
    draft: { welcomeText: 'Hola' },
    expectedEditToken: 'd1:4',
    staffId: 's',
  })

  expect(prismaMock.customerDisplayDesign.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'd1', terminalId: 't', revision: 4 } }),
  )
})

// 🔴 La ficha que se devuelve DESPUÉS lee los mismos activos con un `where` idéntico, así que mirar «alguna llamada»
// dejaría pasar una revisión de escritura sin venue. Se aíslan las consultas hechas DENTRO de la transacción.
it('la revisión de activos al ESCRIBIR (dentro de la transacción) se acota al venue de la RUTA', async () => {
  let dentro = false
  const consultasDentro: unknown[] = []
  prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
    dentro = true
    try {
      return await cb(prismaMock)
    } finally {
      dentro = false
    }
  })
  prismaMock.customerDisplayAsset.findMany.mockImplementation(async (args: any) => {
    if (dentro) consultasDentro.push(args)
    return [{ id: 'lg', kind: 'LOGO' }] as any
  })

  await saveCustomerDisplayDesign({ venueId: 'v', terminalId: 't', draft: { logoAssetId: 'lg' }, expectedEditToken: 'd1:4', staffId: 's' })

  expect(consultasDentro).toHaveLength(1)
  expect(consultasDentro[0]).toEqual(expect.objectContaining({ where: { id: { in: ['lg'] }, venueId: 'v' } }))
})

it('si otra escritura crea el diseño primero, el índice único decide: 409 del CAS, no un 500', async () => {
  prismaMock.customerDisplayDesign.findUnique.mockResolvedValue(null)
  // `…Once`: el setup global sólo limpia las llamadas, no las implementaciones; un rechazo permanente se filtraría a
  // cualquier prueba posterior que cree un diseño.
  prismaMock.customerDisplayDesign.create.mockRejectedValueOnce(
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
  )

  await expect(
    saveCustomerDisplayDesign({
      venueId: 'v',
      terminalId: 't',
      draft: { welcomeText: 'Hola' },
      expectedEditToken: 'factory',
      staffId: 's',
    }),
  ).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_CONFLICT' })
})

// La tablet lee de la caché de 60 s: si guardar no la tirara, la pantalla seguiría mostrando el diseño viejo.
it('guardar invalida la caché de la ficha de ESA terminal', async () => {
  await getEffectiveDesign('v', 't', { cache: true })
  await getEffectiveDesign('v', 't', { cache: true })
  expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1) // la segunda salió de la caché

  await saveCustomerDisplayDesign({
    venueId: 'v',
    terminalId: 't',
    draft: { welcomeText: 'Hola' },
    expectedEditToken: 'd1:4',
    staffId: 's',
  })
  const lecturasTrasGuardar = prismaMock.terminal.findFirst.mock.calls.length

  await getEffectiveDesign('v', 't', { cache: true })
  expect(prismaMock.terminal.findFirst.mock.calls.length).toBe(lecturasTrasGuardar + 1) // ya no sale de la caché
})

const guardar = () =>
  saveCustomerDisplayDesign({ venueId: 'v', terminalId: 't', draft: { welcomeText: 'Hola' }, expectedEditToken: 'd1:4', staffId: 's' })
const restablecer = () => resetCustomerDisplayDesign({ venueId: 'v', terminalId: 't', expectedEditToken: 'd1:4', staffId: 's' })

// 🔴 La espera del candado tiene tope. Cada operación lo pone ella misma y ANTES de tomar el candado: puesto después, la
// espera ya habría ocurrido sin límite. (No vive dentro de `lockTerminalRow`: el traslado comparte esa función.)
describe('la espera del candado', () => {
  it.each([
    ['guardar', guardar],
    ['restablecer', restablecer],
  ])('%s: la PRIMERA sentencia de la transacción fija lock_timeout, y la transacción tiene un tope más holgado', async (_caso, operar) => {
    const orden: string[] = []
    prismaMock.$executeRawUnsafe.mockImplementationOnce(async (sql: string) => {
      orden.push(sql)
      return 0
    })
    prismaMock.$queryRaw.mockImplementationOnce(async () => {
      orden.push('CANDADO')
      return [{ id: 't', venueId: 'v' }]
    })

    await operar()

    expect(orden).toHaveLength(2)
    const [ajuste, candado] = orden
    expect(candado).toBe('CANDADO')
    const ms = Number(/^SET LOCAL lock_timeout = '(\d+)ms'$/.exec(ajuste)?.[1])
    expect(ms).toBeGreaterThan(0)
    const [, opciones] = prismaMock.$transaction.mock.calls[0] as [unknown, { timeout?: number; maxWait?: number }]
    expect(opciones?.timeout).toBeGreaterThan(ms)
  })

  // MINOR 2: el atajo de las pruebas vale SÓLO en pruebas. Staging corre con NODE_ENV=staging (render.yaml) y dev con
  // development: ahí una variable olvidada no puede cambiar cuánto espera un guardado real.
  it.each([
    ['test', 300],
    ['staging', 5_000],
    ['development', 5_000],
    ['production', 5_000],
  ])('con NODE_ENV=%s y CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS=300, la espera es %i ms', async (entorno, esperada) => {
    const antes = { entorno: process.env.NODE_ENV, espera: process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS }
    process.env.NODE_ENV = entorno
    process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS = '300'
    try {
      await guardar()
    } finally {
      // `process.env.X = undefined` guarda el TEXTO "undefined": si no estaba, se borra la llave.
      if (antes.entorno === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = antes.entorno
      if (antes.espera === undefined) delete process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS
      else process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS = antes.espera
    }
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '${esperada}ms'`)
  })

  const P = (code: string, message = 'x') => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' })
  it.each([
    [
      'lock_timeout de Postgres (55P03)',
      () =>
        Object.assign(P('P2010', 'Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`'), {
          meta: { code: '55P03' },
        }),
    ],
    ['la transacción de Prisma venció (P2028)', () => P('P2028', 'Transaction already closed')],
    ['un interbloqueo (P2034)', () => P('P2034', 'Transaction failed due to a write conflict or a deadlock')],
    [
      'un interbloqueo en SQL crudo (40P01)',
      () => Object.assign(P('P2010', 'Raw query failed. Code: `40P01`. Message: `deadlock detected`'), { meta: { code: '40P01' } }),
    ],
  ])('%s: 409 CUSTOMER_DISPLAY_BUSY, no un 500', async (_caso, error) => {
    prismaMock.$transaction.mockRejectedValueOnce(error())
    await expect(guardar()).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_BUSY' })
    prismaMock.$transaction.mockRejectedValueOnce(error())
    await expect(restablecer()).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_BUSY' })
  })

  it('un error que NO es de espera sale tal cual: el traductor no se traga fallos reales', async () => {
    const real = new Error('la base se cayó')
    prismaMock.$transaction.mockRejectedValueOnce(real)
    await expect(guardar()).rejects.toBe(real)
  })
})

describe('los valores de fábrica no se comparten', () => {
  it('FACTORY_DESIGN está congelado a fondo', () => {
    expect(Object.isFrozen(FACTORY_DESIGN)).toBe(true)
    expect(Object.isFrozen(FACTORY_DESIGN.slides)).toBe(true)
  })

  it('designValuesOf(null) entrega su PROPIO arreglo de imágenes, no el de fábrica', () => {
    const a = designValuesOf(null)
    expect(a.slides).not.toBe(FACTORY_DESIGN.slides)
    a.slides.push({ assetId: 'x' })
    expect(FACTORY_DESIGN.slides).toEqual([])
    expect(designValuesOf(null).slides).toEqual([])
  })
})
