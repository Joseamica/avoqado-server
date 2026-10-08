// tests/integration/staffPay/recibos.concepto.test.ts — E6a-fix F13 (QA E6a H11, H13): el concepto de una comisión dice su
// esquema UNA vez y su tasa («Comisión Estándar Meseros 3 % · venta #… · base …», spec fase 3 §11), igual abierto y cerrado;
// y el PDF del recibo no corta el concepto y trae arriba los totales por tipo, como la pantalla.
import PDFDocument from 'pdfkit'
import prisma from '@/utils/prismaClient'
import { exportarRecibo, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { borrarMundo, clase, confirmadas, crearMundo, Mundo, tablaMindform } from './_mundo'
import { activar, cobro, comision, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const SEP2 = new Date('2026-09-02T12:00:00Z')
let m: Mundo
beforeEach(async () => {
  m = await crearMundo('recibo-concepto')
  ;(global as any).__sedes = [m.venueId]
  await tablaMindform(m)
  await activar(m)
})
afterEach(() => borrarMundo(m))

const cerrar = async () => {
  const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: SEP2 })
  return cerrarPeriodo({
    userId: m.owner,
    venueId: m.venueId,
    fecha: '2026-08-15',
    ahora: SEP2,
    confirmarHuerfanas: true,
    huellaEsperada: p.huella,
  })
}
const recibo = (staffId: string) => reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId, fecha: '2026-08-15', limit: 100 })
const comisiones = async (staffId: string) =>
  (await recibo(staffId)).renglones
    .filter(r => r.tipo === 'COMISION')
    .map(r => r.concepto)
    .sort()
const numero = async (p: { orderId: string }) => (await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } })).orderNumber

/** Una comisión con su tipo de cálculo y su tasa (la de `_ventas.comision` es siempre 3 % por porcentaje). */
async function comisionCon(configId: string, o: { iso: string; neto: number; base: number; tasa: number; tipo: 'PERCENTAGE' | 'FIXED' }) {
  const pago = await cobro(m, { iso: o.iso, monto: o.base })
  await prisma.commissionCalculation.create({
    data: {
      venueId: m.venueId,
      staffId: m.sofia,
      configId,
      paymentId: pago.id,
      orderId: pago.orderId,
      baseAmount: o.base,
      effectiveRate: o.tasa,
      grossCommission: o.neto,
      netCommission: o.neto,
      calcType: o.tipo,
      calculatedAt: new Date(o.iso),
    },
  })
  return numero(pago)
}

describe('F13 — el concepto de una comisión (QA E6a H11)', () => {
  it('sin «Comisión» repetido y con su tasa; la devolución también; una comisión fija no inventa una tasa; abierto = cerrado', async () => {
    const meseros = await esquema(m, m.venueId, 'Comisión Estándar Meseros')
    const venta = await cobro(m, { iso: '2026-08-12T18:00:00Z', monto: 3000 })
    await comision(m, { configId: meseros, staffId: m.sofia, iso: '2026-08-12T18:00:05Z', neto: 90, pago: venta })
    const dev = await reembolso(m, venta, { iso: '2026-08-20T18:00:00Z', monto: 1000 })
    await comision(m, { configId: meseros, staffId: m.sofia, iso: '2026-08-20T18:00:00Z', neto: -30, base: 1000, pago: dev })
    const fija = await comisionCon(await esquema(m, m.venueId, 'Comisión Fija Cajeros'), {
      iso: '2026-08-13T18:00:00Z',
      neto: 5,
      base: 500,
      tasa: 5,
      tipo: 'FIXED',
    })
    const lagree = await comisionCon(await esquema(m, m.venueId, 'Lagree'), {
      iso: '2026-08-14T18:00:00Z',
      neto: 25,
      base: 1000,
      tasa: 0.025,
      tipo: 'PERCENTAGE',
    })
    const n = await numero(venta)
    const esperado = [
      `Comisión Estándar Meseros 3 % · venta #${n} · base $3,000.00`,
      `Comisión Fija Cajeros · venta #${fija} · base $500.00`,
      `Comisión Lagree 2.5 % · venta #${lagree} · base $1,000.00`,
      `Devolución · comisión Estándar Meseros 3 % · venta #${n}`,
    ].sort()
    expect(await comisiones(m.sofia)).toEqual(esperado)
    await cerrar()
    expect(await comisiones(m.sofia)).toEqual(esperado) // lo congelado dice lo mismo (la tasa va en su foto)
  })
})

/** Lo que el PDF dibuja (el espía de `recibos.ventas.test.ts`). */
async function textoDelPdf(staffId: string): Promise<string[]> {
  const proto = PDFDocument.prototype as unknown as { _fragment: (texto: string, ...resto: unknown[]) => unknown }
  const fragment = jest.spyOn(proto, '_fragment')
  try {
    const pdf = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId, fecha: '2026-08-15', format: 'pdf' })
    expect(pdf.encoded.buffer.subarray(0, 4).toString()).toBe('%PDF')
    return fragment.mock.calls.map(args => String(args[0]))
  } finally {
    fragment.mockRestore()
  }
}

describe('F13 — el PDF del recibo (QA E6a H13)', () => {
  it('trae arriba los totales por tipo, como la pantalla, y el concepto entero (con su base), sin «…»; abierto y cerrado', async () => {
    await clase(m, { staffId: m.carla, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) }) // Coach, 8 lugares: $480
    const venta = await cobro(m, { iso: '2026-08-12T18:00:00Z', monto: 3000, propina: 80, servedById: m.carla })
    const cfg = await esquema(m, m.venueId, 'Comisión Estándar Meseros Turno Vespertino')
    await comision(m, { configId: cfg, staffId: m.carla, iso: '2026-08-12T18:00:05Z', neto: 90, pago: venta })
    for (const cerrado of [false, true]) {
      if (cerrado) await cerrar()
      const texto = await textoDelPdf(m.carla)
      expect(texto).toContain('Clases $480.00 · Comisiones $90.00 · Propinas $80.00')
      expect(texto.join(' ')).toContain('base $3,000.00')
      expect(texto.filter(t => t.includes('…'))).toEqual([])
    }
  })

  it('con un solo tipo no repite su total arriba (ya es el «Total»)', async () => {
    await clase(m, { staffId: m.carla, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    expect((await textoDelPdf(m.carla)).filter(t => t.startsWith('Clases $'))).toEqual([])
  })
})
