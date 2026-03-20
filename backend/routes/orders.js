const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');

router.post('/', (req, res) => {
  const { phone, provider } = req.body;
  if (!phone || phone.length < 9)
    return res.status(400).json({ error: 'Укажите корректный номер телефона' });
  if (!['click', 'payme'].includes(provider))
    return res.status(400).json({ error: 'Провайдер: click или payme' });

  const saleEnd = new Date((process.env.SALE_END_DATE || '2026-03-30') + 'T23:59:59');
  const isOnSale = new Date() < saleEnd;
  const amount = isOnSale
    ? (parseInt(process.env.COURSE_PRICE_SALE_TIYIN) || 4999900)
    : (parseInt(process.env.COURSE_PRICE_NORMAL_TIYIN) || 9999800);

  try {
    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      const uid = uuidv4();
      db.prepare('INSERT INTO users (id,phone) VALUES (?,?)').run(uid, phone);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    }

    const orderId = uuidv4();
    const orderCode = 'SC-' + Date.now();
    db.prepare(
      "INSERT INTO orders (id,order_code,user_id,amount,provider,status) VALUES (?,?,?,?,?,'pending')"
    ).run(orderId, orderCode, user.id, amount, provider);

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    res.json({ success: true, order: { id: order.id, order_code: order.order_code, amount: order.amount, provider: order.provider, status: order.status } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка создания заказа' });
  }
});

router.get('/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  res.json({ id: order.id, order_code: order.order_code, amount: order.amount, provider: order.provider, status: order.status });
});

module.exports = router;
