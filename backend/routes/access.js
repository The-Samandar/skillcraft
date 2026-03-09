// routes/access.js — выдача JWT токена после оплаты
const router = require('express').Router();
const { db } = require('../db/init');
const { requireAuth, generateToken } = require('../middleware/auth');
const { checkAccess } = require('../services/accessService');

// POST /api/access/token — { email } или { orderId }
router.post('/token', (req, res) => {
  const { email, orderId } = req.body;
  if (!email && !orderId) return res.status(400).json({ error: 'email или orderId обязателен' });

  let order, user;

  if (orderId) {
    order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'paid'").get(orderId);
    if (order?.user_id) user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  } else {
    user  = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) order = db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1").get(user.id);
  }

  if (!order) return res.status(403).json({ error: 'Оплаченный заказ не найден. Проверьте email.' });

  const grant = checkAccess(order.id);
  if (!grant) return res.status(403).json({ error: 'Доступ не найден. Напишите нам если вы оплатили.' });

  const token = generateToken({ userId: user?.id, email: user?.email, orderId: order.id, grantId: grant.id });
  res.json({ success: true, token, email: user?.email, orderId: order.id });
});

// GET /api/access/verify
router.get('/verify', requireAuth, (req, res) => {
  const grant = db.prepare("SELECT * FROM access_grants WHERE id = ? AND is_active = 1").get(req.user.grantId);
  if (!grant) return res.status(403).json({ error: 'Доступ отозван' });
  res.json({ valid: true, orderId: req.user.orderId, email: req.user.email });
});

module.exports = router;
