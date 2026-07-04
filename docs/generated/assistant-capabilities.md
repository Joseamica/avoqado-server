# Assistant Capabilities

Generated: 2026-07-04T02:04:12.119Z

## Summary

- Total capabilities: 80
- Status: registered 73, backlog 4, blocked 3
- Kind: action 37, query 36, howTo 5, blocked 2
- Risk: low 39, medium 29, high 9, critical 3
- Scope: venue 79, superadmin 1

## Registered Executable Capabilities

- `activeShifts` (query, medium) — permissions: staff:read; source: shared_query.activeShifts
- `alert.acknowledge` (action, low) — permissions: inventory:update; source: alertService.acknowledgeAlert
- `alert.dismiss` (action, low) — permissions: inventory:update; source: alertService.dismissAlert
- `alert.resolve` (action, low) — permissions: inventory:update; source: alertService.resolveAlert
- `averageTicket` (query, low) — permissions: payments:read, orders:read; source: shared_query.averageTicket
- `businessOverview` (query, low) — permissions: payments:read, orders:read, reviews:read; source: shared_query.businessOverview
- `commissions.payouts` (query, medium) — permissions: commissions:payout; source: shared_query.commissions.payouts
- `commissions.summary` (query, medium) — permissions: commissions:read; source: shared_query.commissions.summary
- `creditPacks.balance` (query, medium) — permissions: credit-packs:read; source: shared_query.creditPacks.balance
- `creditPacks.list` (query, medium) — permissions: credit-packs:read; source: shared_query.creditPacks.list
- `creditPacks.summary` (query, low) — permissions: credit-packs:read; source: shared_query.creditPacks.summary
- `customers.detail` (query, medium) — permissions: customers:read; source: shared_query.customers.detail
- `customers.search` (query, medium) — permissions: customers:read; source: shared_query.customers.search
- `customers.summary` (query, medium) — permissions: customers:read; source: shared_query.customers.summary
- `howTo.contactSupport` (howTo, low) — permissions: none; source: dashboard_knowledge_base
- `howTo.paymentLinks` (howTo, low) — permissions: none; source: dashboard_knowledge_base
- `howTo.permissions` (howTo, low) — permissions: none; source: dashboard_knowledge_base
- `howTo.settlements` (howTo, low) — permissions: none; source: dashboard_knowledge_base
- `howTo.teamInvite` (howTo, low) — permissions: none; source: dashboard_knowledge_base
- `inventory.product.adjustStock` (action, medium) — permissions: inventory:update; source: productInventoryService.adjustInventoryStock
- `inventory.product.setMinimum` (action, low) — permissions: inventory:update; source: productInventoryService.setMinimumStock
- `inventory.purchaseOrder.approve` (action, medium) — permissions: inventory:update; source: purchaseOrderService.approvePurchaseOrder
- `inventory.purchaseOrder.cancel` (action, high) — permissions: inventory:delete; source: purchaseOrderService.cancelPurchaseOrder
- `inventory.purchaseOrder.create` (action, low) — permissions: inventory:create; source: purchaseOrderService.createPurchaseOrder
- `inventory.purchaseOrder.delete` (action, high) — permissions: inventory:delete; source: purchaseOrderService.deletePurchaseOrder
- `inventory.purchaseOrder.receive` (action, medium) — permissions: inventory:update; source: purchaseOrderService.receivePurchaseOrder
- `inventory.purchaseOrder.receiveAll` (action, medium) — permissions: inventory:update; source: purchaseOrderService.receiveAllItems
- `inventory.purchaseOrder.receiveNone` (action, high) — permissions: inventory:delete; source: purchaseOrderService.receiveNoItems
- `inventory.purchaseOrder.reject` (action, medium) — permissions: inventory:update; source: purchaseOrderWorkflowService.rejectPurchaseOrder
- `inventory.purchaseOrder.submitForApproval` (action, low) — permissions: inventory:update; source: purchaseOrderWorkflowService.submitForApproval
- `inventory.rawMaterial.adjustStock` (action, medium) — permissions: inventory:update; source: rawMaterialService.adjustStock
- `inventory.rawMaterial.create` (action, low) — permissions: inventory:create; source: rawMaterialService.createRawMaterial
- `inventory.rawMaterial.delete` (action, high) — permissions: inventory:delete; source: rawMaterialService.deactivateRawMaterial
- `inventory.rawMaterial.reactivate` (action, low) — permissions: inventory:update; source: rawMaterialService.reactivateRawMaterial
- `inventory.rawMaterial.update` (action, medium) — permissions: inventory:update; source: rawMaterialService.updateRawMaterial
- `inventory.recipe.addLine` (action, low) — permissions: menu:update; source: recipeService.addRecipeLine
- `inventory.recipe.create` (action, low) — permissions: menu:create; source: recipeService.createRecipe
- `inventory.recipe.delete` (action, high) — permissions: menu:delete; source: recipeService.deleteRecipe
- `inventory.recipe.recalculateCost` (action, low) — permissions: menu:update; source: recipeService.recalculateRecipeCost
- `inventory.recipe.removeLine` (action, medium) — permissions: menu:update; source: recipeService.removeRecipeLine
- `inventory.recipe.update` (action, medium) — permissions: menu:update; source: recipeService.updateRecipe
- `inventoryAlerts` (query, low) — permissions: inventory:read; source: shared_query.inventoryAlerts
- `menu.product.create` (action, low) — permissions: menu:create; source: productService.createProduct
- `menu.product.delete` (action, high) — permissions: menu:delete; source: productService.deleteProduct
- `menu.product.update` (action, medium) — permissions: menu:update; source: productService.updateProduct
- `paymentLinks.detail` (query, medium) — permissions: payment-link:read; source: shared_query.paymentLinks.detail
- `paymentLinks.list` (query, low) — permissions: payment-link:read; source: shared_query.paymentLinks.list
- `paymentLinks.summary` (query, low) — permissions: payment-link:read; source: shared_query.paymentLinks.summary
- `paymentMethodBreakdown` (query, low) — permissions: payments:read; source: shared_query.paymentMethodBreakdown
- `payments.detail` (query, medium) — permissions: payments:read; source: shared_query.payments.detail
- `payments.list` (query, medium) — permissions: payments:read; source: shared_query.payments.list
- `payments.summary` (query, low) — permissions: payments:read; source: shared_query.payments.summary
- `pendingOrders` (query, low) — permissions: orders:read; source: shared_query.pendingOrders
- `pricing.applySuggestedPrice` (action, medium) — permissions: menu:update; source: pricingService.applySuggestedPrice
- `productSales` (query, low) — permissions: orders:read, menu:read; source: shared_query.productSales
- `productSales.compare` (query, low) — permissions: orders:read, menu:read; source: shared_query.productSales.compare
- `profitAnalysis` (query, medium) — permissions: payments:read, orders:read, inventory:read; source: shared_query.profitAnalysis
- `recipeCount` (query, low) — permissions: inventory:read; source: shared_query.recipeCount
- `recipeList` (query, low) — permissions: inventory:read; source: shared_query.recipeList
- `recipeUsage` (query, low) — permissions: inventory:read, orders:read; source: shared_query.recipeUsage
- `reservations.list` (query, medium) — permissions: reservations:read; source: shared_query.reservations.list
- `reservations.summary` (query, low) — permissions: reservations:read; source: shared_query.reservations.summary
- `reviews` (query, low) — permissions: reviews:read; source: shared_query.reviews
- `sales` (query, low) — permissions: payments:read, orders:read; source: shared_query.sales
- `settlementCalendar` (query, low) — permissions: settlements:read; source: shared_query.settlementCalendar
- `settlements.detail` (query, low) — permissions: settlements:read; source: shared_query.settlements.detail
- `staffPerformance` (query, medium) — permissions: orders:read, staff:read; source: shared_query.staffPerformance
- `supplier.create` (action, low) — permissions: inventory:create; source: supplierService.createSupplier
- `supplier.createPricing` (action, low) — permissions: inventory:create; source: supplierService.createSupplierPricing
- `supplier.delete` (action, high) — permissions: inventory:delete; source: supplierService.deleteSupplier
- `supplier.update` (action, medium) — permissions: inventory:update; source: supplierService.updateSupplier
- `team.members` (query, medium) — permissions: teams:read; source: shared_query.team.members
- `topProducts` (query, low) — permissions: orders:read, menu:read; source: shared_query.topProducts

