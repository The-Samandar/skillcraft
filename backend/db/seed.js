// db/seed.js — заполняем БД 11 уроками-заглушками
// Запуск: npm run seed
//
// ⚠️ После получения реальных файлов:
// 1. Положи PDF в backend/storage/lessons/
// 2. Обнови title, description ниже
// 3. Запусти: npm run seed

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { initDatabase, db } = require('./init');

// ============================================================
// ⬇️ ЗАМЕНИ НАЗВАНИЯ И ОПИСАНИЯ УРОКОВ ЗДЕСЬ
// ============================================================
const LESSONS = [
  { title: 'Урок 1: Что такое Excel и зачем он нужен',   slug: 'lesson-1',  file_name: 'lesson-1.pdf',  description: 'Интерфейс, ячейки, основные действия',         sort_order: 1  },
  { title: 'Урок 2: Формулы — твой главный инструмент',  slug: 'lesson-2',  file_name: 'lesson-2.pdf',  description: 'СУММ, ЕСЛИ, СЧЁТЕСЛИ — объясняем просто',      sort_order: 2  },
  { title: 'Урок 3: ВПР и поиск между таблицами',        slug: 'lesson-3',  file_name: 'lesson-3.pdf',  description: 'ВПР, XLOOKUP, ИНДЕКС/ПОИСКПОЗ',               sort_order: 3  },
  { title: 'Урок 4: Форматирование и условный стиль',    slug: 'lesson-4',  file_name: 'lesson-4.pdf',  description: 'Условное форматирование, стили, таблицы',      sort_order: 4  },
  { title: 'Урок 5: Работа с датами и текстом',          slug: 'lesson-5',  file_name: 'lesson-5.pdf',  description: 'Даты, сроки, очистка данных',                  sort_order: 5  },
  { title: 'Урок 6: Сортировка и фильтрация',            slug: 'lesson-6',  file_name: 'lesson-6.pdf',  description: 'Умные фильтры, сортировка по нескольким полям',sort_order: 6  },
  { title: 'Урок 7: Сводные таблицы',                    slug: 'lesson-7',  file_name: 'lesson-7.pdf',  description: 'PivotTable — анализ за 3 минуты',              sort_order: 7  },
  { title: 'Урок 8: Диаграммы и графики',                slug: 'lesson-8',  file_name: 'lesson-8.pdf',  description: 'Профессиональные графики для отчётов',         sort_order: 8  },
  { title: 'Урок 9: Защита и безопасность',              slug: 'lesson-9',  file_name: 'lesson-9.pdf',  description: 'Пароли, защита листов и диапазонов',           sort_order: 9  },
  { title: 'Урок 10: Excel в работе и бизнесе',          slug: 'lesson-10', file_name: 'lesson-10.pdf', description: 'Реальные кейсы: отчёты, дашборды, KPI',        sort_order: 10 },
  { title: 'Урок 11: Финальный проект',                  slug: 'lesson-11', file_name: 'lesson-11.pdf', description: 'Собираем всё вместе — полноценная таблица',    sort_order: 11 },
];

async function seed() {
  await initDatabase();

  db.prepare('DELETE FROM lessons').run();

  for (const lesson of LESSONS) {
    db.prepare(
      'INSERT INTO lessons (id,title,slug,file_name,file_path,description,sort_order,is_active) VALUES (@id,@title,@slug,@file_name,@file_path,@description,@sort_order,1)'
    ).run({
      id: uuidv4(),
      title: lesson.title,
      slug: lesson.slug,
      file_name: lesson.file_name,
      file_path: path.join('storage', 'lessons', lesson.file_name),
      description: lesson.description,
      sort_order: lesson.sort_order,
    });
  }

  console.log(`✅ Seeded ${LESSONS.length} lessons`);
  console.log('\n📁 Положи файлы уроков в:');
  LESSONS.forEach(l => console.log(`   backend/storage/lessons/${l.file_name}`));
  console.log('\n▶️  Запусти: npm run dev\n');
  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });
