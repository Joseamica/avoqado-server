/**
 * Candado estático: findMany SIN `take` sobre modelos que crecen con la operación.
 *
 * Incidente 2026-09-01: el detalle del venue materializaba las 33k órdenes + 33k pagos
 * de Testarudo por petición y Render reemplazó la instancia de producción. El barrido
 * posterior encontró 186 findMany sin tope sobre tablas grandes en 88 archivos.
 *
 * Este test CONGELA ese inventario: cada archivo tiene su conteo actual permitido.
 * - Un findMany sin tope NUEVO (archivo nuevo, o conteo que sube) FALLA aquí: o le
 *   pones `take`, o lo acotas por ventana y lo registras aquí A PROPÓSITO subiendo el
 *   número con un porqué en el PR.
 * - Un conteo que BAJA también falla, pidiendo encoger el inventario — la lista sólo
 *   puede encoger sola, nunca crecer sola (mismo patrón que jobContextGuard).
 *
 * No afirma que los 186 actuales sean seguros — muchos se acotan por `where` (rango de
 * fechas, turno abierto) y los patológicos los denuncia en runtime el query-guard
 * (`src/utils/queryResultGuard.ts`). Afirma que nadie AGREGA uno más sin pensarlo.
 */
import * as fs from 'fs'
import * as path from 'path'

// Modelos cuyo tamaño crece con cada venta/checada/evento — el detalle de por qué
// justo éstos: son las tablas más grandes medidas en producción el 2026-09-01.
const MODELOS_GRANDES = [
  'order',
  'payment',
  'orderItem',
  'shift',
  'activityLog',
  'digitalReceipt',
  'serializedItemCustodyEvent',
  'venueTransaction',
  'timeEntry',
  'review',
  'notification',
  'serializedItem',
  'rawMaterialMovement',
  'inventoryMovement',
  'terminalLog',
  'idempotencyRequest',
  'saleVerification',
  'providerEventLog',
]

// Ventana de búsqueda del `take` tras el findMany — idéntica al barrido que produjo
// el inventario. Si se cambia, hay que regenerar el inventario completo.
const VENTANA_CHARS = 1200

