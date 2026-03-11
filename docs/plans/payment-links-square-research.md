# Square Payment Links — UI/UX Research for Avoqado

## Overview

Square Payment Links lets merchants create shareable payment URLs from the dashboard. The link opens a hosted checkout page where customers
pay. No code needed.

**URL structure**: `https://square.link/{shortcode}` (shareable) → opens hosted checkout page.

---

## Navigation & Entry Points

### Sidebar Location

```
Payments & invoices
├── Transactions
├── Orders
├── Invoices
├── Bill Pay
├── Virtual Terminal
├── Payment links        ← LIST of all links
│   └── Settings
│       ├── General      ← Global payment/tipping/fulfillment config
│       └── Branding     ← Logo, button color, font, buy button embed
├── Subscriptions
├── Disputes
└── Risk Manager
```

### Quick Entry Points

1. **Sidebar**: `Payment links > Payment links` → list page → "Create link" button (top-right, black)
2. **Take payment button** (bottom-left floating): dropdown with "Send payment link"
3. **Home page**: "Take a payment" quick action

---

## Flow 1: Create Payment Link

### Step 1 — Choose Purpose (Full-screen modal)

**Layout**: Modal overlays everything. Header: `[← Back] [Business Name] Choose purpose [⚙️ Settings] [Continue]`

**Left panel**: 4 radio-style options (card-like, one selected at a time):

| Option                     | Icon       | Description                     |
| -------------------------- | ---------- | ------------------------------- |
| **Take a payment**         | `$` circle | Free-form amount (any or exact) |
| **Sell an item**           | Price tag  | Links to Item Library catalog   |
| **Sell an event or class** | Calendar   | Date/time/location/capacity     |
| **Accept a donation**      | Heart/gift | Donation goal, open amount      |

**Right panel**: Live mobile preview of the checkout page, updates in real-time as you edit.

**Preview toggle**: Phone icon / Desktop icon (top-right of preview) to switch mobile/desktop preview.

### Step 2 — Create Link Form (per purpose type)

**Layout**: Same full-screen modal. Header: `[← Back] [Business Name] Create link [⚙️] [Save]`

Split layout:

- **Left ~35%**: Form fields (scrollable)
- **Right ~65%**: Live preview with 3 tabs: `Details | Checkout | Confirmation`

---

## Form Fields per Purpose Type

### A) Take a Payment

```
Details
├── Title                          (text input, required)
├── Amount type                    (pill toggle: "Any amount" | "Exact amount")
├── Frequency                      (dropdown: One-time, Weekly, Monthly, etc.)
├── Description (optional)         (textarea, 0/400 chars)
└── Upload image                   (drag/drop area with icon)

Checkout
├── Custom fields                  (toggle switch → expandable)
└── Tipping                        (toggle switch)

Confirmation
└── Redirect to website after checkout  (toggle switch → URL input when on)
```

### B) Sell an Item

```
Item
├── Select or create a new item    (searchable combobox, links to Item Library)
│   └── "Details are saved to your Item Library and shared across all your locations"

Checkout
├── Custom fields                  (toggle switch)
└── Tipping                        (toggle switch)

Confirmation
└── Redirect to website after checkout  (toggle switch)
```

**Preview shows**: Item name, price, quantity selector (−/1/+), subtotal.

### C) Sell an Event or Class

```
Item
├── Select or create a new event   (searchable combobox)

Details
├── Type                           (pill toggle: "In-person" | "Online")
├── Event address                  (text input, shown for In-person)
├── Start date + Start time        (date input + time dropdown, side by side)
├── End date + End time            (date input + time dropdown, side by side)
├── Time zone                      (dropdown)
└── Event capacity                 (number input)

Checkout
├── Custom fields                  (toggle switch)
└── Tipping                        (toggle switch)

Confirmation
└── Redirect to website after checkout  (toggle switch)
```

**Preview shows**: Event name, price, date/time with clock icon, location with globe icon, quantity selector, subtotal.

### D) Accept a Donation

```
Details
├── Title                          (text input, required)
├── Frequency                      (dropdown: One-time, Weekly, Monthly, etc.)
├── Description (optional)         (textarea, placeholder: "Purpose of donation", 0/400)
├── Upload image                   (drag/drop area)
└── Set donation goal              (toggle + info tooltip → amount/end date when on)

Checkout
├── Custom fields                  (toggle switch)
│   (NO tipping for donations)

Confirmation
└── Redirect to website after checkout  (toggle switch)
```

