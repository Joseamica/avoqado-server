const axios = require('axios');

const API_BASE = 'http://localhost:12344';

async function generateToken() {
  const response = await axios.post(`${API_BASE}/api/dev/generate-token`, {
    role: "ADMIN",
    sub: "cmeehg3rz000m9khw06g2r0qb",
    orgId: "test-org-id",
    venueId: "test-venue-id"
  });
  return response.data.token;
}

async function testNotificationBell() {
  try {
    console.log('🔔 Testing Notification Bell Component Behavior\n');
    
    const token = await generateToken();
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Get unread count (what the bell badge shows)
    console.log('1️⃣ Getting unread count for bell badge...');
    const unreadResponse = await axios.get(`${API_BASE}/api/v1/dashboard/notifications/unread-count`, { headers });
    const unreadCount = unreadResponse.data.data.count;
    console.log(`   📬 Bell badge should show: ${unreadCount} notifications\n`);

    // 2. Get recent notifications (what shows in dropdown)
    console.log('2️⃣ Getting recent notifications for dropdown...');
    const notificationsResponse = await axios.get(`${API_BASE}/api/v1/dashboard/notifications?limit=5`, { headers });
    const notifications = notificationsResponse.data.data.notifications;
    
    console.log(`   📋 Dropdown should show ${notifications.length} notifications:`);
    notifications.forEach((notif, index) => {
      const status = notif.isRead ? '✅' : '🔴';
      const priority = notif.priority === 'HIGH' ? '⚡' : notif.priority === 'LOW' ? '🔽' : '📝';
      console.log(`   ${index + 1}. ${status} ${priority} ${notif.title}`);
      console.log(`      💬 ${notif.message.substring(0, 60)}...`);
      console.log(`      🏷️  ${notif.type} | ⏰ ${new Date(notif.createdAt).toLocaleTimeString()}`);
      console.log('');
    });

    // 3. Test marking a notification as read
    if (notifications.length > 0) {
      const firstUnread = notifications.find(n => !n.isRead);
      if (firstUnread) {
        console.log('3️⃣ Testing mark as read functionality...');
        console.log(`   📖 Marking notification as read: "${firstUnread.title}"`);
        
        try {
          await axios.patch(`${API_BASE}/api/v1/dashboard/notifications/${firstUnread.id}/read`, {}, { headers });
          console.log('   ✅ Successfully marked as read');
          
          // Check new unread count
          const newUnreadResponse = await axios.get(`${API_BASE}/api/v1/dashboard/notifications/unread-count`, { headers });
          const newUnreadCount = newUnreadResponse.data.data.count;
          console.log(`   📬 New bell badge count: ${newUnreadCount} (reduced by 1)\n`);
        } catch (error) {
          console.log(`   ❌ Error marking as read: ${error.response?.data?.message || error.message}\n`);
        }
      }
    }

    // 4. Show available actions
    console.log('4️⃣ Available notification actions:');
    console.log('   🔔 GET /notifications/unread-count - Get badge count');
    console.log('   📋 GET /notifications - Get notification list');
    console.log('   📖 PATCH /notifications/:id/read - Mark as read');
    console.log('   ✅ PATCH /notifications/mark-all-read - Mark all as read');
    console.log('   🗑️  DELETE /notifications/:id - Delete notification');
    console.log('   ⚙️  GET /notifications/preferences - Get user preferences');

  } catch (error) {
    console.error('❌ Error testing notification bell:', error.response?.data || error.message);
  }
}

testNotificationBell();