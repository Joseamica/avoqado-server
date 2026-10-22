/**
 * El menú del proveedor no se puede quedar viejo.
 *
 * 🔴 Un menú desactualizado en Uber cuesta dinero de dos formas y ninguna FALLA: el cliente
 * paga el precio viejo (la diferencia la come el negocio), o pide algo que ya no existe y
 * hay que rechazar — y Uber revoca el acceso por debajo del 99% de inyección.
 */
jest.mock('@/services/delivery-channels/core/menuSnapshot.service', () => ({
  buildMenuSnapshot: jest.fn(),
}))

// El sincronizador resuelve el horario antes de publicar; sin esto la cascada consulta
// reservas de verdad. Se fija en ESTIMADO, que es el caso por defecto de un venue nuevo.
jest.mock('@/services/delivery-channels/core/deliveryHours.service', () => ({
  resolveDeliveryHours: jest.fn(async () => ({ horario: {}, fuente: 'ESTIMADO' })),
}))

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async () => true),
}))

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

import { createHash } from 'node:crypto'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { buildMenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import { DeliveryWriteNotSentError } from '@/services/delivery-channels/core/types'
import { Prisma } from '@prisma/client'

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { PLAZO_SIN_VEREDICTO_MS, syncChannelAvailability, syncChannelMenu } from '@/services/delivery-channels/core/menuSync.service'

const mockedSnapshot = buildMenuSnapshot as jest.Mock
const mockedAdapterFor = adapterFor as jest.Mock
const mockedHasAdapter = hasAdapter as jest.Mock
const mockedUpdate = (prisma as any).deliveryChannelLink.update as jest.Mock

const link = (overrides: any = {}): any => ({
  id: 'link1',
  venueId: 'venue1',
  provider: 'UBER_EATS',
  externalLocationId: 'store1',
  status: 'ACTIVE',
  autoSyncMenu: true,
  lastMenuHash: null,
  ...overrides,
})

/** El payload traducido: es lo que se hashea. */
const PAYLOAD = { items: [{ id: 'SKU-1', price_info: { price: 8950 } }] }

function adapter(publishOk = true) {
  return {
    buildMenuPayload: jest.fn(() => PAYLOAD),
    publishMenu: jest.fn(async () => ({ ok: publishOk, status: publishOk ? 204 : 400, raw: publishOk ? '' : 'menu rejected' })),
  }
}

describe('menuSync — el menú del proveedor sigue al de Avoqado', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedHasAdapter.mockReturnValue(true)
    mockedSnapshot.mockResolvedValue({ venueId: 'venue1', generatedAt: 'x', categories: [] })
    mockedUpdate.mockResolvedValue({})
  })

  it('🔴 publica cuando el menú cambió, y GUARDA la huella', async () => {
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)

    const r = await syncChannelMenu(link())

    expect(r.outcome).toBe('PUBLISHED')
    expect(a.publishMenu).toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastMenuHash: expect.any(String), lastMenuSyncAt: expect.any(Date) }) }),
    )
  })

  it('🔴 NO publica si nada cambió: `PUT /menus` reemplaza el menú entero', async () => {
    // Republicar cada 5 minutos un menú idéntico es tirar la escritura más peligrosa de la
    // integración contra el proveedor, gratis y sin motivo.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)
    const primera = await syncChannelMenu(link())
    const hash = mockedUpdate.mock.calls[0][0].data.lastMenuHash
    expect(primera.outcome).toBe('PUBLISHED')

    const r = await syncChannelMenu(link({ lastMenuHash: hash }))

    expect(r.outcome).toBe('UNCHANGED')
    expect(a.publishMenu).toHaveBeenCalledTimes(1) // la primera, no la segunda
  })

  it('🔴 si el proveedor RECHAZA el menú, la huella NO se guarda', async () => {
    // Guardarla haría que la siguiente pasada creyera que el proveedor ya lo tiene, y el
    // menú se quedaría viejo PARA SIEMPRE sin volver a intentarlo. Es el peor final posible:
    // silencioso y permanente.
    mockedAdapterFor.mockReturnValue(adapter(false))

    const r = await syncChannelMenu(link())

    expect(r.outcome).toBe('FAILED')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('🔴 `force` publica aunque la huella coincida — es para cuando el proveedor lo PIDE', async () => {
    // Si Uber manda `store.menu_refresh_request` es porque algo se le perdió. Discutirle con
    // nuestro registro sería confiar en él justo en el caso donde está mal.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)
    await syncChannelMenu(link())
    const hash = mockedUpdate.mock.calls[0][0].data.lastMenuHash

    const r = await syncChannelMenu(link({ lastMenuHash: hash }), { force: true })

    expect(r.outcome).toBe('PUBLISHED')
    expect(a.publishMenu).toHaveBeenCalledTimes(2)
  })

  it('un proveedor que no sabe publicar menú no es un error', async () => {
    mockedHasAdapter.mockReturnValue(false)
    expect((await syncChannelMenu(link({ provider: 'DELIVERECT' }))).outcome).toBe('NO_PUBLISHER')
  })

  it('🔴 la huella se saca del menú TRADUCIDO, no del snapshot interno', async () => {
    // Así, arreglar un bug del traductor republica el menú solo. Con el snapshot, el
    // proveedor se quedaría con el menú mal traducido hasta que alguien editara un producto
    // por casualidad — y nadie relacionaría una cosa con la otra.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)
    await syncChannelMenu(link())
    const hash1 = mockedUpdate.mock.calls[0][0].data.lastMenuHash

    // Mismo snapshot, traductor distinto (como si se hubiera corregido un precio mal mapeado)
    jest.clearAllMocks()
    mockedHasAdapter.mockReturnValue(true)
    mockedUpdate.mockResolvedValue({})
    const b = adapter()
    b.buildMenuPayload = jest.fn(() => ({ items: [{ id: 'SKU-1', price_info: { price: 9950 } }] })) as any
    mockedAdapterFor.mockReturnValue(b)

    const r = await syncChannelMenu(link({ lastMenuHash: hash1 }))

    expect(r.outcome).toBe('PUBLISHED') // detectó el cambio del TRADUCTOR
  })

  it('🔴 el force del pedido de menú de Uber republica aunque la huella sea igual', async () => {
    // Codex plan r1 #1: la regla nueva («una huella ya publicada no se vuelve a mandar») no puede comerse el `force`. Si Uber
    // PIDE el menú es porque de su lado se perdió.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)
    const igual = createHash('sha256').update(JSON.stringify(PAYLOAD)).digest('hex')

    const r = await syncChannelMenu(link({ lastMenuHash: igual }), { force: true })

    expect(r.outcome).toBe('PUBLISHED')
    expect(a.publishMenu).toHaveBeenCalledTimes(1)
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'link1' },
      data: { lastMenuHash: igual, lastMenuSyncAt: expect.any(Date) },
    })
  })

  it('Uber (sin revisión) sigue sellando con el 200 como hoy', async () => {
    // Su 2xx SÍ significa «publicado»: sella la huella en el acto, sin pendiente, sin candado de fila y sin tocar `config`.
    const a = adapter()
    mockedAdapterFor.mockReturnValue(a)

    const r = await syncChannelMenu(link())

    expect(r.outcome).toBe('PUBLISHED')
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: 'link1' },
      data: { lastMenuHash: expect.any(String), lastMenuSyncAt: expect.any(Date) },
    })
    expect((prisma as any).$queryRaw).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════