/** Inventario congelado al 2026-09-01 (186 en 88 archivos). Sólo puede ENCOGER. */
const INVENTARIO: Record<string, number> = {
  'src/jobs/abandoned-orders-cleanup.job.ts': 1,
  'src/jobs/attendance-late-alert.job.ts': 1,
  'src/jobs/auto-clockout.job.ts': 2,
  'src/jobs/blumon-webhook-reconciliation.job.ts': 1,
  'src/jobs/playtelecomEventSimReassignment.job.ts': 3,
  'src/mcp/tools/inventory.ts': 3,
  'src/mcp/tools/sales.ts': 1,
  'src/mcp/tools/staff.ts': 1,
  'src/middlewares/checkTableOwnership.middleware.ts': 1,
  'src/routes/dashboard/organizationConfig.routes.ts': 2,
  'src/services/b4bit/b4bit.service.ts': 1,
  'src/services/command-center/commandCenter.service.ts': 5,
  'src/services/dashboard/accounting.dashboard.service.ts': 2,
  'src/services/dashboard/activity-log.service.ts': 5,
  'src/services/dashboard/assistant.dashboard.service.ts': 1,
  'src/services/dashboard/attendance.dashboard.service.ts': 2,
  'src/services/dashboard/attendanceLiveAlert.ts': 1,
  'src/services/dashboard/autoReorder.service.ts': 2,
  // 2026-09-01: availableBalance bajó de 8 → 0. Calendar, byCardType, projection y
  // cash se agregaron en Postgres; timeline y saldo completo recorren páginas
  // internas con cursores. Al llegar a cero sale del inventario en vez de guardar
  // una excepción vacía.
  'src/services/dashboard/bankReconciliation.service.ts': 1,
  'src/services/dashboard/cash-out/cash-out.ledger.service.ts': 2,
  'src/services/dashboard/cashCloseout.dashboard.service.ts': 1,
  'src/services/dashboard/commission/commission-attendance.ts': 1,
  'src/services/dashboard/commission/commission-utils.ts': 1,
  'src/services/dashboard/cost-management.service.ts': 1,
  'src/services/dashboard/customer.dashboard.service.ts': 1,
  // 2026-09-01: 19 → 3. Las 16 agregaciones se reescribieron a GROUP BY en
  // Postgres (golden snapshots al centavo + integración con base real). Los 3
  // que quedan devuelven las FILAS al dashboard (contrato de la API, con select
  // acotado): quitarlos exige paginar también el cliente — trabajo aparte.
  // 2026-09-01 (tarde): 3 → 2. basic-metrics pasó a summary en SQL; sus listas de
  // compatibilidad llevan take (BASIC_METRICS_ROWS_CAP).
  'src/services/dashboard/generalStats.dashboard.service.ts': 2,
  'src/services/dashboard/inventoryRestock.service.ts': 1,
  'src/services/dashboard/itemCategory.dashboard.service.ts': 1,
  'src/services/dashboard/order.dashboard.service.ts': 2,
  'src/services/dashboard/payment.dashboard.service.ts': 2,
  'src/services/dashboard/purchaseOrder.service.ts': 1,
  'src/services/dashboard/receipt.dashboard.service.ts': 2,
  'src/services/dashboard/refund.dashboard.service.ts': 3,
  'src/services/dashboard/refunds.dashboard.service.ts': 1,
  'src/services/dashboard/reports.dashboard.service.ts': 1,
  'src/services/dashboard/review.dashboard.service.ts': 1,
  'src/services/dashboard/sale-verification.dashboard.service.ts': 2,
  'src/services/dashboard/sales-summary.dashboard.service.ts': 3,
  'src/services/dashboard/settlementCalendar.dashboard.service.ts': 1,
  'src/services/dashboard/settlementIncident.service.ts': 1,
  'src/services/dashboard/shared-query.service.ts': 4,
  'src/services/dashboard/shift.dashboard.service.ts': 1,
  'src/services/dashboard/venue.dashboard.service.ts': 2,
  'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts': 1,
  'src/services/delivery-channels/core/releaseScheduledOrder.service.ts': 1,
  'src/services/fiscal/autoPosting.service.ts': 1,
  'src/services/fiscal/cfdiGlobal.service.ts': 1,
  'src/services/fiscal/cogs.service.ts': 1,
  'src/services/inventory/inventoryPosting.service.ts': 1,
  'src/services/inventory/reverseSalePosting.service.ts': 2,
  'src/services/legacy/mergedPayments.service.ts': 2,
  'src/services/mobile/areaTicket.mobile.service.ts': 1,
  'src/services/mobile/areaTicketV7.mobile.service.ts': 2,
  'src/services/mobile/cash-drawer.mobile.service.ts': 1,
  'src/services/mobile/comp-item.mobile.service.ts': 2,
  'src/services/mobile/end-of-day.mobile.service.ts': 3,
  'src/services/mobile/kds.mobile.service.ts': 1,
  'src/services/mobile/order.mobile.service.ts': 3,
  'src/services/mobile/sync.mobile.service.ts': 1,
  'src/services/mobile/transaction.mobile.service.ts': 1,
  'src/services/onboarding/demoCleanup.service.ts': 1,
  'src/services/organization-dashboard/orgStockControl.service.ts': 1,
  // 2026-09-01: 15 → 5. Diez agregaciones (resumen global, promotores activos ×3, top
  // promotor, efectivo por checada, tendencia y mezcla por vendedor, los dos heatmaps) se
  // reescribieron a SQL (golden al centavo + integración con base real). Los 5 que quedan
  // devuelven FILAS al dashboard o corren un motor por fila (GPS de hoy, personal en línea,
  // checadas del día, calendario, reporte de cierre) y llevan select quirúrgico.
  'src/services/organization-dashboard/organizationDashboard.service.ts': 5,
  'src/services/promoters/promoters.service.ts': 3,
  'src/services/promoters/terminalLocation.service.ts': 1,
  'src/services/referrals/referralRefund.service.ts': 1,
  'src/services/reservation/checkIn.service.ts': 1,
  'src/services/serialized-inventory/custody.service.ts': 1,
  'src/services/serialized-inventory/serializedInventory.service.ts': 3,
  'src/services/serialized-inventory/simRegistration.service.ts': 2,
  'src/services/stock-dashboard/stockDashboard.service.ts': 2,
  'src/services/superadmin/creditAssessment.service.ts': 1,
  'src/services/superadmin/rateCorrection/rateCorrectionApply.ts': 2,
  'src/services/superadmin/rateCorrection/rateCorrectionPreview.ts': 1,
  'src/services/superadmin/settlementCalendar.superadmin.service.ts': 1,
  'src/services/tpv/angelpay-webhook.service.ts': 1,
  'src/services/tpv/blumon-webhook.service.ts': 1,
  'src/services/tpv/order.tpv.service.ts': 3,
  'src/services/tpv/payment.tpv.service.ts': 2,
  'src/services/tpv/refund.tpv.service.ts': 1,
  'src/services/tpv/sale-verification.service.ts': 1,
  'src/services/tpv/shift.tpv.service.ts': 8,
  'src/services/tpv/table.tpv.service.ts': 2,
  'src/services/tpv/time-entry.tpv.service.ts': 3,
  'src/services/wallet/redeemStampReward.service.ts': 1,
  'src/utils/datetime.ts': 2,
}

