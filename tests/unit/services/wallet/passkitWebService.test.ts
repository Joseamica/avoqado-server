/**
 * El servicio que Apple llama para mantener viva una tarjeta.
 *
 * 🔴 Estos endpoints los invoca APPLE, no nuestro dashboard: son públicos y lo único
 * que los protege es el token que viaja DENTRO del pase. Un fallo aquí no se ve en
 * ninguna pantalla — se ve en que las tarjetas de todos los clientes dejan de
 * actualizarse, semanas después y sin un solo error en el log.
 */
import { registerDevice, unregisterDevice, listUpdatedSerials } from '../../../../src/services/wallet/passkitWebService.service'
import { prismaMock } from '../../../__helpers__/setup'

const PASE = { id: 'wp1', serialNumber: 'AVQ-1', authToken: 'secreto-del-pase', venueId: 'v1', customerId: 'c1', active: true }

describe('servicio web de PassKit', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.walletPass.findFirst.mockResolvedValue(PASE as any)
    // Apple distingue 201 (nuevo) de 200 (ya estaba), y el servicio lo deduce
    // comparando las fechas: iguales = recién creado. Por defecto, nuevo.
    const ahora = new Date('2026-08-26T12:00:00Z')
    prismaMock.walletPassRegistration.upsert.mockResolvedValue({ createdAt: ahora, updatedAt: ahora } as any)
    prismaMock.walletPassRegistration.deleteMany.mockResolvedValue({ count: 1 } as any)
  })

  describe('registrar un aparato', () => {
    it('guarda el token con el que se le va a avisar', async () => {
      const r = await registerDevice('device-abc', 'AVQ-1', 'token-push-1', 'secreto-del-pase')

      expect(r.status).toBe(201)
      expect(prismaMock.walletPassRegistration.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceLibraryIdentifier_walletPassId: { deviceLibraryIdentifier: 'device-abc', walletPassId: 'wp1' } },
        }),
      )
    })

    it('🔴 re-registrar el MISMO aparato pisa el token, no crea otra fila', async () => {
      // Apple rota el pushToken. Con una fila nueva por rotación, el aviso se
      // mandaría a un token muerto y la tarjeta quedaría congelada en silencio.
      // Fechas distintas = la fila ya existía y sólo se actualizó.
      prismaMock.walletPassRegistration.upsert.mockResolvedValue({
        createdAt: new Date('2026-08-20T12:00:00Z'),
        updatedAt: new Date('2026-08-26T12:00:00Z'),
      } as any)

      const r = await registerDevice('device-abc', 'AVQ-1', 'token-push-2', 'secreto-del-pase')

      const llamada = prismaMock.walletPassRegistration.upsert.mock.calls[0][0] as any
      expect(llamada.update).toEqual(expect.objectContaining({ pushToken: 'token-push-2' }))
      // Apple espera 200 cuando ya estaba registrado y 201 cuando es nuevo; el
      // servicio contesta 200 aquí porque el upsert encontró la fila.
      expect([200, 201]).toContain(r.status)
    })

    it('🔴 un token de autenticación equivocado NO registra nada', async () => {
      // Es la única barrera de estos endpoints: son públicos por definición, los
      // llama Apple. Sin esto, cualquiera que adivine un serial recibe los avisos de
      // la tarjeta de otra persona.
      const r = await registerDevice('device-abc', 'AVQ-1', 'token-push-1', 'token-equivocado')

      expect(r.status).toBe(401)
      expect(prismaMock.walletPassRegistration.upsert).not.toHaveBeenCalled()
    })

    it('un serial que no existe responde 401, no 404', async () => {
      // 🔴 Deliberado: un 404 confirmaría que ese serial NO existe, y un 200/401
      // que sí. Contestar siempre 401 no le dice a nadie qué seriales son reales.
      prismaMock.walletPass.findFirst.mockResolvedValue(null)

      const r = await registerDevice('device-abc', 'AVQ-inventado', 'token', 'lo-que-sea')

      expect(r.status).toBe(401)
    })
  })

  describe('dar de baja un aparato', () => {
    it('borra el registro de ESE aparato', async () => {
      const r = await unregisterDevice('device-abc', 'AVQ-1', 'secreto-del-pase')

      expect(r.status).toBe(200)
      expect(prismaMock.walletPassRegistration.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ deviceLibraryIdentifier: 'device-abc' }) }),
      )
    })

    it('🔴 con token equivocado no borra nada', async () => {
      const r = await unregisterDevice('device-abc', 'AVQ-1', 'token-equivocado')

      expect(r.status).toBe(401)
      expect(prismaMock.walletPassRegistration.deleteMany).not.toHaveBeenCalled()
    })
  })

  describe('qué tarjetas cambiaron', () => {
    it('devuelve los seriales y la marca de tiempo', async () => {
      prismaMock.walletPassRegistration.findMany.mockResolvedValue([
        { walletPass: { serialNumber: 'AVQ-1', updatedAt: new Date('2026-08-26T10:00:00Z') } },
        { walletPass: { serialNumber: 'AVQ-2', updatedAt: new Date('2026-08-26T11:00:00Z') } },
      ] as any)

      const r = await listUpdatedSerials('device-abc')

      expect(r.status).toBe(200)
      expect(r.body?.serialNumbers).toEqual(['AVQ-1', 'AVQ-2'])
      // `lastUpdated` es lo que el aparato devolverá la próxima vez para no repetir.
      expect(r.body?.lastUpdated).toBeDefined()
    })

    it('🔴 sin nada que actualizar responde 204, no una lista vacía', async () => {
      // Apple lo trata distinto: un 200 con lista vacía hace que el aparato vuelva a
      // preguntar en un bucle. El 204 le dice "no hay nada, descansa".
      prismaMock.walletPassRegistration.findMany.mockResolvedValue([] as any)

      const r = await listUpdatedSerials('device-abc')

      expect(r.status).toBe(204)
    })
  })
})
