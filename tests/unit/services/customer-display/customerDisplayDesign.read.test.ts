// tests/unit/services/customer-display/customerDisplayDesign.read.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { NotFoundError, ValidationError } from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import {
  CACHE_MAX_ENTRIES,
  cacheSizeForTests,
  editTokenOf,
  getCustomerDisplayForDashboard,
  getEffectiveDesign,
  invalidateCustomerDisplayCache,
  previewCustomerDisplay,
} from '@/services/customer-display/customerDisplayDesign.service'
import { resetVenuePlanSnapshotsForTests } from '@/services/customer-display/venuePlanSnapshot'
import { vuelosPorLlave } from '@/services/customer-display/customerDisplayCache'

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(async (_venueId: string, code: string) => code !== 'CUSTOMER_DISPLAY_PROMOS'),
  // F0-B (Task 4): el camino `cache: true` lee el plan del snapshot por venue.
  getVenuePlanInfo: jest.fn(async () => ({ tier: 'FREE', grandfathered: false, exempt: false })),
}))
jest.mock('@/services/customer-display/storageOrigins', () => ({
  ...jest.requireActual('@/services/customer-display/storageOrigins'),
  configuredStorageBucket: jest.fn(() => 'bucket-de-prueba.appspot.com'),
}))

const VENUE = 'venue-a'
const TERMINAL = 'terminal-1'
const accesoAlPlan = venueHasFeatureAccess as jest.Mock

const terminalRow = (over: Record<string, unknown> = {}) => ({
  id: TERMINAL,
  venueId: VENUE,
  name: 'Caja 1',
  type: 'POS_ANDROID',
  customerDisplayDesignVersion: 2,
  customerDisplayPresent: true,
  customerDisplayInvertible: true,
  displayModeProtocolVersion: 1,
  capabilitiesObservedAt: new Date(),
  customerDisplayInverted: false,
  customerDisplayRequest: null,
  customerDisplayRequestVersion: null,
  customerDisplayAck: null,
  customerDisplayInstallationId: null,
  customerDisplayInstallationSwitches: null,
  lastHeartbeat: new Date(),
  venue: { logo: null, updatedAt: new Date('2026-09-01T00:00:00Z') },
  customerDisplayDesign: null,
  ...over,
})

/** Una promesa que la prueba resuelve cuando quiere: sirve para meter una invalidación A MITAD de un cálculo. */
function diferida<T>() {
  let resolver!: (v: T) => void
  const promesa = new Promise<T>(r => (resolver = r))
  return { promesa, resolver }
}

beforeEach(() => {
  invalidateCustomerDisplayCache(TERMINAL)
  resetVenuePlanSnapshotsForTests()
  accesoAlPlan.mockClear()
  // `clearAllMocks` (setup global) NO restaura implementaciones: una prueba que cambie el plan no puede contaminar a la siguiente.
  accesoAlPlan.mockImplementation(async (_venueId: string, code: string) => code !== 'CUSTOMER_DISPLAY_PROMOS')
  prismaMock.terminal.findFirst.mockResolvedValue(terminalRow() as any)
  prismaMock.customerDisplayAsset.findMany.mockResolvedValue([] as any)
})

describe('la lectura está acotada al negocio de la ruta', () => {
  it('una terminal de otro negocio da 404, idéntico a una inexistente', async () => {
    // La base simulada responde como Postgres: la terminal vive SÓLO en VENUE, y un `where` sin venue la encontraría.
    prismaMock.terminal.findFirst.mockImplementation(async ({ where }: any) =>
      where?.id === TERMINAL && (where?.venueId === undefined || where?.venueId === VENUE) ? (terminalRow() as any) : null,
    )

    const deOtroNegocio = await getCustomerDisplayForDashboard('venue-b', TERMINAL).catch(e => e)
    const inexistente = await getCustomerDisplayForDashboard('venue-b', 'no-existe').catch(e => e)

    expect(deOtroNegocio).toBeInstanceOf(NotFoundError)
    expect(inexistente).toBeInstanceOf(NotFoundError)
    // INDISTINGUIBLES: misma clase, mismo estado, mismo mensaje, mismo código. Si difirieran, confirmaríamos que el id existe.
    expect({ status: deOtroNegocio.statusCode, message: deOtroNegocio.message, code: deOtroNegocio.code }).toEqual({
      status: inexistente.statusCode,
      message: inexistente.message,
      code: inexistente.code,
    })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: TERMINAL, venueId: 'venue-b' } }))
    // El 404 se decide ANTES de leer el plan: una terminal ajena no puede costar (ni revelar) una consulta de plan.
    expect(accesoAlPlan).not.toHaveBeenCalled()
  })

  it('una terminal que no es POS_ANDROID da 422, no 404: existe, pero no tiene esa pantalla', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminalRow({ type: 'TPV_ANDROID' }) as any)
    const error = await getCustomerDisplayForDashboard(VENUE, TERMINAL).catch(e => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({ statusCode: 422, code: 'CUSTOMER_DISPLAY_NOT_SUPPORTED' })
    // También el 422 se decide antes del plan.
    expect(accesoAlPlan).not.toHaveBeenCalled()
  })
})

