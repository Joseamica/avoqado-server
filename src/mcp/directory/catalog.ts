/** First directory release: sales summaries, product catalog and ingredient inventory.
 * New tools are excluded until explicitly reviewed. The manual endpoint keeps its full catalog.
 * This distribution boundary never grants venue permissions or bypasses plan/activation gates.
 */
export const DIRECTORY_TOOLS = new Set([
  'list_my_organizations',
  'list_my_venues',
  'venue_profile',
  'daily_sales',
  'top_products',
  'category_mix',
  'sales_by_payment_method',
  'peak_hours',
  'channel_mix',
  'revenue_by_venue',
  'sales_comparison',
  'today_overview',
  'list_menu',
  'menu_categories',
  'menu_item_detail',
  'low_stock',
  'stock_value',
  'get_inventory_movements',
  'list_raw_materials',
  'list_product_recipes',
  'get_recipe',
  'list_suppliers',
  'create_category',
  'create_product',
  'set_menu_item_price',
  'set_menu_item_active',
  'create_raw_material',
  'update_raw_material',
  'adjust_raw_material_stock',
  'adjust_stock',
  'create_recipe',
  'enable_recipe_inventory',
  'create_supplier',
])

export type McpProfile = 'manual' | 'directory'
