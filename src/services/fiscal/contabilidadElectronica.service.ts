import { BadRequestError } from '../../errors/AppError'
import { getCatalog } from './chartOfAccounts.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { getTrialBalance } from './trialBalance.service'

/**
 * Contabilidad electrónica (SAT, Anexo 24) — genera el XML del Catálogo de cuentas y de la Balanza
 * de comprobación en el esquema 1.3 del SAT, a partir del catálogo y de las pólizas ya existentes.
 *
 * Lo que entrega es el XML SIN SELLAR (igual que Alegra): el contribuyente/su contador lo sella con
 * su e.firma y lo envía por el portal del SAT. Importes en PESOS con 2 decimales (el SAT NO usa
 * centavos); saldos en valor ABSOLUTO (el signo lo da la naturaleza de la cuenta). Gated PREMIUM (CFDI).
 *
 * Nombre de archivo SAT: <RFC><Año><Mes><Tipo>.xml — CT=catálogo, BN=balanza normal, BC=complementaria.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const CAT_NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas'
const BCE_NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion'

/** Escapa los 5 caracteres especiales de XML para atributos/contenido. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Centavos enteros → string de pesos con 2 decimales (valor absoluto para saldos SAT). */
const pesos = (cents: number): string => (Math.abs(cents) / 100).toFixed(2)

export interface ContaElectronicaResult {
  needsFiscalSetup: boolean
  empty: boolean
  rfc: string | null
  period: string
  filename: string | null
  xml: string | null
}

const emptyResult = (period: string, rfc: string | null, needsFiscalSetup: boolean, empty: boolean): ContaElectronicaResult => ({
  needsFiscalSetup,
  empty,
  rfc,
  period,
  filename: null,
  xml: null,
})

/**
 * XML del Catálogo de cuentas (Anexo 24, esquema CatalogoCuentas 1.3). Una línea `Ctas` por cuenta
 * activa, con su código agrupador SAT, número de cuenta, descripción, subcuenta-de (padre), nivel y
 * naturaleza (D/A).
 */
export async function getCatalogoXml(venueId: string, period: string): Promise<ContaElectronicaResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return emptyResult(period, null, true, false)

  const cat = await getCatalog(venueId)
  if (cat.needsFiscalSetup) return emptyResult(period, scope.rfc, true, false)
  // Incluye TODAS las cuentas (no sólo activas): el catálogo SAT es la ESTRUCTURA completa y toda
  // cuenta con SubCtaDe debe encadenar a un NumCta presente — excluir un padre rompería la jerarquía.
  const accounts = cat.accounts
  if (accounts.length === 0) return emptyResult(period, scope.rfc, false, true)

  const [anio, mes] = period.split('-')
  const present = new Set(accounts.map(a => a.code))
  const byId = new Map(accounts.map(a => [a.id, a.code]))

  const ctas = accounts
    .map(a => {
      const parentCode = a.parentId ? byId.get(a.parentId) : null
      // Sólo emite SubCtaDe si el padre está presente en el documento (integridad referencial SAT).
      const subCtaDe = parentCode && present.has(parentCode) ? parentCode : null
      const natur = a.nature === 'DEUDORA' ? 'D' : 'A'
      return (
        `  <catalogocuentas:Ctas CodAgrup="${esc(a.satGroupingCode)}" NumCta="${esc(a.code)}" Desc="${esc(a.name)}"` +
        `${subCtaDe ? ` SubCtaDe="${esc(subCtaDe)}"` : ''} Nivel="${a.level}" Natur="${natur}"/>`
      )
    })
    .join('\n')

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<catalogocuentas:Catalogo xmlns:catalogocuentas="${CAT_NS}" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="${CAT_NS} ${CAT_NS}/CatalogoCuentas_1_3.xsd" ` +
    `Version="1.3" RFC="${esc(scope.rfc)}" Mes="${mes}" Anio="${anio}">\n` +
    `${ctas}\n` +
    `</catalogocuentas:Catalogo>\n`

  return { needsFiscalSetup: false, empty: false, rfc: scope.rfc, period, filename: `${scope.rfc}${anio}${mes}CT.xml`, xml }
}

/**
 * XML de la Balanza de comprobación (Anexo 24, esquema BalanzaComprobacion 1.3). Una línea `Ctas` por
 * cuenta con saldo inicial, cargos, abonos y saldo final del periodo (en pesos). `tipoEnvio` N=normal,
 * C=complementaria. Sale de las pólizas (mismo cálculo que la balanza de pantalla).
 */
export async function getBalanzaXml(venueId: string, period: string, tipoEnvio: 'N' | 'C' = 'N'): Promise<ContaElectronicaResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')
  const tb = await getTrialBalance(venueId, period)
  if (tb.needsFiscalSetup) return emptyResult(period, tb.rfc, true, false)
  if (tb.rows.length === 0) return emptyResult(period, tb.rfc, false, true)

  const [anio, mes] = period.split('-')
  const tipo = tipoEnvio === 'C' ? 'C' : 'N'

  const ctas = tb.rows
    .map(
      r =>
        `  <BCE:Ctas NumCta="${esc(r.code)}" SaldoIni="${pesos(r.saldoInicialCents)}" Debe="${pesos(r.debeCents)}" Haber="${pesos(r.haberCents)}" SaldoFin="${pesos(r.saldoFinalCents)}"/>`,
    )
    .join('\n')

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<BCE:Balanza xmlns:BCE="${BCE_NS}" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="${BCE_NS} ${BCE_NS}/BalanzaComprobacion_1_3.xsd" ` +
    `Version="1.3" RFC="${esc(tb.rfc!)}" Mes="${mes}" Anio="${anio}" TipoEnvio="${tipo}">\n` +
    `${ctas}\n` +
    `</BCE:Balanza>\n`

  return { needsFiscalSetup: false, empty: false, rfc: tb.rfc, period, filename: `${tb.rfc}${anio}${mes}B${tipo}.xml`, xml }
}
