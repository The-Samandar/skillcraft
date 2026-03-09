// routes/lessons.js
// После оплаты пользователь скачивает ОДИН ZIP со всеми уроками
//
// ⚠️ Положи файл в: backend/storage/lessons/all-lessons.zip

const router  = require('express').Router();
const path    = require('path');
const fs      = require('fs');
const { db }  = require('../db/init');
const { requireAuth } = require('../middleware/auth');

// GET /api/lessons — информация о курсе (публичный)
router.get('/', (req, res) => {
  res.json({
    course: {
      title: '11 уроков Excel — Skillcraft',
      description: 'Полный курс по Excel для начинающих',
      lessons_count: 11,
      format: 'ZIP архив со всеми материалами',
    }
  });
});

// GET /api/lessons/download — скачать ZIP (только после оплаты)
router.get('/download', requireAuth, (req, res) => {
  const { orderId, grantId } = req.user;

  // Проверяем активный доступ
  const grant = db.prepare(
    "SELECT * FROM access_grants WHERE id = ? AND is_active = 1"
  ).get(grantId);
  if (!grant) return res.status(403).json({ error: 'Нет доступа к урокам' });

  // Проверяем что заказ оплачен
  const order = db.prepare(
    "SELECT * FROM orders WHERE id = ? AND status = 'paid'"
  ).get(orderId);
  if (!order) return res.status(403).json({ error: 'Заказ не оплачен' });

  // Путь к ZIP файлу
  const zipPath = path.join(__dirname, '..', 'storage', 'lessons', 'all-lessons.zip');

  if (!fs.existsSync(zipPath)) {
    console.error('❌ ZIP не найден:', zipPath);
    return res.status(404).json({ error: 'Файл временно недоступен. Напишите нам.' });
  }

  console.log(`📥 ZIP download: order=${orderId}`);
  res.setHeader('Content-Disposition', 'attachment; filename="Skillcraft-Excel-11-urokov.zip"');
  res.setHeader('Content-Type', 'application/zip');
  fs.createReadStream(zipPath).pipe(res);
});

module.exports = router;
