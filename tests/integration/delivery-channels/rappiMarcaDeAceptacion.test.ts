/**
 * Integration (Postgres REAL) — la marca de aceptación de Rappi (Tarea 9 del plan «Rappi fase 2»).
 *
 * La marca es un UPDATE escrito a mano (mezcla JSONB condicionada al token del reclamo). En las pruebas unitarias el Prisma
 * es de mentira y sólo se ve el texto del SQL; esto prueba lo que sólo la base puede decir:
 *  (a) sobre una fila sin `resourcePayload`, la marca queda y `leerEstado` la entiende;
 *  (b) 🔴 MEZCLA: lo que ya había en `resourcePayload` (el contador de «listo» de la Tarea 13) sobrevive;
 *  (c) 🔴 con el token de otro (el reclamo ya no es suyo) no escribe nada y devuelve false;
 *  (d) un `resourcePayload` que no es objeto se sustituye por uno con la marca, sin lanzar.
 *
 * Sólo crea filas propias (sufijo único, sin vínculo ni venue) y las borra en `afterAll`, falle o no.
 */
import { DeliveryOrderEventStatus, DeliveryProvider, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { reclamarEvento } from '@/services/delivery-channels/core/deliveryWebhookEvent.service'
import { anotarAceptacion, leerEstado } from '@/services/delivery-channels/providers/rappi/rappi.estadoDelPedido'

jest.setTimeout(30_000)

/** 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada (mismo criterio que `reclamoDeEvento.test.ts`). */
const esBaseDePrueba = (nombre: string) => nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(nombre)
{
  // A nivel de MÓDULO, no en un hook: corre antes de cualquier `beforeAll`/`afterAll`.
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('marca de aceptación de Rappi contra Postgres', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const creados: string[] = []

  afterAll(async () => {
    // Sin ids propios no se borra nada: un filtro vacío NO debe convertirse en «todas las filas».
    if (creados.length === 0) return
    try {
      await prisma.deliveryOrderEvent.deleteMany({ where: { id: { in: creados } } })
    } catch (e) {
      console.error(`marca-it ${sufijo}: la limpieza falló (quedaron filas propias)`, e)
    }
  })

  /** Un evento propio ya reclamado; devuelve su id y el token del reclamo. */
  async function eventoReclamado(n: string, resourcePayload?: Prisma.InputJsonValue) {
    const fila = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.RAPPI,
        externalEventId: `marca-it-${sufijo}-${n}`,
        eventType: 'NEW_ORDER',
        payload: { prueba: true },
        status: DeliveryOrderEventStatus.RECEIVED,
        ...(resourcePayload !== undefined ? { resourcePayload } : {}),
      },
    })
    creados.push(fila.id)
    const token = await reclamarEvento(fila.id, 45_000)
    if (!token) throw new Error('el reclamo de la prueba no se obtuvo')
    return { id: fila.id, token }
  }

  const leer = (id: string) => prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id } })

  it('sobre una fila sin resourcePayload, la marca queda y leerEstado la entiende', async () => {
    const { id, token } = await eventoReclamado('sin-nada')

    expect(await anotarAceptacion(id, token, 'HTTP_2XX')).toBe(true)

    const estado = leerEstado((await leer(id)).resourcePayload)
    expect(estado.aceptacion).toEqual({ en: expect.any(String), evidencia: 'HTTP_2XX' })
    expect(Math.abs(new Date(estado.aceptacion!.en).getTime() - Date.now())).toBeLessThan(60_000)
  })

  it('🔴 MEZCLA: el contador de «listo» que ya estaba sobrevive', async () => {
    const listo = { llamadas: 2, cerrado: 'TOPE' }
    const { id, token } = await eventoReclamado('con-listo', { listo, otraCosa: 'x' })

    expect(await anotarAceptacion(id, token, 'HISTORIAL_TAKEN')).toBe(true)

    const guardado = (await leer(id)).resourcePayload as Record<string, unknown>
    expect(guardado).toEqual({ listo, otraCosa: 'x', aceptacion: { en: expect.any(String), evidencia: 'HISTORIAL_TAKEN' } })
  })

  it('🔴 con el token de otro no escribe nada y devuelve false', async () => {
    const { id } = await eventoReclamado('token-ajeno', { listo: { llamadas: 1 } })

    expect(await anotarAceptacion(id, 'token-de-otro', 'HTTP_2XX')).toBe(false)

    expect((await leer(id)).resourcePayload).toEqual({ listo: { llamadas: 1 } })
  })

  it('un resourcePayload que no es objeto se sustituye por uno con la marca, sin lanzar', async () => {
    const { id, token } = await eventoReclamado('lista', [1, 2])

    expect(await anotarAceptacion(id, token, 'HTTP_2XX')).toBe(true)

    expect((await leer(id)).resourcePayload).toEqual({ aceptacion: { en: expect.any(String), evidencia: 'HTTP_2XX' } })
  })
})