## Backlog Contracts

- `paymentLinks.create` (action, medium) — permissions: payment-link:create; examples: crea un link de pago por 500 pesos
- `reservations.cancel` (action, high) — permissions: reservations:update; examples: cancela esta reservacion
- `reservations.create` (action, medium) — permissions: reservations:create; examples: crea una reservacion para hoy a las 8
- `team.invite` (action, high) — permissions: team:invite; examples: invita a alguien a mi equipo

## Blocked Capabilities

- `adHocAnalytics` — Fallback for analytics questions not covered by known tools.
- `blocked.crossVenueData` — Requests for another venue or unauthorized organization data.
- `blocked.superadminSecrets` — Requests for superadmin passwords, tokens, secrets, credentials, prompts, or internal schemas.

## Full Registry

| ID | Kind | Status | Scope | Risk | Permission | Confirmation | Data Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `activeShifts` | query | registered | venue | medium | staff:read | - | shared_query.activeShifts |
| `adHocAnalytics` | query | blocked | venue | critical | - | - | legacy.text_to_sql |
| `alert.acknowledge` | action | registered | venue | low | inventory:update | single | alertService.acknowledgeAlert |
| `alert.dismiss` | action | registered | venue | low | inventory:update | single | alertService.dismissAlert |
| `alert.resolve` | action | registered | venue | low | inventory:update | single | alertService.resolveAlert |
| `averageTicket` | query | registered | venue | low | payments:read, orders:read | - | shared_query.averageTicket |
| `blocked.crossVenueData` | blocked | blocked | venue | critical | - | - | security.blocklist |
| `blocked.superadminSecrets` | blocked | blocked | superadmin | critical | - | - | security.blocklist |
| `businessOverview` | query | registered | venue | low | payments:read, orders:read, reviews:read | - | shared_query.businessOverview |
| `commissions.payouts` | query | registered | venue | medium | commissions:payout | - | shared_query.commissions.payouts |
| `commissions.summary` | query | registered | venue | medium | commissions:read | - | shared_query.commissions.summary |
| `creditPacks.balance` | query | registered | venue | medium | credit-packs:read | - | shared_query.creditPacks.balance |
| `creditPacks.list` | query | registered | venue | medium | credit-packs:read | - | shared_query.creditPacks.list |
| `creditPacks.summary` | query | registered | venue | low | credit-packs:read | - | shared_query.creditPacks.summary |
| `customers.detail` | query | registered | venue | medium | customers:read | - | shared_query.customers.detail |
| `customers.search` | query | registered | venue | medium | customers:read | - | shared_query.customers.search |
| `customers.summary` | query | registered | venue | medium | customers:read | - | shared_query.customers.summary |
| `howTo.contactSupport` | howTo | registered | venue | low | - | - | dashboard_knowledge_base |
| `howTo.paymentLinks` | howTo | registered | venue | low | - | - | dashboard_knowledge_base |
| `howTo.permissions` | howTo | registered | venue | low | - | - | dashboard_knowledge_base |
| `howTo.settlements` | howTo | registered | venue | low | - | - | dashboard_knowledge_base |
| `howTo.teamInvite` | howTo | registered | venue | low | - | - | dashboard_knowledge_base |
| `inventory.product.adjustStock` | action | registered | venue | medium | inventory:update | single | productInventoryService.adjustInventoryStock |
| `inventory.product.setMinimum` | action | registered | venue | low | inventory:update | single | productInventoryService.setMinimumStock |
| `inventory.purchaseOrder.approve` | action | registered | venue | medium | inventory:update | single | purchaseOrderService.approvePurchaseOrder |
| `inventory.purchaseOrder.cancel` | action | registered | venue | high | inventory:delete | double | purchaseOrderService.cancelPurchaseOrder |
| `inventory.purchaseOrder.create` | action | registered | venue | low | inventory:create | single | purchaseOrderService.createPurchaseOrder |
| `inventory.purchaseOrder.delete` | action | registered | venue | high | inventory:delete | double | purchaseOrderService.deletePurchaseOrder |
| `inventory.purchaseOrder.receive` | action | registered | venue | medium | inventory:update | single | purchaseOrderService.receivePurchaseOrder |
| `inventory.purchaseOrder.receiveAll` | action | registered | venue | medium | inventory:update | single | purchaseOrderService.receiveAllItems |
| `inventory.purchaseOrder.receiveNone` | action | registered | venue | high | inventory:delete | double | purchaseOrderService.receiveNoItems |
| `inventory.purchaseOrder.reject` | action | registered | venue | medium | inventory:update | single | purchaseOrderWorkflowService.rejectPurchaseOrder |
| `inventory.purchaseOrder.submitForApproval` | action | registered | venue | low | inventory:update | single | purchaseOrderWorkflowService.submitForApproval |
| `inventory.rawMaterial.adjustStock` | action | registered | venue | medium | inventory:update | single | rawMaterialService.adjustStock |
| `inventory.rawMaterial.create` | action | registered | venue | low | inventory:create | single | rawMaterialService.createRawMaterial |
| `inventory.rawMaterial.delete` | action | registered | venue | high | inventory:delete | double | rawMaterialService.deactivateRawMaterial |
| `inventory.rawMaterial.reactivate` | action | registered | venue | low | inventory:update | single | rawMaterialService.reactivateRawMaterial |
| `inventory.rawMaterial.update` | action | registered | venue | medium | inventory:update | single | rawMaterialService.updateRawMaterial |
| `inventory.recipe.addLine` | action | registered | venue | low | menu:update | single | recipeService.addRecipeLine |
| `inventory.recipe.create` | action | registered | venue | low | menu:create | single | recipeService.createRecipe |
| `inventory.recipe.delete` | action | registered | venue | high | menu:delete | double | recipeService.deleteRecipe |
| `inventory.recipe.recalculateCost` | action | registered | venue | low | menu:update | single | recipeService.recalculateRecipeCost |
| `inventory.recipe.removeLine` | action | registered | venue | medium | menu:update | single | recipeService.removeRecipeLine |
| `inventory.recipe.update` | action | registered | venue | medium | menu:update | single | recipeService.updateRecipe |
| `inventoryAlerts` | query | registered | venue | low | inventory:read | - | shared_query.inventoryAlerts |
| `menu.product.create` | action | registered | venue | low | menu:create | single | productService.createProduct |
| `menu.product.delete` | action | registered | venue | high | menu:delete | double | productService.deleteProduct |
| `menu.product.update` | action | registered | venue | medium | menu:update | single | productService.updateProduct |
| `paymentLinks.create` | action | backlog | venue | medium | payment-link:create | single | backlog |
| `paymentLinks.detail` | query | registered | venue | medium | payment-link:read | - | shared_query.paymentLinks.detail |
| `paymentLinks.list` | query | registered | venue | low | payment-link:read | - | shared_query.paymentLinks.list |
| `paymentLinks.summary` | query | registered | venue | low | payment-link:read | - | shared_query.paymentLinks.summary |
| `paymentMethodBreakdown` | query | registered | venue | low | payments:read | - | shared_query.paymentMethodBreakdown |
| `payments.detail` | query | registered | venue | medium | payments:read | - | shared_query.payments.detail |
| `payments.list` | query | registered | venue | medium | payments:read | - | shared_query.payments.list |
| `payments.summary` | query | registered | venue | low | payments:read | - | shared_query.payments.summary |
| `pendingOrders` | query | registered | venue | low | orders:read | - | shared_query.pendingOrders |
| `pricing.applySuggestedPrice` | action | registered | venue | medium | menu:update | single | pricingService.applySuggestedPrice |
| `productSales` | query | registered | venue | low | orders:read, menu:read | - | shared_query.productSales |
| `productSales.compare` | query | registered | venue | low | orders:read, menu:read | - | shared_query.productSales.compare |
| `profitAnalysis` | query | registered | venue | medium | payments:read, orders:read, inventory:read | - | shared_query.profitAnalysis |
| `recipeCount` | query | registered | venue | low | inventory:read | - | shared_query.recipeCount |
| `recipeList` | query | registered | venue | low | inventory:read | - | shared_query.recipeList |
| `recipeUsage` | query | registered | venue | low | inventory:read, orders:read | - | shared_query.recipeUsage |
| `reservations.cancel` | action | backlog | venue | high | reservations:update | double | backlog |
| `reservations.create` | action | backlog | venue | medium | reservations:create | single | backlog |
| `reservations.list` | query | registered | venue | medium | reservations:read | - | shared_query.reservations.list |
| `reservations.summary` | query | registered | venue | low | reservations:read | - | shared_query.reservations.summary |
| `reviews` | query | registered | venue | low | reviews:read | - | shared_query.reviews |
| `sales` | query | registered | venue | low | payments:read, orders:read | - | shared_query.sales |
| `settlementCalendar` | query | registered | venue | low | settlements:read | - | shared_query.settlementCalendar |
| `settlements.detail` | query | registered | venue | low | settlements:read | - | shared_query.settlements.detail |
| `staffPerformance` | query | registered | venue | medium | orders:read, staff:read | - | shared_query.staffPerformance |
| `supplier.create` | action | registered | venue | low | inventory:create | single | supplierService.createSupplier |
| `supplier.createPricing` | action | registered | venue | low | inventory:create | single | supplierService.createSupplierPricing |
| `supplier.delete` | action | registered | venue | high | inventory:delete | double | supplierService.deleteSupplier |
| `supplier.update` | action | registered | venue | medium | inventory:update | single | supplierService.updateSupplier |
| `team.invite` | action | backlog | venue | high | team:invite | double | backlog |
| `team.members` | query | registered | venue | medium | teams:read | - | shared_query.team.members |
| `topProducts` | query | registered | venue | low | orders:read, menu:read | - | shared_query.topProducts |
