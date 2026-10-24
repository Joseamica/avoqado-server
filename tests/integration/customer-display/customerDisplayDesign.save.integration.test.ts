// tests/integration/customer-display/customerDisplayDesign.save.integration.test.ts
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { resetCustomerDisplayDesign, saveCustomerDisplayDesign } from '@/services/customer-display/customerDisplayDesign.service'
import { esperarBloqueado, retenerTerminal } from './barrera'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))

// `logAction` lo simula el setup de integración (fire-and-forget); aquí se lee como el registro de lo auditado.
const bitacora = logAction as jest.Mock

const suffix = `cds-${Date.now()}`
let orgId: string
let venueA: string
let venueB: string
let terminalId: string
let staffId: string
let logoA: string
let slideA: string
let slideB: string

async function activo(venueId: string, kind: 'SLIDE' | 'LOGO', n: string) {
  return (
    await prisma.customerDisplayAsset.create({
      data: {
        venueId,
        kind,
        objectPath: `dev/customer-display-assets/${venueId}/${n}-${suffix}.png`,
        sha256: 'a'.repeat(64),
        mime: 'image/png',
        width: 800,
        height: 600,
        bytes: 100,
      },
      select: { id: true },
    })
  ).id
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const crearVenue = async (n: string) =>
    (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `Venue ${n} ${suffix}`, slug: `venue-${n}-${suffix}`, timezone: 'America/Mexico_City' },
        select: { id: true },
      })
    ).id
  venueA = await crearVenue('a')
  venueB = await crearVenue('b')
  const staff = await prisma.staff.create({
    data: { email: `staff-${suffix}@example.test`, firstName: 'Ana', lastName: 'Prueba' },
    select: { id: true },
  })
  staffId = staff.id
  logoA = await activo(venueA, 'LOGO', 'logo')
  slideA = await activo(venueA, 'SLIDE', 'slide')
  slideB = await activo(venueB, 'SLIDE', 'ajena')
})

beforeEach(async () => {
  if (!venueA || !venueB) return
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  const t = await prisma.terminal.create({
    data: { venueId: venueA, name: `Caja ${suffix}`, type: 'POS_ANDROID', customerDisplayDesignVersion: 2 },
    select: { id: true },
  })
  terminalId = t.id
  bitacora.mockClear() // el setup de integración no limpia los mocks entre pruebas
})

