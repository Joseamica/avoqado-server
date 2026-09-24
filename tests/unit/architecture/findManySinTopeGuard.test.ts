/**
 * Candado estático: findMany SIN `take` sobre CUALQUIER modelo del schema.
 *
 * Incidente 2026-09-01: el detalle del venue materializaba las 33k órdenes + 33k pagos
 * de Testarudo por petición y Render reemplazó la instancia de producción. El barrido
 * posterior encontró 186 findMany sin tope sobre tablas grandes en 88 archivos.
 *
 * Este test CONGELA el inventario: cada archivo tiene su conteo actual permitido.
 * - Un findMany sin tope NUEVO (archivo nuevo, o conteo que sube) FALLA aquí: o le
 *   pones `take`, o lo acotas por ventana y lo registras aquí A PROPÓSITO subiendo el
 *   número con un porqué en el PR.
 * - Un conteo que BAJA también falla, pidiendo encoger el inventario — la lista sólo
 *   puede encoger sola, nunca crecer sola (mismo patrón que jobContextGuard).
 *
 * 🔴 2026-09-24: los modelos YA NO son una lista a mano. Hasta ese día el candado sólo miraba
 * una lista de tablas «grandes», y tres veces seguidas el query-guard cazó en PRODUCCIÓN una
 * tabla que no estaba en ella: `TransactionCost` (8-sep, 3,772 filas), `OrderItemModifier`
 * (18-sep, 2,568) y `KdsOrder` (24-sep, 3,068 comandas de la pantalla de cocina de Testarudo).
 * Cada tabla nueva nacía sin vigilancia hasta que tronaba. Ahora el conjunto sale del propio
 * `prisma/schema.prisma`: un modelo nuevo queda vigilado desde el día uno, sin que nadie se
 * acuerde. Es lo que ya pedía `.claude/rules/bounded-queries-and-server-load.md`: «Every
 * `findMany` needs `take`, a truly unique lookup, or a written explanation enforced by the
 * architecture guard».
 *
 * No afirma que los findMany ya inventariados sean seguros — muchos se acotan por `where`
 * (rango de fechas, turno abierto, una sola orden) y los patológicos los denuncia en runtime el
 * query-guard (`src/utils/queryResultGuard.ts`). Afirma que nadie AGREGA uno más sin pensarlo.
 */
import * as fs from 'fs'
import * as path from 'path'

const RAIZ = path.resolve(__dirname, '../../..')

