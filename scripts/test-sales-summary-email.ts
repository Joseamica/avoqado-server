/**
 * Test script to send a sales summary email
 * Run with: npx ts-node scripts/test-sales-summary-email.ts
 */

import '../src/config/env'
import emailService from '../src/services/email.service'

async function sendTestEmail() {
  const testEmail = 'joseamica@gmail.com'

  // Mock data similar to what the job would generate
  const mockData = {
    venueId: 'test-venue-id',
    venueName: 'Test Restaurante',
    venueTimezone: 'America/Mexico_City',
    venueCurrency: 'MXN',
    reportDate: new Date(),
    businessHoursStart: '8:00 AM',
    businessHoursEnd: '10:00 PM',
    dashboardUrl: 'https://dashboard.avoqado.io/test-restaurante',
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
  }

  // Weekly change: 16.56% increase
  const weeklyChange = 16.56

  console.log(`Sending test sales summary email to ${testEmail}...`)

  try {
    const result = await emailService.sendSalesSummaryEmail(testEmail, mockData, weeklyChange)

    if (result) {
      console.log('Email sent successfully!')
    } else {
      console.log('Email service returned false - check if SMTP is configured')
    }
  } catch (error) {
    console.error('Failed to send email:', error)
  }

  process.exit(0)
}

sendTestEmail()
