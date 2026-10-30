/**
 * Negocios demo (capa 2): todo archivo que manda correo (Resend, o Facturapi con la factura) o WhatsApp (Graph API de Meta) pasa por
 * `omitirPorDemo`. Un transporte nuevo que no lo llame truena aquí, en vez de mandarle mensajes reales a quien un
 * prospecto escribió en el negocio demo. Plan: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md, sección B.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const SALIDA = /new Resend\(|\.emails\.send\(|graph\.facebook\.com|\.sendInvoiceByEmail\(|google\.walletobjects\(/

/** Transportes que nunca parten de un negocio demo. La razón es obligatoria. */
const NUNCA_TOCAN_UN_DEMO: Record<string, string> = {
  'services/superadmin/platform-billing/platformCfdi.service.ts':
    'facturas de Avoqado a sus clientes, sólo superadmin; un negocio demo no tiene suscripción que facturar',
}

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivos(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

/** Cuántos envíos hay en el archivo: cada uno necesita su propio `omitirPorDemo` (Codex r2, 9: uno sin él pasaba). */
const sinComentarios = (codigo: string) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function envios(codigo: string): number {
  const directos = (codigo.match(/\.emails\.send\(|\.sendInvoiceByEmail\(/g) ?? []).length
  const whatsapp = /graph\.facebook\.com/.test(codigo) ? (codigo.match(/\bfetch\(/g) ?? []).length : 0
  const wallet = (codigo.match(/google\.walletobjects\(/g) ?? []).length
  return directos + whatsapp + wallet
}

describe('candado demo: los transportes de mensajes', () => {
  const conSalida = archivos(SRC).filter(f => SALIDA.test(fs.readFileSync(f, 'utf8')))

  it('encuentra los transportes conocidos (si esto baja, la búsqueda se rompió)', () => {
    expect(conSalida.length).toBeGreaterThanOrEqual(6)
  })

  it.each(conSalida.map(f => [path.relative(SRC, f)]))('%s: cada envío pasa por omitirPorDemo', rel => {
    if (rel in NUNCA_TOCAN_UN_DEMO) return
    const codigo = sinComentarios(fs.readFileSync(path.join(SRC, rel), 'utf8'))
    const candados = (codigo.match(/omitirPorDemo\(/g) ?? []).length
    expect(envios(codigo)).toBeGreaterThan(0)
    expect(candados).toBeGreaterThanOrEqual(envios(codigo))
  })
})
