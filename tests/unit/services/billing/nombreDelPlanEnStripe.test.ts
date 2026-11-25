/**
 * Planes editables B1, Task 8: el nombre del producto de Stripe de un plan.
 *
 * - `escribirNombreDelPlan` es el ÚNICO que lo escribe: toma `plan-offer-nombre`, DESPUÉS lee la vigente con esa transacción y
 *   escribe lo que la vigente dice (o, en la sincronización, el nombre del catálogo mientras la vigente no tenga nombre propio).
 * - `exigirNombreDelPlanAlDia` es la puerta del checkout de «Tu plan»: lee Stripe en vivo y responde 503 mientras diga otro nombre.
 *
 * 🔴 Con sólo la v1 (o sin versiones) la oferta no es dueña del nombre: nadie lee Stripe, nadie lo renombra y nadie escribe
 * `nombresEnStripe`.
 */
const mockRetrieve = jest.fn()
const mockUpdate = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ products: { retrieve: mockRetrieve, update: mockUpdate } })))

import logger from '@/config/logger'
import {
  CANDADO_DEL_NOMBRE,
  escribirNombreDelPlan,
  exigirNombreDelPlanAlDia,
  renombrarProductosDelPlan,
} from '@/services/billing/nombreDelPlanEnStripe'
import { definicionDesdeEntrada, entradaDesdeDefinicion, type PlanOfferDefinition } from '@/services/billing/planOffer'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const PRO_PLUS = 'Plan Avoqado Pro Plus'
const MENSAJE = 'Estamos actualizando el nombre de tu plan. Intenta en un minuto. No se te cobró nada.'

/** La v2 del editor: Pro se llama «Pro Plus» y su producto de Stripe, «Plan Avoqado Pro Plus». */
const versionDos = () =>
  definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Pro Plus' }, productos: { PRO: PRO_PLUS } }) as PlanOfferDefinition

/** Una transacción propia (no el `prismaMock`): así se ve que la lectura de la vigente va por ELLA. */
function crearTx(puntero: unknown, nombresEnStripe: unknown = null) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    planOfferPointer: {
      findUnique: jest.fn().mockResolvedValue(puntero === null ? null : { ...(puntero as object), nombresEnStripe }),
      update: jest.fn().mockResolvedValue({}),
    },
    feature: { findUnique: jest.fn().mockResolvedValue({ stripeProductId: 'prod_pro' }) },
  }
}
type TxDePrueba = ReturnType<typeof crearTx>

let tx: TxDePrueba
const usarTx = (nuevo: TxDePrueba) => {
  tx = nuevo
  prismaMock.$transaction.mockImplementation(async (fn: (t: TxDePrueba) => unknown) => fn(tx))
}

beforeEach(() => {
  mockRetrieve.mockReset()
  mockUpdate.mockReset()
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.planOfferPointer.update.mockReset()
  prismaMock.feature.findUnique.mockReset().mockResolvedValue({ stripeProductId: 'prod_pro' })
  usarTx(crearTx(null))
})

afterAll(() => {
  prismaMock.$transaction.mockImplementation((callback: (t: unknown) => unknown) => callback(prismaMock))
})

