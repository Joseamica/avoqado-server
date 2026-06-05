// src/services/fiscal/cfdiValidation.ts
import { CsdStatus } from '@prisma/client'
import { CfdiItemInput, ReceptorValidationResult } from './providers/fiscal-provider.interface'

export interface PreStampInput {
  csdStatus: CsdStatus
  formaPago: string
  receptor: { rfc: string; razonSocial: string; regimenFiscal: string; codigoPostal: string; usoCfdi: string }
  items: CfdiItemInput[]
  expectedSubtotalCents: number
  expectedTaxCents: number
  expectedTotalCents: number
  /** True only for the month-end global CFDI (Flow C). Individual issuance (Flow B/A) must pass false or omit. */
  isGlobal?: boolean
}

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i

/** Pure, deterministic pre-timbrado validation. Returns Spanish reasons (shown to staff/customer). */
export function validateBeforeStamp(input: PreStampInput): ReceptorValidationResult {
  const reasons: string[] = []

  // Emisor CSD must be live
  if (input.csdStatus !== 'ACTIVE') reasons.push('El sello digital (CSD) del emisor no está activo. No se puede facturar.')

  // Receptor
  if (!RFC_RE.test(input.receptor.rfc)) reasons.push('El RFC del receptor no tiene un formato válido.')
  // XAXX010101000 "Público en General" is ONLY valid on the global CFDI (Flow C), never on an individual invoice.
  if (!input.isGlobal && input.receptor.rfc?.toUpperCase() === 'XAXX010101000') {
    reasons.push('El RFC "Público en General" (XAXX010101000) solo es válido en la factura global, no en una factura individual.')
  }
  if (!/^\d{5}$/.test(input.receptor.codigoPostal)) reasons.push('El código postal del receptor debe tener 5 dígitos.')
  if (!input.receptor.razonSocial?.trim()) reasons.push('La razón social del receptor es obligatoria.')
  if (!/^\d{3}$/.test(input.receptor.regimenFiscal)) reasons.push('El régimen fiscal del receptor no es válido.')
  if (!input.receptor.usoCfdi?.trim()) reasons.push('Falta el Uso del CFDI.')

  // FormaPago resolved
  if (!input.formaPago || input.formaPago === '99') reasons.push('La forma de pago no está definida para este CFDI.')

  // Conceptos
  if (input.items.length === 0) reasons.push('El CFDI no tiene conceptos.')
  input.items.forEach((it, i) => {
    const n = i + 1
    if (!it.satProductKey?.trim()) reasons.push(`Concepto ${n} ("${it.description}") sin clave de producto SAT (ClaveProdServ).`)
    if (!it.satUnitKey?.trim()) reasons.push(`Concepto ${n} ("${it.description}") sin clave de unidad SAT (ClaveUnidad).`)
    const hasTraslado = it.taxes.some(t => !t.withholding)
    if (it.objetoImp === '02' && !hasTraslado)
      reasons.push(`Concepto ${n}: ObjetoImp 02 (sí objeto de impuesto) pero sin impuesto trasladado.`)
    if (it.objetoImp === '01' && it.taxes.length > 0)
      reasons.push(`Concepto ${n}: ObjetoImp 01 (no objeto de impuesto) no debe llevar impuestos.`)
  })

  // Money cuadra al centavo (integer cents): subtotal + tax = total
  if (input.expectedSubtotalCents + input.expectedTaxCents !== input.expectedTotalCents) {
    reasons.push('Los importes no cuadran al centavo (subtotal + impuestos ≠ total).')
  }

  return { valid: reasons.length === 0, reasons }
}
