import { actionRegistry } from '../action-registry'
import { inventoryActions } from './inventory.actions'
import { recipeActions } from './recipe.actions'
import { purchaseOrderActions } from './purchase-order.actions'
import { productStockActions } from './product-stock.actions'
import { productCrudActions } from './product-crud.actions'

export function registerAllActions(): number {
  const allActions = [...inventoryActions, ...recipeActions, ...purchaseOrderActions, ...productStockActions, ...productCrudActions]
  allActions.forEach(action => actionRegistry.register(action))
  return allActions.length
}

export { inventoryActions, recipeActions, purchaseOrderActions, productStockActions, productCrudActions }
