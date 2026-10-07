// tests/unit/mcp-customer/staff-service-pay.falloDelServicio.test.ts — fase 3, B14-fix ronda 1 (R3): `falloDelServicio` acota a la
// conexión la vista previa que trae un rechazo del service (B14-fix F1). No puede SUPONER su forma: un rechazo con `pendientes` sin
// `porDestino` (o un destino sin `porSede`, o `porSede` que no es lista) tronaba con TypeError ⇒ 500, en vez de contestar el 4xx.
// Lo que no se puede atribuir a una sede de la conexión no sale (sin montos de sedes fuera); lo demás de la vista previa, igual.
import { acotarAlAlcance, falloDelServicio } from '../../../src/mcp/tools/staffPay.sedes'
import type { McpScope } from '../../../src/mcp/scope'

jest.mock('@/services/dashboard/staffPay/sedes.service', () => ({ estadoSedes: jest.fn() }))

const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['A'] } as unknown as McpScope
const rechazo = (preview: unknown) =>
  Object.assign(new Error('Los números cambiaron desde que los revisaste: revisa el cierre de nuevo'), {
    statusCode: 409,
    code: 'HUELLA_CAMBIO',
    details: { preview },
  })
const responder = (preview: unknown) => {
  const r = falloDelServicio(scope)(rechazo(preview)) as { content: Array<{ text: string }> }
  return { json: JSON.parse(r.content[0].text), texto: r.content[0].text }
}
const destino = { tipo: 'AL_CERRAR', periodo: { start: '2026-10-01', end: '2026-10-31' } }

describe('falloDelServicio con una vista previa de forma parcial (R3)', () => {
  it('`pendientes` SIN `porDestino`: contesta el 409 (no TypeError) y quita las pendientes, que no se pueden atribuir a una sede', () => {
    const { json, texto } = responder({
      total: '130.00',
      porSede: [{ venueId: 'A' }, { venueId: 'B' }],
      pendientes: { n: 2, total: '-80.00' },
    })
    expect(json).toMatchObject({ ok: false, code: 'HUELLA_CAMBIO', preview: { total: '130.00', porSede: [{ venueId: 'A' }] } })
    expect(json.preview).not.toHaveProperty('pendientes')
    expect(texto).not.toContain('-80.00')
  })

  it('un destino sin `porSede` no se puede atribuir: sale; los demás se rehacen con sus sedes de la conexión', () => {
    const { json, texto } = responder({
      pendientes: {
        n: 3,
        total: '-130.00',
        porDestino: [
          { seDescuenta: destino, n: 1, total: '-50.00' },
          {
            seDescuenta: destino,
            n: 2,
            total: '-80.00',
            porSede: [
              { venueId: 'A', n: 1, total: '-30.00' },
              { venueId: 'B', n: 1, total: '-50.00' },
            ],
          },
        ],
      },
    })
    expect(json.preview.pendientes).toEqual({
      n: 1,
      total: '-30.00',
      porDestino: [{ seDescuenta: destino, n: 1, total: '-30.00', porSede: [{ venueId: 'A', n: 1, total: '-30.00' }] }],
    })
    expect(texto).not.toContain('-50.00')
  })

  it('`porSede` que no es lista, renglones sin sede o con un monto ilegible: fuera, sin tronar', () => {
    const { json } = responder({
      porSede: { A: 1 },
      pendientes: {
        n: 2,
        total: '-60.00',
        porDestino: [
          {
            seDescuenta: destino,
            porSede: [null, { n: 1, total: '-10.00' }, { venueId: 'A', n: 1, total: 'x' }, { venueId: 'A', n: 1, total: '-20.00' }],
          },
          'basura',
          { seDescuenta: destino, porSede: 'tampoco' },
        ],
      },
    })
    expect(json.preview).not.toHaveProperty('porSede')
    expect(json.preview.pendientes).toEqual({
      n: 1,
      total: '-20.00',
      porDestino: [{ seDescuenta: destino, n: 1, total: '-20.00', porSede: [{ venueId: 'A', n: 1, total: '-20.00' }] }],
    })
  })

  it('`pendientes: null` y una vista previa sin sedes pasan igual; un 5xx sigue lanzándose', () => {
    expect(responder({ total: '1.00', pendientes: null }).json).toMatchObject({ preview: { total: '1.00', pendientes: null } })
    expect(responder('no es objeto').json.preview).toBeNull()
    const caida = Object.assign(new Error('boom'), { statusCode: 500 })
    expect(() => falloDelServicio(scope)(caida)).toThrow('boom')
  })
})

describe('acotarAlAlcance con la forma completa (regresión)', () => {
  it('se queda con A en `porSede` y en cada destino, y rehace n y total con Decimal', () => {
    const p = acotarAlAlcance(
      {
        total: '130.00',
        porSede: [{ venueId: 'A' }, { venueId: 'B' }],
        pendientes: {
          n: 3,
          total: '-110.00',
          porDestino: [
            {
              seDescuenta: destino,
              n: 3,
              total: '-110.00',
              porSede: [
                { venueId: 'A', n: 2, total: '-60.10' },
                { venueId: 'B', n: 1, total: '-49.90' },
              ],
            },
          ],
        },
      } as any,
      ['A'],
    )
    expect(p).toEqual({
      total: '130.00',
      porSede: [{ venueId: 'A' }],
      pendientes: {
        n: 2,
        total: '-60.10',
        porDestino: [{ seDescuenta: destino, n: 2, total: '-60.10', porSede: [{ venueId: 'A', n: 2, total: '-60.10' }] }],
      },
    })
  })
})
