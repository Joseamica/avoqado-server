---
paths:
  - 'src/services/tpv/**/*.ts'
  - 'src/services/dashboard/rawMaterial*'
  - 'src/services/dashboard/fifoBatch*'
  - 'src/services/dashboard/productInventory*'
  - 'src/services/sdk/**/*.ts'
  - 'src/services/stripe*'
  - 'src/services/pricing/**/*.ts'
---

# Payment & Inventory Rules

## Order → Payment → Inventory Flow

1. Stock deduction ONLY when fully paid (`totalPaid >= order.total`)
2. Non-blocking: Payment succeeds even if deduction fails (log warning, don't throw)
3. FIFO: Oldest batches consumed first (`receivedDate ASC`)
4. Recipe-based: Product → Recipe → RecipeLines → RawMaterials → StockBatches
5. Optional ingredients skipped if unavailable (`isOptional: true`)
6. Low stock alerts auto-generated when `currentStock <= reorderPoint`
7. Partial payments do NOT trigger deduction

## Key Files

| File                                     | Function                                                     |
| ---------------------------------------- | ------------------------------------------------------------ |
| `payment.tpv.service.ts`                 | `recordOrderPayment()` - triggers deduction                  |
| `rawMaterial.service.ts`                 | `deductStockForRecipe()` - recipe orchestration              |
| `fifoBatch.service.ts`                   | `deductStockFIFO()` - FIFO batch consumption                 |
| `productInventoryIntegration.service.ts` | `getProductInventoryMethod()` - returns QUANTITY/RECIPE/null |
| `productInventoryIntegration.service.ts` | `deductInventoryForProduct()` - strategy executor            |

## Blumon: Always Specify TPV or E-commerce

- **TPV**: `blumon-tpv.service.ts` → `MerchantAccount` + `Terminal` (PAX Android)
- **E-commerce**: `blumon-ecommerce.service.ts` → `EcommerceMerchant` + `CheckoutSession` (Web)
- Full docs: `docs/BLUMON_TWO_INTEGRATIONS.md`

## Stripe Subscription Flow

```
Venue Conversion → Stripe Customer → Trial (5-day) → VenueFeature records
Webhooks → Update VenueFeature → checkFeatureAccess middleware validates
```

Triple-layer protection: `authenticateTokenMiddleware` → `checkPermission()` → `checkFeatureAccess()`

## Cost Structure

| Model                   | Meaning                                      |
| ----------------------- | -------------------------------------------- |
| `ProviderCostStructure` | What Blumon charges Avoqado                  |
| `VenuePricingStructure` | What Avoqado charges venue (includes margin) |

MCC lookup: `src/services/pricing/blumon-mcc-lookup.service.ts`
