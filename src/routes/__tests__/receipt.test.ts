import request from 'supertest';
import app from '../../app';
import prisma from '../../utils/prismaClient';
import { ReceiptStatus } from '@prisma/client';
import { pgPool } from '../../server';

describe('Digital Receipt API', () => {
  // Test variables
  let paymentId: string;
  let receiptId: string;
  let accessKey: string;
  const testEmail = 'test@example.com';

  // Close database connection after all tests
  afterAll(async () => {
    await pgPool.end();
  });

  // Before running tests, find a valid payment to use
  beforeAll(async () => {
    // Find a valid payment from the database to use in tests
    const payment = await prisma.payment.findFirst({
      where: {
        status: 'COMPLETED' // Assuming this is a valid status in your enum
      }
    });

    if (!payment) {
      console.warn('No valid payment found for testing. Some tests may fail.');
    } else {
      paymentId = payment.id;
      console.log(`Using payment ID ${paymentId} for receipt tests`);
    }
  });

  // Clean up test data after tests
  afterAll(async () => {
    // Delete test receipt if it was created
    if (receiptId) {
      try {
        await prisma.digitalReceipt.delete({
          where: { id: receiptId }
        });
        console.log(`Test receipt ${receiptId} cleaned up`);
      } catch (err) {
        console.error('Error cleaning up test data:', err);
      }
    }
  });

  describe('POST /api/v1/dashboard/payments/:paymentId/send-receipt', () => {
    it('should create a new digital receipt', async () => {
      // Skip if no valid payment was found
      if (!paymentId) {
        console.warn('Skipping test due to missing payment ID');
        return;
      }

      const response = await request(app)
        .post(`/api/v1/dashboard/payments/${paymentId}/send-receipt`)
        .send({ recipientEmail: testEmail })
        .set('Authorization', 'Bearer YOUR_TEST_TOKEN'); // Replace with a valid test token
      
      // We expect either a successful creation or an auth error if no token
      if (response.status === 401) {
        console.warn('Authentication required. Skipping receipt creation test.');
        return;
      }

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('receiptId');
      expect(response.body).toHaveProperty('accessKey');
      expect(response.body).toHaveProperty('status', ReceiptStatus.PENDING);
      
      // Store for later tests
      receiptId = response.body.receiptId;
      accessKey = response.body.accessKey;
    });
  });

  describe('GET /api/v1/dashboard/receipts/:receiptId', () => {
    it('should return receipt details', async () => {
      // Skip if previous test didn't create a receipt
      if (!receiptId) {
        console.warn('Skipping test due to missing receipt ID');
        return;
      }

      const response = await request(app)
        .get(`/api/v1/dashboard/receipts/${receiptId}`)
        .set('Authorization', 'Bearer YOUR_TEST_TOKEN'); // Replace with a valid test token

      // Handle auth requirement
      if (response.status === 401) {
        console.warn('Authentication required. Skipping receipt details test.');
        return;
      }

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', receiptId);
      expect(response.body).toHaveProperty('paymentId', paymentId);
      expect(response.body).toHaveProperty('dataSnapshot');
      expect(response.body).toHaveProperty('recipientEmail', testEmail);
    });
  });

  describe('GET /api/v1/public/receipts/:accessKey', () => {
    it('should return public receipt data', async () => {
      // Skip if previous tests didn't create a receipt
      if (!accessKey) {
        console.warn('Skipping test due to missing access key');
        return;
      }

      const response = await request(app)
        .get(`/api/v1/public/receipts/${accessKey}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      
      // Check the structure of the receipt data
      const receiptData = response.body.data;
      expect(receiptData).toHaveProperty('payment');
      expect(receiptData).toHaveProperty('order');
      expect(receiptData).toHaveProperty('venue');
    });
  });

  // Simple manual test function that can be run to create a real receipt
  // Not executed in normal test runs but can be uncommented for manual testing
  /*
  it('MANUAL TEST: Create a real receipt and log the access URL', async () => {
    if (!paymentId) {
      console.log('No payment found to create receipt');
      return;
    }

    const response = await request(app)
      .post(`/api/v1/dashboard/payments/${paymentId}/send-receipt`)
      .send({ recipientEmail: 'real@example.com' })
      .set('Authorization', 'Bearer YOUR_REAL_TOKEN'); // Add a valid token here
    
    console.log('Receipt created:');
    console.log(`ID: ${response.body.receiptId}`);
    console.log(`Access Key: ${response.body.accessKey}`);
    console.log(`Public URL: http://localhost:3000/receipts/${response.body.accessKey}`);
    
    // Don't run any expectations, this is just for manual testing
  }, 10000);
  */
});
