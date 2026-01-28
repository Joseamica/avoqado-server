/**
 * Test script to send ALL email templates
 * Run with: npx ts-node scripts/test-all-emails.ts
 */

import '../src/config/env'
import emailService from '../src/services/email.service'

const testEmail = 'joseamica@gmail.com'

async function sendAllTestEmails() {
  console.log(`Sending all email templates to ${testEmail}...\n`)

  // 1. Receipt Email
  console.log('1. Sending Receipt Email...')
  await emailService.sendReceiptEmail(testEmail, {
    venueName: 'Restaurante Demo',
    receiptUrl: 'https://dashboard.avoqado.io/receipt/abc123',
    receiptNumber: 'A1B2',
    orderNumber: '1234',
    venueAddress: 'Av. Reforma 123',
    venueCity: 'Ciudad de Mexico',
    venueState: 'CDMX',
    venuePhone: '55 1234 5678',
    currency: 'MXN',
    items: [
      { name: 'Tacos al Pastor', quantity: 3, price: 45, totalPrice: 135, modifiers: [{ name: 'Extra salsa', price: 10 }] },
      { name: 'Agua de Horchata', quantity: 2, price: 35, totalPrice: 70 },
      { name: 'Guacamole', quantity: 1, price: 85, totalPrice: 85 },
    ],
    subtotal: 290,
    taxAmount: 46.4,
    tipAmount: 50,
    totalAmount: 386.4,
    paymentMethod: 'CARD',
    paymentDate: new Date().toLocaleDateString('es-MX', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    processedBy: 'Carlos Martinez',
    customerName: 'Jose Amica',
  })
  console.log('   Done!')

  // 2. Team Invitation
  console.log('2. Sending Team Invitation Email...')
  await emailService.sendTeamInvitation(testEmail, {
    inviterName: 'Maria Garcia',
    organizationName: 'Avoqado Demo',
    venueName: 'Restaurante Demo',
    role: 'WAITER',
    roleDisplayName: 'Mesero',
    inviteLink: 'https://dashboard.avoqado.io/invite/xyz789',
  })
  console.log('   Done!')

  // 3. Trial Ending Email
  console.log('3. Sending Trial Ending Email...')
  await emailService.sendTrialEndingEmail(testEmail, {
    venueName: 'Restaurante Demo',
    featureName: 'Avoqado Dashboard Pro',
    trialEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
    billingPortalUrl: 'https://dashboard.avoqado.io/billing',
  })
  console.log('   Done!')

  // 4. Payment Failed Email
  console.log('4. Sending Payment Failed Email...')
  await emailService.sendPaymentFailedEmail(testEmail, {
    venueName: 'Restaurante Demo',
    featureName: 'Avoqado Dashboard Pro',
    attemptCount: 2,
    amountDue: 899,
    currency: 'MXN',
    billingPortalUrl: 'https://dashboard.avoqado.io/billing',
    last4: '4242',
  })
  console.log('   Done!')

  // 5. Subscription Suspended Email
  console.log('5. Sending Subscription Suspended Email...')
  await emailService.sendSubscriptionSuspendedEmail(testEmail, {
    venueName: 'Restaurante Demo',
    featureName: 'Avoqado Dashboard Pro',
    suspendedAt: new Date(),
    gracePeriodEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
    billingPortalUrl: 'https://dashboard.avoqado.io/billing',
  })
  console.log('   Done!')

  // 6. Subscription Canceled Email
  console.log('6. Sending Subscription Canceled Email...')
  await emailService.sendSubscriptionCanceledEmail(testEmail, {
    venueName: 'Restaurante Demo',
    featureName: 'Avoqado Dashboard Pro',
    suspendedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
    canceledAt: new Date(),
  })
  console.log('   Done!')

  // 7. Trial Expired Email
  console.log('7. Sending Trial Expired Email...')
  await emailService.sendTrialExpiredEmail(testEmail, {
    venueName: 'Restaurante Demo',
    featureName: 'Avoqado Dashboard Pro',
    expiredAt: new Date(),
  })
  console.log('   Done!')

  // 8. Email Verification
  console.log('8. Sending Email Verification...')
  await emailService.sendEmailVerification(testEmail, {
    firstName: 'Jose',
    verificationCode: '847291',
  })
  console.log('   Done!')

  // 9. Password Reset Email
  console.log('9. Sending Password Reset Email...')
  await emailService.sendPasswordResetEmail(testEmail, {
    firstName: 'Jose',
    resetLink: 'https://dashboard.avoqado.io/reset-password?token=abc123xyz',
    expiresInMinutes: 30,
  })
  console.log('   Done!')

  // 10. Terminal Purchase Email
  console.log('10. Sending Terminal Purchase Email...')
  await emailService.sendTerminalPurchaseEmail(testEmail, {
    venueName: 'Restaurante Demo',
    contactName: 'Jose Amica',
    contactEmail: testEmail,
    quantity: 2,
    productName: 'PAX A910S - Terminal de Pago',
    productPrice: 4500,
    shippingAddress: 'Av. Reforma 123, Col. Juarez',
    shippingCity: 'Ciudad de Mexico',
    shippingState: 'CDMX',
    shippingPostalCode: '06600',
    shippingCountry: 'Mexico',
    shippingSpeed: 'express',
    subtotal: 9000,
    shippingCost: 150,
    tax: 1464,
    totalAmount: 10614,
    currency: 'MXN',
    orderDate: new Date().toISOString(),
  })
  console.log('   Done!')

  // 11. Terminal Purchase Admin Notification
  console.log('11. Sending Terminal Purchase Admin Notification...')
  // This one goes to ORDER_NOTIFICATIONS_EMAIL, but we'll override for testing
  const originalEnv = process.env.ORDER_NOTIFICATIONS_EMAIL
  process.env.ORDER_NOTIFICATIONS_EMAIL = testEmail
  await emailService.sendTerminalPurchaseAdminNotification({
    venueName: 'Restaurante Demo',
    contactName: 'Jose Amica',
    contactEmail: testEmail,
    quantity: 2,
    productName: 'PAX A910S - Terminal de Pago',
    productPrice: 4500,
    shippingAddress: 'Av. Reforma 123, Col. Juarez',
    shippingCity: 'Ciudad de Mexico',
    shippingState: 'CDMX',
    shippingPostalCode: '06600',
    shippingCountry: 'Mexico',
    shippingSpeed: 'express',
    subtotal: 9000,
    shippingCost: 150,
    tax: 1464,
    totalAmount: 10614,
    currency: 'MXN',
    orderDate: new Date().toISOString(),
  })
  process.env.ORDER_NOTIFICATIONS_EMAIL = originalEnv
  console.log('   Done!')

  // 12. TPV Feedback Email
  console.log('12. Sending TPV Feedback Email...')
  // This one goes to hola@avoqado.io, we need to temporarily modify or create a version for testing
  // For now, let's just call it - it will go to hola@avoqado.io
  await emailService.sendTpvFeedbackEmail({
    feedbackType: 'bug',
    message:
      'Este es un mensaje de prueba para verificar el template de feedback.\n\nEl problema ocurre cuando intento procesar un pago con tarjeta.\n\nPasos para reproducir:\n1. Abrir la app\n2. Seleccionar pago con tarjeta\n3. El terminal no responde',
    venueSlug: 'restaurante-demo',
    appVersion: '2.5.1',
    buildVersion: '251',
    androidVersion: '11',
    deviceModel: 'A910S',
    deviceManufacturer: 'PAX',
  })
  console.log('   Done! (sent to hola@avoqado.io)')

  // 13. Sales Summary Email
  console.log('13. Sending Sales Summary Email...')
  await emailService.sendSalesSummaryEmail(
    testEmail,
    {
      venueId: 'test-venue-id',
      venueName: 'Restaurante Demo',
      venueTimezone: 'America/Mexico_City',
      venueCurrency: 'MXN',
      reportDate: new Date(),
      businessHoursStart: '8:00 AM',
      businessHoursEnd: '10:00 PM',
      dashboardUrl: 'https://dashboard.avoqado.io/restaurante-demo',
      metrics: {
        grossSales: 15420.5,
        items: 15420.5,
        serviceCosts: 0,
        discounts: 850.0,
        refunds: 0,
        netSales: 14570.5,
        deferredSales: 0,
        taxes: 2331.28,
        tips: 2185.58,
        platformFees: 364.26,
        staffCommissions: 728.53,
        commissions: 364.26,
        totalCollected: 16391.82,
        netProfit: 13477.71,
        transactionCount: 47,
      },
      previousPeriod: {
        netSales: 12500.0,
        avgOrder: 280.0,
        transactionCount: 42,
      },
      categoryBreakdown: [
        { name: 'Platos Fuertes', itemsSold: 28, netSales: 8400.0 },
        { name: 'Bebidas', itemsSold: 52, netSales: 3120.0 },
        { name: 'Entradas', itemsSold: 18, netSales: 1800.0 },
        { name: 'Postres', itemsSold: 12, netSales: 1250.5 },
      ],
      orderSources: [
        { source: 'Punto de venta', orders: 35, netSales: 10850.0, avgOrder: 310.0 },
        { source: 'Avoqado QR', orders: 12, netSales: 3720.5, avgOrder: 310.04 },
      ],
    },
    16.56,
  )
  console.log('   Done!')

  console.log('\n========================================')
  console.log('All 13 email templates sent successfully!')
  console.log('========================================')
  console.log(`\nCheck your inbox at ${testEmail}`)
  console.log('Note: TPV Feedback email was sent to hola@avoqado.io')

  process.exit(0)
}

sendAllTestEmails().catch(error => {
  console.error('Error sending emails:', error)
  process.exit(1)
})
