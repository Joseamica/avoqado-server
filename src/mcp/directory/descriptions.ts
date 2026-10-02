/**
 * Descriptions published by the directory profile (`/mcp/directory`). The manual endpoint keeps the
 * original descriptions, which point to tools this catalog does not expose and guide the operator.
 * Directory policy: say what the tool does, its inputs, outputs and requirements — never another
 * tool's name and never instructions about how the assistant should behave.
 */
export const DIRECTORY_DESCRIPTIONS: Record<string, string> = {
  list_my_organizations:
    'Organizations the signed-in user belongs to, the role in each one, which is the primary one, and which single organization this connection is bound to. Takes no arguments.',
  list_my_venues:
    'Paginated list of the branches (venues) of the connected organization that the user can access, with the effective role and permissions at each branch, currency and timezone. Optional search by name; hasMore and nextOffset indicate further pages.',
  venue_profile:
    "Basic profile of one branch: name, type, currency, timezone, language, address, contact details and whether it is active. Contains no fiscal, identity or payment-credential data. For organization owners it also includes the branch's Google review link. Requires venueId.",
  daily_sales:
    'Completed sales for one local calendar day, for all accessible branches or for one branch (venueId). Each branch is evaluated in its own timezone. Returns payment count, gross total and breakdowns by payment method, sale type and merchant account. Defaults to today.',
  top_products:
    'Best-selling menu items of one branch over a date range (default: last 7 days), ranked by units sold. Requires venueId; optional fromDate/toDate (YYYY-MM-DD) and limit.',
  category_mix:
    'Sales by menu category of one branch over a date range (default: last 7 days): revenue, units and share of revenue per category, ranked by revenue. Requires venueId; optional fromDate/toDate (YYYY-MM-DD) and limit.',
  sales_by_payment_method:
    'Sales by payment method (cash, card, etc.) of one branch over a date range (default: last 7 days). Returns two figures per method: grossCollected (all money received, including tips and net of refunds, including cancelled orders) and netSales (sale value minus refunds, excluding cancelled orders and tips). Dates are local to the branch and include the whole toDate day. Requires venueId.',
  channel_mix:
    'Sales by order channel (dine-in, takeout, delivery, etc.) of one branch over a date range (default: last 7 days): revenue, order count and share of revenue per channel. Requires venueId; optional fromDate/toDate (YYYY-MM-DD) and limit.',
  peak_hours:
    'Sales and transaction count per hour of the day (0-23, branch timezone) of one branch over a date range (default: last 7 days). Requires venueId; optional fromDate/toDate (YYYY-MM-DD).',
  revenue_by_venue:
    'Completed sales per branch across all accessible branches over the last N days (default 30): gross and transaction count per branch, ranked highest first, plus the combined total and coverage of included branches.',
  sales_comparison:
    'Completed sales of the last N days compared with the previous N days (default 7): gross, transaction count and the absolute and percentage change. Optional venueId; without it, covers all accessible branches.',
  today_overview:
    'Snapshot of one branch for the current local day: completed sales and tips so far, open unpaid tabs and their balance, remaining reservations, products low on stock and open cash shifts. Requires venueId.',
  list_menu:
    'Menu items of one branch: name, price, whether it is active, category and type. Optional name search and active-only filter; paginated. Requires venueId.',
  menu_categories:
    'Menu categories of one branch: name, description, whether active and number of products in each. Active categories by default. Requires venueId.',
  menu_item_detail:
    'Full detail of one menu item of a branch, found by name: description, category, type, price, cost and margin (only when a real cost is set), prep time, calories, active state, stock tracking method and modifier groups with their prices. When the name matches several items, returns the matching names.',
  low_stock:
    'Products of one branch whose counted stock is at or below their minimum level: current and minimum stock, shortfall and last restock date, most depleted first. Requires venueId.',
  stock_value:
    'Value of the unit-counted product inventory of one branch: total cost value, total retail value, potential margin and number of in-stock items without a cost. Items without a cost are not estimated. Serialized items are not included. Requires venueId.',
  get_inventory_movements:
    'Inventory movement history of one branch for products and ingredients: purchases, sales, manual adjustments, losses, counts and transfers, with author, date, quantity change, stock before and after, and reason. Filters by movement type, item name and date range; newest first. Requires the Premium plan (inventory tracking).',
  list_raw_materials:
    'Ingredients (raw materials) of one branch with their storage unit, current stock and cost per unit. Optional name search; paginated. Requires inventory:read and the Premium plan (inventory tracking).',
  list_product_recipes:
    'Recipe coverage and cost for the products of one branch: whether each product has a recipe, recipe cost per portion, manual cost, tracking method and whether automatic ingredient deduction is enabled. Search and filters apply before pagination. Requires inventory:read and the Premium plan (inventory tracking).',
  get_recipe:
    'Recipe of one product, by name or id: ingredients, quantities, units, cost per portion, yield and whether automatic ingredient deduction is enabled. Requires inventory:read and the Premium plan (inventory tracking).',
  list_suppliers:
    'Suppliers of one branch: name, contact person, email, phone, rating, average lead time, minimum order value and whether active. Active suppliers by default; optional search. Requires the Premium plan (inventory tracking).',
  create_category:
    'Creates a new menu category in one branch, with optional description and display order. Applies immediately. Requires the menu:create permission.',
  create_product:
    'Creates a new product, service or class in one branch: name, price, type (product, food_or_beverage, service, class, event, digital, donation) and an existing category by name; optional description, SKU (generated from the name when omitted), duration for services and classes, and alcohol flag for food and beverages. Applies immediately. Requires the products:create permission.',
  set_menu_item_price:
    'Changes the price of one menu item of a branch, found by name, in the branch currency (major units, e.g. 120 = $120.00). Two steps: without confirm it returns a preview (current and new price) and a confirmation token; the change applies only on a second call with confirm:true and that token. Requires the products:update permission.',
  set_menu_item_active:
    'Turns one menu item of a branch on or off, found by name; inactive items stop being shown and sold. Two steps: without confirm it returns a preview (current and new state) and a confirmation token; the change applies only on a second call with confirm:true and that token. Requires the products:update permission.',
  adjust_stock:
    'Changes the counted stock of one product of a branch, found by name. delta is the change, not the new total (positive adds, negative subtracts); stock cannot go below zero. Two steps: without confirm it returns a preview (current and resulting stock) and a confirmation token; the change applies only on a second call with confirm:true and that token. Requires the inventory:adjust permission.',
  create_raw_material:
    'Creates a new ingredient in one branch: name, category, unit of measure, initial stock, minimum stock, reorder point and cost per unit. Applies immediately. Requires inventory:create and the Premium plan (inventory tracking). Categories: MEAT, POULTRY, SEAFOOD, DAIRY, CHEESE, EGGS, VEGETABLES, FRUITS, GRAINS, BREAD, PASTA, RICE, BEANS, SPICES, HERBS, OILS, SAUCES, CONDIMENTS, BEVERAGES, ALCOHOL, CLEANING, PACKAGING, OTHER. Units include KILOGRAM, GRAM, POUND, OUNCE, LITER, MILLILITER, GALLON, CUP, TABLESPOON, TEASPOON, PIECE, UNIT, DOZEN, BOX, BAG, BOTTLE, CAN, JAR.',
  update_raw_material:
    'Edits the name, description, cost per base unit or stock thresholds of one existing ingredient, identified by its id; cost changes recalculate the cost of recipes that use it. Does not change the unit or the stock. Two steps: without confirm it returns a preview (current and new values) and a confirmation token; the change applies only on a second call with confirm:true and that token. Costs allow up to 4 decimals and thresholds up to 3. Requires inventory:update and the Premium plan (inventory tracking).',
  adjust_raw_material_stock:
    'Changes the stock of one existing ingredient, identified by its id, in its storage unit. delta is the change, not the new total (+82 adds 82, -2 removes 2). Two steps: without confirm it returns a preview (ingredient, branch, unit and resulting stock) and a confirmation token; the change applies only on a second call with confirm:true and that token. Requires inventory:adjust and the Premium plan (inventory tracking).',
  create_recipe:
    'Creates the recipe of one menu product: the ingredients it consumes and the quantity of each. Ingredients are matched by name and the operation is all or nothing: when a name matches zero or several ingredients, nothing is created and the candidates are returned. Two steps: without confirm it returns a preview (matched ingredients, units and cost per portion) and a confirmation token; the recipe is created only on a second call with confirm:true and that token. Creating a recipe does not enable automatic ingredient deduction. Requires inventory:create and the Premium plan (inventory tracking).',
  enable_recipe_inventory:
    'Enables automatic ingredient deduction for one product that already has a recipe, identified by productId. Affects future fully paid sales only; past sales and current stock stay unchanged. Two steps: without confirm it returns a preview (current and new tracking method) and a confirmation token; the change applies only on a second call with confirm:true and that token. Requires inventory:update and the Premium plan (inventory tracking).',
  create_supplier:
    'Creates one supplier in a branch: name and optional contact person, email, phone, lead time and notes. A name that already exists (including inactive suppliers) is refused and its id is returned. Two steps: without confirm it returns a preview and a confirmation token; the supplier is created only on a second call with confirm:true and that token. Requires inventory:create and the Premium plan (inventory tracking).',
}
