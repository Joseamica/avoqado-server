const { createNotification } = require('./dist/src/services/dashboard/notification.dashboard.service.js');

async function sendNotificationToCurrentUser() {
  try {
    console.log('🚀 Sending notification via notification service (with Socket.IO)...\n');
    
    // Current logged-in user (SUPERADMIN role - matching Socket.IO connection)
    const currentUserId = 'cmeehg3pr000k9khwcipv746k';
    const venueId = 'cmeehg40f000y9khwolt35m8u';
    
    console.log(`📤 Creating notification for user: ${currentUserId}`);
    console.log(`🏢 Venue: ${venueId}`);
    
    // Use the notification service (this will trigger Socket.IO broadcasting)
    const notification = await createNotification({
      recipientId: currentUserId,
      venueId: venueId,
      type: 'NEW_ORDER',
      title: '🔥 NEW: Urgent Kitchen Alert!',
      message: `BREAKING: VIP customer just ordered our premium tasting menu! 3x Wagyu Steaks, 2x Lobster Thermidor, Premium Wine Pairing. Total: $485.00. Please prioritize this order!`,
      actionUrl: `/orders/ORD-VIP-${Date.now()}`,
      actionLabel: 'Prioritize Order',
      entityType: 'order',
      entityId: `vip-order-${Date.now()}`,
      metadata: {
        orderNumber: `ORD-VIP-${Date.now()}`,
        tableNumber: 'Table 1 (VIP Section)',
        items: ['3x Wagyu Steaks', '2x Lobster Thermidor', 'Premium Wine Pairing'],
        totalAmount: 485.00,
        customerType: 'VIP',
        urgency: 'CRITICAL'
      },
      priority: 'HIGH',
      channels: ['IN_APP']
    });
    
    console.log('✅ Notification created successfully!');
    console.log(`📋 ID: ${notification.id}`);
    console.log(`📝 Title: ${notification.title}`);
    console.log(`⚡ Priority: ${notification.priority}`);
    console.log(`📧 User ID: ${currentUserId}`);
    console.log(`📡 Socket.IO broadcast should have been sent!`);
    
    // Display instructions
    console.log('\n🎉 SUCCESS! Real-time notification sent via notification service!');
    console.log('\n📱 What you should see in your browser:');
    console.log('1. 🔔 Bell badge should update immediately (+1)');
    console.log('2. 🔥 "NEW: Urgent Kitchen Alert!" should appear in real-time');
    console.log('3. ⚡ HIGH priority styling (red/urgent colors)');
    console.log('4. 🌐 Browser notification popup (if enabled)');
    console.log('5. 📡 Real-time Socket.IO update (no refresh needed)');
    
  } catch (error) {
    console.error('❌ Error sending notification:', error.message);
    console.error('Stack:', error.stack);
  }
}

sendNotificationToCurrentUser();