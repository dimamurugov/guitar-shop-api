const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const csv = require('csv-parser');
const { createReadStream } = require('fs');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: ['https://ваш-проект.tilda.ws', 'https://ваш-сайт.ru'] }));
app.use(express.json());

const CATALOG_FILE = path.join(__dirname, 'catalog_cache.json');
const CSV_FILE = path.join(__dirname, 'hour.csv'); // временное хранение CSV
const CSV_URL = 'https://lutner.ru/bitrix/catalog_export/upload/hour.csv';

// ========== 1. Функция загрузки CSV от поставщика ==========
// ========== Парсинг CSV с известными заголовками ==========
async function downloadAndParseCSV() {
    try {
        console.log('🔄 Загрузка CSV-файла с описаниями гитар...');
        
        const response = await fetch(CSV_URL);
        const csvText = await response.text();
        await fs.writeFile(CSV_FILE, csvText, 'utf8');
        
        // Парсим CSV
        const products = [];
        await pipeline(
            createReadStream(CSV_FILE),
            csv({ separator: ';', headers: true }),
            async function* (source) {
                for await (const row of source) {
                    // Преобразуем строки в числа где нужно
                    products.push({
                        id: row.IE_XML_ID,                    // Уникальный ID
                        name: row.IE_NAME,                     // Название гитары
                        brand: row.IP_PROP96,                  // Бренд/производитель
                        description: row.IP_PROP100,           // Описание/характеристики
                        quantity_global: parseInt(row.CP_QUANTITY) || 0,
                        price_retail: parseFloat(row.CV_PRICE_13) || 0,
                        currency_13: row.CV_CURRENCY_13,
                        price_diller: parseFloat(row.CV_PRICE_18) || 0,
                        currency_18: row.CV_CURRENCY_18,
                        price_mp: parseFloat(row.CV_PRICE_20) || 0,
                        currency_20: row.CV_CURRENCY_20,
                        sale: parseFloat(row.CP_SALE) || 0,
                        store_spb: parseInt(row.CP_STORE_SPB) || 0,
                        store_ekb: parseInt(row.CP_STORE_EKB) || 0,
                    });
                }
            }
        );
        
        console.log(`✅ Загружено ${products.length} гитар из CSV`);
        
        // Сохраняем описания отдельно
        await fs.writeFile('descriptions.json', JSON.stringify(products, null, 2));
        
        return products;
        
    } catch (error) {
        console.error('❌ Ошибка загрузки CSV:', error);
        return null;
    }
}

// ========== Объединение данных из CSV и API ==========
function mergeCatalog(apiProducts, csvProducts) {
    if (!csvProducts) return Object.values(apiProducts || {});
    
    // Создаём словарь данных из CSV по ID
    const csvMap = {};
    csvProducts.forEach(csvItem => {
        csvMap[csvItem.id] = csvItem;
    });
    
    // Обогащаем API-данные (цены/остатки) описаниями из CSV
    const merged = Object.values(apiProducts).map(apiItem => {
        const csvItem = csvMap[apiItem.id] || {};
        
        return {
            // Из API (обновляется каждые 5 минут)
            id: apiItem.id,
            quantity: apiItem.quantity,           // актуальный остаток
            price_retail: apiItem.price_retail,   // актуальная цена
            price_diller: apiItem.price_diller,
            price_mp: apiItem.price_mp,
            store_spb: apiItem.store_spb,
            store_ekb: apiItem.store_ekb,
            lastUpdated: apiItem.lastUpdated,
            
            // Из CSV (обновляется раз в сутки)
            name: csvItem.name || `Гитара ${apiItem.id}`,
            brand: csvItem.brand || '',
            description: csvItem.description || '',
            sale: csvItem.sale || 0,
            
            // Дополнительно из CSV (могут пригодиться)
            csv_quantity_global: csvItem.quantity_global,
            csv_price_retail: csvItem.price_retail,
            csv_price_diller: csvItem.price_diller,
        };
    });
    
    return merged;
}

// ========== 3. Эндпоинт для поставщика (цены/остатки) ==========
app.post('/api/update-from-lutner', async (req, res) => {
    try {
        const products = req.body;
        if (!Array.isArray(products)) {
            return res.status(400).json({ error: 'Ожидается массив товаров' });
        }
        
        // Загружаем текущий каталог
        let catalog = {};
        try {
            const existingData = await fs.readFile(CATALOG_FILE, 'utf8');
            catalog = JSON.parse(existingData);
        } catch (err) {}
        
        // Обновляем цены и остатки
        products.forEach(product => {
            catalog[product.id] = {
                ...(catalog[product.id] || {}),
                ...product,
                lastUpdated: Date.now()
            };
        });
        
        // Если у нас уже загружены описания из CSV, объединяем
        let csvDescriptions = null;
        try {
            const csvRaw = await fs.readFile(CSV_FILE, 'utf8');
            // Здесь нужно распарсить CSV, но для простоты предположим, что
            // у нас есть глобальная переменная или отдельный файл с описаниями
        } catch (err) {}
        
        await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2));
        console.log(`✅ Обновлены цены/остатки: ${products.length} товаров`);
        res.status(200).json({ status: 'ok' });
        
    } catch (error) {
        console.error('Ошибка:', error);
        res.status(500).json({ error: 'Внутренняя ошибка' });
    }
});

// ========== 4. Эндпоинт для Tilda (полный каталог) ==========
app.get('/api/catalog', async (req, res) => {
    try {
        const rawData = await fs.readFile(CATALOG_FILE, 'utf8');
        let catalog = JSON.parse(rawData);
        
        // Пытаемся загрузить свежие описания из CSV (если есть)
        let descriptions = [];
        try {
            await fs.access(CSV_FILE);
            descriptions = [];
            await pipeline(
                createReadStream(CSV_FILE),
                csv({ separator: ';', headers: true }),
                async function* (source) {
                    for await (const row of source) {
                        descriptions.push(row);
                    }
                }
            );
        } catch (err) {
            // CSV ещё не скачан
        }
        
        // Объединяем
        const enriched = Object.values(catalog).map(product => {
            const desc = descriptions.find(d => (d.ID || d.ARTICLE) === product.id) || {};
            return {
                ...product,
                name: desc.NAME || product.name || 'Без названия',
                description: desc.DESCRIPTION || '',
                images: desc.IMAGES ? desc.IMAGES.split(';') : []
            };
        });
        
        res.json({ success: true, count: enriched.length, products: enriched });
        
    } catch (error) {
        res.json({ success: true, count: 0, products: [] });
    }
});

// ========== 5. Запуск периодической загрузки CSV ==========
async function scheduleCSVDownload() {
    // Первый запуск через 10 секунд после старта
    setTimeout(async () => {
        const descriptions = await downloadAndParseCSV();
        if (descriptions) {
            // Можно сохранить описания в отдельный файл descriptions.json
            await fs.writeFile('descriptions.json', JSON.stringify(descriptions, null, 2));
        }
    }, 10000);
    
    // Затем запускаем каждый день (86400000 мс) или каждый час (3600000)
    setInterval(async () => {
        const descriptions = await downloadAndParseCSV();
        if (descriptions) {
            await fs.writeFile('descriptions.json', JSON.stringify(descriptions, null, 2));
        }
    }, 86400000); // 24 часа
}

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    scheduleCSVDownload();
});