describe('editToken', () => {
  it('sin diseño es «factory»; con diseño es id:revisión', () => {
    expect(editTokenOf(null)).toBe('factory')
    expect(editTokenOf({ id: 'd1', revision: 3 })).toBe('d1:3')
  })
})

describe('el GET del dashboard', () => {
  it('entrega el diseño, su token, la ficha, los permisos de plan y el estado del aparato', async () => {
    const vista = await getCustomerDisplayForDashboard(VENUE, TERMINAL)

    expect(vista.editToken).toBe('factory')
    // Sin `CUSTOMER_DISPLAY_PROMOS` caen las DOS: las tarjetas exigen ese código Y `PROMOTIONS`.
    expect(vista.entitlements).toEqual({ slides: false, promotionCards: false })
    expect(vista.ficha.fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(vista.device.presence).toBe('SUPPORTED')
    expect(vista.device.designVersion).toBe(2)
  })

  it('consulta el plan UNA vez por operación: dos códigos, dos llamadas, ni una más', async () => {
    await getCustomerDisplayForDashboard(VENUE, TERMINAL)
    expect(accesoAlPlan).toHaveBeenCalledTimes(2)
  })

  it('NO usa la caché: lo que se acaba de guardar se tiene que ver', async () => {
    await getCustomerDisplayForDashboard(VENUE, TERMINAL)
    await getCustomerDisplayForDashboard(VENUE, TERMINAL)
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
  })

  it('un JSON de slides persistido con más de 4 no se carga entero: la lectura está acotada', async () => {
    const muchas = Array.from({ length: 50 }, (_, i) => ({ assetId: `s${i}` }))
    prismaMock.terminal.findFirst.mockResolvedValue(terminalRow({ customerDisplayDesign: disenoCon({ slides: muchas }) }) as any)
    await getCustomerDisplayForDashboard(VENUE, TERMINAL)
    const [{ where }] = prismaMock.customerDisplayAsset.findMany.mock.calls[0] as any
    expect(where.id.in.length).toBeLessThanOrEqual(5) // 4 slides + 1 logo
  })

  // Spec §5.2: cada activo se revalida al LEER, y el que no cumple se omite y se reporta en el GET.
  it('reporta en assetRejected el activo de OTRO negocio y el del kind equivocado, y no los pinta', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(
      terminalRow({ customerDisplayDesign: disenoCon({ logoAssetId: 'logo-ajeno', slides: [{ assetId: 'es-un-logo' }] }) }) as any,
    )
    prismaMock.customerDisplayAsset.findMany.mockResolvedValue([
      { id: 'logo-ajeno', venueId: 'venue-b', kind: 'LOGO', objectPath: 'dev/customer-display-assets/venue-b/a.png', sha256: 'aa' },
      { id: 'es-un-logo', venueId: VENUE, kind: 'LOGO', objectPath: 'dev/customer-display-assets/venue-a/b.png', sha256: 'bb' },
    ] as any)

    const vista = await getCustomerDisplayForDashboard(VENUE, TERMINAL)

    // Dos capas: la consulta ya se acota al venue de la terminal, y aun si la base devolviera una fila ajena (el mock
    // la devuelve sin mirar el `where`), la revalidación la omite y la reporta.
    expect(prismaMock.customerDisplayAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE }) }),
    )
    expect([...vista.assetRejected].sort()).toEqual(['es-un-logo', 'logo-ajeno'])
    expect(vista.ficha.logo).toBeNull() // el negocio no tiene logo propio: sin el activo ajeno, no queda ninguno
  })

  // Spec §6.1 y §12 («el estado del aparato muestra latido y presencia por separado, cada uno con su fecha»).
  it('el estado del aparato da latido y presencia POR SEPARADO, cada uno con su fecha, y el ack tal cual', async () => {
    const latido = new Date('2026-09-23T15:00:00Z')
    const observado = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) // hace 8 días: la regla de 7 la vuelve desconocida
    const ack = { fingerprint: 'abc', seq: 3, receivedAt: '2026-09-23T14:00:00.000Z' }
    prismaMock.terminal.findFirst.mockResolvedValue(
      terminalRow({ lastHeartbeat: latido, capabilitiesObservedAt: observado, customerDisplayAck: ack }) as any,
    )

    const { device } = await getCustomerDisplayForDashboard(VENUE, TERMINAL)

    expect(device.lastHeartbeat).toBe(latido.toISOString())
    expect(device.capabilitiesObservedAt).toBe(observado.toISOString())
    expect(device.presence).toBe('UNKNOWN') // un latido fresco NO vuelve fresca una presencia vieja
    expect(device.stale).toBe(true)
    expect(device.ack).toEqual(ack) // el dashboard decide «Pendiente» al leer, contra la huella vigente de esta misma vista
  })
})

