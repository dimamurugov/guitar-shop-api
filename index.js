const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const csv = require('csv-parser');
const { createReadStream } = require('fs');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: ['https://project16053916.tilda.ws'] }));
app.use(express.json());

const CATALOG_FILE = path.join(__dirname, 'catalog_cache.json');
const CSV_URL = 'https://lutner.ru/bitrix/catalog_export/upload/hour.csv';

// ========== 1. ЗАГРУЗКА CSV (раз в сутки) - базовые данные ==========
async function downloadAndBuildCatalog() {
    try {
        console.log('🔄 Загрузка CSV...');
        const response = await fetch(CSV_URL);
        const csvText = await response.text();
        
        const tempCsvPath = path.join(__dirname, 'temp.csv');
        await fs.writeFile(tempCsvPath, csvText, 'utf8');
        
        const products = [];
        await pipeline(
            createReadStream(tempCsvPath),
            csv({ separator: ';', headers: true }),
            async function* (source) {
                for await (const row of source) {
                    products.push({
                        id: row.IE_XML_ID,
                        name: row.IE_NAME || 'Без названия',
                        brand: row.IP_PROP96 || '',
                        description: row.IP_PROP100 || '',
                        // Временно заполняем из CSV, но потом обновим из API
                        quantity: parseInt(row.CP_QUANTITY) || 0,
                        price_retail: parseFloat(row.CV_PRICE_13) || 0,
                        price_diller: parseFloat(row.CV_PRICE_18) || 0,
                        price_mp: parseFloat(row.CV_PRICE_20) || 0,
                        store_spb: parseInt(row.CP_STORE_SPB) || 0,
                        store_ekb: parseInt(row.CP_STORE_EKB) || 0,
                        sale: parseFloat(row.CP_SALE) || 0,
                        lastUpdated: Date.now()
                    });
                }
            }
        );
        
        // Преобразуем в объект { id: product }
        const catalog = {};
        products.forEach(p => { catalog[p.id] = p; });
        
        await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2));
        await fs.unlink(tempCsvPath);
        
        console.log(`✅ CSV загружен: ${products.length} товаров`);
        return products.length;
        
    } catch (error) {
        console.error('❌ Ошибка загрузки CSV:', error);
        return 0;
    }
}

// ========== 2. API ДЛЯ ПОСТАВЩИКА (обновление цен и остатков) ==========
// Формат данных от поставщика:
// [
//   {
//     "id": "f5d28cba-afb2-11ea-9560-001e67103b79",
//     "quantity": 0,
//     "price_retail": 780,
//     "price_diller": 497,
//     "price_mp": 936,
//     "store_spb": 0,
//     "store_ekb": 0
//   }
// ]
app.post('/api/update-from-lutner', async (req, res) => {
    try {
        const updates = req.body;
        
        // Валидация: проверяем, что это массив
        if (!Array.isArray(updates)) {
            console.error('Ошибка: получены не массив данных');
            return res.status(400).json({ 
                error: 'Invalid data format. Expected array of products.' 
            });
        }
        
        console.log(`📡 Получено обновление от поставщика: ${updates.length} товаров`);
        
        // Загружаем текущий каталог
        let catalog = {};
        try {
            const data = await fs.readFile(CATALOG_FILE, 'utf8');
            catalog = JSON.parse(data);
        } catch (err) {
            console.log('Каталог ещё не создан, создаём новый');
        }
        
        let updatedCount = 0;
        let newCount = 0;
        
        // Обновляем данные для каждого товара из API
        for (const update of updates) {
            // Проверяем обязательные поля
            if (!update.id) {
                console.warn('Пропущен товар без ID');
                continue;
            }
            
            if (catalog[update.id]) {
                // Обновляем только те поля, которые пришли от поставщика
                // (сохраняем name, brand, description из CSV)
                catalog[update.id].quantity = update.quantity !== undefined ? update.quantity : catalog[update.id].quantity;
                catalog[update.id].price_retail = update.price_retail !== undefined ? update.price_retail : catalog[update.id].price_retail;
                catalog[update.id].price_diller = update.price_diller !== undefined ? update.price_diller : catalog[update.id].price_diller;
                catalog[update.id].price_mp = update.price_mp !== undefined ? update.price_mp : catalog[update.id].price_mp;
                catalog[update.id].store_spb = update.store_spb !== undefined ? update.store_spb : catalog[update.id].store_spb;
                catalog[update.id].store_ekb = update.store_ekb !== undefined ? update.store_ekb : catalog[update.id].store_ekb;
                catalog[update.id].lastUpdated = Date.now();
                updatedCount++;
            } else {
                // Новый товар (его нет в CSV)
                catalog[update.id] = {
                    id: update.id,
                    name: `Товар ${update.id}`,
                    quantity: update.quantity || 0,
                    price_retail: update.price_retail || 0,
                    price_diller: update.price_diller || 0,
                    price_mp: update.price_mp || 0,
                    store_spb: update.store_spb || 0,
                    store_ekb: update.store_ekb || 0,
                    lastUpdated: Date.now(),
                    brand: '',
                    description: ''
                };
                newCount++;
            }
        }
        
        // Сохраняем обновлённый каталог
        await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2));
        
        console.log(`✅ Обновлено: ${updatedCount} товаров, добавлено: ${newCount}`);
        console.log(`📊 Всего товаров в каталоге: ${Object.keys(catalog).length}`);
        
        // Отвечаем поставщику, что всё принято (обязательно!)
        res.status(200).json({ 
            status: 'ok',
            received: updates.length,
            updated: updatedCount,
            added: newCount,
            total: Object.keys(catalog).length,
            timestamp: Date.now()
        });
        
    } catch (error) {
        console.error('❌ Ошибка при обработке запроса от поставщика:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
});

