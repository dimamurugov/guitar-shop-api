import express, { Request, Response, Express } from 'express';
import Database from 'better-sqlite3';
import axios from 'axios';
import csv from 'csv-parser';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import fs from 'fs/promises';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';

// ========== ЗАГРУЗКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ==========
dotenv.config();

// ========== ИНТЕРФЕЙСЫ И ТИПЫ ==========

// Товар в нашей системе (SQLite)
interface GuitarProduct {
    id: string;
    name: string;
    brand: string;
    description: string;
    quantity: number;
    price_retail: number;
    price_diller: number;
    price_mp: number;
    store_spb: number;
    store_ekb: number;
    sale: number;
    lastUpdated: number;
    tilda_uid?: string;
}

// Данные от поставщика (API)
interface LutnerUpdate {
    id: string;
    quantity: number;
    price_retail: number;
    price_diller: number;
    price_mp: number;
    store_spb: number;
    store_ekb: number;
}

// Строка из CSV файла
interface CSVRow {
    IE_XML_ID: string;
    IE_NAME: string;
    IP_PROP96: string;
    IP_PROP100: string;
    CP_QUANTITY: string;
    CV_PRICE_13: string;
    CV_PRICE_18: string;
    CV_PRICE_20: string;
    CP_STORE_SPB: string;
    CP_STORE_EKB: string;
    CP_SALE: string;
}

// Ответ Tilda API
interface TildaProductResponse {
    status?: string;
    result?: {
        uid?: string;
        product_id?: string;
    };
    error?: string;
}

// Ответ Tilda API для обновления
interface TildaUpdateResponse {
    status: string;
    result?: {
        uid: string;
    };
    error?: {
        message: string;
    };
}

// Формат ответа нашего API
interface CatalogResponse {
    success: boolean;
    total?: number;
    lastUpdate?: string | null;
    products?: GuitarProduct[];
    error?: string;
}

// Статус сервера
interface StatusResponse {
    success: boolean;
    totalProducts: number;
    lastUpdate: string | null;
    tildaConfigured: boolean;
}

// ========== КОНФИГУРАЦИЯ ==========

const app: Express = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);

const TILDA_API: string = 'https://api.tildacdn.info/v1';
const PUBLIC_KEY: string | undefined = process.env.TILDA_PUBLIC_KEY;
const SECRET_KEY: string | undefined = process.env.TILDA_SECRET_KEY;

const CSV_URL: string = 'https://lutner.ru/bitrix/catalog_export/upload/hour.csv';

// Middleware
app.use(cors({ origin: ['https://project16053916.tilda.ws'] }));
app.use(express.json());

// ========== ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ==========

const dbPath = path.join(__dirname, '..', 'guitars.db');
const db = new Database(dbPath);

// Создаём таблицу, если её нет
db.exec(`
    CREATE TABLE IF NOT EXISTS catalog (
        id TEXT PRIMARY KEY,
        name TEXT,
        brand TEXT,
        description TEXT,
        quantity INTEGER,
        price_retail INTEGER,
        price_diller INTEGER,
        price_mp INTEGER,
        store_spb INTEGER,
        store_ekb INTEGER,
        sale INTEGER,
        lastUpdated INTEGER,
        tilda_uid TEXT
    )
`);

console.log('✅ База данных инициализирована');

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function parseNumber(value: string | undefined, defaultValue: number = 0): number {
    if (!value) return defaultValue;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
}

function parseIntSafe(value: string | undefined, defaultValue: number = 0): number {
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== ФУНКЦИИ ДЛЯ РАБОТЫ С TILDA API ==========

/**
 * Обновление/создание одного товара в Tilda
 */
async function updateProductInTilda(product: GuitarProduct): Promise<TildaUpdateResponse | null> {
    if (!PUBLIC_KEY || !SECRET_KEY) {
        console.error('❌ Tilda API ключи не настроены');
        return null;
    }

    try {
        const response = await axios.post<TildaUpdateResponse>(`${TILDA_API}/updateproduct`, {
            publickey: PUBLIC_KEY,
            secretkey: SECRET_KEY,
            product_id: product.id,
            title: product.name,
            price: product.price_diller,
            quantity: product.quantity,
            category: product.brand || '',
            description: product.description?.slice(0, 500) || '',
            meta: JSON.stringify({
                store_spb: product.store_spb,
                store_ekb: product.store_ekb,
                price_retail: product.price_retail,
                price_mp: product.price_mp
            })
        });

        // Сохраняем tilda_uid для будущих обновлений
        if (response.data.result?.uid) {
            const stmt = db.prepare('UPDATE catalog SET tilda_uid = ? WHERE id = ?');
            stmt.run(response.data.result.uid, product.id);
        }

        console.log(`✅ Синхронизирован: ${product.name.slice(0, 40)} (${product.id})`);
        return response.data;

    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`❌ Ошибка синхронизации ${product.id}:`, error.response?.data || error.message);
        } else {
            console.error(`❌ Ошибка синхронизации ${product.id}:`, error);
        }
        return null;
    }
}

