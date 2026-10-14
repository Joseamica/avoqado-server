// tests/integration/customer-display/customerDisplayDesign.copy.integration.test.ts
import prisma from '@/utils/prismaClient'
import { NotFoundError, ValidationError } from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  copyCustomerDisplayDesign,
  getCustomerDisplayForDashboard,
  previewCopyCustomerDisplay,
  saveCustomerDisplayDesign,
} from '@/services/customer-display/customerDisplayDesign.service'
import { esperarBloqueado, retenerTerminal } from './barrera'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))
const accesoAlPlan = venueHasFeatureAccess as jest.Mock
const conPlan = () => accesoAlPlan.mockImplementation(async () => true)
const sinPlanDePromos = () => accesoAlPlan.mockImplementation(async (_v: string, code: string) => code !== 'CUSTOMER_DISPLAY_PROMOS')
// `logAction` lo simula el setup de integración (fire-and-forget); aquí se lee como el registro de lo auditado.
const bitacora = logAction as jest.Mock

const suffix = `cdc-${Date.now()}`
let orgId: string, venueA: string, venueB: string, staffId: string
let t1: string, t2: string, t3: string, tpvDeA: string, terminalDeB: string
let slideA: string, slideA2: string, slideB: string

async function activo(venueId: string, kind: 'SLIDE' | 'LOGO', n: string) {
  return (
    await prisma.customerDisplayAsset.create({
      data: {
        venueId,
        kind,
        objectPath: `dev/customer-display-assets/${venueId}/${n}-${suffix}.png`,
        sha256: 'b'.repeat(64),
        mime: 'image/png',
        width: 800,
        height: 600,
        bytes: 100,
      },
      select: { id: true },
    })
  ).id
}
const terminal = async (venueId: string, n: string, type = 'POS_ANDROID') =>
  (
    await prisma.terminal.create({
      data: { venueId, name: `${n} ${suffix}`, type: type as any, customerDisplayDesignVersion: 2 },
      select: { id: true },
    })
  ).id

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const venue = async (n: string) =>
    (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `V${n} ${suffix}`, slug: `v${n}-${suffix}`, timezone: 'America/Mexico_City' },
        select: { id: true },
      })
    ).id
  venueA = await venue('a')
  venueB = await venue('b')
  staffId = (
    await prisma.staff.create({ data: { email: `s-${suffix}@example.test`, firstName: 'Ana', lastName: 'Prueba' }, select: { id: true } })
  ).id
  slideA = await activo(venueA, 'SLIDE', 'a1')
  slideA2 = await activo(venueA, 'SLIDE', 'a2')
  slideB = await activo(venueB, 'SLIDE', 'b1')
})

beforeEach(async () => {
  if (!venueA || !venueB) return
  conPlan()
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  t1 = await terminal(venueA, 'Caja 1')
  t2 = await terminal(venueA, 'Caja 2')
  t3 = await terminal(venueA, 'Caja 3')
  tpvDeA = await terminal(venueA, 'Terminal de cobro', 'TPV_ANDROID')
  terminalDeB = await terminal(venueB, 'Caja de B')
})

afterAll(async () => {
  if (!venueA || !venueB) return
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.customerDisplayAsset.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
})

const guardar = (terminalId: string, draft: Record<string, unknown>, expectedEditToken = 'factory') =>
  saveCustomerDisplayDesign({ venueId: venueA, terminalId, draft, expectedEditToken, staffId })
const tokenDe = async (terminalId: string, venueId = venueA) => (await getCustomerDisplayForDashboard(venueId, terminalId)).editToken
/** El 404 de un id que NO existe: la vara con la que se mide todo 404 de la copia (ni el texto ni el código pueden delatar). */
const noExiste = async (sourceToken: string) =>
  copyCustomerDisplayDesign({
    venueId: venueA,
    staffId,
    source: { terminalId: t1, editToken: sourceToken },
    targets: [{ terminalId: 'no-existe', editToken: 'factory' }],
  }).catch(e => e)

