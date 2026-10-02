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

  // Tanda «lecturas»
  accounting_income_statement:
    'Management income statement of one branch for a period (from/to, YYYY-MM-DD, branch timezone): gross sales, returns, net collected income, taxable base and VAT included in prices (16%, 8% and 0% bases; exempt and non-taxable reported separately), tips as informational (not income) and sale count. Management view, not a tax filing. Requires accounting:read.',
  accounting_banks_summary:
    'Cash and bank summary of one branch for a period (from/to, YYYY-MM-DD): money received per payment method, split between what stayed in the cash drawer and what the bank deposits net of fees. Requires accounting:read.',
  bank_reconciliation_summary:
    'Bank reconciliation status of one branch: uploaded bank statements and how many bank deposits already match the deposits made by Avoqado. Requires accounting:read and the Pro plan (bank reconciliation).',
  area_ticket_status:
    'Status of one area ticket or final delivery receipt by its scanned code: payment, claim, print and delivery state, plus the external-register settlement details when the ticket is charged in another point of sale. Read-only.',
  pending_area_ticket_deliveries:
    'Area tickets still waiting for physical delivery to the customer, oldest first, covering tickets already paid in Avoqado and tickets charged in another register, each with its area and settlement state. Requires area-tickets:deliver.',
  area_ticket_reconciliation_queue:
    'Two reconciliation queues of one branch: checkout sessions held because a payment outcome needs review, and open incidents on tickets charged in another register (unconfirmed charges, amount variances). Read-only; requires area-tickets:configure.',
  pending_external_confirmations:
    'Tickets charged in another register that are still waiting for a person to confirm that charge, excluding tickets already confirmed, disputed, declared uncharged or configured as assumed. Read-only; requires area-tickets:configure.',
  list_customer_campaigns:
    'Email campaigns a branch sent or is preparing for its own customers: name, subject, status, audience and delivered vs failed counts. Requires marketing:manage.',
  birthday_automation_status:
    'Automatic birthday greeting of a branch: whether it is on, paused or not yet set up, how many days in advance it is sent, its subject and the last date evaluated. Requires marketing:manage.',
  list_commission_schemes:
    'Active staff commission schemes of accessible branches (configuration only, not earnings): calculation type (percentage, tiered or fixed), commissionable product categories, tiers and commission base (amount collected or list price). Requires commissions:read.',
  list_commission_goals:
    'Staff sales goals of accessible branches, per employee or branch-wide, with their period (daily, weekly or monthly); goals can define commission tier boundaries. Requires commissions:read.',
  commission_payouts:
    'Staff commission payouts of accessible branches: staff member, amount, payment method, status and paid date, plus totals paid and pending. Optional venueId and status. Requires commissions:read.',
  staff_commission:
    'Commission earned by each staff member in one branch over a date range (default: current month, branch timezone), as calculated by the commission engine: total commission, commissionable base and breakdown by scheme and tier. Optional staffId and fromDate/toDate (YYYY-MM-DD). Requires commissions:read.',
  list_credit_packs:
    'Prepaid packs a branch sells (for example 10 classes): name, price in pesos, included products or services with credit counts, active state and number sold. Optional inactive packs. Requires creditPacks:read.',
  customer_credit_balance:
    'Remaining prepaid credits of one customer in a branch, found by name, email or phone: each purchased pack with status, purchase and expiry dates, amount paid and remaining vs original credits per item. Active packs by default; when the search matches several customers, the matches are returned. Requires creditPacks:read.',
  list_customer_groups:
    'Customer segments of a branch (for example VIP or frequent customers): name, description, color, active state and member count. Optional search. Requires customer-groups:read.',
  customer_group_detail:
    'Detail of one customer segment by groupId: description, member count, combined and average spend in pesos, visits, loyalty points and the members ranked by spend. Requires customer-groups:read.',
  find_customer:
    'Customers of a branch matching a name, email or phone (partial match), or the top customers by total spent when no search is given: visits, total spent, loyalty points, tags and contact details.',
  customer_history:
    'Order history of one customer of a branch, found by name, email or phone: recent orders (number, total, status, date) and lifetime summary (visits, total and average spend, loyalty points, tags).',
  customers_awaiting_approval:
    'Customers waiting for the branch to approve their online-booking account, oldest first, each with the approval version required to decide. Requires the reservations feature and customers:approve.',
  delivery_activation_requests:
    "Delivery activation requests of accessible branches (Uber Eats, Rappi, DiDi): the owner's request and its progress (pending, contacted, connected or dismissed) before the delivery integration is live. Optional venueId and status. Read-only.",
  delivery_channels:
    "Delivery channel status of a branch (Uber Eats, Rappi, DiDi): connected channels, active or paused state, order acceptance mode, whether the integration is ready, last menu sync, accepting hours, price markup, today's delivery orders per channel and recent store connection attempts. Requires the delivery channels feature.",
  delivery_courier:
    'Courier currently bringing a delivery order, once the provider assigned one: name, contact phone with access code and vehicle. Indicates when the channel does not provide this data or when nobody has been assigned yet. Requires the kitchen-display ticket id. Read-only.',
  delivery_line_actions:
    "Items the kitchen asked to remove from delivery orders because they ran out, with each request's outcome (pending, uncertain, confirmed or rejected), whether the item was refunded by the provider, and delivery sales whose money is held for review. Paginated, most recent first. Read-only.",
  list_discounts:
    'Discounts configured in a branch: name, type (percentage, fixed amount or comp), value, conditions (minimum purchase, maximum discount, uses per customer), active state and number of coupon codes. Active discounts by default.',
  list_inter_venue_transfers:
    'Ingredient transfers between branches where the given branch is origin or destination: status, direction and search filters, paginated. Requires the Premium plan (inventory tracking).',
  inter_venue_transfer_detail:
    'Detail of one transfer between branches: lines, batch (FIFO) allocations, partial receipts and differences. Requires the Premium plan (inventory tracking).',
  reorder_suggestions:
    'Ingredients of a branch at or below their reorder point: suggested quantity, suggested supplier, estimated cost and urgency, plus whether automatic reordering is enabled. Requires inventory:read and the automatic reorder feature.',
  stock_counts:
    'Physical inventory counts of a branch, newest first: status (in progress, completed, cancelled), creator, dates and each line with expected vs counted quantity and variance, plus a summary of counted lines and differences. Requires the Premium plan (inventory tracking).',
  raw_material_presentations:
    'Purchase and dispatch presentations of one ingredient (box, cone, kilo, etc.) and how many base units each contains; an ingredient without presentations operates only in its base unit. Requires inventory:read and the Premium plan (inventory tracking).',
  stock_batches:
    'Batches of one ingredient in a branch, oldest first (consumption order): batch number, initial and remaining quantity, unit cost, receipt date, expiry, status and originating purchase order. The ingredient is matched by name; several matches are returned for disambiguation. Requires inventory:read and the Premium plan (inventory tracking).',
  inventory_postings:
    'Inventory deduction status of paid sales of a branch: applied, partially failed (retried automatically), in progress or skipped with its reason, newest first, with optional status and order filters. Requires the Premium plan (inventory tracking).',
  list_waste_reports:
    'Waste records of a branch, newest first and paginated: item, declared quantity, quantity deducted, quantity without stock, reason, cost in pesos when known, author, channel and date. Dates are local days (YYYY-MM-DD, inclusive). Expiry write-offs are not included. Requires inventory:read and the Premium plan (inventory tracking).',
  loyalty_status:
    'Loyalty program settings of a branch: active state, points per amount spent and per visit, redemption value of a point, minimum points to redeem and point expiry days. Requires the loyalty feature.',
  wallet_card_design:
    "Appearance of a branch's customer wallet card (Apple Wallet): colors, stamp shape and whether a custom logo and icon were uploaded; unconfigured branches return the default theme. Read-only; requires loyalty:read.",
  stamp_card_status:
    'Stamp card of one customer in a branch: stamps on the current card, stamps required by that card, the reward and earned rewards not yet claimed. Read-only; requires loyalty:read.',
  recent_orders:
    'Most recent orders of accessible branches or one branch: order number, type, status, total, branch, time and refund state (none, partial or full, with refunded amount in pesos).',
  find_order:
    'One order located by order number, internal id or the serial number of an item sold on it, within accessible branches: header, line items, payments and refund state. Refunded sales keep their original total and paid status; refundState indicates the return. When several orders match, the candidates are returned. Exactly one identifier is required.',
  open_orders:
    'Open or partially paid orders of accessible branches or one branch, oldest first: table, covers, type, status, total, amount paid, remaining balance, item count and opening time, plus the total still owed.',
  search_orders:
    'Orders of accessible branches or one branch filtered by status, type and date range (default: last 7 days, YYYY-MM-DD): count and total plus the matching orders, newest first.',
  list_payment_effects:
    'Background jobs derived from recorded payments of a branch (receipt, review request, commissions, referrals and transaction cost) by status: pending, processing, done or needing review, with the reason a cost is pending. Paginated; read-only.',
  list_payment_links:
    'Payment links of a branch: title, purpose, fixed or open amount, currency, status (active, paused, expired, archived), short code and expiry. Active links by default. Read-only.',
  list_payments:
    'Individual payments of a branch over a date range (default: last 7 days): amount, tip, method, type, card brand, status, processor fee, net deposited, staff member, terminal and order number, plus a summary separating sales from refunds. Fees still being confirmed are flagged as provisional. Optional status, method and dates (YYYY-MM-DD).',
  list_refunds:
    'Refunds issued by a branch over a date range (default: last 7 days): amount returned (sale and tip), payment method, reason, note, original order number, staff member and date, plus totals and a breakdown by reason. Each row includes the refund state of the whole original sale. Optional dates (YYYY-MM-DD).',
  list_printers:
    'Physical printers of a branch and its print gateway: name, connection type, address, paper width, character set, left margin calibration, learned hardware identity and last known status. Network printers that change address are found again on the local network and updated automatically. Read-only; requires printers:read.',
  list_print_stations:
    'Print stations of a branch (for example kitchen or bar) with their assigned printer, the default fallback station and how many menu categories have no route. Read-only; requires printers:read.',
  print_routing_preview:
    'Simulation of where a set of products (product ids and quantities) would print in a branch, using the same routing as the point of sale: one ticket per station with its items. Read-only; requires printers:read.',
  list_kitchen_tickets:
    'Kitchen display tickets of a branch, optionally for one station: the tickets that screen currently holds plus tickets without a station, limited to the latest 100 with the total. Read-only; requires orders:read.',
  list_purchase_orders:
    'Purchase orders of a branch, newest first: number, supplier, status, order and expected delivery dates, total in pesos, line count and whether it was generated automatically. Optional status filter. Requires the Premium plan (inventory tracking).',
  purchase_order_detail:
    'Detail of one purchase order by id: supplier and contact, status, dates, amounts (subtotal, tax, total in pesos), approval information, notes and every line item with type, unit, quantity ordered vs received, unit price, line total and purchase presentation. Requires the Premium plan (inventory tracking).',
  product_sales:
    'Sales of one product of a branch over a period (default: last 30 days): units sold, revenue and number of order lines, counting non-cancelled orders. The product is matched by name; several matches are returned for disambiguation. Optional fromDate/toDate (YYYY-MM-DD). Requires reports:read and the Pro plan (advanced reports).',
  list_promotions:
    'Promotions of a branch (combos, bundles and 2x1) with status (draft, published or archived) and prices in pesos. Requires the Pro plan.',
  promotion_status:
    "Promotions of a branch active right now and those starting in the next 4 hours, evaluated in the branch's local time. Requires the Pro plan.",
  promotion_sales:
    'Performance of each promotion of a branch over a period: times sold, list-price value, discount given and net revenue, by promotion name, in pesos and branch-local dates. Requires the Pro plan.',
  referral_status:
    "Referral program settings of a branch: active state, discount for referred customers, referrals required per level, coupon validity days and rewards per level, plus this month's referral activity compared with last month.",
  reservations:
    'Reservations of accessible branches or one branch: date and time, party size, guest, status and confirmation code. Upcoming only by default, soonest first; past reservations optional. Requires reservations:read and the Pro plan (reservations).',
  reservation_detail:
    'Detail of one reservation by confirmation code: status, start and end, party size, guest contact, table or booked services with duration and price, add-ons, deposit (amount, status, paid date), check-in and no-show times, special requests and internal notes. Payment-processor references are not included. Requires reservations:read and the Pro plan (reservations).',
  reservation_settings:
    'Full reservation configuration of a branch: scheduling, pacing, deposits, upfront payment defaults, cancellation and no-show policy, class credit refunds, waitlist, online booking, reminders and calendar sync. Requires the Pro plan (reservations).',
  my_class_now:
    'The class the signed-in staff member is teaching right now in a branch: attendees, check-in state and spot of each person. Returns nothing outside an assigned class. Requires class-sessions:read-assigned.',
  staff_schedule:
    'Weekly schedule and date exceptions of one professional (staff membership id) in a branch. Requires teams:read and the reservations feature.',
  service_staff:
    'Professionals explicitly assigned to one appointment service; in staff-aware mode an empty list means nobody is eligible. Requires menu:read and the reservations feature.',
  list_class_sessions:
    'Group class sessions of a branch: class name, start and end, duration, capacity, enrolled and available spots, instructor and status. Upcoming only by default, soonest first. Requires reservations:read and the Pro plan (reservations).',
  class_session_detail:
    'Roster of one class session by sessionId: class, time, capacity, enrolled and available spots, instructor and attendees with party size, status and confirmation code. Requires reservations:read and the Pro plan (reservations).',
  list_waitlist:
    'Reservation and appointment waitlist of a branch in queue order: position, guest, party size, desired date and time, status and resulting reservation code when converted. Live queue (waiting and notified) by default. Requires reservations:read and the Pro plan (reservations).',
  list_reviews:
    'Customer reviews of a branch: summary (count, average stars, food, service and ambience averages) and recent reviews with stars, comment, staff member, date and source. Optional minimum rating.',
  staff_ranking:
    'Staff of a branch ranked by sales over a date range (default: last 7 days): revenue, orders, tips and average ticket, attributed to the staff member who created each order. This figure is total sales, not a commission base or a per-employee tip amount. Requires analytics:read and the Pro plan (advanced reports).',
  tips_over_time:
    'Tips collected in a branch per day (branch timezone) over a date range (default: last 7 days): daily tip total, tipped transaction count and period total. Branch-level total, not per employee. Requires analytics:read and the Pro plan (advanced reports).',
  staff_tips:
    'Tips collected by each employee of a branch over a date range (default: last 7 days), attributed to the staff member who processed each payment (same rule as the cash closeout): total tips and tipped payments per person, with self-service payments listed as unattributed. Optional staffId. Requires analytics:read and the Pro plan (advanced reports).',
  settlement_calendar:
    "Estimated dates when card money lands in the bank for a branch over a date range (default: last 7 days), based on each merchant account's settlement rules, business days and Mexican holidays: per-day calendar with status, net amount and commission. Cash is excluded.",
  settlement_week:
    'Card money landing in the bank on each day of a Monday-to-Sunday week for a branch, by settlement date: gross, commission and net per day with breakdowns by merchant account and card type, plus the week total. Optional weekStart. Requires the Pro plan (advanced reports).',
  available_balance:
    'Money position of a branch: amount already settled, card money in transit, next estimated settlement (date and amount), period sales and fees, and a breakdown by card type with typical settlement days. Optional date range. Requires the Pro plan (advanced reports).',
  export_sales_summary:
    'Sales summary export of a branch: totals and selected sections (summary mode) or per-transaction rows (detailed mode, up to 200 rows), with the same date, payment method, card type and merchant filters as the dashboard report. Requires analytics:read and the Pro plan (advanced reports); detailed mode also requires the transaction export feature.',
  service_charges:
    'Service charges configured in a branch (automatic large-party gratuity, corkage, delivery fee, etc.): percentage or fixed amount, value, whether it is taxable and the party size that triggers it automatically. Requires the table service feature.',
  list_shifts:
    'Cash register shifts of a branch: who opened and who closed each shift, start time, sales, tips, orders, cash vs card collected, starting and ending cash, cash declared at close, difference and status. Open shifts by default. Requires shifts:read.',
  get_cash_drawer_status:
    'Physical cash drawer of a branch right now: whether one is open, who opened it and when, linked shift and anomalies. While a drawer is open, its amounts (starting cash, cash sales, pay-ins, pay-outs and expected cash) are included only for users with permission to view them (blind count). Requires shifts:read. Read-only.',
  list_cash_drawer_sessions:
    'History of physical cash drawer sessions of a branch, newest first: who opened and closed each one, device, amounts (for open drawers only with permission to view them), whether it was counted at close, counted amount and over/short. Requires shifts:read. Paginated; read-only.',
  cash_closeout:
    'Cash closeout of a branch: cash expected in the drawer since the last closeout (cash payments minus cash refunds, with transaction count) and past closeouts with expected vs counted amount, variance, deposit method, staff member and date. Read-only; requires settlements:read.',
  who_is_late_now:
    "Staff of one branch scheduled to be working right now who have not clocked in, using fixed and rotating schedules, exceptions and the branch's tolerance minutes; people without a schedule or on a day off are excluded. Read-only.",
  work_shifts:
    'Rotating work shifts of a branch: shift templates and person-by-day assignments for a date range of up to 31 days (from/to, YYYY-MM-DD), with draft or published status. Published assignments count for attendance and commissions when rotating shifts are enabled. Read-only.',
  list_staff:
    'Team of a branch: membership id, staff id, name, role and whether each account is active. Optional name search and active-only filter; paginated.',
  attendance_payroll_summary:
    'Attendance figures for payroll of one branch over a period: scheduled and worked days, late days and minutes, absences by type, worked hours and overtime minutes split into approved, pending and denied, with weekly breakdown and days to review. Figures are minutes; pay rates and legal compliance are outside its scope.',
  venue_attendance:
    'Time clock of one branch: who is clocked in now and clock-in and clock-out records with worked hours, break minutes and approval status, for a date range or, without dates, the most recent records. Requires attendance permissions. Read-only.',
  staff_detail:
    'Detail of one team member found by name: account status and the role held at each accessible branch. Contact details are not included. Several matches are returned for disambiguation.',
  tables_status:
    'Live table status of a branch: number, area, capacity, status (available, occupied, reserved, cleaning) and, when occupied, the open order with total, paid amount and remaining balance, plus counts by status. Optional area filter.',
  list_areas: 'Areas or sections of a branch (for example terrace, bar, main room) with description and table count.',
  list_tender_types:
    'Payment types of a branch (cash, cards, transfer and custom types such as delivery platforms or vouchers): whether they enter the cash drawer, tip capture, position in the point of sale, commercial commission percentage, invoicing payment code and active state. Read-only; requires tender-types:read.',
  tender_commissions:
    'Commission paid per payment type over a date range (default: last 30 days, branch-local dates): charge count, gross sales without tips, commission paid and net kept, in pesos, using the commission recorded on each charge. Read-only; requires tender-types:read.',
  audit_terminals:
    'Configuration audit of the payment terminals of accessible branches: effective checkout, quick payment and shift settings per terminal, with known configuration gaps flagged. Optional venueId; paginated.',
  list_devices:
    'Devices connected to accessible branches (payment terminals, phones, tablets and point-of-sale devices): device type, online state, last user, first seen date and which settings each device type can change locally. Filters by form factor and online state; retired devices optional; paginated.',
  terminal_checkout_screens:
    'Customer-facing checkout screens of each device: whether it asks for a star rating and whether it offers a tip, and whether that setting can be changed on the device or only from the dashboard. Read-only; paginated.',
  terminal_payment_requests:
    'Charge requests sent from the point of sale to payment terminals in accessible branches: terminals currently busy, recent charges and older charges still unresolved, with outcome (charged, not charged with its evidence, or unresolved), confirming source, attempts and amounts in pesos. Requires tpv:read. Paginated; read-only.',
  upsell_status:
    "Checkout suggestions of a branch: attributed revenue, ticket lift measured against a control group, where suggestions are enabled, active rules, proposals awaiting the owner's decision and the reasons a rule would not reach the point of sale. Requires the Pro plan.",
}