/**
 * Массовая синхронизация каталога с Tilda
 */
async function syncCatalogToTilda(products: GuitarProduct[]): Promise<void> {
    console.log(`🔄 Синхронизация ${products.length} товаров с Tilda API...`);
    console.log(`⚠️ Лимит API: 150 запросов в час. Процесс займёт время.`);

    const batchSize = 20;
    let synced = 0;

    for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        await Promise.all(batch.map(product => updateProductInTilda(product)));

        synced += batch.length;
        console.log(`📦 Прогресс: ${synced}/${products.length}`);

        // Пауза для соблюдения лимитов API
        await sleep(2000);
    }

    console.log(`✅ Синхронизация завершена! Обновлено ${synced} товаров.`);
}

/**
 * Быстрое обновление только цен и остатков
 */
async function updatePricesInTilda(updates: LutnerUpdate[]): Promise<void> {
    if (!PUBLIC_KEY || !SECRET_KEY) {
        console.error('❌ Tilda API ключи не настроены');
        return;
    }

    console.log(`🔄 Обновление цен/остатков для ${updates.length} товаров в Tilda...`);

    let updated = 0;
    for (const update of updates) {
        try {
            await axios.post<TildaUpdateResponse>(`${TILDA_API}/updateproduct`, {
                publickey: PUBLIC_KEY,
                secretkey: SECRET_KEY,
                product_id: update.id,
                price: update.price_diller,
                quantity: update.quantity
            });
            updated++;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error(`Ошибка обновления ${update.id}:`, error.response?.data || error.message);
            } else {
                console.error(`Ошибка обновления ${update.id}:`, error);
            }
        }
    }

    console.log(`✅ Обновлено ${updated}/${updates.length} товаров в Tilda`);
}

// ========== ЗАГРУЗКА CSV И СОХРАНЕНИЕ В SQLITE ==========