//  Menú en revisión: el proveedor contesta 2xx al POST y lo publicado lo dice un veredicto aparte
// ═════════════════════════════════════════════════════════════════════════════════════════
describe('menú en revisión (menuConRevision): sin sellar ni republicar hasta el veredicto', () => {
  const mockedQueryRaw = (prisma as any).$queryRaw as jest.Mock
  const mockedError = logger.error as jest.Mock

  /** La FILA vigente en la base. `SELECT … FOR UPDATE` devuelve una COPIA, como Prisma: quien la leyó no ve lo posterior. */
  let fila: { config: Record<string, any>; lastMenuHash: string | null }
  const huellaDe = (p: unknown) => createHash('sha256').update(JSON.stringify(p)).digest('hex')
  const H = huellaDe(PAYLOAD)
  const OTRO_PAYLOAD = { items: [{ id: 'SKU-1', price_info: { price: 9950 } }] }
  /** La copia del vínculo que trae una pasada del job (leída ANTES de publicar). */
  const copia = () => link({ provider: 'RAPPI', config: structuredClone(fila.config), lastMenuHash: fila.lastMenuHash })

  /** Lo que hace el veredicto (el procesador, Tarea 16): sella o rechaza la pendiente VIGENTE. */
  function veredicto(aprobado: boolean) {
    const p = fila.config.menuEnRevision
    if (!p) throw new Error('no hay pendiente: el veredicto no tendría qué resolver')
    if (aprobado) fila.lastMenuHash = p.huella
    fila.config = {
      ...fila.config,
      menuEnRevision: null,
      menuRechazado: aprobado ? null : { huella: p.huella, en: new Date().toISOString() },
    }
  }

  function conRevision(publicar: jest.Mock, payload: unknown = PAYLOAD) {
    const a = { menuConRevision: true, buildMenuPayload: jest.fn(() => payload), publishMenu: publicar }
    mockedAdapterFor.mockReturnValue(a)
    return a
  }
  // `any`: cada prueba arma su mock con otra forma de `problemas`; el tipo lo fija el contrato, no esta ayuda.
  const ok200 = (problemas: unknown[] = []): any => ({ ok: true, status: 200, raw: 'Menu updated and ready to be validated', problemas })

  beforeEach(() => {
    jest.clearAllMocks()
    mockedHasAdapter.mockReturnValue(true)
    mockedSnapshot.mockResolvedValue({ venueId: 'venue1', generatedAt: 'x', categories: [] })
    fila = { config: {}, lastMenuHash: null }
    mockedQueryRaw.mockReset().mockImplementation(async () => [structuredClone(fila)])
    mockedUpdate.mockReset().mockImplementation(async ({ data }: any) => {
      if (data.config !== undefined) fila.config = structuredClone(data.config)
      if ('lastMenuHash' in data) fila.lastMenuHash = data.lastMenuHash
      return {}
    })
  })

  it('🔴 con menuConRevision la pendiente se guarda ANTES del POST, con esa hora, y el 2xx no sella', async () => {
    let enElPost: any
    let horaDelPost = 0
    const publicar = jest.fn(async () => {
      enElPost = structuredClone(fila.config.menuEnRevision)
      horaDelPost = Date.now()
      return ok200()
    })
    conRevision(publicar)
    const antes = Date.now()

    const r = await syncChannelMenu(copia())

    expect(r.outcome).toBe('PUBLISHED')
    // La pendiente ya estaba en la base cuando salió el POST, con la hora tomada ANTES de mandarlo.
    expect(enElPost).toEqual({ huella: H, publicadaEn: expect.any(String) })
    expect(Date.parse(enElPost.publicadaEn)).toBeGreaterThanOrEqual(antes)
    expect(Date.parse(enElPost.publicadaEn)).toBeLessThanOrEqual(horaDelPost)
    expect((mockedQueryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/FOR UPDATE/)
    // El 2xx NO sella: «en revisión» no es «publicado».
    expect(fila.lastMenuHash).toBeNull()
    expect(fila.config.menuEnRevision).toEqual(enElPost)
    expect(mockedUpdate.mock.calls.some(([a]: any[]) => 'lastMenuHash' in a.data)).toBe(false)
  })

  it('🔴 el veredicto que llega mientras el POST sigue en vuelo encuentra la pendiente y no se pierde', async () => {
    // Codex plan r1 #3: con la pendiente escrita DESPUÉS del 2xx, un veredicto rápido no encontraba qué sellar.
    const publicar = jest.fn(async () => {
      expect(fila.config.menuEnRevision?.huella).toBe(H)
      veredicto(true)
      return ok200()
    })
    conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('PUBLISHED')

    // El 2xx no revive la pendiente que el veredicto ya resolvió.
    expect(fila.lastMenuHash).toBe(H)
    expect(fila.config.menuEnRevision).toBeNull()
    expect((await syncChannelMenu(copia())).outcome).toBe('UNCHANGED')
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it.each([400, 422])('%s de validación: limpia la pendiente (si sigue siendo la suya) y guarda la huella como rechazada', async status => {
    const motivos = [{ sku: 'TACO-1', problema: 'Rappi rechazó: All items must have a valid name' }]
    conRevision(jest.fn(async () => ({ ok: false, status, raw: '{"errors":[]}', problemas: motivos })))

    const r = await syncChannelMenu(copia())

    expect(r.outcome).toBe('FAILED')
    expect(fila.config.menuEnRevision).toBeNull()
    expect(fila.config.menuRechazado).toEqual({ huella: H, en: expect.any(String) })
    expect(fila.config.menuProblemas).toEqual({ en: expect.any(String), problemas: motivos })
    expect(fila.lastMenuHash).toBeNull()
  })

  it('400 cuando la pendiente ya NO es la suya: no la toca, y la huella rechazada sí queda anotada', async () => {
    // Mientras el POST viajaba, la pendiente cambió de dueño (otra publicación ya reservó la suya): limpiarla tiraría la
    // revisión de OTRO menú. El 400 sigue siendo un hecho sobre ESTA huella.
    const ajena = { huella: 'OTRA', publicadaEn: new Date(Date.now() + 1000).toISOString() }
    conRevision(
      jest.fn(async () => {
        fila.config = { ...fila.config, menuEnRevision: ajena }
        return { ok: false, status: 400, raw: '{}', problemas: [] }
      }),
    )

    await syncChannelMenu(copia())

    expect(fila.config.menuEnRevision).toEqual(ajena)
    expect(fila.config.menuRechazado).toEqual({ huella: H, en: expect.any(String) })
  })

  it.each([
    ['timeout', () => Promise.reject(new Error('The operation was aborted due to timeout'))],
    ['5xx', () => Promise.resolve({ ok: false, status: 503, raw: 'upstream', problemas: [] })],
  ])('🔴 %s del POST: la pendiente se queda y el veredicto que llega después la resuelve', async (_caso, respuesta) => {
    // Codex plan r2 #1: no se sabe si llegó. Limpiar aquí tiraba un veredicto genuino que llegaba después.
    const publicar = jest.fn(respuesta as () => Promise<any>)
    conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('FAILED')
    expect(fila.config.menuEnRevision).toEqual({ huella: H, publicadaEn: expect.any(String) })
    expect(fila.config.menuRechazado).toBeUndefined()

    // Mientras no haya veredicto, no se republica…
    expect((await syncChannelMenu(copia())).outcome).toBe('IN_REVIEW')
    // …y el veredicto que llega después encuentra la pendiente y la sella.
    veredicto(true)
    expect(fila.lastMenuHash).toBe(H)
    expect((await syncChannelMenu(copia())).outcome).toBe('UNCHANGED')
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it('🔴 rechazo local (status 0, sin red: menú vacío tras filtrar) limpia la pendiente; ya corregido, el menú se publica', async () => {
    // Codex plan r3 #1: el adaptador no salió a la red; ningún veredicto va a llegar. Conservar la pendiente dejaba el
    // menú bloqueado «en revisión» para siempre, aun corregido.
    const vacio = [{ sku: 'TACO-1', problema: 'Cuesta $0 y no tiene modificadores: Rappi lo rechaza.' }]
    const publicar = jest.fn(async () => ({ ok: false, status: 0, raw: 'El menú quedó vacío', problemas: vacio }))
    const a = conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('FAILED')
    expect(fila.config.menuEnRevision).toBeNull()
    expect(fila.config.menuRechazado).toBeUndefined() // no fue Rappi: no es una huella rechazada
    expect(fila.config.menuProblemas).toEqual({ en: expect.any(String), problemas: vacio })

    // El dueño corrige el producto: el menú nuevo sale.
    a.buildMenuPayload.mockReturnValue(OTRO_PAYLOAD)
    publicar.mockResolvedValue(ok200())
    expect((await syncChannelMenu(copia())).outcome).toBe('PUBLISHED')
    expect(fila.config.menuEnRevision).toEqual({ huella: huellaDe(OTRO_PAYLOAD), publicadaEn: expect.any(String) })
    expect(fila.config.menuProblemas).toEqual({ en: expect.any(String), problemas: [] })
  })

  it('🔴 dos pasadas encimadas con copias viejas: la segunda no republica una huella ya rechazada ni una ya aprobada', async () => {
    // Codex plan r3 #2: la reserva decide con lo leído BAJO CANDADO, no con la copia de la pasada.
    const vieja = copia() // sin pendiente, sin rechazo, sin huella
    const publicar = jest.fn(async () => ({ ok: false, status: 400, raw: '{}', problemas: [] }))
    conRevision(publicar)

    expect((await syncChannelMenu(vieja)).outcome).toBe('FAILED') // la primera recibe el 400
    expect((await syncChannelMenu(vieja)).outcome).toBe('REJECTED_UNCHANGED') // la segunda, con la copia de ANTES
    expect(publicar).toHaveBeenCalledTimes(1)

    // Lo mismo con una aprobada.
    fila = { config: {}, lastMenuHash: null }
    const otraVieja = copia()
    publicar.mockReset().mockResolvedValue(ok200())
    expect((await syncChannelMenu(otraVieja)).outcome).toBe('PUBLISHED')
    veredicto(true)
    expect((await syncChannelMenu(otraVieja)).outcome).toBe('UNCHANGED')
    expect(publicar).toHaveBeenCalledTimes(1)

    // Y con la otra pendiente todavía en vuelo: la segunda ve la reserva de la primera y no publica.
    fila = { config: {}, lastMenuHash: null }
    const terceraVieja = copia()
    let soltar!: () => void
    publicar.mockReset().mockImplementation(() => new Promise(ok => (soltar = () => ok(ok200()))))
    const primera = syncChannelMenu(terceraVieja)
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect((await syncChannelMenu(terceraVieja)).outcome).toBe('IN_REVIEW')
    soltar()
    expect((await primera).outcome).toBe('PUBLISHED')
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it('un fallo al pedir el token cuenta como "no salió" y limpia la pendiente', async () => {
    // `rappi.http` lo lanza como DeliveryWriteNotSentError('UNAVAILABLE'): se SABE que el proveedor no recibió nada.
    const publicar = jest.fn(async () => {
      throw new DeliveryWriteNotSentError('UNAVAILABLE', 'no se pudo obtener el token')
    })
    conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('FAILED')
    expect(fila.config.menuEnRevision).toBeNull()
    expect(fila.config.menuRechazado).toBeUndefined()

    // La siguiente pasada lo vuelve a intentar.
    publicar.mockReset().mockResolvedValue(ok200())
    expect((await syncChannelMenu(copia())).outcome).toBe('PUBLISHED')
  })

  it('🔴 con un menú en revisión nunca se republica, ni con cambios ni con force', async () => {
    fila.config = { menuEnRevision: { huella: 'VIEJA', publicadaEn: new Date(Date.now() - 60_000).toISOString() } }
    const publicar = jest.fn(async () => ok200())
    conRevision(publicar, OTRO_PAYLOAD) // el menú CAMBIÓ

    expect((await syncChannelMenu(copia())).outcome).toBe('IN_REVIEW')
    expect((await syncChannelMenu(copia(), { force: true })).outcome).toBe('IN_REVIEW')
    expect(publicar).not.toHaveBeenCalled()
    expect(fila.config.menuEnRevision.huella).toBe('VIEJA')

    // Y con una copia que NO ve la pendiente (la leyó antes de que otra pasada reservara): decide la fila bloqueada.
    const sinPendiente = link({ provider: 'RAPPI', config: {}, lastMenuHash: null })
    expect((await syncChannelMenu(sinPendiente, { force: true })).outcome).toBe('IN_REVIEW')
    expect(publicar).not.toHaveBeenCalled()
  })

  it('pasado el plazo sin veredicto avisa UNA vez con 🚨 y sigue sin sellar ni republicar', async () => {
    const publicadaEn = new Date(Date.now() - PLAZO_SIN_VEREDICTO_MS - 60_000).toISOString()
    fila.config = { menuEnRevision: { huella: H, publicadaEn } }
    const vieja = copia()
    const publicar = jest.fn(async () => ok200())
    conRevision(publicar)
    const avisos = () => mockedError.mock.calls.filter(([m]: string[]) => String(m).includes('🚨')).length

    expect((await syncChannelMenu(vieja)).outcome).toBe('IN_REVIEW')
    expect(avisos()).toBe(1)
    expect(fila.config.menuEnRevision).toEqual({ huella: H, publicadaEn, sinVeredictoAvisadoEn: expect.any(String) })

    // Ni con la copia nueva ni con la vieja (dos pasadas encimadas) se vuelve a avisar.
    expect((await syncChannelMenu(copia())).outcome).toBe('IN_REVIEW')
    expect((await syncChannelMenu(vieja)).outcome).toBe('IN_REVIEW')
    expect(avisos()).toBe(1)
    expect(fila.lastMenuHash).toBeNull()
    expect(publicar).not.toHaveBeenCalled()
  })

  it('dentro del plazo no avisa', async () => {
    fila.config = { menuEnRevision: { huella: H, publicadaEn: new Date(Date.now() - 60_000).toISOString() } }
    conRevision(jest.fn())

    expect((await syncChannelMenu(copia())).outcome).toBe('IN_REVIEW')
    expect(mockedError).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('🔴 una huella rechazada no se republica; un menú distinto sí', async () => {
    fila.config = { menuRechazado: { huella: H, en: new Date().toISOString() } }
    const publicar = jest.fn(async () => ok200())
    const a = conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('REJECTED_UNCHANGED')
    expect(publicar).not.toHaveBeenCalled()

    a.buildMenuPayload.mockReturnValue(OTRO_PAYLOAD)
    expect((await syncChannelMenu(copia())).outcome).toBe('PUBLISHED')
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it('los problemas (incluido el 400 con errors[]) quedan guardados', async () => {
    const redondeo = [{ sku: 'TACO-1', problema: 'precio 32.5 redondeado a 33: Rappi sólo acepta enteros' }]
    const publicar = jest.fn(async () => ok200(redondeo))
    const a = conRevision(publicar)

    await syncChannelMenu(copia())
    expect(fila.config.menuProblemas).toEqual({ en: expect.any(String), problemas: redondeo })

    // Otro menú, y Rappi lo rechaza con sus motivos: se guardan junto a los del mapeo.
    veredicto(true)
    a.buildMenuPayload.mockReturnValue(OTRO_PAYLOAD)
    const conMotivos = [...redondeo, { sku: 'product1', problema: 'Rappi rechazó: Invalid urls were found' }]
    publicar.mockResolvedValue({ ok: false, status: 400, raw: '{}', problemas: conMotivos } as any)
    await syncChannelMenu(copia())
    expect(fila.config.menuProblemas).toEqual({ en: expect.any(String), problemas: conMotivos })
  })
})

describe('disponibilidad — agotar y revivir productos', () => {
  const mockedFeature = venueHasFeatureAccess as jest.Mock
  const mockedProducts = (prisma as any).product.findMany as jest.Mock
  const mockedLinkUpdate = (prisma as any).deliveryChannelLink.update as jest.Mock

  const dec = (n: number) => new Prisma.Decimal(n)

  function adaptadorDisp(ok = true) {
    return { setItemSoldOut: jest.fn(async () => ({ ok, status: ok ? 200 : 400, raw: '' })) }
  }

  const mockedQueryRaw = (prisma as any).$queryRaw as jest.Mock
  const mockedTransaction = (prisma as any).$transaction as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    ;(hasAdapter as jest.Mock).mockReturnValue(true)
    mockedFeature.mockResolvedValue(true)
    mockedLinkUpdate.mockResolvedValue({})
    mockedQueryRaw.mockResolvedValue([{ config: {} }])
  })

  it('🔴 no pisa un cambio de config que llegó mientras se hablaba con el proveedor', async () => {
    // El canal se leyó al empezar la pasada (recargo 30 %). Mientras se agotaban productos en Uber,
    // el dueño subió su recargo a 40 %. Escribir la copia vieja devolvía el 30 % y la siguiente
    // publicación del menú cobraba el precio viejo. Sólo `soldOutSkus` es de esta función.
    // Y el candado se toma DESPUÉS de hablar con el proveedor: con la fila bloqueada durante el HTTP, el
    // dueño no podría guardar nada mientras Uber tarda en contestar.
    const transaccionesDuranteHttp: number[] = []
    const a = {
      setItemSoldOut: jest.fn(async () => {
        transaccionesDuranteHttp.push(mockedTransaction.mock.calls.length)
        return { ok: true, status: 200, raw: '' }
      }),
    }
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }]).mockResolvedValueOnce([])
    mockedQueryRaw.mockResolvedValue([{ config: { precios: { recargoPct: 40 }, soldOutSkus: [] } }])

    await syncChannelAvailability(link({ config: { precios: { recargoPct: 30 }, soldOutSkus: [] } }))

    expect(mockedLinkUpdate).toHaveBeenCalledWith({
      where: { id: 'link1' },
      data: { config: { precios: { recargoPct: 40 }, soldOutSkus: ['A'] } },
    })
    // Se relee BLOQUEANDO la fila, dentro de la misma transacción que escribe.
    expect(mockedTransaction).toHaveBeenCalledTimes(1)
    expect(mockedQueryRaw.mock.calls[0][0].join(' ')).toMatch(/FOR UPDATE/)
    expect(transaccionesDuranteHttp).toEqual([0])
  })

  it('si el canal ya no existe al escribir, no truena ni escribe', async () => {
    ;(adapterFor as jest.Mock).mockReturnValue(adaptadorDisp())
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }]).mockResolvedValueOnce([])
    mockedQueryRaw.mockResolvedValue([])

    await expect(syncChannelAvailability(link({ config: {} }))).resolves.toEqual({ agotados: 1, revividos: 0 })
    expect(mockedLinkUpdate).not.toHaveBeenCalled()
  })

  it('🔴 agota lo que se acabó y revive lo que volvió — sólo la DIFERENCIA', () => {
    // Repetir el estado de 96 productos cada 5 minutos serían 96 llamadas por nada.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }, { sku: 'B' }]).mockResolvedValueOnce([])

    return syncChannelAvailability(link({ config: { soldOutSkus: ['B', 'C'] } })).then(r => {
      expect(r).toEqual({ agotados: 1, revividos: 1 })
      expect(a.setItemSoldOut).toHaveBeenCalledWith('A', 'store1', true) // nuevo
      expect(a.setItemSoldOut).toHaveBeenCalledWith('C', 'store1', false) // volvió
      expect(a.setItemSoldOut).not.toHaveBeenCalledWith('B', 'store1', true) // ya estaba
    })
  })

  it('🔴 agota los platillos que NO SE PUEDEN HACER por falta de ingrediente', async () => {
    // Es el caso que de verdad pasa en una cocina: no se acaba "la hamburguesa", se acaba la
    // CARNE — y entonces todos los platillos que la llevan dejan de existir. Sin esto Uber
    // los sigue vendiendo y cada uno termina en un rechazo, que cuenta contra la tasa de
    // inyección que Uber exige para no revocar el acceso.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts
      .mockResolvedValueOnce([]) // (a) nada con inventario propio agotado
      .mockResolvedValueOnce([
        {
          sku: 'HAMBURGUESA',
          recipe: { portionYield: 1, lines: [{ quantity: dec(0.2), rawMaterial: { currentStock: dec(0), name: 'Carne' } }] },
        },
        {
          sku: 'ENSALADA',
          recipe: { portionYield: 1, lines: [{ quantity: dec(0.1), rawMaterial: { currentStock: dec(5), name: 'Lechuga' } }] },
        },
      ])

    const r = await syncChannelAvailability(link({ config: {} }))

    expect(r.agotados).toBe(1)
    expect(a.setItemSoldOut).toHaveBeenCalledWith('HAMBURGUESA', 'store1', true)
    expect(a.setItemSoldOut).not.toHaveBeenCalledWith('ENSALADA', 'store1', true)
  })

  it('🔴 la receta que RINDE VARIAS porciones no se agota de más', async () => {
    // Una receta de 2 kg de carne que rinde 10 porciones necesita 0.2 kg por porción. Con
    // 0.5 kg en bodega SÍ se pueden hacer. Dividir mal aquí esconde platillos que sí hay.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        sku: 'TACOS',
        recipe: { portionYield: 10, lines: [{ quantity: dec(2), rawMaterial: { currentStock: dec(0.5), name: 'Carne' } }] },
      },
    ])

    expect((await syncChannelAvailability(link({ config: {} }))).agotados).toBe(0)
    expect(a.setItemSoldOut).not.toHaveBeenCalled()
  })

  it('un ingrediente OPCIONAL que falte no agota el platillo', async () => {
    // Sale sin él. Contarlo agotaría platillos que sí se pueden preparar.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    // El servicio filtra `isOptional: false` en la consulta, así que un opcional NI SIQUIERA
    // llega: el test lo refleja devolviendo la receta ya sin él.
    mockedProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([{ sku: 'PLATO', recipe: { portionYield: 1, lines: [] } }])

    expect((await syncChannelAvailability(link({ config: {} }))).agotados).toBe(0)
  })

  it('🔴 sin INVENTORY_TRACKING no toca NADA: los números serían basura', async () => {
    // Agotar con base en stock que nadie mantiene ESCONDE productos de la app sin motivo,
    // que es peor que venderlos de más. [mercado] Square hace lo mismo: sólo marca agotado
    // el producto que tiene el seguimiento prendido.
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedFeature.mockResolvedValue(false)

    expect(await syncChannelAvailability(link())).toEqual({ agotados: 0, revividos: 0 })
    expect(mockedProducts).not.toHaveBeenCalled()
    expect(a.setItemSoldOut).not.toHaveBeenCalled()
  })

  it('🔴 si el proveedor RECHAZA agotar uno, no se registra como hecho', async () => {
    // Registrarlo haría que la siguiente pasada creyera que ya está agotado y nunca lo
    // reintentara: el proveedor seguiría vendiendo algo que no hay, para siempre.
    ;(adapterFor as jest.Mock).mockReturnValue(adaptadorDisp(false))
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }]).mockResolvedValueOnce([])

    await syncChannelAvailability(link({ config: {} }))

    expect(mockedLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ config: expect.objectContaining({ soldOutSkus: [] }) }) }),
    )
  })

  it('sin cambios no gasta ni una llamada', async () => {
    const a = adaptadorDisp()
    ;(adapterFor as jest.Mock).mockReturnValue(a)
    mockedProducts.mockResolvedValueOnce([{ sku: 'A' }]).mockResolvedValueOnce([])

    expect(await syncChannelAvailability(link({ config: { soldOutSkus: ['A'] } }))).toEqual({ agotados: 0, revividos: 0 })
    expect(a.setItemSoldOut).not.toHaveBeenCalled()
    expect(mockedLinkUpdate).not.toHaveBeenCalled()
  })
})
