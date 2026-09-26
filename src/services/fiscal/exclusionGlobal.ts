import type { Prisma } from '@prisma/client'

/** Una respuesta incierta sigue ocupando la venta, aunque el barrido la marque STAMP_FAILED. */
export const CFDI_VIVO: Prisma.CfdiWhereInput = {
  AND: [
    { status: { not: 'VALIDATION_FAILED' } },
    { OR: [{ status: { not: 'STAMP_FAILED' } }, { falloDefinitivo: false }] },
    { OR: [{ status: { not: 'CANCELLED' } }, { cancelStatus: null }, { cancelStatus: { notIn: ['ACCEPTED', 'CANCELLED'] } }] },
  ],
}

/** El llamador tiene bloqueada la orden antes de consultar su pertenencia. */
export async function excluirSiEstaEnGlobal(tx: Prisma.TransactionClient, orderId: string): Promise<string | null> {
  const cfdi = await tx.cfdi.findFirst({
    where: { isGlobal: true, manifiestoGlobal: { some: { orderId } }, ...CFDI_VIVO },
    select: { serie: true, folio: true, globalPeriod: true },
  })
  if (!cfdi) return null
  const period = cfdi.globalPeriod as { meses?: string; anio?: number } | null
  const label =
    [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || [period?.meses, period?.anio].filter(Boolean).join('/') || 'del periodo'
  return `Esta venta ya está incluida en la factura global ${label}; para facturarla aparte primero hay que cancelar esa global.`
}