// Spec §5.3 (B13): las tarjetas exigen `CUSTOMER_DISPLAY_PROMOS` Y `PROMOTIONS`; el carrusel, sólo el primero.
describe('las tarjetas de promociones exigen CUSTOMER_DISPLAY_PROMOS y PROMOTIONS', () => {
  const conCodigos = (codigos: string[]) => accesoAlPlan.mockImplementation(async (_v: string, code: string) => codigos.includes(code))

  beforeEach(() => {
    // Aparato que SÍ entiende el carrusel y diseño con las promos prendidas: lo único que decide es el plan.
    prismaMock.terminal.findFirst.mockResolvedValue(terminalRow({ customerDisplayDesign: disenoCon({ showPromotions: true }) }) as any)
  })

  it('PRO sin PROMOTIONS: hay carrusel, pero NO tarjetas', async () => {
    conCodigos(['CUSTOMER_DISPLAY_PROMOS'])
    const vista = await getCustomerDisplayForDashboard(VENUE, TERMINAL)
    expect(vista.entitlements).toEqual({ slides: true, promotionCards: false })
    expect(vista.ficha.promotionCards.enabled).toBe(false)
  })

  it('gratis CON PROMOTIONS: tampoco hay tarjetas (ni carrusel)', async () => {
    conCodigos(['PROMOTIONS'])
    const vista = await getCustomerDisplayForDashboard(VENUE, TERMINAL)
    expect(vista.entitlements).toEqual({ slides: false, promotionCards: false })
    expect(vista.ficha.promotionCards.enabled).toBe(false)
  })

  it('con los DOS códigos las tarjetas sí salen (el control: sin él, «nunca hay tarjetas» pasaría las dos de arriba)', async () => {
    conCodigos(['CUSTOMER_DISPLAY_PROMOS', 'PROMOTIONS'])
    const vista = await getCustomerDisplayForDashboard(VENUE, TERMINAL)
    expect(vista.entitlements).toEqual({ slides: true, promotionCards: true })
    expect(vista.ficha.promotionCards.enabled).toBe(true)
  })
})

