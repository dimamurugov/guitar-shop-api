// src/server.js — Express сервер + cron-планировщик
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cron    = require('node-cron');
const { runSync }        = require('./sync');
const { testConnection } = require('./tilda');
const db = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Middleware: авторизация служебных роутов ───────────────────────────────────
function requireSecret(req, res, next) {
  const token = req.headers['x-sync-secret'] || req.query.secret;
  if (token && token === process.env.SYNC_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized. Передайте заголовок X-Sync-Secret.' });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ПУБЛИЧНЫЕ РОУТЫ
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/products
 * Query: category, search, page, limit (max 200)
 */
app.get('/api/products', (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = db.getAll({
      category: req.query.category,
      search:   req.query.search,
      page:     parseInt(req.query.page) || 1,
      limit,
    });

    res.json({
      success: true,
      pagination: {
        total: result.total,
        page:  result.page,
        limit: result.limit,
        pages: Math.ceil(result.total / result.limit),
      },
      products: result.rows.map(formatProduct),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/products/:id */
app.get('/api/products/:id', (req, res) => {
  const product = db.getById(req.params.id);
  if (!product) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, product: formatProduct(product) });
});

/** GET /api/categories */
app.get('/api/categories', (req, res) => {
  res.json({ success: true, categories: db.getCategories() });
});

// ══════════════════════════════════════════════════════════════════════════════
//  СЛУЖЕБНЫЕ РОУТЫ (X-Sync-Secret)
// ══════════════════════════════════════════════════════════════════════════════

/** POST /admin/sync — ручной запуск */
app.post('/admin/sync', requireSecret, (req, res) => {
  console.log('[admin] Ручной запуск синхронизации');
  res.json({ success: true, message: 'Синхронизация запущена. Проверьте /admin/logs.' });
  runSync().catch(console.error);
});

/** GET /admin/logs */
app.get('/admin/logs', requireSecret, (req, res) => {
  res.json({ success: true, logs: db.getLastLogs(20) });
});

/** GET /admin/status */
app.get('/admin/status', requireSecret, async (req, res) => {
  const logs     = db.getLastLogs(1);
  const lastSync = logs[0] || null;
  const { total } = db.getAll({ limit: 1 });

  let tildaOk = null;
  try { await testConnection(); tildaOk = true; }
  catch { tildaOk = false; }

  res.json({
    success: true,
    productsInDb: total,
    lastSync,
    tildaApiOk: tildaOk,
    nextSyncCron: process.env.SYNC_CRON || '0 3 * * *',
  });
});

/** GET /health */
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Cron ──────────────────────────────────────────────────────────────────────
function startScheduler() {
  const cronExpr = process.env.SYNC_CRON || '0 3 * * *';
  if (!cron.validate(cronExpr)) {
    return console.error(`[cron] Неверное выражение: "${cronExpr}"`);
  }
  cron.schedule(cronExpr, () => {
    console.log('[cron] Плановый запуск...');
    runSync().catch(console.error);
  }, { timezone: 'Europe/Moscow' });
  console.log(`[cron] Запланировано: "${cronExpr}" (Europe/Moscow)`);
}

// ── Старт ─────────────────────────────────────────────────────────────────────
async function main() {
  await db.initDb(); // ← инициализируем sql.js до первого запроса
  console.log('[db] База данных готова');

  app.listen(PORT, () => {
    console.log(`\n🚀 Tilda Sync Server запущен на http://localhost:${PORT}`);
    console.log(`   Healthcheck : GET  /health`);
    console.log(`   Каталог     : GET  /api/products`);
    console.log(`   Ручной sync : POST /admin/sync  (X-Sync-Secret: ...)\n`);
    startScheduler();
  });
}

main().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);
});

// ── Форматировщик ─────────────────────────────────────────────────────────────
function formatProduct(p) {
  return {
    id:          p.id,
    name:        p.name,
    price:       p.price,
    description: p.description,
    image_url:   p.image_url,
    category:    p.category,
    in_stock:    p.in_stock === 1,
    updated_at:  p.updated_at,
  };
}
