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
import {
  aplicarVeredictoDeMenu,
  PLAZO_SIN_VEREDICTO_MS,
  syncChannelAvailability,
  syncChannelMenu,
} from '@/services/delivery-channels/core/menuSync.service'

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

  /** El veredicto REAL (Tarea 16), firmado ahora (después de la publicación): sella o rechaza la pendiente VIGENTE. */
  async function veredicto(aprobado: boolean) {
    if (!fila.config.menuEnRevision) throw new Error('no hay pendiente: el veredicto no tendría qué resolver')
    const enVuelo = fila.config.menuEnRevision.envioEnCurso === true
    const { resultado } = await aplicarVeredictoDeMenu(prisma as any, 'link1', { aprobado, firmadoEnMs: Date.now() })
    expect(resultado).toBe(enVuelo ? 'DIFERIDO' : aprobado ? 'SELLADO' : 'RECHAZO_ANOTADO')
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
    expect(enElPost).toEqual({ huella: H, publicadaEn: expect.any(String), envioEnCurso: true })
    expect(Date.parse(enElPost.publicadaEn)).toBeGreaterThanOrEqual(antes)
    expect(Date.parse(enElPost.publicadaEn)).toBeLessThanOrEqual(horaDelPost)
    expect((mockedQueryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/FOR UPDATE/)
    // El 2xx NO sella: «en revisión» no es «publicado».
    expect(fila.lastMenuHash).toBeNull()
    expect(fila.config.menuEnRevision).toEqual({ huella: H, publicadaEn: enElPost.publicadaEn })
    expect(mockedUpdate.mock.calls.some(([a]: any[]) => 'lastMenuHash' in a.data)).toBe(false)
  })

  it('🔴 el veredicto que llega mientras el POST sigue en vuelo encuentra la pendiente y no se pierde', async () => {
    // Codex plan r1 #3: con la pendiente escrita DESPUÉS del 2xx, un veredicto rápido no encontraba qué sellar.
    const publicar = jest.fn(async () => {
      expect(fila.config.menuEnRevision?.huella).toBe(H)
      await veredicto(true)
      expect(fila.lastMenuHash).toBeNull()
      expect(fila.config.menuEnRevision.veredictoAnticipado).toEqual({ aprobado: true, firmadoEnMs: expect.any(Number) })
      return ok200()
    })
    conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('PUBLISHED')

    // El 2xx aplica el veredicto guardado; nunca publica sin él.
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
    await veredicto(true)
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
    await veredicto(true)
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

  // T16b: tras reservar H, sólo un veredicto escribe `lastMenuHash`. Si al SOLTAR vale H, lo selló un aviso AJENO (de otra
  // publicación: el tardío de una pendiente soltada a mano, o el residual §4.5.1) mientras viajaba un POST que el proveedor
  // rechazó o que nunca salió. Quedaba «al día» un menú que el proveedor no tiene.
  it('🔴 un aviso ajeno sella la huella mientras su POST da 400: queda sin sellar y rechazada, y no se republica (sin bucle)', async () => {
    const publicar = jest.fn(async () => {
      await veredicto(true) // firmado DESPUÉS de reservar: la regla de la hora lo deja pasar
      expect(fila.lastMenuHash).toBeNull()
      return { ok: false, status: 400, raw: '{}', problemas: [] }
    })
    conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('FAILED')

    expect(fila.lastMenuHash).toBeNull()
    expect(fila.config.menuRechazado).toEqual({ huella: H, en: expect.any(String) })
    expect(fila.config.menuEnRevision).toBeNull()
    expect((await syncChannelMenu(copia())).outcome).toBe('REJECTED_UNCHANGED')
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['401', () => Promise.resolve({ ok: false, status: 401, raw: 'unauthorized', problemas: [] })],
    ['DeliveryWriteNotSentError', () => Promise.reject(new DeliveryWriteNotSentError('UNAVAILABLE', 'no se pudo obtener el token'))],
  ])(
    '🔴 un aviso ajeno sella la huella y el POST da %s: queda sin sellar y sin rechazo, y la siguiente pasada la republica',
    async (_c, respuesta) => {
      const publicar = jest.fn(async () => {
        await veredicto(true)
        return (respuesta as () => Promise<any>)()
      })
      conRevision(publicar)

      expect((await syncChannelMenu(copia())).outcome).toBe('FAILED')

      expect(fila.lastMenuHash).toBeNull()
      expect(fila.config.menuRechazado ?? null).toBeNull() // el veredicto ajeno lo dejó en null; nadie anotó un rechazo
      expect(fila.config.menuEnRevision).toBeNull()
      publicar.mockReset().mockResolvedValue(ok200())
      expect((await syncChannelMenu(copia())).outcome).toBe('PUBLISHED')
      expect(publicar).toHaveBeenCalledTimes(1)
    },
  )

  it('soltar no borra un sello que YA estaba antes de reservar (republicar con force lo que el proveedor ya aprobó)', async () => {
    // Con `force` la reserva acepta la huella ya sellada: ese sello no es de un aviso ajeno, es lo que el proveedor tiene.
    fila.lastMenuHash = H
    conRevision(jest.fn(async () => ({ ok: false, status: 401, raw: 'unauthorized', problemas: [] })))

    expect((await syncChannelMenu(copia(), { force: true })).outcome).toBe('FAILED')

    expect(fila.lastMenuHash).toBe(H)
    expect(fila.config.menuEnRevision).toBeNull()
  })

  it.each([
    ['400', () => Promise.resolve({ ok: false, status: 400, raw: '{}', problemas: [] })],
    ['401', () => Promise.resolve({ ok: false, status: 401, raw: 'unauthorized', problemas: [] })],
    ['status 0', () => Promise.resolve({ ok: false, status: 0, raw: 'sin red', problemas: [] })],
    ['NotSent', () => Promise.reject(new DeliveryWriteNotSentError('UNAVAILABLE', 'sin token'))],
  ])('🔴 Codex b2: aprobación anticipada + %s + limpieza sin DB nunca queda AL_DIA sin pendiente', async (_caso, respuesta) => {
    const publicar = jest.fn(async () => {
      await aplicarVeredictoDeMenu(prisma as any, 'link1', { aprobado: true, firmadoEnMs: Date.now() })
      ;(prisma.$transaction as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('base no disponible al limpiar')
      })
      return (respuesta as () => Promise<any>)()
    })
    conRevision(publicar)

    expect((await syncChannelMenu(copia())).outcome).toBe('FAILED')
    fila = structuredClone(fila) // reinicio: sólo sobrevive lo que quedó en la fila
    expect((await syncChannelMenu(copia())).outcome).toBe('IN_REVIEW')
    expect(fila.lastMenuHash).toBeNull()
    expect(fila.config.menuEnRevision?.huella).toBe(H)
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it('soltar elimina la pendiente y el veredicto anticipado en UNA transacción, con la fila bloqueada', async () => {
    let dentro = false
    const escrituras: Array<{ dentro: boolean; columnas: string[] }> = []
    const publicar = jest.fn(async () => {
      await veredicto(true)
      mockedQueryRaw.mockClear()
      ;(prisma.$transaction as jest.Mock).mockClear().mockImplementationOnce(async (cb: any) => {
        dentro = true
        try {
          return await cb(prisma)
        } finally {
          dentro = false
        }
      })
      const escribir = mockedUpdate.getMockImplementation()!
      mockedUpdate.mockImplementation(async (a: any) => {
        escrituras.push({ dentro, columnas: Object.keys(a.data) })
        return escribir(a)
      })
      return { ok: false, status: 400, raw: '{}', problemas: [] }
    })
    conRevision(publicar)

    await syncChannelMenu(copia())

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockedQueryRaw).toHaveBeenCalledTimes(1)
    expect((mockedQueryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/FOR UPDATE/)
    expect(escrituras).toEqual([{ dentro: true, columnas: ['config'] }])
  })

  it.each([
    ['2xx', () => Promise.resolve(ok200())],
    ['timeout', () => Promise.reject(new Error('timeout'))],
    ['5xx', () => Promise.resolve({ ok: false, status: 503, raw: 'upstream', problemas: [] })],
  ])('el veredicto anticipado se aplica al acabar un POST %s, también si fue rechazo', async (_caso, respuesta) => {
    for (const aprobado of [true, false]) {
      fila = { config: {}, lastMenuHash: null }
      conRevision(
        jest.fn(async () => {
          await veredicto(aprobado)
          expect(fila.lastMenuHash).toBeNull()
          return (respuesta as () => Promise<any>)()
        }),
      )
      await syncChannelMenu(copia())
      expect(fila.config.menuEnRevision).toBeNull()
      expect(fila.lastMenuHash).toBe(aprobado ? H : null)
      expect(fila.config.menuRechazado).toEqual(aprobado ? null : { huella: H, en: expect.any(String) })
    }
  })

  it('si falla finalizar un 2xx, sobreviven pendiente y veredicto sin sellar (no basta el 2xx)', async () => {
    conRevision(
      jest.fn(async () => {
        await veredicto(true)
        ;(prisma.$transaction as jest.Mock).mockImplementationOnce(async () => {
          throw new Error('DB no disponible')
        })
        return ok200()
      }),
    )
    expect((await syncChannelMenu(copia())).outcome).toBe('FAILED')
    expect(fila.lastMenuHash).toBeNull()
    expect(fila.config.menuEnRevision.veredictoAnticipado.aprobado).toBe(true)
    expect((await syncChannelMenu(copia())).outcome).toBe('IN_REVIEW')
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
    await veredicto(true)
    a.buildMenuPayload.mockReturnValue(OTRO_PAYLOAD)
    const conMotivos = [...redondeo, { sku: 'product1', problema: 'Rappi rechazó: Invalid urls were found' }]
    publicar.mockResolvedValue({ ok: false, status: 400, raw: '{}', problemas: conMotivos } as any)
    await syncChannelMenu(copia())
    expect(fila.config.menuProblemas).toEqual({ en: expect.any(String), problemas: conMotivos })
  })
})

// Tarea 16 (diseño §4.5.1): el aviso del veredicto no dice DE QUÉ menú es. Sólo se aplica a la pendiente publicada ANTES de que
// el proveedor lo firmara: un aviso duplicado o reprocesado, firmado antes de la publicación siguiente, no la toca. Sin
// tolerancia (Codex plan r1 #2): cualquier margen deja que un aviso viejo selle el menú siguiente.
describe('aplicarVeredictoDeMenu — el veredicto sólo aplica a la pendiente publicada antes de su firma', () => {
  const mockedQueryRaw = (prisma as any).$queryRaw as jest.Mock
  const mockedWarn = logger.warn as jest.Mock
  const PUBLICADA_EN = '2026-10-22T10:00:00.000Z'
  const publicadaMs = Date.parse(PUBLICADA_EN)
  const PENDIENTE = { huella: 'H-pendiente', publicadaEn: PUBLICADA_EN }

  /** La FILA vigente en la base; `SELECT … FOR UPDATE` devuelve una copia y el `update` la escribe. */
  let fila: { config: Record<string, any>; lastMenuHash: string | null; lastMenuSyncAt: Date | null }

  beforeEach(() => {
    jest.clearAllMocks()
    fila = { config: { menuEnRevision: PENDIENTE, note: 'del dueño' }, lastMenuHash: 'h-anterior', lastMenuSyncAt: null }
    mockedQueryRaw.mockReset().mockImplementation(async () => [structuredClone({ config: fila.config, lastMenuHash: fila.lastMenuHash })])
    mockedUpdate.mockReset().mockImplementation(async ({ data }: any) => {
      if (data.config !== undefined) fila.config = structuredClone(data.config)
      if ('lastMenuHash' in data) fila.lastMenuHash = data.lastMenuHash
      if ('lastMenuSyncAt' in data) fila.lastMenuSyncAt = data.lastMenuSyncAt
      return {}
    })
  })

  const aplicar = async (aprobado: boolean, firmadoEnMs: number | null) =>
    (await aplicarVeredictoDeMenu(prisma as any, 'link1', { aprobado, firmadoEnMs })).resultado

  it('T16b: devuelve también la hora de la publicación que juzgó (para medir el desfase del reloj, M7)', async () => {
    expect(await aplicarVeredictoDeMenu(prisma as any, 'link1', { aprobado: true, firmadoEnMs: publicadaMs + 1 })).toEqual({
      resultado: 'SELLADO',
      publicadaEn: PUBLICADA_EN,
    })
    fila.config = {}
    expect(await aplicarVeredictoDeMenu(prisma as any, 'link1', { aprobado: true, firmadoEnMs: publicadaMs + 1 })).toEqual({
      resultado: 'NO_APLICA',
      publicadaEn: null,
    })
  })

  it('🔴 aprobación firmada DESPUÉS de publicar la pendiente: la sella', async () => {
    fila.config.menuRechazado = { huella: 'H-vieja', en: 'x' }

    expect(await aplicar(true, publicadaMs + 90_000)).toBe('SELLADO')

    expect(fila.lastMenuHash).toBe('H-pendiente')
    expect(fila.lastMenuSyncAt).toEqual(expect.any(Date))
    // Aprobado: ya no hay pendiente, y un rechazo anterior deja de ser lo vigente. Lo del dueño no se toca.
    expect(fila.config).toEqual({ menuEnRevision: null, menuRechazado: null, note: 'del dueño' })
    expect((mockedQueryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/FOR UPDATE/)
  })

  it('firmada en el mismo milisegundo que la publicación: aplica (sólo lo firmado ANTES se descarta)', async () => {
    expect(await aplicar(true, publicadaMs)).toBe('SELLADO')
    expect(fila.lastMenuHash).toBe('H-pendiente')
  })

  it('🔴 aprobación firmada ANTES de publicar la pendiente (aviso viejo reprocesado): no la toca', async () => {
    // El aviso del menú ANTERIOR, reprocesado (o duplicado) después de que se publicó el siguiente: sellaría un menú que el
    // proveedor todavía no revisa. Un milisegundo antes basta: no hay tolerancia.
    const antes = structuredClone(fila)

    expect(await aplicar(true, publicadaMs - 1)).toBe('NO_APLICA')

    expect(fila).toEqual(antes)
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedWarn).toHaveBeenCalledWith(expect.stringContaining('firmado ANTES'), expect.objectContaining({ linkId: 'link1' }))
  })

  it('rechazo: limpia la pendiente y guarda la huella rechazada', async () => {
    expect(await aplicar(false, publicadaMs + 1_000)).toBe('RECHAZO_ANOTADO')

    expect(fila.config).toEqual({
      menuEnRevision: null,
      menuRechazado: { huella: 'H-pendiente', en: expect.any(String) },
      note: 'del dueño',
    })
    expect(Number.isNaN(Date.parse(fila.config.menuRechazado.en))).toBe(false)
    // Rechazado no es publicado: lo que estaba arriba sigue siendo lo último aprobado.
    expect(fila.lastMenuHash).toBe('h-anterior')
    expect(fila.lastMenuSyncAt).toBeNull()
  })

  it('🔴 rechazo firmado ANTES de publicar la pendiente: no la toca', async () => {
    // Un rechazo viejo reprocesado borraría la revisión del menú nuevo y lo marcaría rechazado sin que nadie lo haya visto.
    expect(await aplicar(false, publicadaMs - 60_000)).toBe('NO_APLICA')
    expect(fila.config.menuEnRevision).toEqual(PENDIENTE)
    expect(fila.config.menuRechazado).toBeUndefined()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it.each([true, false])('sin hora de firma legible no se aplica (aprobado: %p)', async aprobado => {
    expect(await aplicar(aprobado, null)).toBe('NO_APLICA')
    expect(fila.config.menuEnRevision).toEqual(PENDIENTE)
    expect(fila.lastMenuHash).toBe('h-anterior')
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedWarn).toHaveBeenCalledWith(expect.stringContaining('sin hora de firma'), expect.objectContaining({ linkId: 'link1' }))
  })

  it('una pendiente con la hora ilegible no se puede comparar: no se aplica', async () => {
    fila.config.menuEnRevision = { huella: 'H-pendiente', publicadaEn: 'no-es-fecha' }
    expect(await aplicar(true, publicadaMs + 1_000)).toBe('NO_APLICA')
    expect(fila.lastMenuHash).toBe('h-anterior')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('aprobación sin pendiente: sólo la fecha', async () => {
    fila.config = { note: 'del dueño' }

    expect(await aplicar(true, publicadaMs + 1_000)).toBe('NO_APLICA')

    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    expect(mockedUpdate.mock.calls[0][0]).toEqual({ where: { id: 'link1' }, data: { lastMenuSyncAt: expect.any(Date) } })
    expect(fila.lastMenuHash).toBe('h-anterior')
    expect(fila.config).toEqual({ note: 'del dueño' })
  })

  it('rechazo sin pendiente: no hay qué anotar, pero queda a la vista (warn)', async () => {
    // T16b: el proveedor rechazó ALGO y no hay pendiente que lo explique: con `info` nadie se enteraba.
    fila.config = {}
    expect(await aplicar(false, publicadaMs + 1_000)).toBe('NO_APLICA')
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedWarn).toHaveBeenCalledWith(expect.stringContaining('sin pendiente'), expect.objectContaining({ aprobado: false }))
  })

  it('aprobación sin pendiente: sin warn (una publicación a mano lo explica)', async () => {
    fila.config = {}
    await aplicar(true, publicadaMs + 1_000)
    expect(mockedWarn).not.toHaveBeenCalled()
  })

  it('el vínculo ya no existe: no escribe nada', async () => {
    mockedQueryRaw.mockReset().mockResolvedValue([])
    expect(await aplicar(true, publicadaMs + 1_000)).toBe('NO_APLICA')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('🔴 lee y escribe con la transacción que RECIBE (la del procesador), no con una propia', async () => {
    // Así el cierre del evento entra en la MISMA transacción que el veredicto (Codex r3 #1).
    const tx = {
      $queryRaw: jest.fn(async () => [{ config: { menuEnRevision: PENDIENTE }, lastMenuHash: null }]),
      deliveryChannelLink: { update: jest.fn() },
    }

    expect((await aplicarVeredictoDeMenu(tx as any, 'link1', { aprobado: true, firmadoEnMs: publicadaMs + 1_000 })).resultado).toBe(
      'SELLADO',
    )

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.deliveryChannelLink.update).toHaveBeenCalled()
    expect(mockedQueryRaw).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
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