async function downloadAndSaveToDB(): Promise<GuitarProduct[] | null> {
    try {
        console.log('🔄 Загрузка CSV с гитарами...');
        const response = await fetch(CSV_URL);
        const csvText = await response.text();

        const tempCsvPath = path.join(__dirname, '..', 'temp.csv');
        await fs.writeFile(tempCsvPath, csvText, 'utf8');

        const products: GuitarProduct[] = [];

        await pipeline(
            createReadStream(tempCsvPath),
            csv({ separator: ';', headers: true }),
            async function* (source) {
                for await (const row of source) {
                    const typedRow = row as unknown as CSVRow;
                    products.push({
                        id: typedRow.IE_XML_ID,
                        name: typedRow.IE_NAME || 'Без названия',
                        brand: typedRow.IP_PROP96 || '',
                        description: (typedRow.IP_PROP100 || '').slice(0, 500),
                        quantity: parseIntSafe(typedRow.CP_QUANTITY),
                        price_retail: parseNumber(typedRow.CV_PRICE_13),
                        price_diller: parseNumber(typedRow.CV_PRICE_18),
                        price_mp: parseNumber(typedRow.CV_PRICE_20),
                        store_spb: parseIntSafe(typedRow.CP_STORE_SPB),
                        store_ekb: parseIntSafe(typedRow.CP_STORE_EKB),
                        sale: parseNumber(typedRow.CP_SALE),
                        lastUpdated: Date.now()
                    });
                }
            }
        );

        await fs.unlink(tempCsvPath);
        console.log(`📊 Загружено ${products.length} товаров из CSV`);

        // Сохраняем в SQLite с использованием транзакции
        const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO catalog (
                id, name, brand, description, quantity, price_retail,
                price_diller, price_mp, store_spb, store_ekb, sale, lastUpdated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((prods: GuitarProduct[]) => {
            for (const p of prods) {
                insertStmt.run(
                    p.id, p.name, p.brand, p.description,
                    p.quantity, p.price_retail, p.price_diller, p.price_mp,
                    p.store_spb, p.store_ekb, p.sale, p.lastUpdated
                );
            }
        });

        insertMany(products);
        console.log(`✅ Сохранено в SQLite: ${products.length} товаров`);

        return products;

    } catch (error) {
        console.error('❌ Ошибка загрузки CSV:', error);
        return null;
    }
}

// ========== ЭНДПОИНТЫ API ==========

/**
 * Эндпоинт для поставщика (обновление цен каждые 5 минут)
 * POST /api/update-from-lutner
 */
app.post('/api/update-from-lutner', async (req: Request, res: Response) => {
    try {
        const updates = req.body as LutnerUpdate[];

        if (!Array.isArray(updates)) {
            return res.status(400).json({ error: 'Ожидается массив товаров' });
        }

        console.log(`📡 Получено обновление цен: ${updates.length} товаров`);

        // 1. Обновляем в локальной SQLite
        const updateStmt = db.prepare(`
            UPDATE catalog SET 
                quantity = ?, price_retail = ?, price_diller = ?,
                price_mp = ?, store_spb = ?, store_ekb = ?, lastUpdated = ?
            WHERE id = ?
        `);

        const updatedProducts: LutnerUpdate[] = [];
        for (const update of updates) {
            updateStmt.run(
                update.quantity, update.price_retail, update.price_diller,
                update.price_mp, update.store_spb, update.store_ekb,
                Date.now(), update.id
            );
            updatedProducts.push(update);
        }

        // 2. Обновляем в Tilda через API
        await updatePricesInTilda(updatedProducts);

        console.log(`✅ Обновлено ${updatedProducts.length} товаров`);
        res.json({ status: 'ok', updated: updatedProducts.length });

    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Эндпоинт для проверки статуса
 * GET /api/status
 */
app.get('/api/status', (req: Request, res: Response) => {
    try {
        const countStmt = db.prepare('SELECT COUNT(*) as count FROM catalog');
        const count = countStmt.get() as { count: number };

        const lastUpdateStmt = db.prepare('SELECT MAX(lastUpdated) as last FROM catalog');
        const lastUpdate = lastUpdateStmt.get() as { last: number | null };

        const response: StatusResponse = {
            success: true,
            totalProducts: count.count,
            lastUpdate: lastUpdate.last ? new Date(lastUpdate.last).toISOString() : null,
            tildaConfigured: !!(PUBLIC_KEY && SECRET_KEY)
        };

        res.json(response);
    } catch (error) {
        console.error('Ошибка при получении статуса:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Получение списка товаров (с пагинацией)
 * GET /api/products?page=1&limit=20
 */
app.get('/api/products', (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        const productsStmt = db.prepare(`
            SELECT * FROM catalog 
            ORDER BY name ASC 
            LIMIT ? OFFSET ?
        `);
        const products = productsStmt.all(limit, offset) as GuitarProduct[];

        const countStmt = db.prepare('SELECT COUNT(*) as total FROM catalog');
        const { total } = countStmt.get() as { total: number };

        const response: CatalogResponse = {
            success: true,
            total: total,
            lastUpdate: products[0]?.lastUpdated ? new Date(products[0].lastUpdated).toISOString() : null,
            products: products
        };

        res.json(response);
    } catch (error) {
        console.error('Ошибка при получении товаров:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Корневой эндпоинт
 * GET /
 */
app.get('/', (req: Request, res: Response) => {
    const countStmt = db.prepare('SELECT COUNT(*) as c FROM catalog');
    const count = (countStmt.get() as { c: number }).c;

    res.send(`
        <h2>🎸 Guitar Shop API Server (TypeScript)</h2>
        <p>✅ Сервер работает</p>
        <p>🔗 <a href="/api/status">Статус каталога</a></p>
        <p>📦 <a href="/api/products">Товары (первые 20)</a></p>
        <hr>
        <h3>📊 Конфигурация:</h3>
        <ul>
            <li>Tilda API: ${PUBLIC_KEY ? '✅ настроен' : '❌ не настроен'}</li>
            <li>База данных: ${count > 0 ? '✅ заполнена' : '⏳ ожидает загрузки'}</li>
        </ul>
    `);
});

// ========== ЗАПУСК СЕРВЕРА ==========

async function startServer(): Promise<void> {
    // Проверяем, пуста ли база данных
    const countStmt = db.prepare('SELECT COUNT(*) as c FROM catalog');
    const count = (countStmt.get() as { c: number }).c;

    if (count === 0) {
        console.log('📥 База пуста, загружаем CSV...');
        const products = await downloadAndSaveToDB();
        
        if (products && products.length > 0 && PUBLIC_KEY && SECRET_KEY) {
            console.log('🔄 Отправляем данные в Tilda API...');
            await syncCatalogToTilda(products);
        } else if (!PUBLIC_KEY || !SECRET_KEY) {
            console.warn('⚠️ Tilda API ключи не настроены. Синхронизация отключена.');
        }
    } else {
        console.log(`📚 В базе уже ${count} товаров`);
    }

    // Запускаем сервер
    app.listen(PORT, () => {
        console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
        console.log(`📍 Эндпоинт для поставщика: POST /api/update-from-lutner`);
        console.log(`📍 Проверка статуса: GET /api/status`);
        console.log(`📍 Товары с пагинацией: GET /api/products?page=1&limit=20\n`);
    });

    // Плановое обновление CSV раз в сутки (24 часа = 86400000 мс)
    setInterval(async () => {
        console.log('🔄 Плановое обновление каталога из CSV...');
        const products = await downloadAndSaveToDB();
        if (products && products.length > 0 && PUBLIC_KEY && SECRET_KEY) {
            await syncCatalogToTilda(products);
        }
    }, 86400000);
}

// ========== ДОБАВЛЯЕМ ПОСЛЕ СУЩЕСТВУЮЩИХ ЭНДПОИНТОВ ==========

/**
 * Административная панель (HTML интерфейс)
 * GET /admin
 */
app.get('/admin', (req: Request, res: Response) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Админ-панель | Guitar Shop API</title>
            <style>
                * {
                    box-sizing: border-box;
                }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: #f5f5f5;
                    margin: 0;
                    padding: 20px;
                }
                .container {
                    max-width: 1200px;
                    margin: 0 auto;
                }
                h1 {
                    color: #2c5f2d;
                    margin-bottom: 10px;
                }
                .subtitle {
                    color: #666;
                    margin-bottom: 30px;
                    border-bottom: 1px solid #ddd;
                    padding-bottom: 10px;
                }
                .status-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    margin-bottom: 20px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                }
                .status-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 15px;
                    margin-top: 15px;
                }
                .status-item {
                    background: #f9f9f9;
                    padding: 15px;
                    border-radius: 8px;
                    text-align: center;
                }
                .status-label {
                    font-size: 12px;
                    color: #888;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                }
                .status-value {
                    font-size: 28px;
                    font-weight: bold;
                    color: #333;
                }
                .status-value.synced {
                    color: #2c5f2d;
                }
                .status-value.pending {
                    color: #e67e22;
                }
                .button-group {
                    display: flex;
                    gap: 15px;
                    flex-wrap: wrap;
                    margin-top: 20px;
                }
                .btn {
                    padding: 12px 24px;
                    border: none;
                    border-radius: 8px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .btn-primary {
                    background: #2c5f2d;
                    color: white;
                }
                .btn-primary:hover {
                    background: #1e3b1f;
                    transform: translateY(-1px);
                }
                .btn-secondary {
                    background: #3498db;
                    color: white;
                }
                .btn-secondary:hover {
                    background: #2980b9;
                }
                .btn-danger {
                    background: #e74c3c;
                    color: white;
                }
                .btn-danger:hover {
                    background: #c0392b;
                }
                .btn-warning {
                    background: #e67e22;
                    color: white;
                }
                .btn-warning:hover {
                    background: #d35400;
                }
                .btn:disabled {
                    background: #ccc;
                    cursor: not-allowed;
                    transform: none;
                }
                .log-container {
                    background: #1e1e1e;
                    color: #d4d4d4;
                    border-radius: 8px;
                    padding: 15px;
                    font-family: 'Courier New', monospace;
                    font-size: 12px;
                    height: 300px;
                    overflow-y: auto;
                    margin-top: 20px;
                }
                .log-entry {
                    margin-bottom: 4px;
                    border-bottom: 1px solid #333;
                    padding: 4px 0;
                }
                .log-entry.info { color: #4ec9b0; }
                .log-entry.error { color: #f48771; }
                .log-entry.success { color: #6a9955; }
                .log-entry.warning { color: #dcdcaa; }
                .spinner {
                    display: inline-block;
                    width: 14px;
                    height: 14px;
                    border: 2px solid #fff;
                    border-top-color: transparent;
                    border-radius: 50%;
                    animation: spin 0.6s linear infinite;
                    margin-left: 8px;
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                .refresh-btn {
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    padding: 0 8px;
                }
                .flex-between {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                hr {
                    margin: 20px 0;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="flex-between">
                    <div>
                        <h1>🎸 Guitar Shop API</h1>
                        <div class="subtitle">Управление каталогом гитар и синхронизация с Tilda</div>
                    </div>
                    <button class="refresh-btn" onclick="loadAllData()" title="Обновить">🔄</button>
                </div>
                
                <!-- Статус -->
                <div class="status-card" id="status-card">
                    <h3>📊 Статус синхронизации</h3>
                    <div id="status-content">Загрузка...</div>
                </div>
                
                <!-- Кнопки управления -->
                <div class="status-card">
                    <h3>⚙️ Управление процессами</h3>
                    <div class="button-group">
                        <button class="btn btn-primary" id="btn-load-csv" onclick="loadCSV()">
                            📥 Загрузить CSV в БД
                        </button>
                        <button class="btn btn-secondary" id="btn-sync-tilda" onclick="syncToTilda()">
                            🔄 Синхронизировать с Tilda
                        </button>
                        <button class="btn btn-warning" id="btn-sync-prices" onclick="testPriceUpdate()">
                            💰 Тест обновления цен
                        </button>
                    </div>
                    <div class="button-group" style="margin-top: 10px;">
                        <button class="btn btn-danger" id="btn-reset-sync" onclick="resetSyncFlags()">
                            🔄 Сбросить флаги синхронизации
                        </button>
                        <button class="btn btn-secondary" id="btn-check-status" onclick="loadAllData()">
                            🔍 Проверить статус
                        </button>
                    </div>
                </div>
                
                <!-- Логи -->
                <div class="status-card">
                    <div class="flex-between">
                        <h3>📜 Лог операций</h3>
                        <button class="refresh-btn" onclick="clearLogs()" title="Очистить">🗑️</button>
                    </div>
                    <div class="log-container" id="log-container">
                        <div class="log-entry info">✨ Готов к работе. Используйте кнопки выше для управления.</div>
                    </div>
                </div>
            </div>
            
            <script>
                // Хранилище логов
                let logs = ['✨ Готов к работе. Используйте кнопки выше для управления.'];
                
                function addLog(message, type = 'info') {
                    const timestamp = new Date().toLocaleTimeString();
                    logs.unshift(\`[\${timestamp}] \${message}\`);
                    if (logs.length > 50) logs.pop();
                    renderLogs();
                }
                
                function renderLogs() {
                    const container = document.getElementById('log-container');
                    container.innerHTML = logs.map(log => {
                        let type = 'info';
                        if (log.includes('✅')) type = 'success';
                        else if (log.includes('❌')) type = 'error';
                        else if (log.includes('⚠️')) type = 'warning';
                        return \`<div class="log-entry \${type}">\${escapeHtml(log)}</div>\`;
                    }).join('');
                }
                
                function clearLogs() {
                    logs = [];
                    addLog('🧹 Лог очищен');
                }
                
                function escapeHtml(text) {
                    const div = document.createElement('div');
                    div.textContent = text;
                    return div.innerHTML;
                }
                
                async function loadAllData() {
                    await loadStatus();
                    await loadSyncStatus();
                }
                
                async function loadStatus() {
                    try {
                        const response = await fetch('/api/status');
                        const data = await response.json();
                        
                        document.getElementById('status-content').innerHTML = \`
                            <div class="status-grid">
                                <div class="status-item">
                                    <div class="status-label">Всего товаров</div>
                                    <div class="status-value">\${data.totalProducts || 0}</div>
                                </div>
                                <div class="status-item">
                                    <div class="status-label">Последнее обновление</div>
                                    <div class="status-value" style="font-size: 14px;">\${data.lastUpdate ? new Date(data.lastUpdate).toLocaleString() : 'никогда'}</div>
                                </div>
                                <div class="status-item">
                                    <div class="status-label">Tilda API</div>
                                    <div class="status-value" style="font-size: 14px; color: \${data.tildaConfigured ? '#2c5f2d' : '#e74c3c'}">
                                        \${data.tildaConfigured ? '✅ Подключен' : '❌ Не настроен'}
                                    </div>
                                </div>
                            </div>
                        \`;
                    } catch (error) {
                        document.getElementById('status-content').innerHTML = \`<div style="color: red;">Ошибка загрузки статуса: \${error.message}</div>\`;
                        addLog(\`❌ Ошибка загрузки статуса: \${error.message}\`, 'error');
                    }
                }
                
                async function loadSyncStatus() {
                    try {
                        const response = await fetch('/api/sync-status');
                        const data = await response.json();
                        
                        // Добавляем информацию о синхронизации в существующий блок
                        const syncHtml = \`
                            <div style="margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px;">
                                <div class="status-grid">
                                    <div class="status-item">
                                        <div class="status-label">Синхронизировано с Tilda</div>
                                        <div class="status-value synced">\${data.synced_to_tilda || 0}</div>
                                    </div>
                                    <div class="status-item">
                                        <div class="status-label">Ожидают синхронизации</div>
                                        <div class="status-value pending">\${data.pending_sync || 0}</div>
                                    </div>
                                    <div class="status-item">
                                        <div class="status-label">Прогресс</div>
                                        <div class="status-value">\${data.total_products > 0 ? Math.round((data.synced_to_tilda / data.total_products) * 100) : 0}%</div>
                                    </div>
                                </div>
                                \${data.sync_in_progress ? '<div style="background: #fff3cd; padding: 10px; border-radius: 8px; margin-top: 10px;"><span class="spinner"></span> ⚡ Синхронизация в процессе...</div>' : ''}
                            </div>
                        \`;
                        
                        // Добавляем к существующему содержимому
                        const statusContent = document.getElementById('status-content');
                        statusContent.insertAdjacentHTML('beforeend', syncHtml);
                    } catch (error) {
                        addLog(\`❌ Ошибка загрузки статуса синхронизации: \${error.message}\`, 'error');
                    }
                }
                
                async function loadCSV() {
                    const btn = document.getElementById('btn-load-csv');
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '⏳ Загрузка...';
                    btn.disabled = true;
                    addLog('📥 Запуск загрузки CSV из lutner.ru...');
                    
                    try {
                        const response = await fetch('/api/load-csv', { method: 'POST' });
                        const data = await response.json();
                        
                        if (data.success) {
                            addLog(\`✅ \${data.message}\`, 'success');
                        } else {
                            addLog(\`❌ Ошибка: \${data.error}\`, 'error');
                        }
                        await loadAllData();
                    } catch (error) {
                        addLog(\`❌ Ошибка: \${error.message}\`, 'error');
                    } finally {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                    }
                }
                
                async function syncToTilda() {
                    const btn = document.getElementById('btn-sync-tilda');
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '⏳ Запуск...';
                    btn.disabled = true;
                    addLog('🔄 Запуск синхронизации с Tilda API...');
                    addLog('⚠️ Это может занять несколько часов из-за лимитов API');
                    
                    try {
                        const response = await fetch('/api/sync-to-tilda', { method: 'POST' });
                        const data = await response.json();
                        
                        if (data.success) {
                            addLog(\`✅ \${data.message}\`, 'success');
                            // Начинаем polling статуса
                            startStatusPolling();
                        } else {
                            addLog(\`❌ Ошибка: \${data.message}\`, 'error');
                        }
                        await loadAllData();
                    } catch (error) {
                        addLog(\`❌ Ошибка: \${error.message}\`, 'error');
                    } finally {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                    }
                }
                
                async function testPriceUpdate() {
                    const btn = document.getElementById('btn-sync-prices');
                    const originalText = btn.innerHTML;
                    btn.innerHTML = '⏳ Отправка...';
                    btn.disabled = true;
                    
                    // Тестовые данные для обновления цен
                    const testData = [
                        {
                            id: "test-guitar-001",
                            quantity: 10,
                            price_retail: 45000,
                            price_diller: 35000,
                            price_mp: 42000,
                            store_spb: 7,
                            store_ekb: 3
                        }
                    ];
                    
                    addLog('💰 Отправка тестового обновления цен...');
                    
                    try {
                        const response = await fetch('/api/update-from-lutner', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(testData)
                        });
                        const data = await response.json();
                        
                        if (data.status === 'ok') {
                            addLog(\`✅ Тестовое обновление отправлено. Обновлено \${data.updated} товаров.\`, 'success');
                        } else {
                            addLog(\`❌ Ошибка: \${JSON.stringify(data)}\`, 'error');
                        }
                        await loadAllData();
                    } catch (error) {
                        addLog(\`❌ Ошибка: \${error.message}\`, 'error');
                    } finally {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                    }
                }
                
                async function resetSyncFlags() {
                    if (!confirm('⚠️ ВНИМАНИЕ! Сброс флагов синхронизации отметит все товары как "не синхронизированные". После этого потребуется полная синхронизация. Продолжить?')) {
                        return;
                    }
                    
                    addLog('🔄 Сброс флагов синхронизации...');
                    
                    try {
                        const response = await fetch('/api/reset-sync-flags', { method: 'POST' });
                        const data = await response.json();
                        
                        if (data.success) {
                            addLog(\`✅ \${data.message}\`, 'success');
                        } else {
                            addLog(\`❌ Ошибка: \${data.error}\`, 'error');
                        }
                        await loadAllData();
                    } catch (error) {
                        addLog(\`❌ Ошибка: \${error.message}\`, 'error');
                    }
                }
                
                let pollingInterval = null;
                
                function startStatusPolling() {
                    if (pollingInterval) clearInterval(pollingInterval);
                    
                    pollingInterval = setInterval(async () => {
                        try {
                            const response = await fetch('/api/sync-status');
                            const data = await response.json();
                            
                            if (!data.sync_in_progress) {
                                clearInterval(pollingInterval);
                                pollingInterval = null;
                                addLog('✅ Синхронизация завершена!', 'success');
                                await loadAllData();
                            }
                        } catch (error) {
                            console.error('Polling error:', error);
                        }
                    }, 5000);
                }
                
                // Загружаем данные при загрузке страницы
                loadAllData();
            </script>
        </body>
        </html>
    `);
});

/**
 * Сброс флагов синхронизации (помечаем все товары как несинхронизированные)
 * POST /api/reset-sync-flags
 */
app.post('/api/reset-sync-flags', (req: Request, res: Response) => {
    try {
        db.prepare("UPDATE catalog SET synced_to_tilda = 0").run();
        const count = db.prepare("SELECT COUNT(*) as count FROM catalog").get() as { count: number };
        
        res.json({
            success: true,
            message: `Сброшены флаги для ${count.count} товаров. Теперь они будут синхронизированы при следующем запуске.`
        });
    } catch (error) {
        console.error('Ошибка сброса флагов:', error);
        res.status(500).json({ success: false, error: 'Ошибка сброса флагов' });
    }
});

/**
 * Получение последних логов сервера (опционально)
 * GET /api/logs
 */
let serverLogs: string[] = [];

function addServerLog(message: string, type: string = 'info') {
    const timestamp = new Date().toISOString();
    serverLogs.unshift(`[${timestamp}] [${type}] ${message}`);
    if (serverLogs.length > 100) serverLogs.pop();
}

app.get('/api/logs', (req: Request, res: Response) => {
    res.json({ logs: serverLogs });
});

// Запускаем сервер с обработкой ошибок
startServer().catch((error) => {
    console.error('❌ Критическая ошибка при запуске сервера:', error);
    process.exit(1);
});