// Spec §5.7.2 y §6.1: la instalación cambió 3 o más veces en 24 h ⇒ «¿Copiaste la app a otra tablet?».
describe('el aviso de instalaciones', () => {
  const haceHoras = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

  it('tres cambios de instalación en 24 h encienden el aviso', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(
      terminalRow({ customerDisplayInstallationSwitches: [haceHoras(20), haceHoras(5), haceHoras(1)] }) as any,
    )
    expect((await getCustomerDisplayForDashboard(VENUE, TERMINAL)).device.installationWarning).toBe(true)
  })

  it('dos en 24 h, tres con uno de hace más de 24 h, o ninguno, NO lo encienden', async () => {
    prismaMock.terminal.findFirst
      .mockResolvedValueOnce(terminalRow({ customerDisplayInstallationSwitches: [haceHoras(5), haceHoras(1)] }) as any)
      .mockResolvedValueOnce(terminalRow({ customerDisplayInstallationSwitches: [haceHoras(30), haceHoras(5), haceHoras(1)] }) as any)
      .mockResolvedValueOnce(terminalRow({ customerDisplayInstallationSwitches: null }) as any)

    expect((await getCustomerDisplayForDashboard(VENUE, TERMINAL)).device.installationWarning).toBe(false)
    expect((await getCustomerDisplayForDashboard(VENUE, TERMINAL)).device.installationWarning).toBe(false)
    expect((await getCustomerDisplayForDashboard(VENUE, TERMINAL)).device.installationWarning).toBe(false)
  })
})

describe('la caché de la ficha (la que sirve al poll)', () => {
  it('una segunda lectura dentro de los 60 s no vuelve a la base', async () => {
    await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1)
  })

  it('una entrada VENCIDA no se entrega', async () => {
    const ahora = jest.spyOn(Date, 'now')
    // En `finally`: si una aserción cae, el reloj falso no se queda puesto para las pruebas que siguen.
    try {
      ahora.mockReturnValue(1_000_000)
      await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
      ahora.mockReturnValue(1_000_000 + 60_001)
      await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
      expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
    } finally {
      ahora.mockRestore()
    }
  })

  it('la llave lleva el VENUE: tras un traslado, la ficha del venue viejo no se entrega', async () => {
    await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    prismaMock.terminal.findFirst.mockResolvedValue(terminalRow({ venueId: 'venue-b' }) as any)
    await getEffectiveDesign('venue-b', TERMINAL, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
  })

  // Codex 14-oct (P3): con UNA sola entrada preparada, un borrado que sólo quitara la primera coincidencia también pasaba.
  // Aquí hay DOS entradas de la misma terminal (venues distintos) y una de OTRA terminal.
  it('invalidar por terminal tira TODAS sus entradas, sin importar el venue, y NO toca las de otra terminal', async () => {
    const OTRA = 'terminal-2'
    invalidateCustomerDisplayCache(OTRA) // otras pruebas del archivo pudieron dejar entradas suyas
    await getEffectiveDesign('venue-a', TERMINAL, { cache: true })
    await getEffectiveDesign('venue-b', TERMINAL, { cache: true })
    await getEffectiveDesign('venue-a', OTRA, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(3) // las tres salieron de la base y quedaron guardadas

    prismaMock.terminal.findFirst.mockClear()
    invalidateCustomerDisplayCache(TERMINAL)

    // Las DOS entradas de la terminal invalidada vuelven a la base…
    await getEffectiveDesign('venue-a', TERMINAL, { cache: true })
    await getEffectiveDesign('venue-b', TERMINAL, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
    // …y la de la otra terminal sigue guardada: invalidar una terminal no vacía la caché de las demás.
    await getEffectiveDesign('venue-a', OTRA, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
    invalidateCustomerDisplayCache(OTRA)
  })

  // 🔴 El caso que la v1 perdía: el cálculo empezó ANTES de la invalidación y termina DESPUÉS.
  it('un cálculo que empezó antes de una invalidación NO se guarda al terminar', async () => {
    const lenta = diferida<unknown>()
    prismaMock.terminal.findFirst.mockReturnValueOnce(lenta.promesa as any)
    const enVuelo = getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    invalidateCustomerDisplayCache(TERMINAL) // p. ej. se guardó un diseño mientras tanto
    lenta.resolver(terminalRow())
    await enVuelo

    await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2) // la segunda NO salió de la caché
  })

  it('la caché tiene tope: por muchas terminales que se lean, no pasa de CACHE_MAX_ENTRIES', async () => {
    for (let i = 0; i < CACHE_MAX_ENTRIES + 25; i++) {
      prismaMock.terminal.findFirst.mockResolvedValueOnce(terminalRow({ id: `t${i}` }) as any)
      await getEffectiveDesign(VENUE, `t${i}`, { cache: true })
    }
    expect(cacheSizeForTests().entradas).toBeLessThanOrEqual(CACHE_MAX_ENTRIES)
  })

  it('invalidar miles de terminales que nadie calculó no hace crecer NINGUNA estructura', async () => {
    for (let i = 0; i < 5_000; i++) invalidateCustomerDisplayCache(`nadie-${i}`)
    expect(cacheSizeForTests().enVuelo).toBe(0)
  })

  // Un cálculo puede tardar lo que sea: la protección no puede caducar por reloj.
  it('un cálculo que se resuelve MUCHO después de su invalidación tampoco se guarda', async () => {
    const lenta = diferida<unknown>()
    prismaMock.terminal.findFirst.mockReturnValueOnce(lenta.promesa as any)
    const enVuelo = getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    invalidateCustomerDisplayCache(TERMINAL)
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000) // 10 minutos después
    try {
      for (let i = 0; i < 30; i++) await getEffectiveDesign(VENUE, `otra-${i}`, { cache: true }) // otras terminales purgan
      lenta.resolver(terminalRow())
      await enVuelo
    } finally {
      reloj.mockRestore()
    }

    await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1 + 30 + 1) // la última NO salió de la caché
  })
})

