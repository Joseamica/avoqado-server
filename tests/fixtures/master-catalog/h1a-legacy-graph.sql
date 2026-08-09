\set ON_ERROR_STOP on

-- Frozen pre-H1 graph: the single named Product participates in every legacy
-- relationship whose identity/publication split must leave untouched.
BEGIN;

INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
VALUES ('h1a-legacy-org', 'H1A legacy organization', 'h1a-legacy-org@example.test', '5500000000', CURRENT_TIMESTAMP);

INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
VALUES ('h1a-legacy-venue', 'h1a-legacy-org', 'H1A legacy venue', 'h1a-legacy-venue', CURRENT_TIMESTAMP);

INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt")
VALUES ('h1a-legacy-staff', 'h1a-legacy-staff@example.test', 'Legacy', 'Actor', CURRENT_TIMESTAMP);

INSERT INTO "Module" ("id", "code", "name", "defaultConfig", "updatedAt")
VALUES ('h1a-legacy-module', 'H1A_LEGACY_MODULE', 'Legacy module', '{}'::jsonb, CURRENT_TIMESTAMP);

INSERT INTO "VenueModule" ("id", "venueId", "moduleId", "enabledBy", "updatedAt")
VALUES ('h1a-legacy-venue-module', 'h1a-legacy-venue', 'h1a-legacy-module', 'h1a-legacy-staff', CURRENT_TIMESTAMP);

INSERT INTO "MenuCategory"
  ("id", "venueId", "name", "slug", "availableDays", "updatedAt")
VALUES
  ('h1a-legacy-category', 'h1a-legacy-venue', 'Legacy category', 'h1a-legacy-category', ARRAY[]::text[], CURRENT_TIMESTAMP);

INSERT INTO "Product"
  ("id", "venueId", "categoryId", "sku", "gtin", "name", "price", "taxRate", "tags", "allergens", "updatedAt")
VALUES
  ('h1a-legacy-product', 'h1a-legacy-venue', 'h1a-legacy-category', 'LEGACY-H1A-001', '7501234567893',
   'Legacy product', 42.50, 0.1600, ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP);

INSERT INTO "Inventory" ("id", "productId", "venueId", "currentStock", "updatedAt")
VALUES ('h1a-legacy-inventory', 'h1a-legacy-product', 'h1a-legacy-venue', 12.345, CURRENT_TIMESTAMP);

INSERT INTO "Recipe" ("id", "productId", "portionYield", "totalCost", "prepTime", "updatedAt")
VALUES ('h1a-legacy-recipe', 'h1a-legacy-product', 2, 18.2500, 15, CURRENT_TIMESTAMP);

INSERT INTO "ModifierGroup" ("id", "venueId", "name", "updatedAt")
VALUES ('h1a-legacy-modifier-group', 'h1a-legacy-venue', 'Legacy modifiers', CURRENT_TIMESTAMP);

INSERT INTO "Modifier" ("id", "groupId", "name", "price")
VALUES ('h1a-legacy-modifier', 'h1a-legacy-modifier-group', 'Legacy modifier', 2.00);

INSERT INTO "ProductModifierGroup" ("id", "productId", "groupId")
VALUES ('h1a-legacy-product-modifier', 'h1a-legacy-product', 'h1a-legacy-modifier-group');

INSERT INTO "PricingPolicy"
  ("id", "venueId", "productId", "calculatedCost", "currentPrice", "updatedAt")
VALUES
  ('h1a-legacy-pricing-policy', 'h1a-legacy-venue', 'h1a-legacy-product', 18.2500, 42.50, CURRENT_TIMESTAMP);

INSERT INTO "Order"
  ("id", "venueId", "orderNumber", "subtotal", "taxAmount", "total", "remainingBalance", "updatedAt")
VALUES
  ('h1a-legacy-order', 'h1a-legacy-venue', 'H1A-LEGACY-ORDER', 42.50, 0.00, 42.50, 42.50, CURRENT_TIMESTAMP);

INSERT INTO "OrderItem"
  ("id", "orderId", "productId", "productName", "productSku", "categoryName", "quantity", "unitPrice", "taxAmount", "total", "updatedAt")
VALUES
  ('h1a-legacy-order-item', 'h1a-legacy-order', 'h1a-legacy-product', 'Legacy product', 'LEGACY-H1A-001',
   'Legacy category', 1, 42.50, 0.00, 42.50, CURRENT_TIMESTAMP);

INSERT INTO "OrderItemModifier" ("id", "orderItemId", "modifierId", "name", "price")
VALUES ('h1a-legacy-order-item-modifier', 'h1a-legacy-order-item', 'h1a-legacy-modifier', 'Legacy modifier', 2.00);

INSERT INTO "ActivityLog" ("id", "staffId", "venueId", "action")
VALUES ('h1a-legacy-activity', 'h1a-legacy-staff', 'h1a-legacy-venue', 'LEGACY_H1A_ACTIVITY');

-- Representative legacy volume makes concurrent-index readiness and deploy
-- timing evidence meaningful without imposing a machine-specific SLA.
INSERT INTO "Product"
  ("id", "venueId", "categoryId", "sku", "name", "price", "tags", "allergens", "updatedAt")
SELECT 'h1a-legacy-product-bulk-' || LPAD(g::text, 4, '0'),
       'h1a-legacy-venue',
       'h1a-legacy-category',
       'LEGACY-BULK-' || LPAD(g::text, 4, '0'),
       'Legacy bulk product ' || g,
       1.00,
       ARRAY[]::text[],
       ARRAY[]::text[],
       CURRENT_TIMESTAMP
  FROM generate_series(1, 250) AS g;

INSERT INTO "ActivityLog" ("id", "staffId", "venueId", "action")
SELECT 'h1a-legacy-activity-bulk-' || LPAD(g::text, 4, '0'),
       'h1a-legacy-staff',
       'h1a-legacy-venue',
       'LEGACY_H1A_BULK'
  FROM generate_series(1, 2000) AS g;

COMMIT;
