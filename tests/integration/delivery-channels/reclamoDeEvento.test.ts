/**
 * Integration (Postgres REAL) — el reclamo de un `DeliveryOrderEvent` (Tarea 8 del plan «Rappi fase 2»).
 *
 * Las pruebas unitarias corren sobre un Prisma de mentira que no sabe de concurrencia: ahí un `updateMany` condicional es
 * una llamada más. Esto prueba lo que sólo la base puede decir:
 *  (a) 🔴 varios reclamos SIMULTÁNEOS del mismo evento ⇒ sólo uno obtiene token (la petición viva y el job nunca aceptan
 *      ni registran el mismo pedido a la vez);
 *  (b) un reclamo vencido (el proceso murió) se puede retomar, y el dueño viejo ya no puede renovar ni cerrar;
 *  (c) un evento PROCESSED no se reclama;
 *  (d) renovar o cerrar con un token ajeno no toca nada.
 *
 * Sólo crea filas propias (sufijo único, sin vínculo ni venue) y las borra en `afterAll`, falle o no.
 */
import { DeliveryOrderEventStatus, DeliveryProvider } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cerrarEventoReclamado, reclamarEvento, renovarReclamo } from '@/services/delivery-channels/core/deliveryWebhookEvent.service'

jest.setTimeout(30_000)

/**
 * 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada. Mismo criterio que
 * `rappiCandadoDeFila.test.ts`: la de esta Mac (`av-db-25-test`) o una desechable (`avoqado_*_test_*`).
 */
