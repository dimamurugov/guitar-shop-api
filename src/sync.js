// src/sync.js — оркестратор синхронизации
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { fetchCatalog } = require('./fetcher');
const db = require('./db');
const { uploadProducts } = require('./tilda');

async function runSync() {
  await db.initDb(); // idempotent — повторный вызов безопасен

  const logId     = db.startSyncLog();
  const startedAt = Date.now();

  console.log('\n══════════════════════════════════════════');
  console.log(`[sync] Старт ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════\n');

  let stats = { status: 'error', total: 0, inserted: 0, updated: 0, hidden: 0, error_msg: null };

  try {
    const url       = process.env.SUPPLIER_CSV_URL;
    const delimiter = process.env.CSV_DELIMITER || ',';
    if (!url) throw new Error('Не задан SUPPLIER_CSV_URL в .env');

    // 1. Скачать CSV
    const products = await fetchCatalog(url, delimiter);
    if (!products.length) throw new Error('CSV пустой');
    stats.total = products.length;
    console.log(`[sync] Получено от поставщика: ${products.length} товаров`);

    // 2. Сохранить в БД
    //    replaceAll возвращает hiddenProducts — товары, исчезнувшие у поставщика,
    //    которые теперь помечены in_stock = 0 (но НЕ удалены из БД).
    const dbStats = db.replaceAll(products);
    stats.inserted = dbStats.inserted;
    stats.updated  = dbStats.updated;
    stats.hidden   = dbStats.hidden;
    console.log(
      `[sync] БД: +${stats.inserted} новых, ~${stats.updated} обновлено, ` +
      `${stats.hidden} скрыто (нет у поставщика)`
    );

    // 3. Загрузить в Tilda
    //    Передаём ВСЕ товары из CSV (активные) + скрытые (quantity='0').
    //    Tilda найдёт каждый по externalid и обновит, не создавая дублей.
    //    Ручные правки в админке Tilda (доп. фото, описания) сохранятся.
    const allForTilda = [...products, ...dbStats.hiddenProducts];
    const tildaStats  = await uploadProducts(allForTilda);
    console.log(
      `[sync] Tilda обновлена: ${tildaStats.active} активных, ` +
      `${tildaStats.hidden} скрытых`
    );

    stats.status = 'success';
  } catch (err) {
    stats.error_msg = err.message;
    console.error('[sync] ОШИБКА:', err.message);
  } finally {
    // sync_log.deleted переиспользуем под hidden для совместимости схемы
    db.finishSyncLog(logId, {
      ...stats,
      deleted: stats.hidden,
    });
    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\n[sync] Завершено за ${dur}с. Статус: ${stats.status}\n`);
  }

  return stats;
}

if (require.main === module) {
  runSync().then(s => process.exit(s.status === 'success' ? 0 : 1));
}

module.exports = { runSync };