/** Todos los modelos del schema, con el nombre que usa el cliente de Prisma (`prisma.kdsOrder`). */
function modelosDelSchema(): string[] {
  const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8')
  return Array.from(schema.matchAll(/^model\s+(\w+)\s*\{/gm), m => m[1][0].toLowerCase() + m[1].slice(1))
}

const MODELOS = modelosDelSchema()

// Ventana de búsqueda del `take` tras el findMany — idéntica al barrido que produjo
// el inventario. Si se cambia, hay que regenerar el inventario completo.
const VENTANA_CHARS = 1200

/**
 * Inventario congelado. Sólo puede ENCOGER.
 *
 * 2026-09-01: 186 en 88 archivos, contando sólo una lista a mano de modelos «grandes».
 * 2026-09-24: recontado sobre TODOS los modelos del schema — 953 en 387 archivos. Los
 * comentarios de cada archivo vienen del inventario anterior: sus números hablan de la
 * lista vieja, no del conteo de hoy.
 */
const INVENTARIO: Record<string, number> = {
  'src/controllers/dashboard/auth.dashboard.controller.ts': 5,
  'src/controllers/dashboard/cost-management.controller.ts': 2,
  'src/controllers/dashboard/ecommerceMerchant.controller.ts': 1,
  'src/controllers/dashboard/financialConnection.controller.ts': 1,
  'src/controllers/dashboard/googleCalendarStatus.controller.ts': 1,
  'src/controllers/dashboard/inventory/purchaseOrderInvoice.controller.ts': 1,
  'src/controllers/dashboard/loyalty.dashboard.controller.ts': 1,
  'src/controllers/dashboard/manualSale.controller.ts': 1,
  'src/controllers/dashboard/marketingCampaign.dashboard.controller.ts': 1,
  'src/controllers/dashboard/modules.superadmin.controller.ts': 4,
  'src/controllers/dashboard/organizations.superadmin.controller.ts': 3,
  'src/controllers/dashboard/simCustody.dashboard.controller.ts': 1,
  'src/controllers/dashboard/terminalOrder.controller.ts': 1,
  'src/controllers/dashboard/tpv-command.dashboard.controller.ts': 1,
  'src/controllers/dashboard/venues.superadmin.controller.ts': 1,
  'src/controllers/google-calendar.controller.ts': 1,
  'src/controllers/mobile/category.mobile.controller.ts': 1,
  'src/controllers/mobile/coupon.mobile.controller.ts': 1,
  'src/controllers/mobile/discount.mobile.controller.ts': 1,
  'src/controllers/mobile/product.mobile.controller.ts': 2,
  'src/controllers/mobile/staff.mobile.controller.ts': 1,
  'src/controllers/mobile/supplier.mobile.controller.ts': 1,
  'src/controllers/mobile/tpvSettings.mobile.controller.ts': 1,
  'src/controllers/public/reservation.public.controller.ts': 12,
  'src/controllers/sdk/session-dashboard.sdk.controller.ts': 1,
  'src/controllers/superadmin/angelpayUserAccount.controller.ts': 2,
  'src/controllers/superadmin/appUpdate.controller.ts': 1,
  'src/controllers/superadmin/ecommerceMerchants.superadmin.controller.ts': 1,
  'src/controllers/superadmin/holidays.controller.ts': 1,
  'src/controllers/superadmin/merchantAccount.controller.ts': 7,
  'src/controllers/superadmin/onboarding.controller.ts': 5,
  'src/controllers/superadmin/pushNotifications.superadmin.controller.ts': 1,
  'src/controllers/superadmin/terminal.controller.ts': 1,
  'src/controllers/superadmin/terminalOrder.superadmin.controller.ts': 1,
  'src/controllers/tpv/menu.tpv.controller.ts': 1,
  'src/controllers/tpv/terminal.tpv.controller.ts': 2,
  'src/controllers/venuePaymentConfig.controller.ts': 1,
  'src/controllers/webhook/google-calendar.webhook.controller.ts': 1,
  'src/jobs/abandoned-orders-cleanup.job.ts': 1,
  'src/jobs/areaTicketExternalReconciliation.job.ts': 1,
  'src/jobs/attendance-late-alert.job.ts': 3,
  'src/jobs/auto-clockout.job.ts': 4,
  'src/jobs/blumon-webhook-reconciliation.job.ts': 1,
  'src/jobs/cash-drawer-reconciler.job.ts': 1,
  'src/jobs/cfdiGlobal.job.ts': 1,
  'src/jobs/delivery-webhook-reconciliation.job.ts': 1,
  'src/jobs/gcal-health-check.job.ts': 1,
  'src/jobs/gcal-horizon-refresh.job.ts': 1,
  'src/jobs/mercadopago-token-refresh.job.ts': 1,
  'src/jobs/monitorPosConnections.ts': 1,
  'src/jobs/monthly-overage-billing.job.ts': 1,
  'src/jobs/nightly-low-stock.job.ts': 5,
  'src/jobs/nightly-sales-summary.job.ts': 2,
  'src/jobs/nightly-upsell-rules.job.ts': 4,
  'src/jobs/plan-renewal-reminder.job.ts': 1,
  'src/jobs/plan-winback.job.ts': 1,
  'src/jobs/publishScheduledAnnouncements.job.ts': 1,
  'src/jobs/stalePendingAlert.job.ts': 1,
  'src/jobs/subscription-cancellation.job.ts': 2,
  'src/jobs/tpv-order-expiry.job.ts': 1,
  'src/jobs/weekly-new-customers-report.job.ts': 1,
  'src/lib/providerDeviceCompatibility.ts': 1,
  'src/mcp/errors.ts': 1,
  'src/mcp/instrument.ts': 1,
  'src/mcp/oauth/orgPick.ts': 1,
  'src/mcp/scope.ts': 3,
  'src/mcp/tools/areaTickets.ts': 2,
  'src/mcp/tools/campaigns.ts': 1,
  'src/mcp/tools/commissions.ts': 4,
  'src/mcp/tools/creditPacks.ts': 1,
  'src/mcp/tools/customers.ts': 1,
  'src/mcp/tools/deliveryChannels.ts': 1,
  'src/mcp/tools/features.ts': 2,
  // 3 → 0 (2026-09-04): candidatos, hidratación y revalidación ya tienen topes;
  // la paginación keyset además agota las páginas sin acumular mapas globales.
  'src/mcp/tools/inventory.ts': 6,
  'src/mcp/tools/loyalty.ts': 1,
  'src/mcp/tools/menu.ts': 1,
  'src/mcp/tools/organizations.ts': 1,
  'src/mcp/tools/overview.ts': 1,
  'src/mcp/tools/promotions.ts': 1,
  'src/mcp/tools/recipes.ts': 1,
  'src/mcp/tools/reservations.ts': 1,
  'src/mcp/tools/sales.ts': 2,
  'src/mcp/tools/serialized.ts': 4,
  'src/mcp/tools/staff.ts': 3,
  'src/mcp/tools/tables.ts': 2,
  'src/mcp/tools/terminals.ts': 2,
  'src/mcp/tools/trends.ts': 1,
  'src/mcp/tools/upsell.ts': 1,
  'src/mcp/tools/venues.ts': 1,
  'src/middlewares/checkTableOwnership.middleware.ts': 1,
  'src/observability/venueNames.ts': 1,
  'src/routes/dashboard/organizationConfig.routes.ts': 12,
  'src/routes/dashboard/storesAnalysis.routes.ts': 5,
  'src/routes/me.routes.ts': 1,
  'src/routes/superadmin/partnerKey.routes.ts': 1,
  'src/services/access/access.service.ts': 2,
  'src/services/access/basePlan.service.ts': 5,
  'src/services/access/feature-metadata.service.ts': 2,
  'src/services/access/scopedQuery.service.ts': 2,
  'src/services/access/seatCap.service.ts': 2,
  'src/services/announcements/announcement.service.ts': 1,
  'src/services/announcements/announcementOutbox.service.ts': 1,
  'src/services/announcements/announcementRead.service.ts': 4,
  'src/services/announcements/audience.service.ts': 1,
  'src/services/auth/session.service.ts': 1,
  'src/services/b4bit/b4bit.service.ts': 1,
  'src/services/cleanup/liveDemoCleanup.service.ts': 2,
  'src/services/command-center/commandCenter.service.ts': 6,
  'src/services/consumer/reservation.consumer.service.ts': 3,
  'src/services/dashboard/accounting.dashboard.service.ts': 2,
  'src/services/dashboard/activity-log.service.ts': 9,
  'src/services/dashboard/ai-learning.service.ts': 1,
  'src/services/dashboard/alert.service.ts': 4,
  'src/services/dashboard/appointmentStaffAssignment.service.ts': 24,
  'src/services/dashboard/areaTicket.dashboard.service.ts': 4,
  'src/services/dashboard/assistant.dashboard.service.ts': 6,
  'src/services/dashboard/attendance.dashboard.service.ts': 4,
  'src/services/dashboard/attendanceLiveAlert.ts': 2,
  'src/services/dashboard/attendancePayroll.service.ts': 1,
  'src/services/dashboard/auth.service.ts': 1,
  'src/services/dashboard/autoReorder.service.ts': 3,
  'src/services/dashboard/availableBalance.dashboard.service.ts': 2,
  'src/services/dashboard/badReviewNotification.service.ts': 1,
  // 2026-09-01: availableBalance bajó de 8 → 0. Calendar, byCardType, projection y
  // cash se agregaron en Postgres; timeline y saldo completo recorren páginas
  // internas con cursores. Al llegar a cero sale del inventario en vez de guardar
  // una excepción vacía.
  'src/services/dashboard/bankReconciliation.service.ts': 2,
  'src/services/dashboard/cash-out/cash-out.config.service.ts': 10,
  'src/services/dashboard/cash-out/cash-out.ledger.service.ts': 4,
  'src/services/dashboard/cash-out/cash-out.org.service.ts': 5,
  'src/services/dashboard/cash-out/cash-out.report.service.ts': 2,
  'src/services/dashboard/cash-out/cash-out.settlement.service.ts': 3,
  'src/services/dashboard/cash-out/cash-out.withdrawal.service.ts': 2,
  'src/services/dashboard/category-resolution.service.ts': 2,
  'src/services/dashboard/chat-conversation.service.ts': 1,
  'src/services/dashboard/classSession.dashboard.service.ts': 2,
  'src/services/dashboard/commission/commission-aggregation.service.ts': 1,
  // 2026-09-07: cashCloseout 1 → 0. El efectivo esperado del corte se suma en Postgres
  // (`aggregate` + `DRAWER_CASH_WHERE`); ya no hidrata el efectivo desde el último corte.
  'src/services/dashboard/commission/commission-attendance.ts': 1,
  'src/services/dashboard/commission/commission-calculation.service.ts': 5,
  'src/services/dashboard/commission/commission-clawback.service.ts': 3,
  'src/services/dashboard/commission/commission-config.service.ts': 1,
  'src/services/dashboard/commission/commission-milestone.service.ts': 1,
  'src/services/dashboard/commission/commission-override.service.ts': 2,
  'src/services/dashboard/commission/commission-payout.service.ts': 2,
  'src/services/dashboard/commission/commission-resolution.service.ts': 3,
  'src/services/dashboard/commission/commission-tier.service.ts': 2,
  'src/services/dashboard/commission/commission-utils.ts': 4,
  'src/services/dashboard/commission/goal-resolution.service.ts': 2,
  // 2026-09-08: +1 al ampliar la lista a transactionCost/checkoutSession (no es código nuevo,
  // es un findMany que el barrido no miraba). Registrado para que no crezca; su arreglo va aparte.
  'src/services/dashboard/cost-management.service.ts': 2,
  'src/services/dashboard/costRecalculationTrigger.service.ts': 2,
  'src/services/dashboard/creditPack.dashboard.service.ts': 4,
  'src/services/dashboard/creditPack.public.service.ts': 5,
  'src/services/dashboard/customer.dashboard.service.ts': 1,
  'src/services/dashboard/customerGroup.dashboard.service.ts': 2,
  'src/services/dashboard/discount.dashboard.service.ts': 3,
  'src/services/dashboard/discountEngine.service.ts': 3,
  'src/services/dashboard/feature.service.ts': 2,
  'src/services/dashboard/fifoBatch.service.ts': 3,
  // 2026-09-01: 19 → 3. Las 16 agregaciones se reescribieron a GROUP BY en
  // Postgres (golden snapshots al centavo + integración con base real). Los 3
  // que quedan devuelven las FILAS al dashboard (contrato de la API, con select
  // acotado): quitarlos exige paginar también el cliente — trabajo aparte.
  // 2026-09-01 (tarde): 3 → 2. basic-metrics pasó a summary en SQL; sus listas de
  // compatibilidad llevan take (BASIC_METRICS_ROWS_CAP).
  'src/services/dashboard/generalStats.dashboard.service.ts': 2,
  'src/services/dashboard/googleOAuth.service.ts': 1,
  'src/services/dashboard/impersonation.service.ts': 1,
  'src/services/dashboard/interVenueTransfer.service.ts': 4,
  'src/services/dashboard/inventoryRestock.service.ts': 1,
  'src/services/dashboard/itemCategory.dashboard.service.ts': 1,
  'src/services/dashboard/loyalty.dashboard.service.ts': 1,
  'src/services/dashboard/manualSale.resolvers.ts': 1,
  'src/services/dashboard/menu.dashboard.service.ts': 4,
  'src/services/dashboard/merchantRouting.dashboard.service.ts': 1,
  'src/services/dashboard/modifierInventoryAnalytics.service.ts': 2,
  'src/services/dashboard/notification.dashboard.service.ts': 2,
  'src/services/dashboard/notification.service.ts': 2,
  'src/services/dashboard/order.dashboard.service.ts': 2,
  'src/services/dashboard/orderSummary.dashboard.service.ts': 2,
  'src/services/dashboard/orgItemCategory.dashboard.service.ts': 1,
  // 2026-09-02: la rama MindForm dejó de materializar todo el histórico; sólo
  // conserva el findMany paginado del listado nativo.
  'src/services/dashboard/payment.dashboard.service.ts': 1,
  'src/services/dashboard/paymentLink.service.ts': 4,
  'src/services/dashboard/paymentSummary.dashboard.service.ts': 2,
  'src/services/dashboard/permissionSet.service.ts': 1,
  'src/services/dashboard/pricing.service.ts': 2,
  'src/services/dashboard/printStation.dashboard.service.ts': 7,
  'src/services/dashboard/product.dashboard.service.ts': 2,
  'src/services/dashboard/productInventoryIntegration.service.ts': 1,
  'src/services/dashboard/productLabel.service.ts': 1,
  'src/services/dashboard/productStaff.service.ts': 2,
  'src/services/dashboard/productWizard.service.ts': 1,
  'src/services/dashboard/promotion.dashboard.service.ts': 3,
  'src/services/dashboard/purchaseOrder.service.ts': 6,
  'src/services/dashboard/purchaseOrderInvoice.service.ts': 1,
  'src/services/dashboard/rawMaterial.service.ts': 4,
  'src/services/dashboard/rawMaterialPresentation.service.ts': 2,
  // 2026-09-18: +1 al añadir orderItemModifier a la lista (no es código nuevo, es un
  // findMany que el barrido no miraba). Registrado para que no crezca; su arreglo va aparte.
  'src/services/dashboard/receipt.dashboard.service.ts': 3,
  'src/services/dashboard/recipe.service.ts': 2,
  'src/services/dashboard/recipeRecalculation.service.ts': 3,
  'src/services/dashboard/refund.dashboard.service.ts': 3,
  'src/services/dashboard/refunds.dashboard.service.ts': 1,
  'src/services/dashboard/reports.dashboard.service.ts': 1,
  'src/services/dashboard/reservation.dashboard.service.ts': 3,
  'src/services/dashboard/reservationAvailability.service.ts': 8,
  'src/services/dashboard/reservationSettings.service.ts': 3,
  'src/services/dashboard/reservationWaitlist.service.ts': 1,
  'src/services/dashboard/review.dashboard.service.ts': 1,
  'src/services/dashboard/rolePermission.service.ts': 1,
  'src/services/dashboard/sale-verification.dashboard.service.ts': 3,
  'src/services/dashboard/sale-verification.org.dashboard.service.ts': 4,
  'src/services/dashboard/sales-summary.dashboard.service.ts': 2,
  'src/services/dashboard/seatReconciliation.service.ts': 1,
  'src/services/dashboard/settlementCalendar.dashboard.service.ts': 1,
  // sales-summary.dashboard.service.ts: 2 → 0 el 2026-09-24. El desglose por método de pago
  // (`byPaymentMethodDetailed`) y sus reembolsos se agregan en SQL con GROUP BY; antes traían una
  // fila por cobro (3,109 en un mes de Testarudo) y dispararon el query-guard en producción.
  // 2026-09-07: settlementCalendar 1 → 0. La semana de liquidación recorre los pagos por
  // páginas de 500 con cursor (mismo patrón que availableBalance).
  'src/services/dashboard/settlementIncident.service.ts': 5,
  // 4 → 3 el 2026-09-02: `getActiveShifts` dejó de traer una fila por ORDEN para contarlas en
  // memoria y ahora las cuenta con `groupBy` en Postgres (una fila por turno). Con un turno abierto
  // durante semanas —los hay en producción— ese `findMany` materializaba todas sus órdenes en un
  // camino que el usuario dispara desde el chatbot a voluntad.
  'src/services/dashboard/shared-query.service.ts': 5,
  'src/services/dashboard/shift.dashboard.service.ts': 1,
  'src/services/dashboard/staffDocument.service.ts': 1,
  'src/services/dashboard/staffOnboarding.service.ts': 1,
  'src/services/dashboard/staffSchedule.service.ts': 1,
  'src/services/dashboard/stockCountAudit.service.ts': 1,
  'src/services/dashboard/superadmin.service.ts': 11,
  'src/services/dashboard/supplier.service.ts': 3,
  'src/services/dashboard/team.dashboard.service.ts': 3,
  'src/services/dashboard/tenderType.dashboard.service.ts': 1,
  'src/services/dashboard/terminal-migration.service.ts': 3,
  'src/services/dashboard/terminals.superadmin.service.ts': 6,
  'src/services/dashboard/text-to-sql-assistant.service.ts': 3,
  'src/services/dashboard/token-budget.service.ts': 1,
  'src/services/dashboard/tpv.dashboard.service.ts': 3,
  'src/services/dashboard/venue-access.service.ts': 1,
  'src/services/dashboard/venue.dashboard.service.ts': 8,
  'src/services/dashboard/venueFeature.dashboard.service.ts': 4,
  'src/services/dashboard/venueRoleConfig.dashboard.service.ts': 3,
  'src/services/dashboard/workSchedule.service.ts': 1,
  'src/services/dashboard/workShift.service.ts': 5,
  'src/services/delivery-channels/core/deliveryActivation.service.ts': 1,
  'src/services/delivery-channels/core/deliveryChannelLink.service.ts': 3,
  'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts': 2,
  'src/services/delivery-channels/core/menuSnapshot.service.ts': 1,
  'src/services/delivery-channels/core/menuSync.service.ts': 2,
  'src/services/delivery-channels/core/releaseScheduledOrder.service.ts': 1,
  'src/services/delivery-channels/providers/uber-eats/uber.client.ts': 1,
  'src/services/financial-connections/financialConnection.service.ts': 1,
  'src/services/fiscal/accountLedger.service.ts': 1,
  'src/services/fiscal/accountMapping.service.ts': 3,
  'src/services/fiscal/accountingPeriodLock.service.ts': 1,
  'src/services/fiscal/accountingReports.service.ts': 1,
  'src/services/fiscal/accountsPayable.service.ts': 1,
  'src/services/fiscal/autoPosting.service.ts': 2,
  'src/services/fiscal/cfdi.service.ts': 1,
  'src/services/fiscal/cfdiGlobal.service.ts': 1,
  'src/services/fiscal/chartOfAccounts.service.ts': 2,
  'src/services/fiscal/cogs.service.ts': 1,
  'src/services/fiscal/diot.service.ts': 1,
  'src/services/fiscal/expensePosting.service.ts': 1,
  'src/services/fiscal/fiscalConfig.service.ts': 2,
  'src/services/fiscal/fixedAsset.service.ts': 1,
  'src/services/fiscal/fixedAssetDepreciation.service.ts': 2,
  'src/services/fiscal/isr.service.ts': 1,
  'src/services/fiscal/ivaFlujo.service.ts': 1,
  'src/services/fiscal/journalEntry.service.ts': 2,
  'src/services/fiscal/nomina.service.ts': 2,
  'src/services/fiscal/nominaCfdi.service.ts': 1,
  'src/services/fiscal/trialBalance.service.ts': 1,
  'src/services/google-calendar/own-event-edit.service.ts': 1,
  'src/services/inventory/inventoryPosting.service.ts': 1,
  'src/services/inventory/reverseSalePosting.service.ts': 2,
  'src/services/invitation.service.ts': 2,
  'src/services/launchCampaigns/launchCampaign.service.ts': 1,
  'src/services/legacy/mergedPayments.service.ts': 2,
  'src/services/liveDemo.service.ts': 1,
  'src/services/marketing/birthdaySweep.service.ts': 1,
  'src/services/marketing/campaignEnqueue.service.ts': 1,
  'src/services/marketing/emailSuppression.service.ts': 1,
  'src/services/master-catalog/catalogImportDependencies.service.ts': 8,
  'src/services/master-catalog/catalogImportLookup.service.ts': 12,
  'src/services/master-catalog/catalogItem.service.ts': 1,
  'src/services/master-catalog/catalogOverrideRecovery.service.ts': 1,
  'src/services/master-catalog/catalogPublicationActivation.service.ts': 1,
  'src/services/master-catalog/catalogPublicationOutbox.service.ts': 1,
  'src/services/master-catalog/catalogPublicationOverrideDecision.service.ts': 1,
  'src/services/master-catalog/catalogPublicationReversionAuthority.service.ts': 2,
  'src/services/master-catalog/catalogPublicationTargetLoader.service.ts': 3,
  'src/services/master-catalog/catalogValidationProfile.service.ts': 1,
  'src/services/master-catalog/masterCatalogControlPlane.service.ts': 2,
  'src/services/mcp/mcpAudit.service.ts': 1,
  'src/services/mobile/areaTicket.mobile.service.ts': 3,
  'src/services/mobile/areaTicketV7.mobile.service.ts': 10,
  'src/services/mobile/auth.mobile.service.ts': 4,
  'src/services/mobile/cash-drawer.mobile.service.ts': 1,
  'src/services/mobile/comp-item.mobile.service.ts': 4,
  'src/services/mobile/creditPack.mobile.service.ts': 1,
  'src/services/mobile/end-of-day.mobile.service.ts': 4,
  'src/services/mobile/inventory.mobile.service.ts': 8,
  'src/services/mobile/measurement-unit.mobile.service.ts': 1,
  'src/services/mobile/menu.mobile.service.ts': 1,
  // 1 → 0 (2026-09-23, KDS Uber T16): la venta de cada comanda se carga por lote en
  // `kdsCapacidades.ts`, con `take` = número de ids pedidos.
  'src/services/mobile/order.mobile.service.ts': 6,
  'src/services/mobile/print.mobile.service.ts': 2,
  'src/services/mobile/product-option.mobile.service.ts': 1,
  'src/services/mobile/push.mobile.service.ts': 2,
  'src/services/mobile/service-charge.mobile.service.ts': 4,
  'src/services/mobile/sync.mobile.service.ts': 1,
  'src/services/mobile/time-entry.mobile.service.ts': 1,
  'src/services/mobile/transaction.mobile.service.ts': 1,
  'src/services/modules/module.service.ts': 9,
  'src/services/notifications/emailUnsubscribe.service.ts': 1,
  'src/services/onboarding/demoCleanup.service.ts': 7,
  'src/services/onboarding/demoSeed.service.ts': 1,
  'src/services/onboarding/venueCreation.service.ts': 1,
  'src/services/organization-dashboard/orgMessages.service.ts': 1,
  'src/services/organization-dashboard/orgStockControl.service.ts': 3,
  'src/services/organization-dashboard/orgTerminals.service.ts': 5,
  // 2026-09-01: 15 → 5. Diez agregaciones (resumen global, promotores activos ×3, top
  // promotor, efectivo por checada, tendencia y mezcla por vendedor, los dos heatmaps) se
  // reescribieron a SQL (golden al centavo + integración con base real). Los 5 que quedan
  // devuelven FILAS al dashboard o corren un motor por fila (GPS de hoy, personal en línea,
  // checadas del día, calendario, reporte de cierre) y llevan select quirúrgico.
  'src/services/organization-dashboard/organizationDashboard.service.ts': 40,
  'src/services/organization-dashboard/storesAnalysisScope.service.ts': 1,
  'src/services/organization-payment-config.service.ts': 1,
  'src/services/organization/organization.service.ts': 7,
  'src/services/partner/partner.service.ts': 1,
  'src/services/payments/reservation-deposit-webhook.service.ts': 3,
  'src/services/payments/revenueShareReport.service.ts': 1,
  'src/services/printing/printConfig.service.ts': 4,
  'src/services/promoters/promoterLocation.service.ts': 3,
  'src/services/promoters/promoters.service.ts': 4,
  'src/services/promoters/terminalLocation.service.ts': 4,
  'src/services/promotions/promotion.service.ts': 1,
  'src/services/promotions/promotionCatalog.service.ts': 1,
  'src/services/referrals/referralQualification.service.ts': 1,
  'src/services/referrals/referralRefund.service.ts': 1,
  // 2026-09-09: la MISMA consulta se mudó aquí desde `referralRefund.service.ts` (1 → 0) al
  // extraer `isOrderFullyReversed`. Es un TRASLADO, no un crecimiento: el total no sube.
  // 🔴 Este cupo NO afirma que la consulta esté acotada por FILAS: sigue sin `take`, y se deja
  // así a propósito — truncar la lista de reembolsos haría que una orden ya reembolsada por
  // completo se leyera como parcial. Lo que la acota es su `where` por orden y venue.
  'src/services/referrals/referralReversalPolicy.service.ts': 1,
  'src/services/reservation/checkIn.service.ts': 1,
  'src/services/reservation/createOrderFromReservation.ts': 1,
  'src/services/reservation/customerApprovalOutbox.service.ts': 2,
  'src/services/reservation/kioskCheckIn.service.ts': 1,
  'src/services/reservation/kioskOutreach.service.ts': 3,
  'src/services/reservation/reservation-services.resolver.ts': 1,
  'src/services/reservation/resolveAppointmentWindow.ts': 3,
  'src/services/reservation/resolveModifierSelections.ts': 1,
  'src/services/reviewSync.service.ts': 1,
  'src/services/serialized-inventory/custody.service.ts': 2,
  'src/services/serialized-inventory/serializedInventory.service.ts': 8,
  'src/services/serialized-inventory/simRegistration.service.ts': 5,
  'src/services/shared/loyaltyOnPaidOrder.ts': 1,
  'src/services/shared/serviceCharges.ts': 1,
  'src/services/shared/turnoDeCaja.ts': 1,
  'src/services/staffOrganization.service.ts': 1,
  'src/services/stock-dashboard/stockDashboard.service.ts': 9,
  'src/services/stripe.service.ts': 3,
  'src/services/stripe.webhook.service.ts': 3,
  'src/services/superadmin/aggregator.service.ts': 1,
  'src/services/superadmin/angelpayUserAccount.service.ts': 1,
  'src/services/superadmin/balanceProvider.service.ts': 1,
  'src/services/superadmin/bulkVenueCreation.service.ts': 3,
  'src/services/superadmin/creditAssessment.service.ts': 3,
  'src/services/superadmin/kycReview.service.ts': 2,
  'src/services/superadmin/marketing.superadmin.service.ts': 3,
  'src/services/superadmin/merchantAccount.service.ts': 13,
  'src/services/superadmin/merchantRevenueShare.service.ts': 1,
  'src/services/superadmin/paymentAnalytics.service.ts': 1,
  'src/services/superadmin/paymentProvider.service.ts': 3,
  'src/services/superadmin/platform-billing/platformCfdi.service.ts': 1,
  'src/services/superadmin/providerCostStructure.service.ts': 1,
  // 2026-09-08: +1 al ampliar la lista a transactionCost/checkoutSession (no es código nuevo,
  // es un findMany que el barrido no miraba). Registrado para que no crezca; su arreglo va aparte.
  'src/services/superadmin/rateCorrection/rateCorrectionApply.ts': 3,
  'src/services/superadmin/rateCorrection/rateCorrectionList.ts': 1,
  // 2026-09-08: +1 al ampliar la lista a transactionCost/checkoutSession (no es código nuevo,
  // es un findMany que el barrido no miraba). Registrado para que no crezca; su arreglo va aparte.
  'src/services/superadmin/rateCorrection/rateCorrectionPreview.ts': 2,
  'src/services/superadmin/settlementConfiguration.service.ts': 1,
  'src/services/superadmin/staff.superadmin.service.ts': 1,
  'src/services/superadmin/stripeConnectOffboarding.service.ts': 1,
  'src/services/superadmin/subscription.service.ts': 1,
  'src/services/superadmin/training.service.ts': 4,
  'src/services/superadmin/venueCommission.service.ts': 1,
  'src/services/superadmin/venuePricing.service.ts': 2,
  'src/services/terminal-payment.service.ts': 4,
  // 2026-09-18: settlementCalendar.superadmin 1 → 0. El calendario de todos los negocios
  // recorre por páginas con cursor; al llegar a cero sale del inventario.
  'src/services/tpv/blumon-webhook.service.ts': 2,
  'src/services/tpv/command-execution.service.ts': 3,
  'src/services/tpv/command-queue.service.ts': 2,
  'src/services/tpv/fastPaymentCustomer.ts': 1,
  'src/services/tpv/floor-element.tpv.service.ts': 1,
  'src/services/tpv/merchantRouting.service.ts': 3,
  'src/services/tpv/order.tpv.service.ts': 12,
  'src/services/tpv/payment.tpv.service.ts': 4,
  'src/services/tpv/refund.tpv.service.ts': 1,
  'src/services/tpv/sale-verification.service.ts': 1,
  // 2026-09-04, ronda de arreglo 1 (P1.3/P2.5): de 7 a 4. Se fueron el `include` anidado sin tope
  // de `getShifts` (`orders → payments → allocations`) y los dos `findMany` de `getCurrentShift`,
  // que ahora agregan en la base. Los 4 que quedan son P3.2/P3.3 y siguen abiertos.
  'src/services/tpv/shift.tpv.service.ts': 4,
  'src/services/tpv/table.tpv.service.ts': 3,
  'src/services/tpv/time-entry.tpv.service.ts': 4,
  'src/services/tpv/tpv-health.service.ts': 1,
  'src/services/tpv/tpv-message.service.ts': 4,
  'src/services/tpv/uncharged-reconciliation.service.ts': 2,
  'src/services/upsell/upsell.service.ts': 5,
  'src/services/upsell/upsellImpression.service.ts': 1,
  'src/services/wallet/notifyPassUpdated.service.ts': 2,
  'src/services/wallet/passkitWebService.service.ts': 1,
  'src/services/wallet/redeemStampReward.service.ts': 1,
  'src/services/wallet/scanWalletPass.service.ts': 1,
  'src/utils/datetime.ts': 2,
  'src/utils/passwordChangeGuard.ts': 1,
  'src/utils/staff-venue.util.ts': 1,
}

const patron = new RegExp(`\\.(${MODELOS.join('|')})\\.findMany\\s*\\(`, 'g')

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

describe('findMany sin tope sobre cualquier modelo — el inventario sólo encoge', () => {
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
        `findMany sin \`take\` NUEVO:\n  ${violaciones.join('\n  ')}\n\n` +
          `Un findMany sin tope es la clase de bug que tumbó producción el 2026-09-01 (33k órdenes por petición) y la que ` +
          `el query-guard siguió cazando después en tablas que nadie creía grandes. ` +
          `Ponle \`take\`, o acótalo por ventana de fechas y — sólo si es a ` +
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

  // 🔴 El candado vale lo que vale el conjunto de modelos que mira. Si alguien lo vuelve a reducir a
  // una lista a mano, las tablas nuevas vuelven a nacer sin vigilancia — que es exactamente cómo se
  // escaparon TransactionCost, OrderItemModifier y KdsOrder.
  it('mira TODOS los modelos del schema, no una lista a mano', () => {
    const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8')
    const enSchema = (schema.match(/^model\s+\w+\s*\{/gm) ?? []).length
    expect(enSchema).toBeGreaterThan(300)
    expect(MODELOS).toHaveLength(enSchema)
    for (const m of ['order', 'payment', 'transactionCost', 'orderItemModifier', 'kdsOrder', 'venue', 'product']) {
      expect(MODELOS).toContain(m)
    }
  })

  it('atrapa un findMany sin tope sobre CUALQUIER modelo, y deja pasar el que lleva take', () => {
    expect(contarSinTope('await prisma.kdsOrder.findMany({ where: { venueId } })')).toBe(1)
    expect(contarSinTope('await tx.menuCategory.findMany({ where: { venueId } })')).toBe(1)
    expect(contarSinTope('await prisma.kdsOrder.findMany({ where: { venueId }, take: 100 })')).toBe(0)
    // Algo que no es un modelo del schema no cuenta.
    expect(contarSinTope('await repo.cosasQueNoExisten.findMany({})')).toBe(0)
  })
})
