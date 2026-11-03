/**
 * Número de vinculación (plan A6): `number-check`, `actionable` y `status` son literales hermanas de
 * `/verification/:verificationId`. Express casa en orden de registro: si la paramétrica va antes, `number-check` llega al
 * detalle como id y responde 404 para siempre. Se interroga el stack real del router (mismo `Layer.match` que en
 * producción) y el YAML de sus `@openapi` con la misma librería que `src/config/swagger.ts`.
 */
import path from 'path'
import swaggerJsdoc from 'swagger-jsdoc'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import tpvRouter from '@/routes/tpv.routes'

/** El path registrado del PRIMER layer GET que casa con `url`: el que Express ejecutaría. */
function firstGetMatch(r: any, url: string): string | undefined {
  for (const layer of r.stack ?? []) {
    if (!layer.route || !layer.route.methods?.get) continue
    if (layer.match(url)) return layer.route.path
  }
  return undefined
}

describe('tpv.routes — lecturas de la verificación', () => {
  it.each(['number-check', 'actionable', 'status', 'pending'])('GET /verification/%s la atiende su ruta literal', literal => {
    expect(firstGetMatch(tpvRouter, `/verification/${literal}`)).toBe(`/verification/${literal}`)
  })

  it('un id real sigue cayendo en el detalle', () => {
    expect(firstGetMatch(tpvRouter, '/verification/cmgxk2l3e0001qz8h5y6t7r8s')).toBe('/verification/:verificationId')
  })

  it('el YAML de las rutas nuevas se parsea y aparecen en el spec', () => {
    const spec = swaggerJsdoc({
      definition: { openapi: '3.0.0', info: { title: 'test', version: '1.0.0' } },
      apis: [path.join(__dirname, '../../../src/routes/tpv.routes.ts')],
      failOnErrors: true,
    }) as { paths: Record<string, { get?: { summary?: string }; post?: { responses?: Record<string, unknown> } }> }

    for (const literal of ['number-check', 'actionable', 'status', 'pending']) {
      expect(spec.paths[`/tpv/verification/${literal}`]?.get?.summary).toEqual(expect.any(String))
    }
    expect(spec.paths['/tpv/verification/{verificationId}/number']?.post?.responses).toHaveProperty('403')
  })
})
