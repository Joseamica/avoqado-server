# Blumon E-commerce Integration Documentation

> **Web checkout for online payments**

This directory contains all documentation for integrating **Blumon E-commerce Hosted Checkout** for web-based payments.

---

## ⚠️ Are You in the Right Place?

**This directory is for E-commerce Web Checkout ONLY**

✅ **You're in the right place if:**

- You need **online payments** (web/mobile browser)
- Customer **enters card details** on a web page
- You're integrating with a **web store** or **e-commerce site**
- Payment flow uses **webhooks** (asynchronous)
- You work with `EcommerceMerchant` and `CheckoutSession` models

❌ **You're in the WRONG place if:**

- You need **in-person payments** at a restaurant
- You have a **PAX Android terminal**
- Payment happens via **card reader** (tap/swipe/chip)
- → **Go to `../blumon-tpv/` instead!**

---

## 📚 Documentation Files

### 🚀 Start Here

1. **[SDK_INTEGRATION_GUIDE.md](SDK_INTEGRATION_GUIDE.md)** - Quick 5-minute integration guide
   - HTML/JavaScript SDK setup
   - Backend API integration
   - Complete working examples

### 📖 Implementation Details

2. **[BLUMON_ECOMMERCE_IMPLEMENTATION.md](BLUMON_ECOMMERCE_IMPLEMENTATION.md)** - Complete implementation guide

   - OAuth 2.0 authentication
   - Checkout session management
   - Webhook handling
   - Token lifecycle

3. **[BLUMON_SDK_INTEGRATION_STATUS.md](BLUMON_SDK_INTEGRATION_STATUS.md)** - Current implementation status
   - What's completed
   - What's pending
   - Known issues
   - Testing procedures

### 🔒 Security & Compliance

4. **[SDK_SAQ_A_COMPLIANCE.md](SDK_SAQ_A_COMPLIANCE.md)** - PCI DSS SAQ-A compliance guide
   - Card data handling
   - Security requirements
   - Compliance checklist

### 🧪 Testing & Development

5. **[BLUMON_MOCK_TEST_CARDS.md](BLUMON_MOCK_TEST_CARDS.md)** - Test card numbers

   - Mock service test cards
   - Success scenarios
   - Error scenarios
   - Development testing

6. **[WEBHOOK_SIMULATOR_GUIDE.md](WEBHOOK_SIMULATOR_GUIDE.md)** - Webhook testing
   - Manual webhook simulation
   - Development dashboard
   - Event testing

---

## 🗺️ Related Documentation

- **Master Distinction Guide**: `../BLUMON_TWO_INTEGRATIONS.md` - Complete comparison
- **Android SDK Documentation**: `../blumon-tpv/` - In-person payments
- **Merchant Models Explained**: `../MERCHANT_MODELS_ARCHITECTURE.md` - Why two models exist

---

## 🎯 Quick Links

### API Endpoints

- Create Checkout: `POST /api/v1/sdk/checkout/create`
- Webhook Receiver: `POST /api/v1/sdk/webhooks/blumon`
- Session Dashboard: `http://localhost:3000/sdk/sessions/dashboard`

### Service Files

- Real Service: `src/services/sdk/blumon-ecommerce.service.ts`
- Mock Service: `src/services/sdk/blumon-ecommerce.service.mock.ts`
- Interface: `src/services/sdk/blumon-ecommerce.interface.ts`

### Database Models

- `EcommerceMerchant` - Merchant configuration & OAuth credentials
- `CheckoutSession` - Individual checkout sessions
- `Payment` - Completed payments

---

## 🚀 Getting Started

1. Read **[SDK_INTEGRATION_GUIDE.md](SDK_INTEGRATION_GUIDE.md)** first
2. Set up OAuth credentials following **[BLUMON_ECOMMERCE_IMPLEMENTATION.md](BLUMON_ECOMMERCE_IMPLEMENTATION.md)**
3. Enable mock mode for development: `USE_BLUMON_MOCK=true`
4. Test with cards from **[BLUMON_MOCK_TEST_CARDS.md](BLUMON_MOCK_TEST_CARDS.md)**
5. Use **[WEBHOOK_SIMULATOR_GUIDE.md](WEBHOOK_SIMULATOR_GUIDE.md)** for webhook testing

---

**Last Updated**: 2025-01-17 **Maintainer**: Avoqado Team **Support**: See main SETUP.md for troubleshooting
