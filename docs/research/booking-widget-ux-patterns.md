# Booking Widget UX Patterns Research

> Research conducted March 2026. Covers Square Appointments, Mindbody, Vagaro, Booksy, ClassPass, and Momoyoga.

---

## 1. Platform-by-Platform Analysis

### 1.1 Square Appointments

**Booking Flow (Individual Appointments):**

1. **Select Service** -- Customer sees a list of services on the booking site/widget. Can select one or multiple services.
2. **Select Staff** -- Choose a specific staff member or "Any Available Staff." Staff members are filtered to only show those assigned to
   the selected service.
3. **Enter Information** -- Name, phone number, email, address.
4. **Select Time** -- Browse available time slots, confirm time zone, click "Book Appointment."

**Class Booking Flow:**

- Classes are displayed alongside services on the booking site.
- Customer selects a class, sees the **number of remaining spots** displayed below the class price.
- Each customer books individually (no multi-person booking in a single transaction).
- Capacity is set per class (instructor + max spots), and online availability updates in real time.

**Key UX Patterns:**

- **10-minute slot hold**: Once a customer selects a time slot, it is held for 10 minutes. If not completed, the slot becomes available
  again. This prevents double-booking during checkout.
- **Customer Account auto-creation**: After the first booking, customers get an account to view past/upcoming appointments, add a card on
  file, and rebook.
- **"Any Available Staff" option**: Reduces friction for customers who have no preference.
- **Multi-service booking**: Customers can add multiple services in a single booking session.
- **Payment flexibility**: Credit/debit, Apple Pay, Google Pay, gift cards, Afterpay, prepaid packages.

**Embedding Options:** Book Now button, QR code, or full embedded widget.

---

### 1.2 Mindbody

**Two Distinct Widget Types (critical architectural insight):**

| Widget                 | Purpose                     | Customer Experience                                                                                                       |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Schedule Widget**    | Group classes               | Shows ALL classes in a single calendar view. Customer browses by day, sees class name, time, instructor. Clicks to book.  |
| **Class List Widget**  | Group classes (alternative) | Shows each class separately with its own description and upcoming schedule. Customer picks a class, then picks a session. |
| **Appointment Widget** | Individual appointments     | Customer searches for available appointment times, selects a slot, books or requests.                                     |

**Class Booking Flow:**

1. Browse schedule (calendar or list view).
2. Select a class session.
3. Book using an existing pass/membership OR purchase a new one at checkout.
4. If class is full, option to **join waitlist** automatically.

**Appointment Booking Flow:**

1. Search/browse available appointment types.
2. Select date and time.
3. Book or request appointment.
4. Pay or use existing pass/membership.

**Key UX Patterns:**

- **Separate widgets for separate concerns**: Classes and appointments are fundamentally different UX flows; Mindbody uses different widgets
  rather than forcing one flow to handle both.
- **Pick-a-Spot**: For studios with physical layouts (cycling, yoga), customers can select a specific numbered spot in the room when
  booking. Room layout is visual.
- **Waitlist automation**: Two modes -- "Auto-add" (moves next waitlisted person in automatically) and "First to Claim" (texts all
  waitlisted, first to respond gets the spot).
- **Capacity controls**: Online capacity can be set separately from total capacity, allowing studios to reserve spots for walk-ins.
- **Pass/membership integration**: Booking flow is aware of what the customer already owns. If they have a valid pass, booking is one-click.
  If not, they can purchase during checkout.
- **Real-time sync**: Schedule changes propagate instantly to website widget, branded app, Mindbody marketplace app, and affiliate network.

---

### 1.3 Vagaro

**Booking Flow (Individual Appointments):**

1. **Select Service** -- Browse services on the business listing page. Select "Book Now" on a service.
2. **Choose Provider** -- Select a specific employee. Can filter by employee and date using a "Change" button.
3. **Pick Time** -- Select a timeslot from available options. If nothing works, option to join waitlist.
4. **Booking Details** -- Select who the booking is for (self, family member, friend, pet). Add notes/requests. Review cancellation policy.
   Pay deposit if required.
5. **Confirm** -- Click "Book" (instant) or "Request" (requires business approval).

**Class Booking Flow:**

- Classes and workshops are scheduled separately from services.
- Customers see class schedule and can book sessions.
- Class Lead Time (buffer before class) is configured separately from Appointment Lead Time.

**Key UX Patterns:**

- **"Book for someone else"**: Explicit "Who Are You Booking For" selector -- book for family, friend, or pet. Uncommon but valuable for
  family-oriented businesses.
- **Employee-specific booking links**: Each staff member gets a unique booking URL they can share directly with clients. Pre-filters to that
  employee's services.
- **Multi-channel widget**: Three display modes -- in-page embed, popup, or new tab. Business chooses what fits their site.
- **Tab-based widget**: Widget shows configurable tabs (Services, Classes, etc.). Business picks which tabs to show and which tab opens by
  default.
- **Flexible deployment**: Widget embeds on website, Facebook, Instagram, Yelp, Apple Maps.
- **Rebooking flow**: Returning customers can rebook previous services quickly.

---

### 1.4 Booksy

**Booking Flow:**

1. **Find Business** -- Search marketplace or arrive via direct link/QR code/Google Maps/Instagram.
2. **Select Service** -- Browse categorized services with pricing visible upfront. Can select multiple services if the business allows.
3. **Select Staff** -- Choose preferred provider (stylist, technician, etc.). Staff is filtered to those qualified for the selected service
   variant.
4. **Select Date/Time** -- Calendar view showing provider's availability. Flexible date option shows "+/- 1 day" and "+/- 2 days" nearby
   availability.
5. **Add Notes** -- Optional text field for preferences or requests.
6. **Confirm & Pay** -- Review details, accept cancellation policy, pay online or choose to pay in-person.

**Key UX Patterns:**

- **"Book Again" button**: Returning clients see a one-tap rebooking option for their previous service + provider combo. Eliminates
  re-entering everything.
- **Flexible date display (+/- days)**: When a specific date has no availability, the system proactively shows nearby dates, reducing
  dead-ends and drop-off.
- **Automatic slot reopening**: When a client reschedules, the original slot is immediately reopened for others.
- **Waitlist for full schedules**: When fully booked, customers can join an automated waitlist with cancellation notifications.
- **Multi-channel discoverability**: No app download required for initial booking -- works from Google Search, Google Maps, Instagram,
  Facebook links directly in browser.
- **Notes field**: Allows customers to communicate preferences, which helps providers prepare (reduces back-and-forth).

---

### 1.5 ClassPass

**Booking Flow (Class-Only):**

1. **Browse/Search** -- Search bar at top for specific class types, OR scroll through curated list on homepage. Filter by activity type,
   time, credits.
2. **View Class Card** -- Each card shows: class name, start time, duration, credit cost, studio name.
3. **Select Class** -- Click the blue credit button on the card.
4. **Review & Confirm** -- Two-step confirmation: popup shows all details, customer clicks "Reserve" to finalize.

**Key UX Patterns:**

- **Credit-based pricing visible on every card**: Credit cost is shown as a prominent blue button on every class listing. No hidden pricing.
- **Two-step booking confirmation**: Intentional friction -- after selecting a class, a review popup appears before final confirmation.
  Reduces accidental bookings (important when credits are consumed).
- **Real-time availability**: Spots shown in real-time. Can book up to 5 minutes before class starts.
- **Waitlist with notifications**: When a class is full, customers join a waitlist. System notifies when spots open, customer can confirm
  quickly.
- **Minimal data entry**: Since users are already logged in with a membership, booking is essentially two taps (select + confirm). No forms.
- **Filter-first browsing**: Homepage is structured around discovery -- filter by activity type, time of day, credit range, location.

---

### 1.6 Momoyoga

**Booking Flow (Class-Only, Yoga/Wellness Focus):**

1. **View Schedule** -- WordPress/website widget shows next 8 weeks of classes in a clean calendar view.
2. **Select Class** -- Click "Book Now" on a class session.
3. **Redirect to Momoyoga** -- Customer is redirected to the Momoyoga-hosted page for account/payment handling.
4. **Login or Register** -- Must have account to complete booking.
5. **Use Pass/Pay** -- Book using existing class pass or membership, or purchase one.
6. **Confirmation** -- Booking appears in customer's schedule, confirmation email sent.

**Key UX Patterns:**

- **Schedule-first, not service-first**: The primary view is a weekly calendar of upcoming classes. Customer browses by date/time, not by
  class type. This is the opposite of appointment-based flows.
- **Waitlist for full classes**: When a class is full, customers can add themselves to the waitlist. Email notification when a spot opens.
- **Class pass / membership integration**: Booking flow checks what the customer owns. If they have a valid pass, booking is instant. If
  not, they are prompted to purchase.