describe('la caché: lo que se entrega y cuánto dura en la fila', () => {
  // 🔴 Cada acierto devuelve el MISMO objeto (y el que lo calculó recibe justo el que se guardó): si alguien lo
  // mutara, lo verían todos los que lean esa terminal durante 60 s. Congelado, la mutación truena en vez de envenenar.
  it('el valor en caché está congelado a fondo: ni quien lo calculó ni un acierto posterior pueden mutarlo', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(
      terminalRow({ customerDisplayDesign: disenoCon({ accentColor: '#3FB950', showPromotions: true }) }) as any,
    )
    const calculado = await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    const acierto = await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1) // el segundo SÍ salió de la caché

    for (const { ficha, assetRejected } of [calculado, acierto]) {
      expect(() => ((ficha as any).welcomeText = 'mutado')).toThrow(TypeError)
      expect(() => (ficha.slides as any[]).push({ url: 'x', sha256: 'y' })).toThrow(TypeError)
      expect(() => ((ficha.promotionCards as any).enabled = true)).toThrow(TypeError)
      expect(() => ((ficha.accent as any).color = '#000000')).toThrow(TypeError)
      expect(() => (assetRejected as string[]).push('x')).toThrow(TypeError)
    }
    expect((await getEffectiveDesign(VENUE, TERMINAL, { cache: true })).ficha.welcomeText).toBeNull()
  })

  // 🔴 `Map.set` sobre una llave que ya existe conserva su lugar en la fila: un valor recién guardado se quedaría
  // donde estaba el viejo y el tope lo tiraría primero, antes que entradas más viejas de verdad.
  it('un valor que se vuelve a guardar pasa al FINAL de la fila: el tope no tira lo recién refrescado', async () => {
    // Una hora en el futuro: todo lo que dejaron las pruebas anteriores ya venció y la primera purga lo barre.
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000)
    try {
      const primero = diferida<unknown>()
      const segundo = diferida<unknown>()
      prismaMock.terminal.findFirst.mockReturnValueOnce(primero.promesa as any).mockReturnValueOnce(segundo.promesa as any)
      const calculo1 = getEffectiveDesign(VENUE, TERMINAL, { cache: true })
      // F0-B (Task 4): con «un solo cálculo por llave», el segundo pedido se UNIRÍA al primero y por la API pública ya no
      // hay dos cálculos de la misma llave y generación. Se suelta el registro a mano para forzar el caso que el `delete`
      // previo a `purgar` sigue protegiendo (defensa), sin cambiar lo que la prueba afirma.
      vuelosPorLlave.delete(`${TERMINAL}:${VENUE}`)
      const calculo2 = getEffectiveDesign(VENUE, TERMINAL, { cache: true }) // dos cálculos de la MISMA llave en vuelo
      primero.resolver(terminalRow())
      await calculo1 // la llave entra primero: es la más vieja de la fila

      for (let i = 0; i < CACHE_MAX_ENTRIES - 2; i++) await getEffectiveDesign(VENUE, `relleno-${i}`, { cache: true })
      segundo.resolver(terminalRow())
      await calculo2 // la MISMA llave se vuelve a guardar, fresca: tiene que irse al final de la fila

      await getEffectiveDesign(VENUE, 'extra-1', { cache: true }) // la caché llega al tope
      await getEffectiveDesign(VENUE, 'extra-2', { cache: true }) // y el tope tira a la más vieja

      const lecturasAntes = prismaMock.terminal.findFirst.mock.calls.length
      await getEffectiveDesign(VENUE, TERMINAL, { cache: true })
      expect(prismaMock.terminal.findFirst.mock.calls.length).toBe(lecturasAntes) // sigue en caché: lo tirado fue `relleno-0`
    } finally {
      reloj.mockRestore()
    }
  })
})

