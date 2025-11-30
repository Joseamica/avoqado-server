import { Router } from 'express'
import { validateRequest } from '../../middlewares/validation'
import { checkPermission } from '../../middlewares/checkPermission.middleware'

// Import controllers
import * as rawMaterialController from '../../controllers/dashboard/inventory/rawMaterial.controller'
import * as recipeController from '../../controllers/dashboard/inventory/recipe.controller'
import * as pricingController from '../../controllers/dashboard/inventory/pricing.controller'
import * as supplierController from '../../controllers/dashboard/inventory/supplier.controller'
import * as purchaseOrderController from '../../controllers/dashboard/inventory/purchaseOrder.controller'
import * as alertController from '../../controllers/dashboard/inventory/alert.controller'
import * as reportController from '../../controllers/dashboard/inventory/report.controller'
import * as productWizardController from '../../controllers/dashboard/inventory/productWizard.controller'
import * as productInventoryController from '../../controllers/dashboard/productInventory.controller'

// Import schemas
import {
  CreateRawMaterialSchema,
  UpdateRawMaterialSchema,
  AdjustStockSchema,
  GetRawMaterialsQuerySchema,
  RawMaterialIdParamsSchema,
  CreateRecipeSchema,
  UpdateRecipeSchema,
  AddRecipeLineSchema,
  ProductIdParamsSchema,
  CreatePricingPolicySchema,
  UpdatePricingPolicySchema,
  CalculatePriceSchema,
  CreateSupplierSchema,
  UpdateSupplierSchema,
  SupplierIdParamsSchema,
  CreateSupplierPricingSchema,
  GetSupplierRecommendationsSchema,
  CreatePurchaseOrderSchema,
  UpdatePurchaseOrderSchema,
  ReceivePurchaseOrderSchema,
  GetPurchaseOrdersQuerySchema,
  PurchaseOrderIdParamsSchema,
  GetAlertsQuerySchema,
  AcknowledgeAlertSchema,
  ResolveAlertSchema,
  GetPMIXReportSchema,
  GetProfitabilityReportSchema,
  GetIngredientUsageReportSchema,
  // NEW: Product Wizard schemas
  ProductWizardStep1Schema,
  ProductWizardStep2Schema,
  ProductWizardStep3SimpleStockSchema,
  ProductWizardStep3RecipeSchema,
  // NEW: Product Inventory (QUANTITY tracking) schemas
  AdjustProductInventoryStockSchema,
  CreateProductWithInventorySchema,
  GetWizardProgressSchema,
  SetProductInventoryMethodSchema,
  PreviewCostChangeSchema,
  TriggerCostRecalculationSchema,
  GetRecipeCostVariancesSchema,
  VenueIdParamsSchema,
  // NEW: Modifier Inventory schemas
  ConfigureVariableIngredientSchema,
  RecipeLineIdParamsSchema,
} from '../../schemas/dashboard/inventory.schema'

const router = Router({ mergeParams: true })

// ===========================================
// RAW MATERIALS ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials:
 *   get:
 *     tags: [Inventory - Raw Materials]
 *     summary: Get all raw materials for a venue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: venueId, in: path, required: true, schema: { type: string } }
 *       - { name: category, in: query, schema: { type: string } }
 *       - { name: lowStock, in: query, schema: { type: string, enum: [true, false] } }
 *       - { name: active, in: query, schema: { type: string, enum: [true, false] } }
 *       - { name: search, in: query, schema: { type: string } }
 *     responses:
 *       200:
 *         description: List of raw materials
 */
router.get(
  '/raw-materials',
  checkPermission('inventory:read'),
  validateRequest(GetRawMaterialsQuerySchema),
  rawMaterialController.getRawMaterials,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}:
 *   get:
 *     tags: [Inventory - Raw Materials]
 *     summary: Get a raw material by ID
 */
