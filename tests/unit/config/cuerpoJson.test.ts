/**
 * Codex servidor r7 #2 (máquina de efectivo): el cierre y la duda de la QuickPay llevan el carrito que la máquina YA cobró. Con el límite
 * general de 1 MiB, un carrito que sí se cotizó rebotaba con 413 antes de guardar nada y el efectivo quedaba sólo en la PC. Aquí, el lector
 * REAL del cuerpo (`usarCuerposJson`, el mismo que monta `middleware.ts`) con rutas de eco.
 */
import express from 'express'
import request from 'supertest'

import { LIMITE_JSON_DE_LA_MAQUINA, usarCuerposJson } from '@/config/cuerpoJson'
import { TOPE_DEL_CARRITO_DE_LA_MAQUINA } from '@/services/cashMachine/cotizacionDeLaMaquina'

const app = express()
usarCuerposJson(app)
app.post('*', (req, res) => res.json({ bytes: Number(req.headers['content-length']), crudo: Boolean(req.cuerpoCrudo) }))
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
  res.status(err.status ?? 500).json({ type: err.type }),
)

const VENTA = '/api/v1/mobile/venues/cjld2cjxh0000qzrmn831i7rn/cash-machine/sales'
const DUDA = '/api/v1/mobile/venues/cjld2cjxh0000qzrmn831i7rn/cash-machine/doubts'
const MiB = 1024 * 1024
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** El carrito de Codex: 3,404 renglones con notas que suman 1,048,546 bytes. */
function carritoDeCodex() {
  const items = Array.from({ length: 3404 }, () => ({ productId: 'prod-pan', quantity: 1, notes: 'sin cebolla, bien dorado'.repeat(10) }))
  const c = { staffId: 'staff-A', orderType: 'TAKEOUT', source: 'AVOQADO_ANDROID', tip: 0, discount: 0, items }
  items[0].notes += 'x'.repeat(1_048_546 - bytes(JSON.stringify(c)))
  return c
}

/** El sobre del cierre que sube la PC (`SubidaDeLaMaquina.cuerpoDelCierre`), con el carrito. */
const cierreCon = (pedido: unknown) =>
  JSON.stringify({
    referenceCC: 'AQ0123456789AB',
    cierre: {
      outcome: 'GUARDADO',
      dueCents: 100000,
      saleCents: 100000,
      tipCents: 0,
      creditCents: 5000,
      changeDispensedCents: 0,
      occurredAtKnown: true,
      occurredAt: '2026-11-21T18:00:00.000Z',
      saleShiftId: null,
      cancelMode: '2',
    },
    bindingId: 'cjld2cjxh0000qzrmn831i7rn',
    pedido,
  })

const enviar = (ruta: string, cuerpo: string) => request(app).post(ruta).set('Content-Type', 'application/json').send(cuerpo)

describe('usarCuerposJson · el cierre de la máquina nunca rebota por tamaño si su carrito se cotizó', () => {
  it('🔴 el cierre de Codex (carrito de 1,048,546 bytes, más de 1 MiB con el sobre) entra a la venta y a la duda', async () => {
    const cuerpo = cierreCon(carritoDeCodex())
    expect(bytes(cuerpo)).toBeGreaterThan(MiB)
    for (const ruta of [VENTA, DUDA, `${VENTA}/`]) {
      const r = await enviar(ruta, cuerpo)
      expect([ruta, r.status]).toEqual([ruta, 200])
      expect(r.body).toEqual({ bytes: bytes(cuerpo), crudo: true })
    }
  })

  it('🔴 un carrito en el tope de la cotización cabe aunque la PC lo reescriba con TODO escapado (\\uXXXX, el peor caso ×6) más el sobre', async () => {
    // Notas de «é» (2 bytes en UTF-8) hasta el tope, medido como lo mide la cotización (`JSON.stringify`).
    const base = { staffId: 'staff-A', items: [{ productId: 'prod-pan', quantity: 2, notes: '' }] }
    const n = Math.floor((TOPE_DEL_CARRITO_DE_LA_MAQUINA - bytes(JSON.stringify(base))) / 2)
    const pedido = { ...base, items: [{ ...base.items[0], notes: 'é'.repeat(n) }] }
    expect(bytes(JSON.stringify(pedido))).toBeLessThanOrEqual(TOPE_DEL_CARRITO_DE_LA_MAQUINA)
    const escapado = cierreCon(pedido).replace(/[\u0080-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    expect(bytes(escapado)).toBeGreaterThan(MiB) // con el límite general, este cierre era un 413
    for (const ruta of [VENTA, DUDA]) expect((await enviar(ruta, escapado)).status).toBe(200)
    // Y la cuenta del peor caso (cada byte del carrito escapado a 6) más un sobre generoso sigue abajo del límite de la máquina.
    expect(6 * TOPE_DEL_CARRITO_DE_LA_MAQUINA + 64 * 1024).toBeLessThan(LIMITE_JSON_DE_LA_MAQUINA)
  })

  it('el límite de la máquina existe: más de 4 MiB es 413', async () => {
    const enorme = cierreCon({ items: [{ notes: 'x'.repeat(LIMITE_JSON_DE_LA_MAQUINA) }] })
    expect((await enviar(VENTA, enorme)).status).toBe(413)
  })

  it('🔴 lo demás sigue con 1 MiB: la cotización, las cuentas y la consulta de la venta', async () => {
    const cuerpo = cierreCon(carritoDeCodex())
    for (const ruta of [
      '/api/v1/mobile/venues/cjld2cjxh0000qzrmn831i7rn/cash-machine/quote',
      '/api/v1/mobile/venues/cjld2cjxh0000qzrmn831i7rn/orders',
      `${VENTA}/AQ0123456789AB`,
      '/api/v1/dashboard/venues/cjld2cjxh0000qzrmn831i7rn/cash-machine/doubts',
    ]) {
      expect([ruta, (await enviar(ruta, cuerpo)).status]).toEqual([ruta, 413])
    }
    expect((await enviar('/api/v1/mobile/venues/v/orders', JSON.stringify({ ok: 1 }))).body).toEqual({ bytes: 8, crudo: true })
  })
})
