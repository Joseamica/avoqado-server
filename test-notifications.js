const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createTestNotifications() {
  try {
    console.log('🔔 Creating test notifications...\n');

    // Get a real staff member from the database
    const staff = await prisma.staff.findFirst({
      include: {
        venues: {
          include: {
            venue: true
          }
        }
      }
    });

    if (!staff || staff.venues.length === 0) {
      console.log('❌ No staff or venues found in database');
      return;
    }

    const venue = staff.venues[0].venue;
    console.log(`👤 Using staff: ${staff.firstName} ${staff.lastName}`);
    console.log(`🏢 Using venue: ${venue.name}\n`);

    // Create different types of notifications
    const notifications = [
      {
        recipientId: staff.id,
        venueId: venue.id,
        type: 'NEW_ORDER',
        title: '🆕 New Order Alert!',
        message: `New order #ORD-${Date.now()} received from Table 5. Customer ordered Pasta Alfredo and Caesar Salad.`,
        actionUrl: `/orders/ORD-${Date.now()}`,
        actionLabel: 'View Order',
        entityType: 'order',
        entityId: `order-${Date.now()}`,
        metadata: {
          orderNumber: `ORD-${Date.now()}`,
          tableNumber: 'Table 5',
          items: ['Pasta Alfredo', 'Caesar Salad']
        },
        priority: 'HIGH',
        channels: ['IN_APP'],
        isRead: false
      },
      {
        recipientId: staff.id,
        venueId: venue.id,
        type: 'PAYMENT_RECEIVED',
        title: '💰 Payment Confirmed',
        message: `Payment of $45.99 received for order #ORD-${Date.now() - 1000}. Payment method: Credit Card.`,
        actionUrl: `/payments/payment-${Date.now()}`,
        actionLabel: 'View Payment',
        entityType: 'payment',
        entityId: `payment-${Date.now()}`,
        metadata: {
          amount: '45.99',
          orderNumber: `ORD-${Date.now() - 1000}`,
          method: 'Credit Card'
        },
        priority: 'NORMAL',
        channels: ['IN_APP'],
        isRead: false
      },
      {
        recipientId: staff.id,
        venueId: venue.id,
        type: 'LOW_INVENTORY',
        title: '⚠️ Low Stock Alert',
        message: 'Chicken Breast is running low (only 3 portions remaining). Consider restocking soon.',
        actionUrl: '/inventory',
        actionLabel: 'Manage Inventory',
        entityType: 'inventory',
        entityId: `inventory-${Date.now()}`,
        metadata: {
          productName: 'Chicken Breast',
          currentStock: 3,
          minStock: 10
        },
        priority: 'HIGH',
        channels: ['IN_APP'],
        isRead: false
      },
      {
        recipientId: staff.id,
        venueId: venue.id,
        type: 'ANNOUNCEMENT',
        title: '📢 Team Announcement',
        message: 'Kitchen deep cleaning scheduled for tonight at 11 PM. All staff please coordinate accordingly.',
        actionUrl: '/announcements',
        actionLabel: 'Read More',
        entityType: 'announcement',
        entityId: `announcement-${Date.now()}`,
        metadata: {
          announcementText: 'Kitchen deep cleaning scheduled for tonight at 11 PM.',
          urgency: 'medium'
        },
        priority: 'NORMAL',
        channels: ['IN_APP'],
        isRead: false
      }
    ];

    // Create notifications one by one
    for (let i = 0; i < notifications.length; i++) {
      const notification = await prisma.notification.create({
        data: notifications[i]
      });
      
      console.log(`✅ Created notification ${i + 1}: ${notification.title}`);
      
      // Add a small delay between notifications
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n🎉 Successfully created ${notifications.length} test notifications!`);
    console.log('\n📱 You can now:');
    console.log('1. Check the API endpoint: GET /api/v1/dashboard/notifications');
    console.log('2. Open the frontend dashboard to see the notification bell');
    console.log('3. Test real-time updates via Socket.IO');

  } catch (error) {
    console.error('❌ Error creating notifications:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

createTestNotifications();