describe('la vista previa', () => {
  it('devuelve la ficha del borrador, repite el previewSeq del editor y NO escribe nada', async () => {
    const { ficha, previewSeq } = await previewCustomerDisplay(VENUE, TERMINAL, { welcomeText: 'Hola, pasa' }, 7)

    expect(ficha.welcomeText).toBe('Hola, pasa')
    expect(previewSeq).toBe(7)
    expect(prismaMock.customerDisplayDesign.update).not.toHaveBeenCalled()
    expect(prismaMock.customerDisplayDesign.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.customerDisplayDesign.create).not.toHaveBeenCalled()
  })

  // Auditoría de Codex, 7ª ronda (P2-12): la respuesta de la petición VIEJA llega después y NO debe ganar.
  it('dos borradores que terminan en orden INVERTIDO conservan cada uno el número de SU petición', async () => {
    const lenta = diferida<unknown>()
    prismaMock.terminal.findFirst.mockReturnValueOnce(lenta.promesa as any)
    const vieja = previewCustomerDisplay(VENUE, TERMINAL, { welcomeText: 'Vieja' }, 1)
    const nueva = await previewCustomerDisplay(VENUE, TERMINAL, { welcomeText: 'Nueva' }, 2)
    lenta.resolver(terminalRow())
    const tardia = await vieja

    expect(nueva.previewSeq).toBe(2)
    expect(tardia.previewSeq).toBe(1) // el editor la descarta: 1 < 2
  })

  it('aplica las MISMAS reglas que guardar: un borrador inválido se rechaza', async () => {
    await expect(previewCustomerDisplay(VENUE, TERMINAL, { accentColor: 'azul' }, 1)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('aplica el candado de plan: sin PRO, una imagen nueva ni siquiera se puede previsualizar', async () => {
    await expect(previewCustomerDisplay(VENUE, TERMINAL, { slides: [{ assetId: 'nueva' }] }, 1)).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  // Spec §5.5: la vista previa «valida la propiedad de los activos», igual que la ficha guardada.
  it('revalida la PROPIEDAD de los activos: el logo de otro negocio no se pinta; el propio sí', async () => {
    prismaMock.customerDisplayAsset.findMany.mockResolvedValue([
      { id: 'logo-ajeno', venueId: 'venue-b', kind: 'LOGO', objectPath: 'dev/customer-display-assets/venue-b/a.png', sha256: 'aa' },
      { id: 'logo-propio', venueId: VENUE, kind: 'LOGO', objectPath: 'dev/customer-display-assets/venue-a/b.png', sha256: 'bb' },
    ] as any)

    const ajeno = await previewCustomerDisplay(VENUE, TERMINAL, { logoAssetId: 'logo-ajeno' }, 1)
    const propio = await previewCustomerDisplay(VENUE, TERMINAL, { logoAssetId: 'logo-propio' }, 2)

    expect(ajeno.assetRejected).toEqual(['logo-ajeno'])
    expect(ajeno.ficha.logo).toBeNull()
    expect(propio.assetRejected).toEqual([])
    expect(propio.ficha.logo).toEqual({
      source: 'asset',
      url: 'https://storage.googleapis.com/bucket-de-prueba.appspot.com/dev/customer-display-assets/venue-a/b.png',
      sha256: 'bb',
    })
  })
})

function disenoCon(over: Record<string, unknown>) {
  return {
    id: 'd1',
    terminalId: TERMINAL,
    revision: 1,
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
    ...over,
  }
}
