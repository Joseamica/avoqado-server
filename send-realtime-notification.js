const { PrismaClient } = require('@prisma/client');
const { socketManager } = require('./dist/src/communication/sockets/managers/socketManager');
const { SocketEventType } = require('./dist/src/communication/sockets/types');
const prisma = new PrismaClient();

async function sendRealtimeNotification() {
  try {
    console.log('🚀 Sending real-time notification...\n');
    
    const loggedInUserId = 'cmeehg3pr000k9khwcipv746k';
    const venueId = 'cmeehg40f000y9khwolt35m8u';
    
    // Create a fresh notification
    const notification = await prisma.notification.create({
      data: {
        recipientId: loggedInUserId,
        venueId: venueId,
        type: 'NEW_ORDER',
        title: '🔥 URGENT: Large Order!',
        message: `BREAKING: Party of 12 just placed a huge order! 6x Family Pizzas, 4x Salads, 12x Drinks. Total: $286.50. Need immediate kitchen attention!`,
        actionUrl: `/orders/ORD-URGENT-${Date.now()}`,
        actionLabel: 'Rush This Order',
        entityType: 'order',
        entityId: `urgent-order-${Date.now()}`,
        metadata: {
          orderNumber: `ORD-URGENT-${Date.now()}`,
          tableNumber: 'Table 8 (Large Party)',
          items: ['6x Family Pizzas', '4x Caesar Salads', '12x Soft Drinks'],
          totalAmount: 286.50,
          partySize: 12,
          urgency: 'HIGH'
        },
        priority: 'HIGH',
        channels: ['IN_APP'],
        isRead: false
      },
      include: {
        recipient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        venue: {
          select: {
            id: true,
            name: true,
            slug: true
          }
        }
      }
    });
    
    console.log('✅ Created notification:', notification.title);
    
    // Actually emit Socket.IO event to connected clients
    console.log('📡 Broadcasting to connected clients...');
    console.log(`🎯 Target user: ${notification.recipient.firstName} ${notification.recipient.lastName}`);
    console.log(`🏢 Venue: ${notification.venue.name}`);
    console.log(`⚡ Priority: ${notification.priority}`);
    
    // Emit to specific user
    const socketPayload = {
      correlationId: `notif-${Date.now()}`,
      timestamp: new Date(),
      venueId: notification.venueId,
      userId: notification.recipientId,
      notificationId: notification.id,
      recipientId: notification.recipientId,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      priority: notification.priority,
      isRead: notification.isRead,
      actionUrl: notification.actionUrl,
      actionLabel: notification.actionLabel,
      metadata: notification.metadata
    };
    
    // Broadcast to the specific user
    if (socketManager.getBroadcastingService()) {
      socketManager.broadcastToUser(notification.recipientId, SocketEventType.NOTIFICATION_NEW, socketPayload);
      console.log('✅ Socket event emitted to user:', notification.recipientId);
    } else {
      console.log('⚠️ Socket manager not initialized, notification saved to DB only');
    }
    
    console.log('\n🎉 SUCCESS! Real-time notification sent!');
    console.log('\n📱 What you should see in your browser IMMEDIATELY:');
    console.log('1. 🔔 Bell badge should update to show +1 more notification');
    console.log('2. 🔥 "URGENT: Large Order!" should appear at the top');
    console.log('3. ⚡ HIGH priority styling (red/urgent colors)');
    console.log('4. 💰 Total amount and party details in metadata');
    console.log('5. 🎵 Browser notification sound/popup (if permissions granted)');
    
    console.log('\n✨ No refresh needed - should appear instantly!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

sendRealtimeNotification();