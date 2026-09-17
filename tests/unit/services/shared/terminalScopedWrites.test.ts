import { Prisma } from '@prisma/client'

import { NotFoundError } from '@/errors/AppError'
import { countUpdatedTerminals, scopedTerminalWhere, writeScopedTerminal } from '@/services/shared/terminalScopedWrites'

// 🔴 Auditorías de Codex del spec «pantalla del cliente» (3ª y 4ª ronda, 2026-09-16/17): varias operaciones leían una
// terminal dentro de su negocio y la escribían sólo por id. Si entre las dos la terminal se mudaba (una migración del
// dueño de la organización o del superadmin), la escritura caía en el negocio nuevo. Estas piezas son las que usan todas.

const p2025 = () => new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' })

describe('scopedTerminalWhere — la condición con la que se escribe una terminal', () => {
  it('acota por el venue de la operación', () => {
    expect(scopedTerminalWhere('t1', { venueId: 'v1' })).toEqual({ id: 't1', venueId: 'v1' })
  })

  it('acota por la organización a través del venue actual de la terminal', () => {
    expect(scopedTerminalWhere('t1', { organizationId: 'o1' })).toEqual({ id: 't1', venue: { organizationId: 'o1' } })
  })

  it('sin ámbito (superadmin y llamadores internos) sólo filtra por id, como antes', () => {
    expect(scopedTerminalWhere('t1')).toEqual({ id: 't1' })
  })
})

describe('writeScopedTerminal — una terminal que ya no está en el negocio es un 404', () => {
  it('traduce el P2025 de la escritura acotada a NotFoundError con el mensaje dado', async () => {
    const promise = writeScopedTerminal(() => Promise.reject(p2025()), 'Terminal no encontrada en este negocio')

    await expect(promise).rejects.toBeInstanceOf(NotFoundError)
    await expect(writeScopedTerminal(() => Promise.reject(p2025()), 'Terminal no encontrada en este negocio')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Terminal no encontrada en este negocio',
    })
  })

  it('cualquier otro error pasa tal cual (no se disfraza de 404)', async () => {
    const otro = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })

    await expect(writeScopedTerminal(() => Promise.reject(otro), 'x')).rejects.toBe(otro)
    const caida = new Error('caída')
    await expect(writeScopedTerminal(() => Promise.reject(caida), 'x')).rejects.toBe(caida)
  })

  it('devuelve lo que devuelve la escritura', async () => {
    await expect(writeScopedTerminal(() => Promise.resolve({ id: 't1' }), 'x')).resolves.toEqual({ id: 't1' })
  })
})

describe('countUpdatedTerminals — una terminal que se mudó cuenta cero', () => {
  it('suma los resultados de updateMany', () => {
    expect(countUpdatedTerminals([{ count: 1 }, { count: 0 }, { count: 1 }])).toBe(2)
  })

  it('ignora lo que no es un resultado de updateMany', () => {
    expect(countUpdatedTerminals([{ id: 'x' }, null, { count: 1 }])).toBe(1)
  })
})