// ========== 3. ЭНДПОИНТ ДЛЯ TILDA ==========
app.get('/api/catalog', async (req, res) => {
    try {
        const data = await fs.readFile(CATALOG_FILE, 'utf8');
        const catalog = JSON.parse(data);
        const products = Object.values(catalog);
        
        console.log(`📤 Отправлено ${products.length} товаров на Tilda`);
        
        // Формируем ответ в удобном для Tilda формате
        res.json({
            success: true,
            count: products.length,
            lastUpdate: products[0]?.lastUpdated || null,
            products: products.map(p => ({
                // Основные поля для отображения на сайте
                id: p.id,
                name: p.name,
                description: p.description,
                brand: p.brand,
                
                // Цены и остатки (актуальные из API)
                quantity: p.quantity,
                price_retail: p.price_retail,
                price_diller: p.price_diller,
                price_mp: p.price_mp,
                store_spb: p.store_spb,
                store_ekb: p.store_ekb,
                
                // Служебная информация
                lastUpdated: p.lastUpdated,
                sale: p.sale || 0
            }))
        });
        
    } catch (error) {
        console.log('Каталог ещё не создан');
        res.json({
            success: true,
            count: 0,
            products: []
        });
    }
});

// ========== 4. ПРОВЕРОЧНЫЙ ЭНДПОИНТ ДЛЯ ТЕСТИРОВАНИЯ ==========
app.get('/api/test-update', async (req, res) => {
    // Тестовые данные в формате поставщика
    const testData = [
        {
            "id": "test-guitar-001",
            "quantity": 10,
            "price_retail": 45000,
            "price_diller": 35000,
            "price_mp": 42000,
            "store_spb": 7,
            "store_ekb": 3
        },
        {
            "id": "test-guitar-002",
            "quantity": 5,
            "price_retail": 89000,
            "price_diller": 69000,
            "price_mp": 85000,
            "store_spb": 4,
            "store_ekb": 1
        }
    ];
    
    // Имитируем запрос от поставщика
    const mockReq = { body: testData };
    const mockRes = {
        status: (code) => ({ json: (data) => console.log('Response:', code, data) })
    };
    
    await app.handle(mockReq, mockRes);
    res.json({ message: 'Тестовые данные отправлены на /api/update-from-lutner' });
});

// ========== 5. КОРНЕВОЙ ЭНДПОИНТ ==========
app.get('/', (req, res) => {
    res.send(`
        <h2>🎸 Guitar Shop API Server</h2>
        <p>✅ Сервер работает</p>
        <p>📦 <a href="/api/catalog">Просмотреть каталог</a></p>
        <hr>
        <h3>🔌 Доступные эндпоинты:</h3>
        <ul>
            <li><strong>POST /api/update-from-lutner</strong> - для поставщика (обновление цен/остатков)</li>
            <li><strong>GET /api/catalog</strong> - для Tilda (получение каталога)</li>
            <li><strong>GET /api/test-update</strong> - для тестирования (отправляет тестовые данные)</li>
        </ul>
        <hr>
        <p>📊 Статус каталога: <span id="status">загрузка...</span></p>
        <script>
            fetch('/api/catalog')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('status').innerHTML = 
                        \`✅ \${data.count} товаров (последнее обновление: \${new Date(data.lastUpdate).toLocaleString()})\`;
                })
                .catch(e => document.getElementById('status').innerHTML = '❌ Ошибка загрузки');
        </script>
    `);
});

// ========== 6. ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, async () => {
    console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📍 Эндпоинт для поставщика: POST /api/update-from-lutner`);
    console.log(`📍 Эндпоинт для Tilda: GET /api/catalog\n`);
    
    // Загружаем CSV при старте
    console.log('📥 Инициализация каталога...');
    const count = await downloadAndBuildCatalog();
    console.log(`✅ Готово: ${count} товаров в каталоге\n`);
});