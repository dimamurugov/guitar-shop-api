// src/db.js — SQLite через sql.js (чистый JS, без нативной компиляции)
const initSqlJs = require('sql.js');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'catalog.db');

let db = null; // sql.js Database instance

// ── Инициализация (асинхронная, вызывается один раз при старте) ───────────────

async function initDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    // Загружаем существующую БД с диска
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  createSchema();
  return db;
}

/** Сохраняет текущее состояние БД на диск (sql.js держит всё в памяти) */
function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function createSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      price       REAL NOT NULL,
      description TEXT,
      image_url   TEXT,
      category    TEXT,
      in_stock    INTEGER DEFAULT 1,
      raw_data    TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL DEFAULT 'running',
      total       INTEGER DEFAULT 0,
      inserted    INTEGER DEFAULT 0,
      updated     INTEGER DEFAULT 0,
      deleted     INTEGER DEFAULT 0,
      error_msg   TEXT
    );
  `);
  persist();
}

// ── Вспомогательные ───────────────────────────────────────────────────────────

/** Выполняет SELECT и возвращает массив объектов */
function query(sql, params = []) {
  const stmt   = db.prepare(sql);
  const rows   = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** Выполняет INSERT/UPDATE/DELETE */
function run(sql, params = []) {
  db.run(sql, params);
}

// ── Продукты ──────────────────────────────────────────────────────────────────

/**
 * Атомарно обновляет каталог:
 *   — upsert товаров из CSV
 *   — товары, исчезнувшие у поставщика, помечаются in_stock = 0
 *     (НЕ удаляются), чтобы в Tilda они остались как «нет в наличии»
 *     и ручные правки в админке Tilda не потерялись.
 *
 * Возвращает:
 *   inserted  — новых товаров добавлено
 *   updated   — существующих обновлено
 *   hidden    — помечено «нет в наличии» (исчезли у поставщика)
 *   hiddenProducts — массив объектов скрытых товаров (для Tilda)
 */
function replaceAll(products) {
  const newIds = new Set(products.map(p => p.id));
  const oldRows = query('SELECT id FROM products');
  const oldIds  = new Set(oldRows.map(r => r.id));

  let inserted = 0, updated = 0, hidden = 0;

  db.run('BEGIN TRANSACTION');
  try {
    // Upsert товаров из CSV
    for (const p of products) {
      run(`
        INSERT INTO products (id, name, price, description, image_url, category, in_stock, raw_data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          name        = excluded.name,
          price       = excluded.price,
          description = excluded.description,
          image_url   = excluded.image_url,
          category    = excluded.category,
          in_stock    = excluded.in_stock,
          raw_data    = excluded.raw_data,
          updated_at  = excluded.updated_at
      `, [p.id, p.name, p.price, p.description, p.image_url, p.category, p.in_stock, p.raw_data]);

      oldIds.has(p.id) ? updated++ : inserted++;
    }

    // Товары, исчезнувшие у поставщика → помечаем «нет в наличии»
    const toHide = [];
    for (const oldId of oldIds) {
      if (!newIds.has(oldId)) {
        run(`
          UPDATE products
          SET in_stock = 0, updated_at = datetime('now')
          WHERE id = ? AND in_stock != 0
        `, [oldId]);
        toHide.push(oldId);
        hidden++;
      }
    }

    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }

  persist();

  // Возвращаем скрытые товары полными объектами — sync.js передаст их в Tilda
  const hiddenProducts = hidden > 0
    ? query(`SELECT * FROM products WHERE id IN (${Array(hidden).fill('?').join(',')})`,
        [...oldIds].filter(id => !newIds.has(id)))
    : [];

  return { inserted, updated, hidden, hiddenProducts };
}

function getAll({ category, search, page = 1, limit = 50 } = {}) {
  let where  = 'WHERE 1=1';
  const params = [];

  if (category) {
    where += ' AND category = ?';
    params.push(category);
  }
  if (search) {
    where += ' AND (name LIKE ? OR description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const offset = (page - 1) * limit;
  const rows   = query(`SELECT * FROM products ${where} ORDER BY name LIMIT ? OFFSET ?`,
                        [...params, limit, offset]);
  const total  = query(`SELECT COUNT(*) as cnt FROM products ${where}`, params)[0]?.cnt ?? 0;

  return { rows, total, page, limit };
}

function getById(id) {
  return query('SELECT * FROM products WHERE id = ?', [id])[0] ?? null;
}

function getCategories() {
  return query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category')
    .map(r => r.category);
}

// ── Лог синхронизации ─────────────────────────────────────────────────────────

function startSyncLog() {
  run(`INSERT INTO sync_log (started_at) VALUES (datetime('now'))`);
  const row = query('SELECT last_insert_rowid() as id')[0];
  persist();
  return row.id;
}

function finishSyncLog(id, { status, total, inserted, updated, deleted, error_msg }) {
  run(`
    UPDATE sync_log
    SET finished_at = datetime('now'), status = ?, total = ?, inserted = ?, updated = ?, deleted = ?, error_msg = ?
    WHERE id = ?
  `, [status, total, inserted, updated, deleted, error_msg ?? null, id]);
  persist();
}

function getLastLogs(limit = 10) {
  return query('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?', [limit]);
}

module.exports = {
  initDb,
  replaceAll, getAll, getById, getCategories,
  startSyncLog, finishSyncLog, getLastLogs,
};

// Примечание: replaceAll больше не удаляет товары из БД.
// Товары, исчезнувшие у поставщика, помечаются in_stock = 0
// и остаются в базе. Это позволяет передать их в Tilda с quantity = '0',
// сохранив все ручные правки в админке Tilda.