- **Multi-language**: Customer-facing pages auto-detect language, important for studios with international clientele.
- **Real-time updates**: Schedule changes propagate to all embedded widgets immediately.
- **Minimal widget, hosted checkout**: Widget on the website is display-only (schedule). Actual booking/payment happens on the Momoyoga
  platform. Simpler to implement but creates a redirect.

---

## 2. Individual Appointments vs. Group Classes: Key UX Differences

| Aspect                  | Individual Appointments                       | Group Classes                                         |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------- |
| **Primary navigation**  | Service-first (pick what you want, then when) | Schedule-first (browse what's happening, then pick)   |
| **Date/time selection** | Customer picks from open slots on a calendar  | Customer picks from a fixed schedule of sessions      |
| **Staff/instructor**    | Customer chooses or accepts "Any Available"   | Instructor is pre-assigned to the class               |
| **Capacity**            | Usually 1:1 (slot is either free or taken)    | Multiple spots per session; show "X spots remaining"  |
| **Waitlist**            | Less common (some platforms offer it)         | Critical feature; classes fill up                     |
| **Duration**            | Variable (customer may pick service duration) | Fixed (class has a set duration)                      |
| **Booking urgency**     | Lower (many slots available)                  | Higher (limited spots, FOMO)                          |
| **Cancellation impact** | Frees one slot                                | Frees one spot, may trigger waitlist notification     |
| **Recurring**           | Customer may rebook same service              | Classes recur on a schedule, customer may "subscribe" |

### Architectural Implication for Avoqado

These are fundamentally different interaction models. The best platforms (Mindbody in particular) use **separate widgets/views** for classes
vs. appointments rather than trying to unify them into one flow. The recommended approach:

- **For individual reservations**: Service --> Staff --> Date/Time --> Info --> Confirm
- **For group classes**: Calendar/Schedule view --> Select Session --> Book/Waitlist --> Confirm

A shared entry point (e.g., a tab bar or toggle: "Book Appointment" | "View Class Schedule") is the cleanest way to handle both.

---

## 3. Showing Remaining Spots for Classes

| Platform      | How They Show It                                                                |
| ------------- | ------------------------------------------------------------------------------- |
| **Square**    | Message below the class price showing "X spots remaining"                       |
| **Mindbody**  | Capacity tracked server-side; when full, "Join Waitlist" replaces "Book" button |
| **ClassPass** | Real-time availability; when full, waitlist option shown                        |
| **Momoyoga**  | Booked count visible; waitlist option when full                                 |
| **Vagaro**    | Waitlist option when no timeslots available                                     |

**Best practice**: Show spots remaining when capacity is getting low (e.g., "3 spots left") to create urgency but avoid showing it when
plenty of spots are available (e.g., don't show "47 of 50 spots remaining" -- that's noise).

---

## 4. Logged-In vs. Guest Customers

| Platform      | Approach                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Square**    | Guest booking allowed; account auto-created after first booking. Customer gets account to manage future bookings. |
| **Mindbody**  | Account required for booking (can create during checkout). Existing pass/membership holders are recognized.       |
| **Vagaro**    | Can book as guest or with Vagaro account. Guest gets confirmation email.                                          |
| **Booksy**    | No app download required for initial booking. Can book from browser links. Account created during process.        |
| **ClassPass** | Account + membership required (paid platform).                                                                    |
| **Momoyoga**  | Account required. Must log in or register to complete booking.                                                    |

**Best practice (from industry research):**

- 24% of booking abandonment happens because account creation is required.
- Two-thirds of consumers expect to complete checkout in under 4 minutes.
- **Recommended**: Allow guest booking with minimal required fields (name, phone/email). Offer optional account creation after booking is
  confirmed. Auto-create a lightweight account tied to email/phone for returning customer recognition.

---

## 5. Calendar and Time Selection Patterns

### For Individual Appointments

- **Calendar widget**: Show a month view or week view with available dates highlighted (unavailable dates grayed out).
- **Time slot grid**: After selecting a date, show available time slots as tappable buttons/pills (not a dropdown).
- **Auto-select next available**: Pre-select the nearest available date/time to reduce scrolling.
- **Time zone awareness**: Show and allow confirmation of time zone (especially important for remote/virtual services).

### For Group Classes

- **Weekly schedule view**: Show Monday-Sunday with classes listed under each day.
- **List view alternative**: Some customers prefer a scrollable list sorted by date/time, especially on mobile.
- **Filter by class type**: Allow filtering by activity type, instructor, or time of day.
- **Session cards**: Each class shown as a card with: class name, time, duration, instructor name, spots remaining, price/credits.

### Shared Best Practices

- **10-minute slot hold** (Square pattern): Temporarily reserve the slot during checkout to prevent double-booking.
- **+/- day flexibility** (Booksy pattern): When a date has no availability, proactively show nearby dates.
- **Sticky/visible CTA**: "Book Now" button should always be visible, especially on mobile.
- **Progress indicator**: If the flow has multiple steps, show a step indicator (Step 1 of 4).

---

## 6. Particularly Good UX Patterns to Adopt

### High-Impact, Low-Effort

| Pattern                                  | Source         | Why It Matters                                                                                                          |
| ---------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Slot hold timer**                      | Square         | Prevents double-booking during checkout. Show a countdown ("Your slot is held for 9:42") to create urgency to complete. |
| **"Book Again" for returning customers** | Booksy         | One-tap rebooking of previous service+provider. Massive friction reduction for repeat customers.                        |
| **"Any Available" staff option**         | Square         | Customers who just want the earliest slot don't have to choose a specific person.                                       |
| **Flexible date display (+/- days)**     | Booksy         | Reduces dead-end frustration when a specific date is full.                                                              |
| **Two-step confirmation**                | ClassPass      | Prevents accidental bookings. Especially important when money or credits are consumed.                                  |
| **Guest checkout with auto-account**     | Square, Booksy | Don't require registration upfront. Create account silently after booking.                                              |

### High-Impact, Medium-Effort

| Pattern                                | Source              | Why It Matters                                                                                                       |
| -------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Pick-a-Spot room layout**            | Mindbody            | For classes with physical positions (cycling, yoga), visual spot selection increases engagement and premium pricing. |
| **Waitlist with auto-notification**    | Mindbody, ClassPass | Converts "fully booked" from a dead-end into a lead. Auto-notify when spots open.                                    |
| **Separate online vs. total capacity** | Mindbody            | Reserve spots for walk-ins while still offering online booking.                                                      |
| **Pass/membership-aware booking**      | Mindbody, Momoyoga  | If customer owns a valid pass, booking is one-click. No payment form needed.                                         |
| **Pre-filled returning customer data** | Timify, Vagaro      | Recognize returning customers by email/phone and auto-fill their info.                                               |

### Medium-Impact, Low-Effort

| Pattern                     | Source         | Why It Matters                                                             |
| --------------------------- | -------------- | -------------------------------------------------------------------------- |
| **Notes/requests field**    | Booksy, Vagaro | Reduces no-shows and prep time. Customers communicate preferences upfront. |
| **"Book for someone else"** | Vagaro         | Useful for family bookings, gift experiences.                              |
| **Multi-service booking**   | Square, Booksy | Let customers bundle multiple services in one booking session.             |
| **QR code booking entry**   | Square         | Physical locations can display QR codes for instant mobile booking.        |

---

## 7. Recommended Flow for Avoqado Booking Widget

Based on this research, here is the recommended architecture:

### Entry Point

```
[Tab: "Reservar Cita" (Book Appointment)]  |  [Tab: "Ver Clases" (View Classes)]
```

### Flow A: Individual Reservation

```
Step 1: Select Service(s)
  - Service cards with name, duration, price
  - Option to add multiple services
  - Service categories for organization

Step 2: Select Staff
  - "Cualquier disponible" (Any Available) as default/first option
  - Staff cards with name, photo, specialties
  - Only show staff qualified for selected service(s)

Step 3: Select Date & Time
  - Calendar (month view) with available dates highlighted
  - Time slots as tappable pills after date selection
  - Auto-select nearest available date
  - Show "+/- 1 day" alternatives if selected date is full
  - 10-minute slot hold on selection

Step 4: Customer Info
  - If returning customer detected (cookie/email): pre-fill, show "Book Again"
  - If guest: Name, Email, Phone (3 fields only)
  - Optional: Notes/requests text area
  - Optional: "Booking for someone else" toggle

Step 5: Confirm & Pay
  - Summary card: service, staff, date/time, price
  - Accept cancellation policy (checkbox)
  - Payment (if required): card, digital wallet
  - Two-step: Review screen -> "Confirmar Reserva" button
  - Instant confirmation + email/SMS
```

### Flow B: Group Class

```
Step 1: Browse Schedule
  - Weekly calendar view (default)
  - Optional: list view toggle
  - Filter by: class type, instructor, time of day
  - Each session card shows:
    - Class name & description
    - Day, time, duration
    - Instructor name + photo
    - Price / credits required
    - "X lugares disponibles" (X spots available) -- only when < 30% capacity remaining
    - "Clase llena - Unirse a lista de espera" when full

Step 2: Select Session
  - Tap session card -> expanded view with full description
  - "Reservar Lugar" (Book Spot) button
  - If full: "Unirse a Lista de Espera" (Join Waitlist)

Step 3: Customer Info
  - Same as appointment flow Step 4
  - If customer has valid pass/membership: show it, one-click booking

Step 4: Confirm
  - Same two-step confirmation
  - Show spot number if Pick-a-Spot is enabled
  - Confirmation + calendar invite
```

### Shared Components

- **Progress indicator**: Stepper at top showing current step
- **Mobile-first**: All interactions must work on touch devices
- **Slot/spot hold**: 10-minute timer visible during checkout
- **Waitlist engine**: Shared between classes and appointments (if enabled)
- **Notification system**: Email + SMS confirmation, reminders (24h, 1h before)
- **Returning customer recognition**: By email or phone, auto-fill data
- **Guest checkout**: Never require account creation to book. Create account silently.
- **Cancellation/reschedule self-service**: Post-booking, customer can manage via link in confirmation email

---

## 8. Sources

### Platform Documentation

- [Square Appointments - Set up online booking](https://squareup.com/help/us/en/article/5353-view-client-facing-online-booking-tools)
- [Square Appointments - Class booking](https://squareup.com/help/us/en/article/7991-class-booking-with-square-appointments)
- [Square Appointments - View Client-Facing Booking Tools](https://squareup.com/help/us/en/article/5353-book-appointments-with-square-merchants)
- [Mindbody - Scheduling](https://www.mindbodyonline.com/business/scheduling)
- [Mindbody - Schedule widget setup](https://support.mindbodyonline.com/s/article/Configuring-your-Schedule-Widget-branded-web-tools-formerly-HealCode?language=en_US)
- [Mindbody - Appointment widget setup](https://support.mindbodyonline.com/s/article/Configuring-your-Appointments-Widget-Branded-web-healcode?language=en_US)
- [Mindbody - Class List widget setup](https://support.mindbodyonline.com/s/article/Configuring-your-Class-List-Widget-Branded-web-healcode?language=en_US)
- [Mindbody - Waitlist improvements](https://www.mindbodyonline.com/business/education/product-waitlist-improvements)
- [Vagaro - Booking widget overview](https://www.vagaro.com/learn/book-smarter-vagaro-booking-widgets)
- [Vagaro - Book a Service (customer)](https://support.vagaro.com/hc/en-us/articles/115003521813-Book-a-Service-Appointment-for-Customers-of-a-Vagaro-Business)
- [Vagaro - Widget builder support](https://support.vagaro.com/hc/en-us/articles/204347860-Add-the-Booking-Widget-to-Your-Site)
- [Booksy - Online Booking features](https://biz.booksy.com/en-us/features/online-booking)
- [Booksy - Website booking guide](https://biz.booksy.com/en-us/blog/website-booking-system-guide-implement-optimize-for-your-salon)
- [ClassPass - How to book](https://help.classpass.com/hc/en-us/articles/204335689-How-do-I-make-a-reservation)
- [ClassPass - Booking reservations](https://help.classpass.com/hc/en-us/sections/360009481391-Booking-reservations)
- [Momoyoga - Online scheduling software](https://www.momoyoga.com/en/online-class-scheduling-software)
- [Momoyoga - WordPress plugin](https://wordpress.org/plugins/momoyoga-integration/)
- [Momoyoga - Schedule integration options](https://support.momoyoga.com/en/support/solutions/articles/201000109941-what-are-the-momoyoga-schedule-integration-options-)

### UX Best Practices

- [Booking UX Best Practices 2025 - Ralabs](https://ralabs.org/blog/booking-ux-best-practices/)
- [Time Picker UX Patterns 2025 - Eleken](https://www.eleken.co/blog-posts/time-picker-ux)
- [9 Must-Have Booking Widget Features - Timify](https://www.timify.com/en/blog/booking-widget-requirements/)
- [Booking Widget Guide 2025 - Salon Booking System](https://www.salonbookingsystem.com/salon-booking-system-blog/booking-widget/)
- [Guest Checkout Best Practices - Shopify](https://www.shopify.com/enterprise/blog/guest-checkout)
- [Baymard Institute - Time Booking Interface Examples](https://baymard.com/ecommerce-design-examples/time-booking-interface)
- [Appointment Booking Widget UX/UI - Behance](https://www.behance.net/gallery/85494481/Appointment-Booking-Widget-UXUI-Design)