router.get(
  '/raw-materials/:rawMaterialId',
  checkPermission('inventory:read'),
  validateRequest(RawMaterialIdParamsSchema),
  rawMaterialController.getRawMaterial,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials:
 *   post:
 *     tags: [Inventory - Raw Materials]
 *     summary: Create a new raw material
 */
router.post(
  '/raw-materials',
  checkPermission('inventory:create'),
  validateRequest(CreateRawMaterialSchema),
  rawMaterialController.createRawMaterial,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}:
 *   put:
 *     tags: [Inventory - Raw Materials]
 *     summary: Update a raw material
 */
router.put(
  '/raw-materials/:rawMaterialId',
  checkPermission('inventory:update'),
  validateRequest(UpdateRawMaterialSchema),
  rawMaterialController.updateRawMaterial,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}:
 *   delete:
 *     tags: [Inventory - Raw Materials]
 *     summary: Delete a raw material
 */
router.delete(
  '/raw-materials/:rawMaterialId',
  checkPermission('inventory:delete'),
  validateRequest(RawMaterialIdParamsSchema),
  rawMaterialController.deleteRawMaterial,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/deactivate:
 *   put:
 *     tags: [Inventory - Raw Materials]
 *     summary: Deactivate a raw material (soft disable)
 *     description: Deactivates a raw material while preserving usage history in recipes
 */
router.put(
  '/raw-materials/:rawMaterialId/deactivate',
  checkPermission('inventory:update'),
  validateRequest(RawMaterialIdParamsSchema),
  rawMaterialController.deactivateRawMaterial,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/reactivate:
 *   put:
 *     tags: [Inventory - Raw Materials]
 *     summary: Reactivate a raw material
 *     description: Reactivates a previously deactivated raw material
 */
router.put(
  '/raw-materials/:rawMaterialId/reactivate',
  checkPermission('inventory:update'),
  validateRequest(RawMaterialIdParamsSchema),
  rawMaterialController.reactivateRawMaterial,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/adjust-stock:
 *   post:
 *     tags: [Inventory - Raw Materials]
 *     summary: Adjust stock for a raw material
 */
router.post(
  '/raw-materials/:rawMaterialId/adjust-stock',
  checkPermission('inventory:read'),
  validateRequest(AdjustStockSchema),
  rawMaterialController.adjustStock,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/movements:
 *   get:
 *     tags: [Inventory - Raw Materials]
 *     summary: Get stock movements for a raw material
 */
router.get(
  '/raw-materials/:rawMaterialId/movements',
  checkPermission('inventory:read'),
  validateRequest(RawMaterialIdParamsSchema),
  rawMaterialController.getStockMovements,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/recipes:
 *   get:
 *     tags: [Inventory - Raw Materials]
 *     summary: Get recipes that use this raw material
 */
router.get(
  '/raw-materials/:rawMaterialId/recipes',
  checkPermission('inventory:read'),
  validateRequest(RawMaterialIdParamsSchema),
  rawMaterialController.getRawMaterialRecipes,
)

// ===========================================
// RECIPES ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe:
 *   get:
 *     tags: [Inventory - Recipes]
 *     summary: Get recipe for a product
 */
router.get(
  '/products/:productId/recipe',
  checkPermission('inventory:read'),
  validateRequest(ProductIdParamsSchema),
  recipeController.getRecipe,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe:
 *   post:
 *     tags: [Inventory - Recipes]
 *     summary: Create a recipe for a product
 */
router.post(
  '/products/:productId/recipe',
  checkPermission('inventory:read'),
  validateRequest(CreateRecipeSchema),
  recipeController.createRecipe,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe:
 *   put:
 *     tags: [Inventory - Recipes]
 *     summary: Update a recipe
 */
router.put(
  '/products/:productId/recipe',
  checkPermission('inventory:read'),
  validateRequest(UpdateRecipeSchema),
  recipeController.updateRecipe,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe:
 *   delete:
 *     tags: [Inventory - Recipes]
 *     summary: Delete a recipe
 */
router.delete(
  '/products/:productId/recipe',
  checkPermission('inventory:delete'),
  validateRequest(ProductIdParamsSchema),
  recipeController.deleteRecipe,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe/lines:
 *   post:
 *     tags: [Inventory - Recipes]
 *     summary: Add ingredient to recipe
 */
router.post(
  '/products/:productId/recipe/lines',
  checkPermission('inventory:read'),
  validateRequest(AddRecipeLineSchema),
  recipeController.addRecipeLine,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe/lines/{recipeLineId}:
 *   delete:
 *     tags: [Inventory - Recipes]
 *     summary: Remove ingredient from recipe
 */
router.delete('/products/:productId/recipe/lines/:recipeLineId', checkPermission('inventory:delete'), recipeController.removeRecipeLine)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe/inventory-config:
 *   get:
 *     tags: [Inventory - Recipes]
 *     summary: Get recipe with full modifier inventory configuration
 *     description: Returns recipe lines with their linked modifier groups and raw materials
 */
router.get(
  '/products/:productId/recipe/inventory-config',
  checkPermission('inventory:read'),
  validateRequest(ProductIdParamsSchema),
  recipeController.getRecipeWithInventoryConfig,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/recipe/lines/{recipeLineId}/variable:
 *   put:
 *     tags: [Inventory - Recipes]
 *     summary: Configure recipe line as variable ingredient
 *     description: Mark an ingredient as variable (can be substituted by modifier selections)
 */
router.put(
  '/products/:productId/recipe/lines/:recipeLineId/variable',
  checkPermission('inventory:update'),
  validateRequest(ConfigureVariableIngredientSchema),
  recipeController.configureVariableIngredient,
)

// ===========================================
// PRICING ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/pricing-policy:
 *   get:
 *     tags: [Inventory - Pricing]
 *     summary: Get pricing policy for a product
 */
router.get(
  '/products/:productId/pricing-policy',
  checkPermission('inventory:read'),
  validateRequest(ProductIdParamsSchema),
  pricingController.getPricingPolicy,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/pricing-policy:
 *   post:
 *     tags: [Inventory - Pricing]
 *     summary: Create pricing policy for a product
 */
router.post(
  '/products/:productId/pricing-policy',
  checkPermission('inventory:read'),
  validateRequest(CreatePricingPolicySchema),
  pricingController.createPricingPolicy,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/pricing-policy:
 *   put:
 *     tags: [Inventory - Pricing]
 *     summary: Update pricing policy
 */
router.put(
  '/products/:productId/pricing-policy',
  checkPermission('inventory:read'),
  validateRequest(UpdatePricingPolicySchema),
  pricingController.updatePricingPolicy,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/calculate-price:
 *   get:
 *     tags: [Inventory - Pricing]
 *     summary: Calculate suggested price for a product
 */
router.get(
  '/products/:productId/calculate-price',
  checkPermission('inventory:read'),
  validateRequest(CalculatePriceSchema),
  pricingController.calculatePrice,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/apply-suggested-price:
 *   post:
 *     tags: [Inventory - Pricing]
 *     summary: Apply suggested price to product
 */
router.post('/products/:productId/apply-suggested-price', checkPermission('inventory:read'), pricingController.applySuggestedPrice)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/pricing-analysis:
 *   get:
 *     tags: [Inventory - Pricing]
 *     summary: Get pricing analysis for all products
 */
router.get('/pricing-analysis', checkPermission('inventory:read'), pricingController.getPricingAnalysis)

// ===========================================
// SUPPLIERS ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/suppliers:
 *   get:
 *     tags: [Inventory - Suppliers]
 *     summary: Get all suppliers
 */
router.get('/suppliers', checkPermission('inventory:read'), supplierController.getSuppliers)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/suppliers/{supplierId}:
 *   get:
 *     tags: [Inventory - Suppliers]
 *     summary: Get a supplier by ID
 */
router.get(
  '/suppliers/:supplierId',
  checkPermission('inventory:read'),
  validateRequest(SupplierIdParamsSchema),
  supplierController.getSupplier,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/suppliers:
 *   post:
 *     tags: [Inventory - Suppliers]
 *     summary: Create a new supplier
 */
router.post('/suppliers', checkPermission('inventory:read'), validateRequest(CreateSupplierSchema), supplierController.createSupplier)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/suppliers/{supplierId}:
 *   put:
 *     tags: [Inventory - Suppliers]
 *     summary: Update a supplier
 */
router.put(
  '/suppliers/:supplierId',
  checkPermission('inventory:read'),
  validateRequest(UpdateSupplierSchema),
  supplierController.updateSupplier,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/suppliers/{supplierId}:
 *   delete:
 *     tags: [Inventory - Suppliers]
 *     summary: Delete a supplier
 */
router.delete(
  '/suppliers/:supplierId',
  checkPermission('inventory:delete'),
  validateRequest(SupplierIdParamsSchema),
  supplierController.deleteSupplier,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/suppliers/{supplierId}/pricing:
 *   post:
 *     tags: [Inventory - Suppliers]
 *     summary: Create supplier pricing for a raw material
 */
router.post(
  '/suppliers/:supplierId/pricing',
  checkPermission('inventory:read'),
  validateRequest(CreateSupplierPricingSchema),
  supplierController.createSupplierPricing,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/supplier-pricing:
 *   get:
 *     tags: [Inventory - Suppliers]
 *     summary: Get supplier pricing history for a raw material
 */
router.get(
  '/raw-materials/:rawMaterialId/supplier-pricing',
  checkPermission('inventory:read'),
  supplierController.getSupplierPricingHistory,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/supplier-recommendations:
 *   get:
 *     tags: [Inventory - Suppliers]
 *     summary: Get supplier recommendations for a raw material
 */
router.get(
  '/raw-materials/:rawMaterialId/supplier-recommendations',
  checkPermission('inventory:read'),
  validateRequest(GetSupplierRecommendationsSchema),
  supplierController.getSupplierRecommendations,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/suppliers/{supplierId}/performance:
 *   get:
 *     tags: [Inventory - Suppliers]
 *     summary: Get supplier performance metrics
 */
router.get('/suppliers/:supplierId/performance', checkPermission('inventory:read'), supplierController.getSupplierPerformance)

// ===========================================
// PURCHASE ORDERS ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders:
 *   get:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Get all purchase orders
 */
router.get(
  '/purchase-orders',
  checkPermission('inventory:read'),
  validateRequest(GetPurchaseOrdersQuerySchema),
  purchaseOrderController.getPurchaseOrders,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders/{purchaseOrderId}:
 *   get:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Get a purchase order by ID
 */
router.get(
  '/purchase-orders/:purchaseOrderId',
  checkPermission('inventory:read'),
  validateRequest(PurchaseOrderIdParamsSchema),
  purchaseOrderController.getPurchaseOrder,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders:
 *   post:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Create a new purchase order
 */
router.post(
  '/purchase-orders',
  checkPermission('inventory:read'),
  validateRequest(CreatePurchaseOrderSchema),
  purchaseOrderController.createPurchaseOrder,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders/{purchaseOrderId}:
 *   put:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Update a purchase order
 */
router.put(
  '/purchase-orders/:purchaseOrderId',
  checkPermission('inventory:read'),
  validateRequest(UpdatePurchaseOrderSchema),
  purchaseOrderController.updatePurchaseOrder,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders/{purchaseOrderId}/approve:
 *   post:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Approve a purchase order
 */
router.post('/purchase-orders/:purchaseOrderId/approve', checkPermission('inventory:read'), purchaseOrderController.approvePurchaseOrder)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders/{purchaseOrderId}/receive:
 *   post:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Receive a purchase order
 */
router.post(
  '/purchase-orders/:purchaseOrderId/receive',
  checkPermission('inventory:read'),
  validateRequest(ReceivePurchaseOrderSchema),
  purchaseOrderController.receivePurchaseOrder,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders/{purchaseOrderId}/cancel:
 *   post:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Cancel a purchase order
 */
router.post('/purchase-orders/:purchaseOrderId/cancel', checkPermission('inventory:read'), purchaseOrderController.cancelPurchaseOrder)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/purchase-orders/stats:
 *   get:
 *     tags: [Inventory - Purchase Orders]
 *     summary: Get purchase order statistics
 */
router.get('/purchase-orders/stats', checkPermission('inventory:read'), purchaseOrderController.getPurchaseOrderStats)

// ===========================================
// ALERTS ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts:
 *   get:
 *     tags: [Inventory - Alerts]
 *     summary: Get all alerts
 */
router.get('/alerts', checkPermission('inventory:read'), validateRequest(GetAlertsQuerySchema), alertController.getAlerts)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts/count:
 *   get:
 *     tags: [Inventory - Alerts]
 *     summary: Get active alerts count
 */
router.get('/alerts/count', checkPermission('inventory:read'), alertController.getActiveAlertsCount)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts/by-category:
 *   get:
 *     tags: [Inventory - Alerts]
 *     summary: Get alerts by category
 */
router.get('/alerts/by-category', checkPermission('inventory:read'), alertController.getAlertsByCategory)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts/{alertId}/acknowledge:
 *   post:
 *     tags: [Inventory - Alerts]
 *     summary: Acknowledge an alert
 */
router.post(
  '/alerts/:alertId/acknowledge',
  checkPermission('inventory:read'),
  validateRequest(AcknowledgeAlertSchema),
  alertController.acknowledgeAlert,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts/{alertId}/resolve:
 *   post:
 *     tags: [Inventory - Alerts]
 *     summary: Resolve an alert
 */
router.post(
  '/alerts/:alertId/resolve',
  checkPermission('inventory:read'),
  validateRequest(ResolveAlertSchema),
  alertController.resolveAlert,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts/{alertId}/dismiss:
 *   post:
 *     tags: [Inventory - Alerts]
 *     summary: Dismiss an alert
 */
router.post('/alerts/:alertId/dismiss', checkPermission('inventory:read'), alertController.dismissAlert)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/raw-materials/{rawMaterialId}/alerts:
 *   get:
 *     tags: [Inventory - Alerts]
 *     summary: Get alert history for a raw material
 */
router.get('/raw-materials/:rawMaterialId/alerts', checkPermission('inventory:read'), alertController.getAlertHistory)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts/stats:
 *   get:
 *     tags: [Inventory - Alerts]
 *     summary: Get alert statistics
 */
router.get('/alerts/stats', checkPermission('inventory:read'), alertController.getAlertStats)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/alerts:
 *   post:
 *     tags: [Inventory - Alerts]
 *     summary: Create manual alert
 */
router.post('/alerts', checkPermission('inventory:read'), alertController.createManualAlert)

// ===========================================
// REPORTS ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/reports/pmix:
 *   get:
 *     tags: [Inventory - Reports]
 *     summary: Get Product Mix (PMIX) report
 */
router.get('/reports/pmix', checkPermission('inventory:read'), validateRequest(GetPMIXReportSchema), reportController.getPMIXReport)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/reports/profitability:
 *   get:
 *     tags: [Inventory - Reports]
 *     summary: Get profitability report
 */
router.get(
  '/reports/profitability',
  checkPermission('inventory:read'),
  validateRequest(GetProfitabilityReportSchema),
  reportController.getProfitabilityReport,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/reports/ingredient-usage:
 *   get:
 *     tags: [Inventory - Reports]
 *     summary: Get ingredient usage report
 */
router.get(
  '/reports/ingredient-usage',
  checkPermission('inventory:read'),
  validateRequest(GetIngredientUsageReportSchema),
  reportController.getIngredientUsageReport,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/reports/cost-variance:
 *   get:
 *     tags: [Inventory - Reports]
 *     summary: Get cost variance report
 */
router.get('/reports/cost-variance', checkPermission('inventory:read'), reportController.getCostVarianceReport)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/reports/valuation:
 *   get:
 *     tags: [Inventory - Reports]
 *     summary: Get inventory valuation report
 */
router.get('/reports/valuation', checkPermission('inventory:read'), reportController.getInventoryValuation)

// ===========================================
// PRODUCT WIZARD ROUTES (NEW)
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/should-use-inventory:
 *   get:
 *     tags: [Inventory - Product Wizard]
 *     summary: Check if venue should use inventory (recommendations)
 */
router.get(
  '/should-use-inventory',
  checkPermission('inventory:read'),
  validateRequest(VenueIdParamsSchema),
  productWizardController.shouldUseInventory,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/wizard/step1:
 *   post:
 *     tags: [Inventory - Product Wizard]
 *     summary: Wizard Step 1 - Create basic product
 */
router.post(
  '/wizard/step1',
  checkPermission('inventory:read'),
  validateRequest(ProductWizardStep1Schema),
  productWizardController.createProductStep1,
)

/**
 * @openapi
 * /api/v1/dashboard/products/{productId}/wizard/step2:
 *   post:
 *     tags: [Inventory - Product Wizard]
 *     summary: Wizard Step 2 - Configure inventory type
 */
router.post(
  '/products/:productId/wizard/step2',
  checkPermission('inventory:read'),
  validateRequest(ProductWizardStep2Schema),
  productWizardController.configureInventoryStep2,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}/wizard/step3-simple:
 *   post:
 *     tags: [Inventory - Product Wizard]
 *     summary: Wizard Step 3A - Setup simple stock (retail/jewelry)
 */
router.post(
  '/products/:productId/wizard/step3-simple',
  checkPermission('inventory:read'),
  validateRequest(ProductWizardStep3SimpleStockSchema),
  productWizardController.setupSimpleStockStep3,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}/wizard/step3-recipe:
 *   post:
 *     tags: [Inventory - Product Wizard]
 *     summary: Wizard Step 3B - Setup recipe (restaurants)
 */
router.post(
  '/products/:productId/wizard/step3-recipe',
  checkPermission('inventory:read'),
  validateRequest(ProductWizardStep3RecipeSchema),
  productWizardController.setupRecipeStep3,
)

/**
 * @openapi
 * /api/v1/dashboard/products/{productId}/wizard/progress:
 *   get:
 *     tags: [Inventory - Product Wizard]
 *     summary: Get wizard progress for a product
 */
router.get(
  '/products/:productId/wizard/progress',
  checkPermission('inventory:read'),
  validateRequest(GetWizardProgressSchema),
  productWizardController.getWizardProgress,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/wizard/complete:
 *   post:
 *     tags: [Inventory - Product Wizard]
 *     summary: "All-in-one: Create product with inventory"
 */
router.post(
  '/wizard/complete',
  checkPermission('inventory:read'),
  validateRequest(CreateProductWithInventorySchema),
  productWizardController.createProductWithInventory,
)

// ===========================================
// PRODUCT INVENTORY STATUS ROUTES (NEW)
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}/inventory-status:
 *   get:
 *     tags: [Inventory - Product Status]
 *     summary: Get inventory status for a product
 */
router.get('/products/:productId/inventory-status', checkPermission('inventory:read'), productWizardController.getProductInventoryStatus)

/**
 * @openapi
 * /api/v1/dashboard/products/{productId}/inventory-method:
 *   get:
 *     tags: [Inventory - Product Status]
 *     summary: Get inventory method for a product
 */
router.get('/products/:productId/inventory-method', checkPermission('inventory:read'), productWizardController.getProductInventoryMethod)

/**
 * @openapi
 * /api/v1/dashboard/products/{productId}/inventory-method:
 *   put:
 *     tags: [Inventory - Product Status]
 *     summary: Set inventory method for a product
 */
router.put(
  '/products/:productId/inventory-method',
  checkPermission('inventory:read'),
  validateRequest(SetProductInventoryMethodSchema),
  productWizardController.setProductInventoryMethod,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/products/{productId}/switch-inventory-method:
 *   post:
 *     tags: [Inventory - Product Status]
 *     summary: Switch inventory method (auto-conversion between QUANTITY ↔ RECIPE)
 *     description: Automatically removes old configuration and switches to new inventory method
 */
router.post(
  '/products/:productId/switch-inventory-method',
  checkPermission('inventory:read'),
  validateRequest(SetProductInventoryMethodSchema), // Requires inventoryMethod in body (QUANTITY or RECIPE)
  productWizardController.switchInventoryMethod,
)

// ===========================================
// PRODUCT INVENTORY (QUANTITY TRACKING) ROUTES
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/adjust-stock:
 *   post:
 *     tags: [Inventory - Product Stock]
 *     summary: Adjust stock for a product with QUANTITY tracking
 *     description: Increase or decrease stock for products using simple count-based inventory (not recipe-based)
 */
router.post(
  '/products/:productId/adjust-stock',
  checkPermission('inventory:update'),
  validateRequest(AdjustProductInventoryStockSchema),
  productInventoryController.adjustInventoryStockHandler,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/products/{productId}/movements:
 *   get:
 *     tags: [Inventory - Product Stock]
 *     summary: Get stock movements for a product with QUANTITY tracking
 *     description: View audit trail of stock changes for products using simple count-based inventory
 */
router.get(
  '/products/:productId/movements',
  checkPermission('inventory:read'),
  validateRequest(ProductIdParamsSchema),
  productInventoryController.getInventoryMovementsHandler,
)

// ===========================================
// COST RECALCULATION ROUTES (NEW)
// ===========================================

/**
 * @openapi
 * /api/v1/dashboard/raw-materials/{rawMaterialId}/preview-cost-change:
 *   get:
 *     tags: [Inventory - Cost Management]
 *     summary: Preview cost change impact (what-if analysis)
 */
router.get(
  '/raw-materials/:rawMaterialId/preview-cost-change',
  checkPermission('inventory:read'),
  validateRequest(PreviewCostChangeSchema),
  productWizardController.previewCostChange,
)

/**
 * @openapi
 * /api/v1/dashboard/raw-materials/{rawMaterialId}/trigger-cost-recalculation:
 *   post:
 *     tags: [Inventory - Cost Management]
 *     summary: Trigger cost recalculation for affected recipes
 */
router.post(
  '/raw-materials/:rawMaterialId/trigger-cost-recalculation',
  checkPermission('inventory:read'),
  validateRequest(TriggerCostRecalculationSchema),
  productWizardController.triggerCostRecalculation,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/stale-recipes:
 *   get:
 *     tags: [Inventory - Cost Management]
 *     summary: Get recipes with stale costs
 */
router.get(
  '/stale-recipes',
  checkPermission('inventory:read'),
  validateRequest(VenueIdParamsSchema),
  productWizardController.getStaleRecipes,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/recalculate-stale-recipes:
 *   post:
 *     tags: [Inventory - Cost Management]
 *     summary: Recalculate all stale recipes
 */
router.post(
  '/recalculate-stale-recipes',
  checkPermission('inventory:read'),
  validateRequest(VenueIdParamsSchema),
  productWizardController.recalculateStaleRecipes,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/recalculate-all-recipes:
 *   post:
 *     tags: [Inventory - Cost Management]
 *     summary: Force recalculation of all recipes
 */
router.post(
  '/recalculate-all-recipes',
  checkPermission('inventory:read'),
  validateRequest(VenueIdParamsSchema),
  productWizardController.recalculateAllRecipes,
)

/**
 * @openapi
 * /api/v1/dashboard/venues/{venueId}/inventory/recipe-cost-variances:
 *   get:
 *     tags: [Inventory - Cost Management]
 *     summary: Get recipes with cost variances (poor margins)
 */
router.get(
  '/recipe-cost-variances',
  checkPermission('inventory:read'),
  validateRequest(GetRecipeCostVariancesSchema),
  productWizardController.getRecipeCostVariances,
)

export default router
