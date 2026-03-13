# Skillcraft — Excel Course

## Структура проекта

```
skillcraft/
├── frontend/
│   ├── index.html      ← твой сайт + модалка оплаты (не изменён дизайн)
│   ├── success.html    ← страница после оплаты
│   └── lessons.html    ← страница "Мои уроки"
│
└── backend/
    ├── db/
    │   ├── init.js     ← SQLite инициализация (5 таблиц)
    │   └── seed.js     ← 11 уроков-заглушек
    ├── middleware/
    │   └── auth.js     ← JWT
    ├── routes/
    │   ├── orders.js   ← создание заказов
    │   ├── click.js    ← Click Prepare/Complete
    │   ├── payme.js    ← Payme JSON-RPC
    │   ├── lessons.js  ← защищённое скачивание
    │   └── access.js   ← выдача JWT
    ├── services/
    │   └── accessService.js
    ├── storage/
    │   └── lessons/    ← ⚠️ СЮДА КЛАДЁШЬ PDF ФАЙЛЫ
    ├── server.js
    ├── package.json
    └── .env.example
```

---

## Запуск на MacBook

### 1. Backend

```bash
cd skillcraft/backend
npm install
cp .env.example .env
# Отредактируй .env (цену, JWT_SECRET)
npm run seed
npm run dev
```

Backend: http://localhost:3000

### 2. Frontend

Открой `frontend/index.html` в браузере.

Или запусти локальный сервер (чтобы не было CORS проблем):

```bash
# Установи один раз
npm install -g live-server

# Запускай из папки frontend/
cd skillcraft/frontend
live-server --port=5500
```

Frontend: http://localhost:5500

---

## Что куда вставлять

### Уроки (PDF файлы):
```
backend/storage/lessons/lesson-1.pdf
backend/storage/lessons/lesson-2.pdf
...
backend/storage/lessons/lesson-11.pdf
```
После добавления файлов — ничего перезапускать не нужно.

Чтобы изменить названия уроков — отредактируй `backend/db/seed.js` и запусти `npm run seed`.

### Ключи Click:
В файле `backend/.env`:
```
CLICK_SERVICE_ID=твой_service_id
CLICK_MERCHANT_ID=твой_merchant_id
CLICK_SECRET_KEY=твой_secret_key
```

### Ключи Payme:
В файле `backend/.env`:
```
PAYME_MERCHANT_ID=твой_merchant_id
PAYME_TEST_KEY=тестовый_ключ
PAYME_SECRET_KEY=боевой_ключ
```

### Цена курса:
В файле `backend/.env`:
```
COURSE_PRICE_TIYIN=9900000    # 54 000 UZS
COURSE_PRICE_DISPLAY=54 000 UZS
```
И в `frontend/index.html` найди строку `sc-price-value` — обнови текст.

---

## После деплоя backend

1. Получи URL (например `https://api.yourdomain.uz`)
2. В `backend/.env`:
   ```
   BACKEND_URL=https://api.yourdomain.uz
   FRONTEND_URL=https://yourdomain.uz
   NODE_ENV=production
   ```
3. В `frontend/index.html`, `success.html`, `lessons.html` найди строку:
   ```js
   const API_URL = 'http://localhost:3000';
   ```
   И замени на:
   ```js
   const API_URL = 'https://api.yourdomain.uz';
   ```
4. В кабинете Click укажи Callback URL:
   `https://api.yourdomain.uz/api/payments/click/callback`
5. В кабинете Payme укажи Callback URL:
   `https://api.yourdomain.uz/api/payments/payme/callback`
