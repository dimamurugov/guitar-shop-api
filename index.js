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

const CATALOG_FILE = path.join(__dirname, 'catalog_cache.json');
const CSV_URL = 'https://lutner.ru/bitrix/catalog_export/upload/hour.csv';

// ========== 1. ЗАГРУЗКА CSV И СОЗДАНИЕ КАТАЛОГА ==========
async function downloadAndBuildCatalog() {
    try {
        console.log('🔄 Загрузка CSV с гитарами...');
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
        
        // Проверяем, что products - это массив
        console.log(`📊 Собрано ${products.length} товаров в массиве`);
        console.log(`📝 Первый товар: ${products[0]?.name} (${products[0]?.id})`);
        console.log(`📝 Последний товар: ${products[products.length-1]?.name}`);
        
        // Сохраняем каталог как МАССИВ (не объект)
        await fs.writeFile(CATALOG_FILE, JSON.stringify(products, null, 2));
        
        // Проверяем, что записалось
        const verify = await fs.readFile(CATALOG_FILE, 'utf8');
        const parsed = JSON.parse(verify);
        console.log(`✅ Проверка: в файле ${parsed.length} товаров`);
        
        await fs.unlink(tempCsvPath);
        
        console.log(`✅ Каталог сохранён: ${products.length} гитар`);
        return products.length;
        
    } catch (error) {
        console.error('❌ Ошибка загрузки CSV:', error);
        console.error(error.stack);
        return 0;
    }
}

// ========== 2. ЭНДПОИНТ ДЛЯ TILDA ==========
app.get('/api/catalog', async (req, res) => {
    try {
        // Проверяем, существует ли файл
        try {
            await fs.access(CATALOG_FILE);
        } catch (err) {
            console.log('❌ Файл каталога не найден');
            return res.json({
                success: true,
                count: 0,
                products: []
            });
        }
        
        // Читаем файл
        const data = await fs.readFile(CATALOG_FILE, 'utf8');
        console.log(`📄 Размер файла: ${data.length} байт`);
        
        // Парсим JSON
        let products;
        try {
            products = JSON.parse(data);
        } catch (parseErr) {
            console.error('❌ Ошибка парсинга JSON:', parseErr);
            return res.json({
                success: true,
                count: 0,
                products: [],
                error: 'JSON parse error'
            });
        }
        
        // Проверяем, что products - это массив
        if (!Array.isArray(products)) {
            console.error('❌ products не является массивом, это:', typeof products);
            console.log(`📦 Тип: ${typeof products}, содержимое: ${Object.keys(products).length} ключей`);
            
            // Если это объект, конвертируем в массив
            if (typeof products === 'object' && products !== null) {
                products = Object.values(products);
                console.log(`🔄 Конвертировано в массив: ${products.length} товаров`);
            }
        }
        
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
        console.error(error.stack);
        res.json({
            success: false,
            count: 0,
            products: [],
            error: error.message
        });
    }
});

// ========== 3. ДОПОЛНИТЕЛЬНЫЙ ЭНДПОИНТ ДЛЯ ДИАГНОСТИКИ ==========
app.get('/api/debug', async (req, res) => {
    try {
        const exists = await fs.access(CATALOG_FILE).then(() => true).catch(() => false);
        let fileSize = 0;
        let fileContent = null;
        
        if (exists) {
            const stats = await fs.stat(CATALOG_FILE);
            fileSize = stats.size;
            fileContent = await fs.readFile(CATALOG_FILE, 'utf8');
        }
        
        res.json({
            file_exists: exists,
            file_size_bytes: fileSize,
            file_size_mb: (fileSize / 1024 / 1024).toFixed(2),
            file_preview: fileContent ? fileContent.substring(0, 500) : null,
            server_time: new Date().toISOString()
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// ========== 4. КОРНЕВОЙ ЭНДПОИНТ ==========
app.get('/', (req, res) => {
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

// ========== 5. ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, async () => {
    console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📍 Эндпоинт для Tilda: GET /api/catalog`);
    console.log(`📍 Диагностика: GET /api/debug\n`);
    
    // Загружаем CSV при старте
    console.log('📥 Загрузка каталога...');
    const count = await downloadAndBuildCatalog();
    console.log(`✅ Готово: ${count} гитар в каталоге\n`);
    
    // Обновляем каталог раз в сутки (86400000 мс)
    setInterval(async () => {
        console.log('🔄 Плановое обновление каталога...');
        await downloadAndBuildCatalog();
    }, 86400000);
});