const RAIZ = path.resolve(__dirname, '../../..')
const patron = new RegExp(`\\.(${MODELOS_GRANDES.join('|')})\\.findMany\\s*\\(`, 'g')

function listarArchivos(dir: string): string[] {
  const salida: string[] = []
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name)
    if (entrada.isDirectory()) salida.push(...listarArchivos(completo))
    else if (entrada.name.endsWith('.ts') && !entrada.name.includes('.test.')) salida.push(completo)
  }
  return salida
}

function contarSinTope(contenido: string): number {
  let n = 0
  patron.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = patron.exec(contenido)) !== null) {
    const ventana = contenido.slice(m.index, m.index + VENTANA_CHARS)
    if (!/\btake\s*:/.test(ventana)) n += 1
  }
  return n
}

describe('findMany sin tope sobre modelos grandes — el inventario sólo encoge', () => {
  const medido: Record<string, number> = {}

  beforeAll(() => {
    for (const abs of listarArchivos(path.join(RAIZ, 'src'))) {
      const rel = path.relative(RAIZ, abs).split(path.sep).join('/')
      const n = contarSinTope(fs.readFileSync(abs, 'utf8'))
      if (n > 0) medido[rel] = n
    }
  })

  it('ningún archivo AGREGA un findMany sin tope (nuevo o de más)', () => {
    const violaciones: string[] = []
    for (const [archivo, n] of Object.entries(medido)) {
      const permitido = INVENTARIO[archivo] ?? 0
      if (n > permitido) {
        violaciones.push(`${archivo}: tiene ${n}, permitidos ${permitido}`)
      }
    }
    if (violaciones.length) {
      throw new Error(
        `findMany sin \`take\` NUEVO sobre un modelo que crece con la operación:\n  ${violaciones.join('\n  ')}\n\n` +
          `Un findMany sin tope sobre Order/Payment/TimeEntry/... es la clase de bug que tumbó producción el 2026-09-01 ` +
          `(33k órdenes materializadas por petición). Ponle \`take\`, o acótalo por ventana de fechas y — sólo si es a ` +
          `propósito — sube su número en el INVENTARIO de este test explicando por qué en el PR.`,
      )
    }
  })

  it('el inventario no guarda archivos que ya se limpiaron (encoge cuando el código mejora)', () => {
    const sobras: string[] = []
    for (const [archivo, permitido] of Object.entries(INVENTARIO)) {
      const n = medido[archivo] ?? 0
      if (n < permitido) {
        sobras.push(`${archivo}: el inventario permite ${permitido} pero quedan ${n} — baja el número`)
      }
    }
    if (sobras.length) {
      throw new Error(`El inventario está inflado; encógelo para fijar la mejora:\n  ${sobras.join('\n  ')}`)
    }
  })
})