describe('la puerta del checkout (exigirNombreDelPlanAlDia)', () => {
  it('sin versiones: no llama a Stripe y no frena', async () => {
    await expect(exigirNombreDelPlanAlDia('PRO')).resolves.toBeUndefined()
    await expect(exigirNombreDelPlanAlDia('PREMIUM')).resolves.toBeUndefined()
    // El job tampoco toca Stripe ni abre una transacción.
    await expect(renombrarProductosDelPlan()).resolves.toEqual({ PRO: 'SIN_VERSION', PREMIUM: 'SIN_VERSION' })
    expect(mockRetrieve).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 con sólo la v1 (stripeProductName null): no llama a Stripe y no frena aunque Stripe esté caído o diga otro nombre', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    mockRetrieve.mockRejectedValue(Object.assign(new Error('Stripe caído'), { type: 'StripeConnectionError' }))
    await expect(exigirNombreDelPlanAlDia('PRO')).resolves.toBeUndefined()
    mockRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Otro nombre cualquiera' })
    await expect(exigirNombreDelPlanAlDia('PREMIUM')).resolves.toBeUndefined()
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it('con el nombre de Stripe igual al de la vigente: no frena', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, versionDos()) as never)
    mockRetrieve.mockResolvedValue({ id: 'prod_pro', name: PRO_PLUS })

    await expect(exigirNombreDelPlanAlDia('PRO')).resolves.toBeUndefined()
    expect(mockRetrieve).toHaveBeenCalledWith('prod_pro', { timeout: 15_000, maxNetworkRetries: 0 })
    // Premium no cambió de nombre en la v2: no se lee.
    mockRetrieve.mockClear()
    await expect(exigirNombreDelPlanAlDia('PREMIUM')).resolves.toBeUndefined()
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 v2 «Pro Plus» y v3 sólo precio: la vigente hereda «Plan Avoqado Pro Plus»; Stripe dice «Plan Avoqado Pro» → 503 PLAN_RENAME_PENDING', async () => {
    const v2 = versionDos()
    const entrada = entradaDesdeDefinicion(v2)
    entrada.PRO.monthlyNetCents = 129900
    const v3 = definicionDesdeEntrada(entrada, v2)
    expect(v3.PRO.stripeProductName).toBe(PRO_PLUS)
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv3', 3, v3) as never)
    mockRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Plan Avoqado Pro' })

    const error = await exigirNombreDelPlanAlDia('PRO').catch((e: unknown) => e)
    expect(error).toMatchObject({ statusCode: 503, code: 'PLAN_RENAME_PENDING', message: MENSAJE })
  })

  it('Stripe falla al leer el producto → 503 PLAN_RENAME_PENDING', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, versionDos()) as never)
    mockRetrieve.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))

    await expect(exigirNombreDelPlanAlDia('PRO')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_RENAME_PENDING', message: MENSAJE })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('el plan sin producto de Stripe con la vigente dueña del nombre → 503 PLAN_NOT_CONFIGURED, sin llamar a Stripe', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, versionDos()) as never)
    prismaMock.feature.findUnique.mockResolvedValue({ stripeProductId: null })

    await expect(exigirNombreDelPlanAlDia('PRO')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    expect(mockRetrieve).not.toHaveBeenCalled()
  })
})

