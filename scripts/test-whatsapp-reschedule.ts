#!/usr/bin/env tsx

/**
 * One-off smoke test for the WhatsApp reservation_reschedule template (v2, 5 params).
 * Sends a real WhatsApp using whatever phone you pass via TEST_PHONE env (defaults to
 * the number passed by the user during initial wiring).
 *
 * Usage:
 *   tsx scripts/test-whatsapp-reschedule.ts
 *   TEST_PHONE=5512956265 TEST_NAME="Jose" tsx scripts/test-whatsapp-reschedule.ts
 *
 * Cleanup: delete this file after verifying delivery.
 */

import 'dotenv/config'
import { sendReservationRescheduleWhatsApp } from '../src/services/whatsapp.service'

const phone = process.env.TEST_PHONE || '5512956265'
const customerName = process.env.TEST_NAME || 'Jose Antonio'
const venueName = process.env.TEST_VENUE || 'Avoqado'
const date = process.env.TEST_DATE || '1 de mayo'
const time = process.env.TEST_TIME || '15:00'
const message = process.env.TEST_MESSAGE || 'Disculpa el cambio, gracias por tu paciencia.'

async function main() {
  console.log('📲 Sending WhatsApp reservation_reschedule v2...')
  console.log(`   to:       ${phone}`)
  console.log(`   {{1}}:    ${customerName}`)
  console.log(`   {{2}}:    ${venueName}`)
  console.log(`   {{3}}:    ${date}`)
  console.log(`   {{4}}:    ${time}`)
  console.log(`   {{5}}:    ${message}`)
  console.log('')

  try {
    await sendReservationRescheduleWhatsApp(phone, {
      customerName,
      venueName,
      date,
      time,
      message,
    })
    console.log('✅ Sent successfully')
    process.exit(0)
  } catch (err) {
    console.error('❌ Failed:', (err as Error).message)
    if ((err as any).stack) console.error((err as Error).stack)
    process.exit(1)
  }
}

main()
