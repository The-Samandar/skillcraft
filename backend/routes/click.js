const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

// =========================
// CLICK CHECKOUT URL
// =========================

router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const amountUzs = (Number(order.amount) / 100).toFixed(2);
  const returnUrl =
    process.env.CLICK_RETURN_URL || `${process.env.FRONTEND_URL}/success.html`;

  const url =
    `https://my.click.uz/services/pay` +
    `?service_id=${encodeURIComponent(process.env.CLICK_SERVICE_ID || '')}` +
    `&merchant_id=${encodeURIComponent(process.env.CLICK_MERCHANT_ID || '')}` +
    `&amount=${encodeURIComponent(amountUzs)}` +
    `&transaction_param=${encodeURIComponent(order.order_code)}` +
    `&return_url=${encodeURIComponent(returnUrl)}`;

  return res.json({ checkout_url: url });
});

router.get('/card-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const amountUzs = (Number(order.amount) / 100).toFixed(2);
  const returnUrl =
    process.env.CLICK_RETURN_URL || `${process.env.FRONTEND_URL}/success.html`;

  const url =
    `https://my.click.uz/services/pay` +
    `?service_id=${encodeURIComponent(process.env.CLICK_SERVICE_ID || '')}` +
    `&merchant_id=${encodeURIComponent(process.env.CLICK_MERCHANT_ID || '')}` +
    `&amount=${encodeURIComponent(amountUzs)}` +
    `&transaction_param=${encodeURIComponent(order.order_code)}` +
    `&return_url=${encodeURIComponent(returnUrl)}`;

  return res.json({ checkout_url: url });
});

// =========================
// CLICK URL CHECK FROM CABINET
// =========================

router.get('/prepare', (_req, res) => {
  return res.json({ error: 0, error_note: 'Success' });
});

router.get('/complete', (_req, res) => {
  return res.json({ error: 0, error_note: 'Success' });
});

// =========================
// SIGN VERIFY
// =========================

function verifySign(body, fallbackAction) {
  const secret = process.env.CLICK_SECRET_KEY;

  if (!secret) {
    console.error('❌ CLICK_SECRET_KEY is missing');
    return false;
  }

  const {
    click_trans_id,
    service_id,
    merchant_trans_id,
    merchant_prepare_id = '',
    amount,
    action,
    sign_time,
    sign_string,
  } = body;

  const realAction = Number(action ?? fallbackAction);

  let signStr;
  if (realAction === 0) {
    signStr = `${click_trans_id}${service_id}${secret}${merchant_trans_id}${amount}${realAction}${sign_time}`;
  } else {
    signStr = `${click_trans_id}${service_id}${secret}${merchant_trans_id}${merchant_prepare_id}${amount}${realAction}${sign_time}`;
  }

  const expected = crypto.createHash('md5').update(signStr).digest('hex');
  const valid = String(sign_string || '') === expected;

  if (!valid) {
    console.error('❌ Click sign mismatch');
    console.error('   Expected:', expected);
    console.error('   Got:     ', sign_string);
    console.error('   Action:  ', realAction);
    console.error('   String:  ', signStr);
  }

  return valid;
}

// =========================
// PREPARE
// =========================