describe('el escritor (escribirNombreDelPlan)', () => {
  it('🔴 escribir con origen JOB y sólo la v1: ni products.retrieve ni products.update ni escritura de nombresEnStripe', async () => {
    usarTx(crearTx(punteroA('cv1', 1, versionUno())))

    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('SIN_VERSION')
    expect(mockRetrieve).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(tx.planOfferPointer.update).not.toHaveBeenCalled()
    expect(prismaMock.planOfferPointer.update).not.toHaveBeenCalled()
  })

  it('con origen SYNC y sin nombre propio en la vigente (la v1, o una versión del editor que no cambió el nombre) escribe directo el nombre del catálogo, sin products.retrieve', async () => {
    const soloPrecio = definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 } })
    for (const puntero of [punteroA('cv1', 1, versionUno()), punteroA('cv2', 2, soloPrecio)]) {
      usarTx(crearTx(puntero))
      mockUpdate.mockReset().mockResolvedValue({ id: 'prod_pro', name: 'Plan Pro' })

      await expect(escribirNombreDelPlan('PRO', 'SYNC', { nombre: 'Plan Pro', descripcion: 'Todo Pro' })).resolves.toBe('SIN_VERSION')
      // El mismo `products.update` de hoy (nombre y descripción del catálogo); la única opción nueva es el tope de 10 s.
      expect(mockUpdate.mock.calls).toEqual([['prod_pro', { name: 'Plan Pro', description: 'Todo Pro' }, { timeout: 10_000 }]])
      expect(mockRetrieve).not.toHaveBeenCalled()
      // 🔴 Sin nombre propio nadie escribe la observación (C3).
      expect(tx.planOfferPointer.update).not.toHaveBeenCalled()
    }
    // Una descripción vacía viaja como hoy: `undefined`.
    usarTx(crearTx(punteroA('cv1', 1, versionUno())))
    mockUpdate.mockReset().mockResolvedValue({ id: 'prod_pro', name: 'Plan Pro' })
    await escribirNombreDelPlan('PRO', 'SYNC', { nombre: 'Plan Pro', descripcion: null })
    expect(mockUpdate.mock.calls[0][1]).toEqual({ name: 'Plan Pro', description: undefined })
  })

  it('🔴 escribir toma plan-offer-nombre ANTES de leer la vigente y calcula el nombre con esa tx', async () => {
    usarTx(crearTx(punteroA('cv2', 2, versionDos())))
    mockRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Plan Avoqado Pro' })
    mockUpdate.mockResolvedValue({ id: 'prod_pro', name: PRO_PLUS })

    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('RENOMBRADO')

    // El candado, con su nombre, es lo primero que pasa en la transacción.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    const [sql, llave] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, string]
    expect(sql.join('?')).toContain('pg_advisory_xact_lock(hashtext(?))')
    expect(llave).toBe(CANDADO_DEL_NOMBRE)
    expect(CANDADO_DEL_NOMBRE).toBe('plan-offer-nombre')
    const candado: number = tx.$executeRaw.mock.invocationCallOrder[0]
    const lecturas: number[] = tx.planOfferPointer.findUnique.mock.invocationCallOrder
    expect(lecturas.length).toBeGreaterThan(0)
    expect(lecturas.every((orden: number) => orden > candado)).toBe(true)
    // La vigente se leyó con ESA transacción, no fuera.
    expect(prismaMock.planOfferPointer.findUnique).not.toHaveBeenCalled()
    // El nombre que se escribe es el de la vigente leída ahí, con el tope de 10 s y sin reintentos del SDK.
    expect(mockRetrieve).toHaveBeenCalledWith('prod_pro', { timeout: 10_000, maxNetworkRetries: 0 })
    expect(mockUpdate.mock.calls).toEqual([['prod_pro', { name: PRO_PLUS }, { timeout: 10_000, maxNetworkRetries: 0 }]])
    expect(mockUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(candado)
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 15_000, timeout: 30_000 })
  })

  it('JOB con el nombre ya al día: AL_DIA, sin products.update; la observación sólo se escribe cuando cambia', async () => {
    usarTx(crearTx(punteroA('cv2', 2, versionDos())))
    mockRetrieve.mockResolvedValue({ id: 'prod_pro', name: PRO_PLUS })

    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('AL_DIA')
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(tx.planOfferPointer.update).toHaveBeenCalledWith({
      where: { id: 'vigente' },
      data: { nombresEnStripe: { PRO: { esperado: PRO_PLUS, enStripe: PRO_PLUS, estado: 'AL_DIA' } } },
    })

    // La misma observación ya guardada: no se vuelve a escribir. La del otro plan se conserva al escribir ésta.
    usarTx(crearTx(punteroA('cv2', 2, versionDos()), { PRO: { esperado: PRO_PLUS, enStripe: PRO_PLUS, estado: 'AL_DIA' } }))
    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('AL_DIA')
    expect(tx.planOfferPointer.update).not.toHaveBeenCalled()

    const premium = { esperado: 'Plan Avoqado Premium Max', enStripe: 'Plan Avoqado Premium Max', estado: 'AL_DIA' }
    usarTx(crearTx(punteroA('cv2', 2, versionDos()), { PREMIUM: premium }))
    await escribirNombreDelPlan('PRO', 'JOB')
    expect(tx.planOfferPointer.update).toHaveBeenCalledWith({
      where: { id: 'vigente' },
      data: { nombresEnStripe: { PREMIUM: premium, PRO: { esperado: PRO_PLUS, enStripe: PRO_PLUS, estado: 'AL_DIA' } } },
    })
  })

  it('JOB con Stripe fallando: FALLO, sin lanzar, y la observación dice que no está al día', async () => {
    usarTx(crearTx(punteroA('cv2', 2, versionDos()), { PRO: { esperado: PRO_PLUS, enStripe: 'Plan Avoqado Pro', estado: 'FALLO' } }))
    mockRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Plan Avoqado Pro' })
    mockUpdate.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))

    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('FALLO')
    // Lo mismo que ya decía: no se reescribe.
    expect(tx.planOfferPointer.update).not.toHaveBeenCalled()

    // Sin nada guardado, la observación queda con lo que Stripe dice y FALLO. Si Stripe ni siquiera contesta la lectura, se conserva
    // lo último que se vio.
    usarTx(crearTx(punteroA('cv2', 2, versionDos())))
    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('FALLO')
    expect(tx.planOfferPointer.update).toHaveBeenCalledWith({
      where: { id: 'vigente' },
      data: { nombresEnStripe: { PRO: { esperado: PRO_PLUS, enStripe: 'Plan Avoqado Pro', estado: 'FALLO' } } },
    })
    usarTx(crearTx(punteroA('cv2', 2, versionDos()), { PRO: { esperado: PRO_PLUS, enStripe: 'Plan Avoqado Pro', estado: 'AL_DIA' } }))
    mockRetrieve.mockRejectedValueOnce(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('FALLO')
    expect(tx.planOfferPointer.update).toHaveBeenCalledWith({
      where: { id: 'vigente' },
      data: { nombresEnStripe: { PRO: { esperado: PRO_PLUS, enStripe: 'Plan Avoqado Pro', estado: 'FALLO' } } },
    })

    // Que el candado o la lectura fallen también es FALLO (el job lo intenta en la siguiente vuelta).
    prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))
    await expect(escribirNombreDelPlan('PRO', 'JOB')).resolves.toBe('FALLO')
  })

  it('SYNC con la vigente dueña del nombre: escribe el de la vigente con la descripción del catálogo, en una transacción de 120 s, y anota la observación', async () => {
    usarTx(crearTx(punteroA('cv2', 2, versionDos())))
    mockUpdate.mockResolvedValue({ id: 'prod_pro', name: PRO_PLUS })

    await expect(escribirNombreDelPlan('PRO', 'SYNC', { nombre: 'Plan Pro', descripcion: 'Todo Pro' })).resolves.toBe('RENOMBRADO')
    expect(mockUpdate.mock.calls).toEqual([['prod_pro', { name: PRO_PLUS, description: 'Todo Pro' }, { timeout: 10_000 }]])
    expect(mockRetrieve).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 15_000, timeout: 120_000 })
    expect(tx.planOfferPointer.update).toHaveBeenCalledWith({
      where: { id: 'vigente' },
      data: { nombresEnStripe: { PRO: { esperado: PRO_PLUS, enStripe: PRO_PLUS, estado: 'RENOMBRADO' } } },
    })
  })

  it('🔴 SYNC: si Stripe rechaza el products.update, el error sube tal cual (como hoy, la sincronización salta el precio de ese plan)', async () => {
    usarTx(crearTx(punteroA('cv2', 2, versionDos())))
    const rechazo = Object.assign(new Error('Invalid request'), { type: 'StripeInvalidRequestError', statusCode: 400 })
    mockUpdate.mockRejectedValue(rechazo)

    await expect(escribirNombreDelPlan('PRO', 'SYNC', { nombre: 'Plan Pro', descripcion: null })).rejects.toBe(rechazo)
    expect(tx.planOfferPointer.update).not.toHaveBeenCalled()
  })

  it('🔴 SYNC: si el candado o la lectura de la vigente fallan, FALLO con aviso y sin escribir ningún nombre (nunca un update sin candado)', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))
    await expect(escribirNombreDelPlan('PRO', 'SYNC', { nombre: 'Plan Pro', descripcion: null })).resolves.toBe('FALLO')

    const roto = crearTx(null)
    roto.planOfferPointer.findUnique.mockRejectedValue(Object.assign(new Error('Can’t reach database server'), { code: 'P1001' }))
    usarTx(roto)
    await expect(escribirNombreDelPlan('PRO', 'SYNC', { nombre: 'Plan Pro', descripcion: null })).resolves.toBe('FALLO')

    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockRetrieve).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('renombrarProductosDelPlan: sólo el plan dueño de su nombre pasa por el escritor; el otro queda SIN_VERSION sin abrir transacción', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, versionDos()) as never)
    usarTx(crearTx(punteroA('cv2', 2, versionDos())))
    mockRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Plan Avoqado Pro' })
    mockUpdate.mockResolvedValue({ id: 'prod_pro', name: PRO_PLUS })

    await expect(renombrarProductosDelPlan()).resolves.toEqual({ PRO: 'RENOMBRADO', PREMIUM: 'SIN_VERSION' })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})
