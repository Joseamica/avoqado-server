/**
 * Un renglón con llave de ronda que YA existe (la ronda en línea que expiró y su réplica de la cola se cruzaron)
 * es un conflicto TRANSITORIO: la cola lo reintenta y encuentra el renglón por su llave. Nunca cuarentena.
 */
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

import { ConflictError } from '@/errors/AppError'
import { conLlaveDeRonda } from '@/services/tpv/order.tpv.service'

void prismaMock

it('P2002 ⇒ VERSION_CONFLICT (la cola lo reintenta)', async () => {
  const p = conLlaveDeRonda(() => Promise.reject(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })))
  const error: any = await p.catch(e => e)
  expect(error).toBeInstanceOf(ConflictError)
  expect(error.errorCode ?? error.code).toBe('VERSION_CONFLICT')
})

it('otros errores pasan tal cual, y el éxito devuelve el valor', async () => {
  await expect(conLlaveDeRonda(() => Promise.reject(new Error('otra cosa')))).rejects.toThrow('otra cosa')
  await expect(conLlaveDeRonda(async () => 42)).resolves.toBe(42)
})
