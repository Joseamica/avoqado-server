/**
 * Blumon CLI Help
 *
 * Shows all available Blumon development commands
 * Similar to `stripe help`
 */

console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║                                                                          ║
║   🥑 Avoqado Blumon CLI - Development Commands                          ║
║                                                                          ║
║   Stripe-style commands for Blumon SDK development                      ║
║                                                                          ║
╚══════════════════════════════════════════════════════════════════════════╝

📚 AUTHENTICATION & SETUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  npm run blumon:auth
    Authenticate Blumon master credentials (OAuth 2.0)
    Similar to: stripe login

    Example:
      $ npm run blumon:auth
      ✓ Master merchant authenticated successfully
      ✓ Access token expires in: 23h 59m


🛒 CHECKOUT SESSIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  npm run blumon:session
    Create a test checkout session
    Similar to: stripe checkout sessions create

    Example:
      $ npm run blumon:session
      ✓ Session created: cs_test_abc123xyz
      → Checkout URL: https://sandbox-ecommerce.blumonpay.com/checkout/...

  npm run blumon:sessions
    List all active checkout sessions
    Similar to: stripe checkout sessions list

    Example:
      $ npm run blumon:sessions
      Found 3 active sessions:
        • cs_test_pending_001 - $299.00 MXN (PENDING)
        • cs_test_processing_002 - $450.00 MXN (PROCESSING)


🔔 WEBHOOKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  npm run blumon:webhook
    Simulate a webhook event
    Similar to: stripe trigger payment_intent.succeeded

    Example:
      $ npm run blumon:webhook
      ✓ Simulated webhook: payment.completed
      → Session cs_test_abc123 marked as COMPLETED


🏪 MERCHANT MANAGEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  npm run blumon:merchant
    Check Blumon merchant status and credentials
    Similar to: stripe account

    Example:
      $ npm run blumon:merchant
      ✓ Merchant: Tienda Web (Blumon)
      ✓ OAuth Status: Active
      ✓ Access Token: Valid (expires in 23h)


🧪 TESTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  npm run blumon:mock
    Test with mock Blumon service (no API calls)

    Example:
      $ npm run blumon:mock
      ✓ Using MOCK service (no real API calls)
      ✓ Card tokenized (simulated)

  npm run blumon:flow
    Test complete checkout flow end-to-end

    Example:
      $ npm run blumon:flow
      ✓ Session created
      ✓ Card tokenized
      ✓ Payment charged
      ✓ Webhook received

  npm run sdk:errors
    Test error parser with all error types

    Example:
      $ npm run sdk:errors
      ✓ Testing 8 error types
      ✓ All error messages translated correctly


🛠️ DEVELOPMENT UTILITIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  npm run dev:dashboard
    Open session dashboard in browser

    URL: http://localhost:3000/sdk/sessions/dashboard

  npm run dev:clean-sessions
    Delete old checkout sessions

    Example:
      $ npm run dev:clean-sessions -- --days=7
      ✓ Deleted 25 sessions older than 7 days

    Options:
      --days=N      Delete sessions older than N days (default: 7)
      --dry-run     Show what would be deleted without deleting

  npm run dev:logs
    Tail development logs in real-time
    Similar to: stripe logs tail

    Example:
      $ npm run dev:logs
      [12:34:56] INFO: Session created cs_test_abc123


📖 FULL SDK TESTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  npm run sdk:test
    Test all SDK endpoints (create session, tokenize, charge)

    Example:
      $ npm run sdk:test
      ✓ POST /sdk/checkout/sessions - Session created
      ✓ POST /sdk/tokenize - Card tokenized
      ✓ POST /sdk/checkout/charge - Payment charged


💡 TIPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. Always run 'npm run blumon:auth' first to set up OAuth credentials

  2. Use 'npm run blumon:mock' during development to avoid API limits

  3. Check 'npm run dev:dashboard' to see all sessions visually

  4. Run 'npm run dev:clean-sessions' weekly to keep DB clean

  5. Use test cards from docs/BLUMON_MOCK_TEST_CARDS.md


📚 DOCUMENTATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  docs/BLUMON_SDK_INTEGRATION_STATUS.md  - SDK implementation status
  docs/SDK_INTEGRATION_GUIDE.md          - Complete integration guide
  docs/SDK_SAQ_A_COMPLIANCE.md           - PCI compliance guidelines
  docs/BLUMON_MOCK_TEST_CARDS.md         - Test card numbers


🔗 QUICK START
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # 1. Start the server
  npm run dev

  # 2. Authenticate (in another terminal)
  npm run blumon:auth

  # 3. Create a test session
  npm run blumon:session

  # 4. Open the dashboard
  npm run dev:dashboard

  # 5. Simulate a successful payment
  npm run blumon:webhook


Need more help? Check the documentation or run specific commands with --help

`)

process.exit(0)
