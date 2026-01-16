/**
 * Generate QR Code for Master TOTP Setup
 *
 * Run this script to get the QR code that needs to be scanned
 * in Google Authenticator for emergency SUPERADMIN access.
 *
 * Usage: npx ts-node scripts/generate-totp-qr.ts
 */

import * as dotenv from 'dotenv'
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib'
import * as QRCode from 'qrcode'

// Load environment variables
dotenv.config()

async function main() {
  const secret = process.env.TOTP_MASTER_SECRET

  if (!secret) {
    console.error('❌ TOTP_MASTER_SECRET not found in .env file')
    console.error('   Add this line to your .env file:')
    console.error('   TOTP_MASTER_SECRET=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')
    process.exit(1)
  }

  // Create TOTP instance with same config as the service
  const totp = new TOTP({
    digits: 8,
    period: 60, // 60 seconds per code
    secret,
    issuer: 'Avoqado TPV',
    label: 'MasterAdmin',
    crypto: new NobleCryptoPlugin(),
    base32: new ScureBase32Plugin(),
  })

  // Generate otpauth:// URI
  const uri = totp.toURI({
    label: 'MasterAdmin',
    issuer: 'Avoqado TPV',
    secret,
  })

  console.log('\n🔐 AVOQADO MASTER TOTP SETUP')
  console.log('='.repeat(50))
  console.log('\n📱 Scan this QR code with Google Authenticator:\n')

  // Generate QR code in terminal
  try {
    const qrCode = await QRCode.toString(uri, { type: 'terminal', small: true })
    console.log(qrCode)
  } catch (error) {
    console.error('❌ Could not generate QR code:', error)
    console.log('\n📋 Manual setup URI (copy to authenticator app):')
    console.log(uri)
  }

  console.log('\n📋 Configuration Details:')
  console.log('-'.repeat(50))
  console.log(`Secret (Base32): ${secret}`)
  console.log(`Digits: 8`)
  console.log(`Period: 60 seconds`)
  console.log(`Algorithm: SHA1`)

  console.log('\n⚠️  SECURITY WARNING:')
  console.log('-'.repeat(50))
  console.log('• Keep this secret PRIVATE - it grants SUPERADMIN access')
  console.log('• Only share with trusted team members')
  console.log('• All master logins are logged for audit purposes')
  console.log('• Consider rotating the secret periodically')

  // Generate a test code to verify setup
  const testCode = await totp.generate()
  console.log('\n✅ Test Code (valid for next 60 seconds):')
  console.log(`   ${testCode}`)
  console.log('\n')
}

main().catch(console.error)
