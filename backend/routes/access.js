const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { requireAuth, generateToken } = require('../middleware/auth');
const { checkAccess } = require('../services/accessService');

// Нормализация: +998 90 123 45 67 → +998901234567
function normalizePhone(raw) {
  if (!raw) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 9)  return '+998' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '+998' + digits.slice(1);
  if (digits.length === 12 && digits.startsWith('998')) return '+' + digits;
  if (digits.length === 11 && digits.startsWith('998')) return '+998' + digits.slice(3);
  return '+998' + digits.slice(-9);
}

router.post('/token', (req, res) => {
  const { phone, orderId, device_token: clientToken } = req.body;
  if (!phone && !orderId) return res.status(400).json({ error: 'Номер телефона или orderId обязателен' });

  let order, user;

  if (orderId) {
    // Вход сразу после оплаты
    order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'paid'").get(orderId);
    if (order?.user_id) user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  } else {
    // Повторный вход по номеру телефона
    // Нормализуем номер — убираем пробелы, дефисы, скобки
    const normalized = normalizePhone(phone);
    user = db.prepare('SELECT * FROM users WHERE phone = ?').get(normalized)
        || db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (user) {
      order = db.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1").get(user.id);
    }
  }

  if (!order) return res.status(403).json({ error: 'Оплаченный заказ не найден. Проверьте номер телефона.' });

  const grant = checkAccess(order.id);
  if (!grant) return res.status(403).json({ error: 'Доступ не найден. Напишите нам, если вы оплатили.' });

  // ─── ЗАЩИТА ОТ ШАРИНГА ───────────────────────────────────
  if (user) {
    if (!user.device_token) {
      // Первый вход — привязываем устройство
      const newToken = clientToken || uuidv4();
      db.prepare("UPDATE users SET device_token = ? WHERE id = ?").run(newToken, user.id);
      user.device_token = newToken;
      console.log(`🔒 Устройство привязано: ${user.phone}`);
    } else if (!orderId) {
      // Повторный вход по номеру — проверяем устройство
      if (!clientToken || clientToken !== user.device_token) {
        console.log(`🚫 Чужое устройство пытается войти: ${phone}`);
        return res.status(403).json({
          error: 'Этот номер уже используется на другом устройстве. Обратитесь в поддержку.',
          code: 'DEVICE_MISMATCH'
        });
      }
    }
  }

  const token = generateToken({
    userId:  user?.id,
    phone:   user?.phone,
    orderId: order.id,
    grantId: grant.id,
  });

  res.json({
    success:      true,
    token,
    phone:        user?.phone,
    orderId:      order.id,
    device_token: user?.device_token,
  });
});

router.get('/verify', requireAuth, (req, res) => {
  const grant = db.prepare("SELECT * FROM access_grants WHERE id = ? AND is_active = 1").get(req.user.grantId);
  if (!grant) return res.status(403).json({ error: 'Доступ отозван' });
  res.json({ valid: true, orderId: req.user.orderId, phone: req.user.phone });
});

module.exports = router;