const esBaseDePrueba = (nombre: string) => nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(nombre)
{
  // A nivel de MÓDULO, no en un hook: corre antes de cualquier `beforeAll`/`afterAll`.
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

const RECLAMO_MS = 45_000

describe('reclamo de DeliveryOrderEvent contra Postgres', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const creados: string[] = []

  afterAll(async () => {
    // Sin ids propios no se borra nada: un filtro vacío NO debe convertirse en «todas las filas».
    if (creados.length === 0) return
    try {
      await prisma.deliveryOrderEvent.deleteMany({ where: { id: { in: creados } } })
    } catch (e) {
      console.error(`reclamo-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  /** Un evento propio, sin vínculo ni venue: el reclamo sólo mira id, estado, token y vencimiento. */
  async function evento(n: string, status: DeliveryOrderEventStatus = DeliveryOrderEventStatus.RECEIVED) {
    const fila = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.RAPPI,
        externalEventId: `reclamo-it-${sufijo}-${n}`,
        eventType: 'NEW_ORDER',
        payload: { prueba: true },
        status,
      },
    })
    creados.push(fila.id)
    return fila.id
  }

  const leer = (id: string) => prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id } })

  it('🔴 dos reclamos simultáneos del mismo evento: sólo uno obtiene token', async () => {
    const id = await evento('simultaneo-2')

    const tokens = await Promise.all([reclamarEvento(id, RECLAMO_MS), reclamarEvento(id, RECLAMO_MS)])

    const ganadores = tokens.filter((t): t is string => t !== null)
    expect(ganadores).toHaveLength(1)
    const fila = await leer(id)
    expect(fila.claimToken).toBe(ganadores[0])
    expect(fila.lockedUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('🔴 aunque sean ocho a la vez (petición viva, carril de Rappi, pasada general…), gana uno solo', async () => {
    const id = await evento('simultaneo-8')

    const tokens = await Promise.all(Array.from({ length: 8 }, () => reclamarEvento(id, RECLAMO_MS)))

    const ganadores = tokens.filter((t): t is string => t !== null)
    expect(ganadores).toHaveLength(1)
    expect((await leer(id)).claimToken).toBe(ganadores[0])
  })

  it('un reclamo vigente no se puede volver a reclamar', async () => {
    const id = await evento('vigente')

    const primero = await reclamarEvento(id, RECLAMO_MS)
    const segundo = await reclamarEvento(id, RECLAMO_MS)

    expect(primero).not.toBeNull()
    expect(segundo).toBeNull()
    expect((await leer(id)).claimToken).toBe(primero)
  })

  it('un reclamo vencido se puede retomar, y el dueño viejo ya no renueva ni cierra', async () => {
    const id = await evento('vencido')
    const viejo = await reclamarEvento(id, RECLAMO_MS)
    expect(viejo).not.toBeNull()
    // El proceso «murió»: su reclamo venció hace un segundo.
    await prisma.deliveryOrderEvent.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1_000) } })

    const nuevo = await reclamarEvento(id, RECLAMO_MS)

    expect(nuevo).not.toBeNull()
    expect(nuevo).not.toBe(viejo)
    expect(await renovarReclamo(id, viejo!, RECLAMO_MS)).toBe(false)
    expect(await cerrarEventoReclamado(id, viejo!, DeliveryOrderEventStatus.FAILED, undefined, 'INGEST: dueño viejo')).toBe(false)
    const fila = await leer(id)
    expect(fila).toMatchObject({ claimToken: nuevo, status: DeliveryOrderEventStatus.RECEIVED, error: null })
  })

  it('un evento PROCESSED no se reclama', async () => {
    const id = await evento('procesado', DeliveryOrderEventStatus.PROCESSED)

    expect(await reclamarEvento(id, RECLAMO_MS)).toBeNull()

    expect(await leer(id)).toMatchObject({ claimToken: null, lockedUntil: null, status: DeliveryOrderEventStatus.PROCESSED })
  })

  it('un evento que no existe no se reclama', async () => {
    expect(await reclamarEvento(`no-existe-${sufijo}`, RECLAMO_MS)).toBeNull()
  })

  it('renovar o cerrar con un token ajeno no toca nada; con el propio, renueva y cierra soltando el reclamo', async () => {
    const id = await evento('ajeno')
    const token = await reclamarEvento(id, 5_000)
    expect(token).not.toBeNull()
    const antes = await leer(id)

    expect(await renovarReclamo(id, 'token-ajeno', RECLAMO_MS)).toBe(false)
    expect(await cerrarEventoReclamado(id, 'token-ajeno', DeliveryOrderEventStatus.FAILED, undefined, 'ajeno')).toBe(false)
    const intacta = await leer(id)
    expect(intacta).toMatchObject({
      claimToken: token,
      lockedUntil: antes.lockedUntil,
      status: DeliveryOrderEventStatus.RECEIVED,
      error: null,
      processedAt: null,
    })

    // Con el propio: renovar extiende el vencimiento…
    expect(await renovarReclamo(id, token!, RECLAMO_MS)).toBe(true)
    expect((await leer(id)).lockedUntil!.getTime()).toBeGreaterThan(antes.lockedUntil!.getTime())
    // …y cerrar escribe el resultado y suelta el reclamo.
    expect(await cerrarEventoReclamado(id, token!, DeliveryOrderEventStatus.FAILED, undefined, 'ACCEPT_500: boom')).toBe(true)
    const cerrada = await leer(id)
    expect(cerrada).toMatchObject({
      claimToken: null,
      lockedUntil: null,
      status: DeliveryOrderEventStatus.FAILED,
      error: 'ACCEPT_500: boom',
    })
    expect(cerrada.processedAt).not.toBeNull()
  })

  it('cerrado como FAILED (reclamo suelto), el siguiente intento lo puede reclamar; cerrado PROCESSED, ya no', async () => {
    const id = await evento('reintento')
    const a = await reclamarEvento(id, RECLAMO_MS)
    await cerrarEventoReclamado(id, a!, DeliveryOrderEventStatus.FAILED, undefined, 'ACCEPT_500')

    const b = await reclamarEvento(id, RECLAMO_MS)
    expect(b).not.toBeNull()
    expect(await cerrarEventoReclamado(id, b!, DeliveryOrderEventStatus.PROCESSED, undefined)).toBe(true)

    expect(await reclamarEvento(id, RECLAMO_MS)).toBeNull()
  })
})
