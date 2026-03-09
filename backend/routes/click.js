// routes/click.js
// ============================================================
// CLICK SHOP API — Prepare + Complete
// Документация: https://docs.click.uz/click-api-request/
//
// Данные мерчанта Skillcraft.uz:
//   SERVICE_ID       = 97042
//   MERCHANT_ID      = 57342
//   SECRET_KEY       = (из .env)
//   MERCHANT_USER_ID = 78839
//
// В кабинете merchant.click.uz → Сервисы → карандаш укажи:
//   Адрес проверки:  https://твой-домен/api/payments/click/prepare
//   Адрес результата: https://твой-домен/api/payments/click/complete
// ============================================================

const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

// ─── CHECKOUT URL (кнопка "Оплата через Click") ─────────────
// GET /api/payments/click/checkout-url?orderId=...
router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const amountUzs  = order.amount / 100;
  const returnUrl  = process.env.CLICK_RETURN_URL || `${process.env.FRONTEND_URL}/success.html`;

  // Ссылка для оплаты через приложение Click / выставление счёта
  const url =
    `https://my.click.uz/services/pay` +
    `?service_id=${process.env.CLICK_SERVICE_ID}` +
    `&merchant_id=${process.env.CLICK_MERCHANT_ID}` +
    `&amount=${amountUzs}` +
    `&transaction_param=${order.order_code}` +
    `&return_url=${encodeURIComponent(returnUrl)}`;

  res.json({ checkout_url: url });
});

// ─── CARD URL (кнопка "Оплата с любой карты") ───────────────
// GET /api/payments/click/card-url?orderId=...
// Документация: https://docs.click.uz/click-pay-by-card/
router.get('/card-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const amountUzs = order.amount / 100;
  const returnUrl = process.env.CLICK_RETURN_URL || `${process.env.FRONTEND_URL}/success.html`;

  // Ссылка для оплаты картой без регистрации в Click
  const url =
    `https://my.click.uz/pay-by-card` +
    `?service_id=${process.env.CLICK_SERVICE_ID}` +
    `&merchant_id=${process.env.CLICK_MERCHANT_ID}` +
    `&amount=${amountUzs}` +
    `&transaction_param=${order.order_code}` +
    `&return_url=${encodeURIComponent(returnUrl)}`;

  res.json({ checkout_url: url });
});

// ─── ПРОВЕРКА ПОДПИСИ ────────────────────────────────────────
// Документация: https://docs.click.uz/click-api-request/#sign
function verifySign(body, action) {
  const secret = process.env.CLICK_SECRET_KEY; // m0MoUvbfd8

  const {
    click_trans_id,
    service_id,
    merchant_trans_id,
    merchant_prepare_id = '',
    amount,
    sign_time,
    sign_string,
  } = body;

  let signStr;
  if (parseInt(action) === 0) {
    // Prepare: click_trans_id + service_id + secret + merchant_trans_id + amount + action + sign_time
    signStr = `${click_trans_id}${service_id}${secret}${merchant_trans_id}${amount}${action}${sign_time}`;
  } else {
    // Complete: добавляется merchant_prepare_id
    signStr = `${click_trans_id}${service_id}${secret}${merchant_trans_id}${merchant_prepare_id}${amount}${action}${sign_time}`;
  }

  const expected = crypto.createHash('md5').update(signStr).digest('hex');
  const valid = sign_string === expected;

  if (!valid) {
    console.error('❌ Click sign mismatch');
    console.error('   Expected:', expected);
    console.error('   Got:     ', sign_string);
  }

  return valid;
}

// ─── PREPARE ────────────────────────────────────────────────
// POST /api/payments/click/prepare
// Click вызывает перед списанием — мы проверяем заказ
router.post('/prepare', require('express').urlencoded({ extended: true }), (req, res) => {
  const {
    click_trans_id,
    service_id,
    merchant_trans_id,
    amount,
    action,
  } = req.body;

  console.log('📥 Click PREPARE:', { merchant_trans_id, amount, click_trans_id });

  // 1. Проверка подписи
  if (!verifySign(req.body, 0)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }

  // 2. Проверяем service_id
  if (String(service_id) !== String(process.env.CLICK_SERVICE_ID)) {
    return res.json({ error: -6, error_note: 'Permission denied' });
  }

  // 3. Находим заказ по order_code
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(merchant_trans_id);
  if (!order) {
    return res.json({ error: -5, error_note: 'User does not exist' });
  }

  // 4. Уже оплачен?
  if (order.status === 'paid') {
    return res.json({ error: -4, error_note: 'Already paid' });
  }

  // 5. Проверяем сумму (Click присылает в сумах, у нас в тийинах)
  const expectedUzs = order.amount / 100;
  if (Math.abs(parseFloat(amount) - expectedUzs) > 0.01) {
    console.error(`❌ Amount mismatch: expected ${expectedUzs}, got ${amount}`);
    return res.json({ error: -2, error_note: 'Incorrect parameter amount' });
  }

  // 6. Создаём запись о платеже
  const paymentId = uuidv4();
  db.prepare(
    "INSERT INTO payments (id,order_id,provider,provider_transaction_id,amount,raw_payload,status) VALUES (?,?,'click',?,?,?,'pending')"
  ).run(paymentId, order.id, click_trans_id, order.amount, JSON.stringify(req.body));

  console.log(`✅ Click Prepare OK — order: ${merchant_trans_id}, payment: ${paymentId}`);

  return res.json({
    click_trans_id,
    merchant_trans_id,
    merchant_prepare_id: paymentId,
    error: 0,
    error_note: 'Success',
  });
});

// ─── COMPLETE ───────────────────────────────────────────────
// POST /api/payments/click/complete
// Click вызывает после списания — подтверждаем и выдаём доступ
router.post('/complete', require('express').urlencoded({ extended: true }), (req, res) => {
  const {
    click_trans_id,
    merchant_trans_id,
    merchant_prepare_id,
    amount,
    error: clickError,
  } = req.body;

  console.log('📥 Click COMPLETE:', { merchant_trans_id, clickError, click_trans_id });

  // 1. Проверка подписи
  if (!verifySign(req.body, 1)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }

  // 2. Находим заказ
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(merchant_trans_id);
  if (!order) {
    return res.json({ error: -5, error_note: 'User does not exist' });
  }

  // 3. Находим payment из Prepare
  const payment = db.prepare(
    "SELECT * FROM payments WHERE id = ? AND provider = 'click'"
  ).get(merchant_prepare_id);
  if (!payment) {
    return res.json({ error: -6, error_note: 'Transaction does not exist' });
  }

  // 4. Click прислал ошибку — оплата не прошла
  if (parseInt(clickError) < 0) {
    db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(order.id);
    db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(payment.id);
    console.log(`❌ Click payment FAILED: ${merchant_trans_id}`);
    return res.json({
      click_trans_id,
      merchant_trans_id,
      merchant_confirm_id: null,
      error: 0,
      error_note: 'Success',
    });
  }

  // 5. Оплата успешна
  db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(order.id);
  db.prepare(
    "UPDATE payments SET status='success', provider_transaction_id=? WHERE id=?"
  ).run(click_trans_id, payment.id);

  // Выдаём доступ ко всем 11 урокам
  grantCourseAccess(order.id, order.user_id);

  console.log(`✅✅ Click payment SUCCESS: ${merchant_trans_id}`);

  return res.json({
    click_trans_id,
    merchant_trans_id,
    merchant_confirm_id: order.id,
    error: 0,
    error_note: 'Success',
  });
});

module.exports = router;