afterAll(async () => {
  if (!venueA || !venueB) return
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.customerDisplayAsset.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  // `staffId` queda sin asignar si beforeAll falla antes de crearlo: un `{ id: undefined }` borraría TODO el personal.
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

const guardar = (over: Record<string, unknown> = {}) =>
  saveCustomerDisplayDesign({
    venueId: venueA,
    terminalId,
    draft: { welcomeText: 'Bienvenido' },
    expectedEditToken: 'factory',
    staffId,
    ...over,
  } as Parameters<typeof saveCustomerDisplayDesign>[0])

const disenoGuardado = () =>
  prisma.customerDisplayDesign.findUnique({
    where: { terminalId },
    select: {
      revision: true,
      theme: true,
      accentColor: true,
      logoAssetId: true,
      welcomeText: true,
      thanksText: true,
      slides: true,
      slideSeconds: true,
      showPromotions: true,
    },
  })

describe('el primer guardado crea el diseño', () => {
  it('sobre «factory» lo crea y devuelve el token nuevo', async () => {
    const r = await guardar()
    expect(r.editToken).toMatch(/^[a-z0-9]+:1$/)
    expect(r.design.welcomeText).toBe('Bienvenido')
  })

  it('un SEGUNDO guardado con «factory» da 409: el diseño ya existe', async () => {
    await guardar()
    await expect(guardar()).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_CONFLICT' })
  })
})

describe('🔴 activos: se revisan al ESCRIBIR, no sólo al leer (P1-5)', () => {
  it('logo y slide propios, del tipo correcto: se guardan', async () => {
    const r = await guardar({ draft: { logoAssetId: logoA, slides: [{ assetId: slideA }] } })
    expect(r.design).toMatchObject({ logoAssetId: logoA, slides: [{ assetId: slideA }] })
  })

  it.each([
    ['una SLIDE puesta como logo', () => ({ logoAssetId: slideA })],
    ['un LOGO puesto como slide', () => ({ slides: [{ assetId: logoA }] })],
    ['un id que no existe', () => ({ logoAssetId: 'no-existe' })],
    ['un activo de OTRO negocio', () => ({ slides: [{ assetId: slideB }] })],
  ])('%s: 400 y NO se escribe nada', async (_caso, draft) => {
    await expect(guardar({ draft: draft() })).rejects.toBeInstanceOf(BadRequestError)
    expect(await disenoGuardado()).toBeNull()
  })

  it('el error de un activo ajeno es el MISMO que el de uno inexistente: no revela que existe en otro negocio', async () => {
    const ajeno = await guardar({ draft: { slides: [{ assetId: slideB }] } }).catch(e => e)
    const inexistente = await guardar({ draft: { slides: [{ assetId: 'no-existe' }] } }).catch(e => e)
    expect(ajeno.message).toBe(inexistente.message)
    expect(ajeno.code).toBe(inexistente.code)
  })
})

describe('CAS', () => {
  it('guardar con el token que se leyó funciona; repetirlo con el viejo da 409', async () => {
    const primero = await guardar()
    const segundo = await guardar({ expectedEditToken: primero.editToken, draft: { welcomeText: 'Pasa' } })
    expect(segundo.design.welcomeText).toBe('Pasa')

    await expect(guardar({ expectedEditToken: primero.editToken, draft: { welcomeText: 'Tarde' } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CUSTOMER_DISPLAY_CONFLICT',
    })
    expect((await disenoGuardado())?.welcomeText).toBe('Pasa') // el perdedor no pisó nada
  })

  // Esta prueba demuestra el CAS, NO el candado: el CAS por sí solo ya produce «uno gana». El valor del candado
  // lo demuestra la prueba de la barrera, más abajo.
  it('DOS guardados a la vez con el mismo token: exactamente uno gana y el otro recibe el 409 del CAS', async () => {
    const { editToken } = await guardar()
    const resultados = await Promise.allSettled([
      guardar({ expectedEditToken: editToken, draft: { welcomeText: 'Uno' } }),
      guardar({ expectedEditToken: editToken, draft: { welcomeText: 'Dos' } }),
    ])
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const [perdedor] = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(perdedor.reason).toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_CONFLICT' })
    // Y la base guarda lo del GANADOR, no lo del perdedor ni una mezcla.
    const [ganador] = resultados.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof guardar>>> => r.status === 'fulfilled')
    expect(await disenoGuardado()).toMatchObject({ welcomeText: ganador.value.design.welcomeText, revision: 2 })
  })

  it('el CAS lleva el ID del diseño, no sólo la revisión: un diseño RECREADO no acepta el token viejo', async () => {
    expect(terminalId).toBeTruthy() // un verde vacío (la prueba sale sin afirmar nada) sería peor que un rojo
    const primero = await guardar()
    // Lo que pasa al mover la terminal y traerla de vuelta: la fila se borra y nace otra, con
    // revisión 1 otra vez. Sólo el id distingue una de otra.
    await prisma.customerDisplayDesign.deleteMany({ where: { terminalId } })
    await prisma.customerDisplayDesign.create({ data: { terminalId } })

    await expect(guardar({ expectedEditToken: primero.editToken })).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('🔴 el traslado gana: una edición que PASÓ la lectura inicial y espera el candado NO escribe después', () => {
  it('la terminal se muda mientras el guardado espera el candado: 404 y nada escrito', async () => {
    const { editToken } = await guardar()
    const { pid, soltar, transaccion } = await retenerTerminal(terminalId)

    // El guardado pasa su lectura inicial (la terminal todavía es de A) y se queda esperando el candado.
    const guardado = guardar({ expectedEditToken: editToken, draft: { welcomeText: 'De otro negocio' } })
    expect(await esperarBloqueado(pid, guardado)).toBe('bloqueada')

    // Sólo AHORA ocurre el traslado, y se confirma.
    soltar(async tx => {
      await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueB } })
    })
    await transaccion

    const bajoElCandado = await guardado.catch(e => e)
    expect(bajoElCandado).toBeInstanceOf(NotFoundError)
    expect((await disenoGuardado())?.welcomeText).toBe('Bienvenido')

    // El 404 bajo el candado es EL MISMO que el de la lectura inicial (la terminal ya es de B): un mensaje o un código
    // distinto le diría a quien pregunta que la terminal existía y se acaba de ir.
    const antesDelCandado = await guardar({ expectedEditToken: editToken }).catch(e => e)
    expect(antesDelCandado).toBeInstanceOf(NotFoundError)
    expect(bajoElCandado.message).toBe(antesDelCandado.message)
    expect(bajoElCandado.code).toBe(antesDelCandado.code)
  })
})

// 🔴 Esperar el candado tiene un tope (`lock_timeout`). Vencerlo es «otro cambio se cruzó, vuelve a intentarlo»: un 409
// con código, nunca un 500 genérico. La espera se acorta aquí por entorno para no esperar el tope real.
describe('esperar el candado de más da 409 CUSTOMER_DISPLAY_BUSY, no un 500', () => {
  const esperaOriginal = process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS
  beforeEach(() => {
    process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS = '300'
  })
  afterEach(() => {
    if (esperaOriginal === undefined) delete process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS
    else process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS = esperaOriginal
  })

  it.each([
    ['guardar', (token: string) => guardar({ expectedEditToken: token, draft: { welcomeText: 'Tarde' } })],
    ['restablecer', (token: string) => resetCustomerDisplayDesign({ venueId: venueA, terminalId, expectedEditToken: token, staffId })],
  ])('%s con la terminal retenida más allá del tope: 409 BUSY y nada escrito', async (_caso, operar) => {
    const { editToken } = await guardar()
    bitacora.mockClear()
    const { soltar, transaccion } = await retenerTerminal(terminalId)
    try {
      await expect(operar(editToken)).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_BUSY' })
    } finally {
      soltar()
      await transaccion
    }
    expect(await disenoGuardado()).toMatchObject({ welcomeText: 'Bienvenido', revision: 1 })
    expect(bitacora).not.toHaveBeenCalled()
  })
})

describe('restablecer', () => {
  it('escribe los defaults y SUBE la revisión (no la reinicia)', async () => {
    // Todos los campos lejos de fábrica: así la prueba ve que el restablecer escribe CADA uno, no sólo los de texto.
    const primero = await guardar({
      draft: {
        welcomeText: 'Hola',
        thanksText: 'Gracias',
        theme: 'DARK' as const,
        accentColor: '#112233',
        logoAssetId: logoA,
        slides: [{ assetId: slideA }],
        slideSeconds: 12,
        showPromotions: true,
      },
    })

    const r = await resetCustomerDisplayDesign({ venueId: venueA, terminalId, expectedEditToken: primero.editToken, staffId })

    expect(r.design).toMatchObject({ welcomeText: null, theme: 'LIGHT', slides: [], showPromotions: false })
    expect(r.editToken).toBe(primero.editToken.replace(/:\d+$/, ':2'))
    // Lo GUARDADO, no sólo lo que la función contestó.
    expect(await disenoGuardado()).toEqual({
      revision: 2,
      theme: 'LIGHT',
      accentColor: null,
      logoAssetId: null,
      welcomeText: null,
      thanksText: null,
      slides: [],
      slideSeconds: 8,
      showPromotions: false,
    })
  })
})

// Toda mutación deja rastro en ActivityLog; lo rechazado, ninguno (no ocurrió nada que auditar).
describe('la bitácora', () => {
  it('guardar y restablecer escriben UNA entrada cada uno; un guardado rechazado no escribe ninguna', async () => {
    const primero = await guardar()
    expect(bitacora).toHaveBeenCalledTimes(1)
    expect(bitacora).toHaveBeenLastCalledWith(
      expect.objectContaining({
        staffId,
        venueId: venueA,
        action: 'CUSTOMER_DISPLAY_DESIGN_UPDATED',
        entity: 'CustomerDisplayDesign',
        entityId: terminalId,
        data: expect.objectContaining({ editToken: primero.editToken, changedKeys: ['welcomeText'] }),
      }),
    )
    // Qué CAMPOS cambiaron, nunca sus valores: la bitácora no copia el texto del negocio.
    expect(JSON.stringify(bitacora.mock.calls[0][0].data)).not.toContain('Bienvenido')

    await guardar({ expectedEditToken: 'viejo:1' }).catch(() => undefined) // 409 del CAS
    await guardar({ expectedEditToken: primero.editToken, draft: { logoAssetId: 'no-existe' } }).catch(() => undefined) // 400
    expect(bitacora).toHaveBeenCalledTimes(1)

    const r = await resetCustomerDisplayDesign({ venueId: venueA, terminalId, expectedEditToken: primero.editToken, staffId })
    expect(bitacora).toHaveBeenCalledTimes(2)
    expect(bitacora).toHaveBeenLastCalledWith(
      expect.objectContaining({
        staffId,
        venueId: venueA,
        action: 'CUSTOMER_DISPLAY_DESIGN_RESET',
        entityId: terminalId,
        data: expect.objectContaining({ editToken: r.editToken, changedKeys: ['welcomeText'] }),
      }),
    )
  })
})
