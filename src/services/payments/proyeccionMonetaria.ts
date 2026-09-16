/**
 * Codex R3 (P2): UNA sola proyección monetaria para la comisión y el neto de un Payment, compartida por el costo síncrono
 * (`createTransactionCost`), el diferido (`settleDeferredTransactionCost`) y la liquidación (`calculateNetSettlementAmount`).
 * Parte de los valores tal como quedan PERSISTIDOS en `TransactionCost` (escala 4: `venueChargeAmount` numeric(10,4),
 * `venueFixedFee` numeric(8,4)), redondea la comisión a la escala de `Payment.feeAmount` (2) y deriva el neto del importe
 * menos ESA comisión, de modo que comisión + neto = importe siempre — en los tres escritores.
 * Con $1.11 al 2.25 %: 0.024975 → 0.0250 → comisión 0.03 → neto 1.08 (y no 1.085 → 1.09, que sumaba $1.12).
 */
import { Prisma } from '@prisma/client'

export function proyectarComisionYNeto(amount: unknown, venueChargeAmount: unknown, venueFixedFee: unknown): { fee: number; net: number } {
  const charge = new Prisma.Decimal(String(venueChargeAmount ?? 0)).toDecimalPlaces(4)
  const fixed = new Prisma.Decimal(String(venueFixedFee ?? 0)).toDecimalPlaces(4)
  const fee = charge.plus(fixed).toDecimalPlaces(2)
  const net = new Prisma.Decimal(String(amount ?? 0)).toDecimalPlaces(2).minus(fee)
  return { fee: fee.toNumber(), net: net.toNumber() }
}