**Preview shows**: "Donation" heading, open amount input, progress bar when goal enabled (e.g., "$500 raised of $1,000 goal", "Ends in 30
days").

---

## Live Preview (Right Panel)

### 3 Preview Tabs

**Details tab**: Shows the customer-facing landing page

- Business logo (top, if enabled)
- Title / item name
- Price or "Enter amount" input
- Description text
- Image (if uploaded)
- For events: date, time, location icons
- For items: quantity selector (−/+)
- "Proceso de pago" CTA button (blue, full-width)
- "Pago seguro con Square" footer badge

**Checkout tab**: Shows the full checkout form

- Subtotal + Order total breakdown
- Coupon input field
- **Express checkout**: Apple Pay + Google Pay buttons
- **Contact section**: Phone (with country code dropdown), Email, First name, Last name
- **Payment section**: "All transactions are secure and encrypted", Card radio option with card brand icons
- "Pay $XX.XX" button (disabled until all fields filled)

**Confirmation tab**: Shows post-payment receipt

- Green checkmark icon
- "Tu pago está confirmado"
- **RESUMEN**: Item/payment name + amount
- Subtotal + Order total
- "VISA que termina en 1234" (mock card)
- Customer name, email, phone

### Preview Device Toggle

Top-right corner: `[📱 Phone] [🖥 Desktop]` — switches preview between mobile and desktop viewport.

---

## Settings Pages

### General Settings (`/payment-links/settings/general`)

**Payments**

- Credit card: Shows accepted brands (Visa, MC, Amex, Discover, Diners, JCB, UnionPay)
- Apple Pay: toggle (on by default)
- Google Pay: toggle (on by default)
- Cash App: toggle (on by default)

**Email Notifications**

- "Get an email notification after each transaction"
- Dashboard or mobile add-on links: toggle
- Point of Sale or Virtual Terminal links: toggle

**Location Settings**

- Location dropdown (for multi-location businesses)
- "Configure settings and Square Payment Links for this location"

**Tipping** (per-location)

- Tip options: "Smart tips" (configurable)
- Tip amounts: "15% (default), 20%, 25% and $1.00 (default), $2.00, $3.00"

**Service Charges**

- "Variable service charges can not be applied"
- "Add in Account settings" button

**Coupons**

- Enable coupons: toggle
- "Edit coupons in Marketing" link

**Customer Information**

- Enable customer notes: toggle
- "Display a text box for customers to leave an optional note"

**Merchant Policies**

- "These policies are only displayed on your payment link"
- "Add" button → custom policies
- "Edit policies displayed on your receipt in Receipts" link

**Fulfillment** (items only, not events/subscriptions)

- Enable shipping: toggle → "Set shipping rates in Shipping Rate Profiles"
- Enable pickup: toggle

### Branding Settings (`/payment-links/settings/branding`)

- **Location**: dropdown (per-location branding)
- **Logo**: toggle (show/hide business logo)
- **Button**:
  - Color: hex color picker (default `#006aff`)
  - Shape: dropdown (Round, Square, etc.)
- **Buy button** (embeddable):
  - Preview of styled button
  - **Two embed code textareas**: simple link HTML + full modal popup with JS
- **Font**: dropdown (default "SQ Market")
- **Image**: toggle
- **Title**: toggle
- **Price**: toggle

---

## Payment Links List Page (`/payment-links`)

**Header**: Location dropdown (left) + "Create link" button (black, top-right)

**Empty state**: Card with:

- "Get paid fast online with a payment link"
- "Create a payment link in seconds, even save it as a buy button or QR code. Once a link is created, you can reuse it —perfect for standard
  offerings you always charge for."
- "Create link" button (black)

**With links** (from marketing page info): Each link shows name, type, amount, status, and actions to copy/share/edit/deactivate.

**Banner**: "Before you can accept payments, we need to verify your identity" (KYC warning, similar to our flow).

---

## Key UX Patterns

1. **Full-screen modal for creation** — not a regular dialog, takes over entire screen
2. **Split layout**: form (left) + live preview (right) — changes reflect instantly
3. **Purpose-first**: user declares intent before seeing any form fields
4. **Progressive disclosure**: toggles reveal additional fields (custom fields, tipping, redirect URL)
5. **Unsaved changes guard**: "You have unsaved changes" modal with "Discard" / "Keep editing"
6. **Validation inline**: "Title is required" alert appears next to the field
7. **Multi-location aware**: Location dropdown on list page AND settings pages
8. **Reusable links**: once created, same link works for multiple payments
9. **Embeddable buy buttons**: generates HTML/JS code to embed on external websites
10. **3-tab preview**: Details → Checkout → Confirmation shows the full customer journey

---

## Avoqado Adaptation Notes

### What we can replicate (MVP)

- "Take a payment" purpose (free-form amount, exact amount)
- Full-screen modal creation flow (we already have FullScreenModal)
- Live preview on the right (mobile-style)
- Title, amount type (any/exact), description, image upload
- Custom fields toggle
- Copy link / share via WhatsApp (better than Square for LATAM)
- QR code generation
- Link list page with status

### What to adapt for our context

- **Payment processor**: Blumon E-commerce (not Square's own)
- **Hosted checkout**: We need to build a public-facing checkout page (like `/pay/{linkId}`)
- **WhatsApp sharing** > email/SMS (LATAM advantage over Square)
- **Venue-scoped**: Links belong to a venue, not a "location"
- **Currency**: MXN default, not USD
- **Tipping**: Map to our existing tip configuration
- **No "Sell an item"** initially — our menu system is different
- **No "Events/Classes"** initially — defer to reservation module
- **No "Donations"** — not relevant for restaurant/retail POS

### Deferred features

- Embeddable buy buttons (HTML/JS code generation)
- Subscription/recurring payments
- Shipping/fulfillment settings
- Coupon integration
- Service charges on links
- Desktop preview toggle
