import express, { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import cors from 'cors';
import csv from 'csv-parser';
import { createReadStream } from 'fs';
import Database from 'better-sqlite3';

interface Product {
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
}

interface CatalogResponse {
    success: boolean;
    count: number;
    lastUpdate: number | null;
    products: Product[];
    error?: string;
}

interface DebugResponse {
    success: boolean;
    totalProducts: number;
    latestUpdate: number | null;
    uniqueBrands: number;
    brands: string[];
    error?: string;
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors({ origin: ['https://project16053916.tilda.ws'] }));

const DB_PATH = path.join(__dirname, 'catalog.db');
const CSV_URL = 'https://lutner.ru/bitrix/catalog_export/upload/hour.csv';

// Инициализация БД
const db = new Database(DB_PATH);

// Создание таблицы
db.exec(`
    DROP TABLE IF EXISTS products;
    CREATE TABLE products (
        id TEXT,
        name TEXT NOT NULL,
        brand TEXT,
        description TEXT,
        quantity INTEGER DEFAULT 0,
        price_retail REAL DEFAULT 0,
        price_diller REAL DEFAULT 0,
        price_mp REAL DEFAULT 0,
        store_spb INTEGER DEFAULT 0,
        store_ekb INTEGER DEFAULT 0,
        sale REAL DEFAULT 0,
        lastUpdated INTEGER NOT NULL
    )
`);

// ========== 1. ЗАГРУЗКА CSV И СОЗДАНИЕ КАТАЛОГА ==========
async function downloadAndBuildCatalog(): Promise<number> {
    try {
        console.log('🔄 Загрузка CSV с гитарами...');
        const response = await fetch(CSV_URL);
        const csvText = await response.text();
        
        const tempCsvPath = path.join(__dirname, 'temp.csv');
        await fs.writeFile(tempCsvPath, csvText, 'utf8');
        
        const products: Product[] = [];
        
        await new Promise<void>((resolve, reject) => {
            createReadStream(tempCsvPath, { encoding: 'utf8' })
                .pipe(csv({
                    separator: ';',
                    mapHeaders: ({ header }) => header.trim()
                }))
                .on('data', (row: any) => {
                    products.push({
                        id: (row.IE_XML_ID as string) || '',
                        name: (row.IE_NAME as string) || 'Без названия',
                        brand: (row.IP_PROP96 as string) || '',
                        description: (row.IP_PROP100 as string) || '',
                        quantity: parseInt(row.CP_QUANTITY as string) || 0,
                        price_retail: parseFloat(row.CV_PRICE_13 as string) || 0,
                        price_diller: parseFloat(row.CV_PRICE_18 as string) || 0,
                        price_mp: parseFloat(row.CV_PRICE_20 as string) || 0,
                        store_spb: parseInt(row.CP_STORE_SPB as string) || 0,
                        store_ekb: parseInt(row.CP_STORE_EKB as string) || 0,
                        sale: parseFloat(row.CP_SALE as string) || 0,
                        lastUpdated: Date.now()
                    });
                })
                .on('end', () => resolve())
                .on('error', reject);
        });
        
        console.log(`📊 Собрано ${products.length} товаров`);
        
        db.prepare('DROP TABLE IF EXISTS products').run();
        
        db.exec(`
            CREATE TABLE products (
                id TEXT,
                name TEXT NOT NULL,
                brand TEXT,
                description TEXT,
                quantity INTEGER DEFAULT 0,
                price_retail REAL DEFAULT 0,
                price_diller REAL DEFAULT 0,
                price_mp REAL DEFAULT 0,
                store_spb INTEGER DEFAULT 0,
                store_ekb INTEGER DEFAULT 0,
                sale REAL DEFAULT 0,
                lastUpdated INTEGER NOT NULL
            )
        `);
        
        const insert = db.prepare(`
            INSERT INTO products (id, name, brand, description, quantity, price_retail, price_diller, price_mp, store_spb, store_ekb, sale, lastUpdated)
            VALUES (@id, @name, @brand, @description, @quantity, @price_retail, @price_diller, @price_mp, @store_spb, @store_ekb, @sale, @lastUpdated)
        `);
        
        const insertMany = db.transaction((products: Product[]) => {
            for (const product of products) {
                insert.run(product);
            }
        });
        
        insertMany(products);
        
        await fs.unlink(tempCsvPath);
        
        const count = db.prepare('SELECT COUNT(*) as count FROM products').get() as { count: number };
        console.log(`✅ Каталог сохранён в БД: ${count.count} гитар`);
        return count.count;
        
    } catch (error) {
        console.error('❌ Ошибка загрузки CSV:', error);
        if (error instanceof Error) {
            console.error(error.stack);
        }
        return 0;
    }
}

// ========== 2. ЭНДПОИНТ ДЛЯ TILDA ==========
app.get('/api/catalog', (_req: Request, res: Response<CatalogResponse>) => {
    try {
        const count = db.prepare('SELECT COUNT(*) as count FROM products').get() as { count: number };
        const products = db.prepare('SELECT * FROM products').all() as Product[];
        
        console.log(`📤 Отправлено ${products.length} товаров на Tilda`);
        
        // Для отладки: показываем первые 3 товара
        if (products.length > 0) {
            console.log(`🔍 Первые 3 товара в ответе:`);
            products.slice(0, 3).forEach((p, i) => {
                console.log(`   ${i+1}. ${p.name} (${p.id})`);
            });
        }
        
        res.json({
            success: true,
            count: products.length,
            lastUpdate: products[0]?.lastUpdated || null,
            products: products
        });
        
    } catch (error) {
        console.error('❌ Ошибка в эндпоинте /api/catalog:', error);
        if (error instanceof Error) {
            console.error(error.stack);
        }
        res.json({
            success: false,
            count: 0,
            products: [],
            lastUpdate: null,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// ========== 4. КОРНЕВОЙ ЭНДПОИНТ ==========
app.get('/', (_req: Request, res: Response) => {
    const count = db.prepare('SELECT COUNT(*) as count FROM products').get() as { count: number };
    res.send(`
        <h2>🎸 Guitar Shop API Server</h2>
        <p>✅ Сервер работает</p>
        <p>📦 <a href="/api/catalog">Просмотреть каталог</a></p>
        <p>🔧 <a href="/api/debug">Диагностика</a></p>
        <hr>
        <p>📊 Статус: <span id="status">загрузка...</span></p>
        <script>
            fetch('/api/catalog')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('status').innerHTML = 
                        \`✅ \${data.count} гитар (обновлено: \${data.lastUpdate ? new Date(data.lastUpdate).toLocaleString() : 'никогда'})\`;
                })
                .catch(e => document.getElementById('status').innerHTML = '❌ Ошибка: ' + e.message);
        </script>
    `);
});

// ========== 4.1 ЭНДПОИНТ ДИАГНОСТИКИ ==========
app.get('/api/debug', (_req: Request, res: Response<DebugResponse>) => {
    try {
        const count = db.prepare('SELECT COUNT(*) as count FROM products').get() as { count: number };
        const latest = db.prepare('SELECT * FROM products ORDER BY lastUpdated DESC LIMIT 1').get() as Product | undefined;
        const brands = db.prepare("SELECT DISTINCT brand FROM products WHERE brand != ''").all() as { brand: string }[];
        
        res.json({
            success: true,
            totalProducts: count.count,
            latestUpdate: latest?.lastUpdated || null,
            uniqueBrands: brands.length,
            brands: brands.map(b => b.brand).slice(0, 20)
        });
    } catch (error) {
        res.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            totalProducts: 0,
            latestUpdate: null,
            uniqueBrands: 0,
            brands: []
        });
    }
});

// ========== 5. ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, async () => {
    console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📍 Эндпоинт для Tilda: GET /api/catalog`);
    console.log(`📍 Диагностика: GET /api/debug\n`);
    
    // Загружаем CSV при старте
    console.log('📥 Загрузка каталога...');
    const count = await downloadAndBuildCatalog();
    console.log(`✅ Готово: ${count} гитар в базе\n`);
    
    // Обновляем каталог раз в сутки (86400000 мс)
    setInterval(async () => {
        console.log('🔄 Плановое обновление каталога...');
        await downloadAndBuildCatalog();
    }, 86400000);
});

// Закрытие БД при остановке
process.on('SIGINT', () => {
    db.close();
    console.log('\n✅ База данных закрыта');
    process.exit(0);
});

process.on('SIGTERM', () => {
    db.close();
    console.log('\n✅ База данных закрыта');
    process.exit(0);
});