describe('copiar', () => {
  it('copia el diseño del origen a los destinos y sube la revisión de cada uno', async () => {
    const origen = await guardar(t1, { welcomeText: 'Hola', theme: 'DARK', slides: [{ assetId: slideA }] })

    const r = await copyCustomerDisplayDesign({
      venueId: venueA,
      staffId,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [
        { terminalId: t2, editToken: 'factory' },
        { terminalId: t3, editToken: 'factory' },
      ],
    })

    expect(r).toEqual({ copied: [t2, t3], promosOmitted: false })
    for (const t of [t2, t3]) {
      expect((await getCustomerDisplayForDashboard(venueA, t)).design).toMatchObject({
        welcomeText: 'Hola',
        theme: 'DARK',
        slides: [{ assetId: slideA }],
      })
    }
  })

  it('UN destino con token viejo aborta TODO y dice cuál', async () => {
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    const deT2 = await guardar(t2, { welcomeText: 'Mío' })

    await expect(
      copyCustomerDisplayDesign({
        venueId: venueA,
        staffId,
        source: { terminalId: t1, editToken: origen.editToken },
        targets: [
          { terminalId: t2, editToken: 'factory' },
          { terminalId: t3, editToken: 'factory' },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_CONFLICT', details: { conflicts: [t2] } })

    expect(await tokenDe(t3)).toBe('factory')
    expect(await tokenDe(t2)).toBe(deT2.editToken)
  })

  // 🔴 El rollback de VERDAD: el primer destino YA se escribió cuando el segundo falla.
  it('si el SEGUNDO destino falla después de escribir el primero, el primero se deshace', async () => {
    sinPlanDePromos() // sin plan, cada destino conserva SUS imágenes: así el segundo lleva las suyas
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    // Un diseño heredado con una referencia inválida (un activo de OTRO negocio), puesto a mano como lo dejaría un
    // dato viejo. La regla de activos lo rechaza al escribir el SEGUNDO destino, con el primero ya escrito.
    const malo = await prisma.customerDisplayDesign.create({
      data: { terminalId: t3, slides: [{ assetId: slideB }] },
      select: { id: true, revision: true },
    })

    await expect(
      copyCustomerDisplayDesign({
        venueId: venueA,
        staffId,
        source: { terminalId: t1, editToken: origen.editToken },
        targets: [
          { terminalId: t2, editToken: 'factory' },
          { terminalId: t3, editToken: `${malo.id}:${malo.revision}` },
        ],
      }),
      // Y dice en QUÉ dispositivo está la imagen que no sirve: «t3», no sólo «una imagen».
    ).rejects.toMatchObject({ statusCode: 400, code: 'ASSET_NOT_USABLE', details: { assetId: slideB, terminalId: t3 } })

    expect(await tokenDe(t2)).toBe('factory') // el primer destino NO quedó escrito
  })

  it('una terminal de OTRO negocio no puede ser destino: el MISMO 404 que una inexistente, y nada se copia', async () => {
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    const ajena = await copyCustomerDisplayDesign({
      venueId: venueA,
      staffId,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [{ terminalId: terminalDeB, editToken: 'factory' }],
    }).catch(e => e)
    const inexistente = await noExiste(origen.editToken)

    expect(ajena).toBeInstanceOf(NotFoundError)
    expect(inexistente).toBeInstanceOf(NotFoundError)
    expect(ajena.message).toBe(inexistente.message)
    expect(ajena.code).toBe(inexistente.code)
    expect(await tokenDe(terminalDeB, venueB)).toBe('factory')
  })

  it('una terminal PROPIA sin pantalla del cliente da 422, no 404', async () => {
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    const error = await copyCustomerDisplayDesign({
      venueId: venueA,
      staffId,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [{ terminalId: tpvDeA, editToken: 'factory' }],
    }).catch(e => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({ statusCode: 422, code: 'CUSTOMER_DISPLAY_NOT_SUPPORTED' })
  })

  // MINOR 4: el dashboard y el MCP tienen que poder decir «el ORIGEN cambió», que se arregla distinto que un destino.
  it('un ORIGEN con token viejo da el 409 del CAS diciendo que es el origen, en la copia y en su vista previa', async () => {
    const viejo = await guardar(t1, { welcomeText: 'Hola' })
    await guardar(t1, { welcomeText: 'Cambió' }, viejo.editToken)
    const pedido = {
      venueId: venueA,
      source: { terminalId: t1, editToken: viejo.editToken },
      targets: [{ terminalId: t2, editToken: 'factory' }],
    }

    const esperado = { statusCode: 409, code: 'CUSTOMER_DISPLAY_CONFLICT', details: { source: true, terminalId: t1 } }
    await expect(copyCustomerDisplayDesign({ ...pedido, staffId })).rejects.toMatchObject(esperado)
    await expect(previewCopyCustomerDisplay(pedido)).rejects.toMatchObject(esperado)
    expect(await tokenDe(t2)).toBe('factory')
  })

  // 🔴 IMPORTANT 1: el candado serializa, no reautoriza. Una copia que pasó la revisión inicial ANTES de un traslado no
  // puede escribir DESPUÉS de él en una terminal que ya es de otro negocio.
  it('un destino que se muda de negocio mientras la copia espera su candado: el MISMO 404 y ningún destino escrito', async () => {
    // t3 es la ÚLTIMA en tomarse (orden por id): la copia ya retiene t1 y t2 cuando se queda esperando.
    expect([t1, t2, t3].slice().sort()).toEqual([t1, t2, t3])
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    const { pid, soltar, transaccion } = await retenerTerminal(t3)

    const copia = copyCustomerDisplayDesign({
      venueId: venueA,
      staffId,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [
        { terminalId: t2, editToken: 'factory' },
        { terminalId: t3, editToken: 'factory' },
      ],
    })
    copia.catch(() => undefined) // se lee abajo; evita el aviso de promesa rechazada sin manejar mientras espera
    expect(await esperarBloqueado(pid, copia)).toBe('bloqueada')

    // Sólo AHORA ocurre el traslado, y se confirma.
    soltar(async tx => {
      await tx.terminal.update({ where: { id: t3 }, data: { venueId: venueB } })
    })
    await transaccion

    const bajoElCandado = await copia.catch(e => e)
    const inexistente = await noExiste(origen.editToken)
    expect(bajoElCandado).toBeInstanceOf(NotFoundError)
    expect(bajoElCandado.message).toBe(inexistente.message)
    expect(bajoElCandado.code).toBe(inexistente.code)
    expect(await tokenDe(t2)).toBe('factory') // todo o nada: t2 tampoco se escribió
    expect(await tokenDe(t3, venueB)).toBe('factory') // y en el negocio nuevo, nada nuestro
  })

  it('el origen no puede ser su propio destino, ni haber destinos repetidos, ni cero, ni más de 20', async () => {
    const origen = await guardar(t1, {})
    const copiar = (targets: { terminalId: string; editToken: string }[]) =>
      copyCustomerDisplayDesign({ venueId: venueA, staffId, source: { terminalId: t1, editToken: origen.editToken }, targets })

    await expect(copiar([{ terminalId: t1, editToken: origen.editToken }])).rejects.toMatchObject({
      statusCode: 400,
      code: 'SOURCE_IN_TARGETS',
    })
    await expect(
      copiar([
        { terminalId: t2, editToken: 'factory' },
        { terminalId: t2, editToken: 'factory' },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: 'DUPLICATE_TARGET' })
    await expect(copiar([])).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TARGETS' })
    const veintiuno = Array.from({ length: 21 }, (_, i) => ({ terminalId: `x${i}`, editToken: 'factory' }))
    await expect(copiar(veintiuno)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_TARGETS' })
  })

  // Resultado EXACTO, no «cualquier cosa menos deadlock»: la primera en tomar los dos candados gana; la segunda los
  // toma después, encuentra el token de SU origen ya cambiado y recibe el 409 del CAS. Nunca BUSY, nunca otro error.
  it('copiar A→B y B→A a la vez: una gana y la otra recibe CUSTOMER_DISPLAY_CONFLICT', async () => {
    const a = await guardar(t1, { welcomeText: 'A' })
    const b = await guardar(t2, { welcomeText: 'B' })

    const resultados = await Promise.allSettled([
      copyCustomerDisplayDesign({
        venueId: venueA,
        staffId,
        source: { terminalId: t1, editToken: a.editToken },
        targets: [{ terminalId: t2, editToken: b.editToken }],
      }),
      copyCustomerDisplayDesign({
        venueId: venueA,
        staffId,
        source: { terminalId: t2, editToken: b.editToken },
        targets: [{ terminalId: t1, editToken: a.editToken }],
      }),
    ])

    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const [perdedora] = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(perdedora.reason).toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_CONFLICT' })
  })

  // Misma regla que guardar y restablecer: esperar un candado de más es «vuelve a intentarlo», y TODO o NADA.
  it('un destino retenido más allá del tope: 409 BUSY y ningún destino escrito', async () => {
    const esperaOriginal = process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS
    process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS = '300'
    try {
      const origen = await guardar(t1, { welcomeText: 'Hola' })
      const { soltar, transaccion } = await retenerTerminal(t3)
      try {
        await expect(
          copyCustomerDisplayDesign({
            venueId: venueA,
            staffId,
            source: { terminalId: t1, editToken: origen.editToken },
            targets: [
              { terminalId: t2, editToken: 'factory' },
              { terminalId: t3, editToken: 'factory' },
            ],
          }),
        ).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_BUSY' })
      } finally {
        soltar()
        await transaccion
      }
      expect(await tokenDe(t2)).toBe('factory')
      expect(await tokenDe(t3)).toBe('factory')
    } finally {
      if (esperaOriginal === undefined) delete process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS
      else process.env.CUSTOMER_DISPLAY_LOCK_TIMEOUT_MS = esperaOriginal
    }
  })

  it('la copia deja UNA entrada por dispositivo ESCRITO, con qué campos cambió; una copia rechazada no deja ninguna', async () => {
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    await guardar(t3, { welcomeText: 'Hola', theme: 'DARK' })
    bitacora.mockClear()

    await copyCustomerDisplayDesign({
      venueId: venueA,
      staffId,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [
        { terminalId: t2, editToken: 'factory' },
        { terminalId: t3, editToken: await tokenDe(t3) },
      ],
    })
    expect(bitacora).toHaveBeenCalledTimes(2)
    expect(bitacora.mock.calls.map(([e]) => e)).toEqual([
      {
        staffId,
        venueId: venueA,
        action: 'CUSTOMER_DISPLAY_DESIGN_COPIED',
        entity: 'CustomerDisplayDesign',
        entityId: t2,
        data: { sourceTerminalId: t1, changedKeys: ['welcomeText'] },
      },
      {
        staffId,
        venueId: venueA,
        action: 'CUSTOMER_DISPLAY_DESIGN_COPIED',
        entity: 'CustomerDisplayDesign',
        entityId: t3,
        data: { sourceTerminalId: t1, changedKeys: ['theme'] },
      },
    ])
    // Qué CAMPOS cambiaron, nunca sus valores.
    expect(JSON.stringify(bitacora.mock.calls)).not.toContain('Hola')

    await copyCustomerDisplayDesign({
      venueId: venueA,
      staffId,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [{ terminalId: t2, editToken: 'factory' }], // t2 ya no está de fábrica: 409
    }).catch(() => undefined)
    expect(bitacora).toHaveBeenCalledTimes(2) // las dos de la copia buena; la rechazada no agregó ninguna
  })
})

describe('copiar SIN el plan de promos', () => {
  it('copia marca, textos y logo, y NO toca las imágenes ni el interruptor del destino', async () => {
    // Con plan, el destino tenía sus propias imágenes y promos prendidas; el origen, otras.
    const destino = await guardar(t2, { welcomeText: 'Destino', slides: [{ assetId: slideA2 }], showPromotions: true })
    const origen = await guardar(t1, { welcomeText: 'Hola', theme: 'DARK', slides: [{ assetId: slideA }] })

    sinPlanDePromos()
    const r = await copyCustomerDisplayDesign({
      venueId: venueA,
      staffId,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [{ terminalId: t2, editToken: destino.editToken }],
    })

    expect(r.promosOmitted).toBe(true)
    expect((await getCustomerDisplayForDashboard(venueA, t2)).design).toMatchObject({
      welcomeText: 'Hola',
      theme: 'DARK',
      slides: [{ assetId: slideA2 }], // las SUYAS
      showPromotions: true, // como estaba
    })
  })
})

// Codex r8 (remanente de P2-9): lo que el MCP enseña antes de confirmar tiene que ser lo que la copia HARÍA.
describe('la vista previa de la copia', () => {
  it('dice qué pasará en CADA destino (sin plan, que conserva sus imágenes) y no escribe nada', async () => {
    const destino = await guardar(t2, { slides: [{ assetId: slideA2 }] })
    const origen = await guardar(t1, { welcomeText: 'Hola', slides: [{ assetId: slideA }] })
    sinPlanDePromos()

    const vista = await previewCopyCustomerDisplay({
      venueId: venueA,
      source: { terminalId: t1, editToken: origen.editToken },
      targets: [
        { terminalId: t2, editToken: destino.editToken },
        { terminalId: t3, editToken: 'factory' },
      ],
    })

    expect(vista).toEqual({
      promosOmitted: true,
      origen: { editToken: origen.editToken, diseno: expect.objectContaining({ welcomeText: 'Hola', slides: [{ assetId: slideA }] }) },
      destinos: [
        { terminalId: t2, nombre: `Caja 2 ${suffix}`, conservaSusImagenes: true, imagenes: 1 },
        { terminalId: t3, nombre: `Caja 3 ${suffix}`, conservaSusImagenes: true, imagenes: 0 },
      ],
    })
    expect(await tokenDe(t2)).toBe(destino.editToken)
    expect(await tokenDe(t3)).toBe('factory')
  })

  it('un destino con token viejo se dice AHORA, con el mismo 409 que daría la copia', async () => {
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    await guardar(t2, { welcomeText: 'Mío' })
    await expect(
      previewCopyCustomerDisplay({
        venueId: venueA,
        source: { terminalId: t1, editToken: origen.editToken },
        targets: [{ terminalId: t2, editToken: 'factory' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_DISPLAY_CONFLICT', details: { conflicts: [t2] } })
  })

  it('un destino que la copia rechazaría por sus imágenes se rechaza ANTES de confirmar', async () => {
    sinPlanDePromos()
    const origen = await guardar(t1, { welcomeText: 'Hola' })
    const malo = await prisma.customerDisplayDesign.create({
      data: { terminalId: t3, slides: [{ assetId: slideB }] },
      select: { id: true, revision: true },
    })
    await expect(
      previewCopyCustomerDisplay({
        venueId: venueA,
        source: { terminalId: t1, editToken: origen.editToken },
        targets: [
          { terminalId: t2, editToken: 'factory' },
          { terminalId: t3, editToken: `${malo.id}:${malo.revision}` },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'ASSET_NOT_USABLE', details: { assetId: slideB, terminalId: t3 } })
  })
})