router.post('/prepare', require('express').urlencoded({ extended: true }), (req, res) => {
  const {
    click_trans_id,
    service_id,
    merchant_trans_id,
    amount,
  } = req.body;

  console.log('📥 Click PREPARE:', { merchant_trans_id, amount, click_trans_id });

  if (!verifySign(req.body, 0)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }

  if (String(service_id) !== String(process.env.CLICK_SERVICE_ID)) {
    return res.json({ error: -6, error_note: 'Permission denied' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(merchant_trans_id);
  if (!order) {
    return res.json({ error: -5, error_note: 'User does not exist' });
  }

  if (String(order.status).toLowerCase() === 'paid') {
    return res.json({ error: -4, error_note: 'Already paid' });
  }

  const expectedUzs = (Number(order.amount) / 100).toFixed(2);
  if (Number(amount).toFixed(2) !== expectedUzs) {
    console.error(`❌ Amount mismatch in PREPARE: expected ${expectedUzs}, got ${amount}`);
    return res.json({ error: -2, error_note: 'Incorrect parameter amount' });
  }

  // Идемпотентность: если уже есть pending payment для этого order + click_trans_id, вернём его
  const existingPayment = db.prepare(
    "SELECT * FROM payments WHERE order_id = ? AND provider = 'click' AND provider_transaction_id = ? LIMIT 1"
  ).get(order.id, String(click_trans_id));

  if (existingPayment) {
    return res.json({
      click_trans_id,
      merchant_trans_id,
      merchant_prepare_id: existingPayment.id,
      error: 0,
      error_note: 'Success',
    });
  }

  const paymentId = uuidv4();

  db.prepare(
    "INSERT INTO payments (id, order_id, provider, provider_transaction_id, amount, raw_payload, status) VALUES (?, ?, 'click', ?, ?, ?, 'pending')"
  ).run(
    paymentId,
    order.id,
    String(click_trans_id),
    Number(order.amount),
    JSON.stringify(req.body)
  );

  console.log(`✅ Click PREPARE OK — order=${merchant_trans_id}, payment=${paymentId}`);

  return res.json({
    click_trans_id,
    merchant_trans_id,
    merchant_prepare_id: paymentId,
    error: 0,
    error_note: 'Success',
  });
});

// =========================
// COMPLETE
// =========================

router.post('/complete', require('express').urlencoded({ extended: true }), (req, res) => {
  const {
    click_trans_id,
    service_id,
    merchant_trans_id,
    merchant_prepare_id,
    amount,
    error: clickError,
  } = req.body;

  console.log('📥 Click COMPLETE:', {
    merchant_trans_id,
    merchant_prepare_id,
    clickError,
    click_trans_id,
  });

  if (!verifySign(req.body, 1)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }

  if (String(service_id) !== String(process.env.CLICK_SERVICE_ID)) {
    return res.json({ error: -6, error_note: 'Permission denied' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(merchant_trans_id);
  if (!order) {
    return res.json({ error: -5, error_note: 'User does not exist' });
  }

  const expectedUzs = (Number(order.amount) / 100).toFixed(2);
  if (Number(amount).toFixed(2) !== expectedUzs) {
    console.error(`❌ Amount mismatch in COMPLETE: expected ${expectedUzs}, got ${amount}`);
    return res.json({ error: -2, error_note: 'Incorrect parameter amount' });
  }

  const payment = db.prepare(
    "SELECT * FROM payments WHERE id = ? AND provider = 'click' LIMIT 1"
  ).get(merchant_prepare_id);

  if (!payment) {
    return res.json({ error: -6, error_note: 'Transaction does not exist' });
  }

  // Если Click сообщает об ошибке оплаты
  if (parseInt(clickError, 10) < 0) {
    db.prepare("UPDATE orders SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(order.id);
    db.prepare("UPDATE payments SET status = 'failed', updated_at = datetime('now'), raw_payload = ? WHERE id = ?")
      .run(JSON.stringify(req.body), payment.id);

    console.log(`❌ Click payment FAILED: ${merchant_trans_id}`);

    return res.json({
      click_trans_id,
      merchant_trans_id,
      merchant_confirm_id: null,
      error: 0,
      error_note: 'Success',
    });
  }

  // Если уже оплачен — возвращаем успешный идемпотентный ответ
  if (String(order.status).toLowerCase() === 'paid') {
    return res.json({
      click_trans_id,
      merchant_trans_id,
      merchant_confirm_id: order.id,
      error: 0,
      error_note: 'Success',
    });
  }

  db.prepare("UPDATE orders SET status = 'paid', updated_at = datetime('now') WHERE id = ?").run(order.id);
  db.prepare(
    "UPDATE payments SET status = 'success', provider_transaction_id = ?, raw_payload = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(String(click_trans_id), JSON.stringify(req.body), payment.id);

  try {
    grantCourseAccess(order.id, order.user_id);
  } catch (e) {
    console.error('❌ grantCourseAccess error:', e);
  }

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