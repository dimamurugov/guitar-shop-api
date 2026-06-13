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

// Запускаем сервер с обработкой ошибок
startServer().catch((error) => {
    console.error('❌ Критическая ошибка при запуске сервера:', error);
    process.exit(1);
});