const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');

function grantCourseAccess(orderId, userId) {
  const existing = db.prepare(
    "SELECT id FROM access_grants WHERE order_id = ? AND is_active = 1"
  ).get(orderId);
  if (existing) return existing;

  const id = uuidv4();
  db.prepare(
    "INSERT INTO access_grants (id,order_id,user_id,access_type,is_active) VALUES (?,?,?,'full_course',1)"
  ).run(id, orderId, userId || null);

  console.log(`🎓 Access granted: order=${orderId}`);
  return { id };
}

function checkAccess(phoneOrOrderId) {

  let grant = db.prepare(`
    SELECT ag.* FROM access_grants ag
    JOIN orders o ON o.id = ag.order_id
    WHERE ag.order_id = ? AND ag.is_active = 1 AND o.status = 'paid'
  `).get(phoneOrOrderId);
  if (grant) return grant;

  // По номеру телефона
  grant = db.prepare(`
    SELECT ag.* FROM access_grants ag
    JOIN orders o ON o.id = ag.order_id
    JOIN users u ON u.id = o.user_id
    WHERE u.phone = ? AND ag.is_active = 1 AND o.status = 'paid'
    ORDER BY ag.granted_at DESC LIMIT 1
  `).get(phoneOrOrderId);

  return grant || null;
}

module.exports = { grantCourseAccess, checkAccess };