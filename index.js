// server.js
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Разрешаем запросы с Tilda (ваш домен на Tilda)
app.use(cors({
    origin: ['https://project16053916.tilda.ws', 'http://явыбираюгитару.рф'],
    methods: ['GET', 'POST']
}));

// Для обработки JSON от поставщика
app.use(express.json());

// Путь к файлу для хранения каталога
const CATALOG_FILE = path.join(__dirname, 'catalog_cache.json');

// ========== 1. Эндпоинт для поставщика (получение обновлений) ==========
app.post('/api/update-from-lutner', async (req, res) => {
    try {
        // Данные приходят в виде массива товаров
        const products = req.body;
        
        // Проверяем, что данные корректны
        if (!Array.isArray(products)) {
            return res.status(400).json({ error: 'Ожидается массив товаров' });
        }
        
        // Загружаем старый каталог (если есть)
        let catalog = {};
        try {
            const existingData = await fs.readFile(CATALOG_FILE, 'utf8');
            catalog = JSON.parse(existingData);
        } catch (err) {
            // Файла нет - создаём новый
        }
        
        // Обновляем данные для каждого товара
        products.forEach(product => {
            catalog[product.id] = {
                ...catalog[product.id],  // сохраняем старые поля (например, название, описание)
                ...product,               // обновляем цены, остатки
                lastUpdated: Date.now()   // метка времени
            };
        });
        
        // Сохраняем в файл
        await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2));
        
        console.log(`✅ Получено обновление: ${products.length} товаров`);
        res.status(200).json({ status: 'ok', count: products.length });
        
    } catch (error) {
        console.error('Ошибка при сохранении:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ========== 2. Эндпоинт для Tilda (получение каталога) ==========
app.get('/api/catalog', async (req, res) => {
    try {
        // Читаем данные из файла
        const data = await fs.readFile(CATALOG_FILE, 'utf8');
        const catalog = JSON.parse(data);
        
        // Преобразуем в массив для удобства на фронтенде
        const productsArray = Object.values(catalog);
        
        res.json({
            success: true,
            count: productsArray.length,
            products: productsArray
        });
        
    } catch (error) {
        // Если файла ещё нет, возвращаем пустой массив
        res.json({
            success: true,
            count: 0,
            products: []
        });
    }
});

// ========== 3. Эндпоинт для получения конкретного товара ==========
app.get('/api/product/:id', async (req, res) => {
    try {
        const data = await fs.readFile(CATALOG_FILE, 'utf8');
        const catalog = JSON.parse(data);
        const product = catalog[req.params.id];
        
        if (!product) {
            return res.status(404).json({ error: 'Товар не найден' });
        }
        
        res.json({ success: true, product });
        
    } catch (error) {
        res.status(404).json({ error: 'Товар не найден' });
    }
});

// ========== 4. Простая HTML-страница для проверки ==========
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Guitar Shop API</title></head>
        <body>
            <h1>API для магазина гитар</h1>
            <p>✅ Сервер работает</p>
            <p>📦 Каталог: <a href="/api/catalog">/api/catalog</a></p>
            <p>🔄 Эндпоинт для поставщика: POST /api/update-from-lutner</p>
        </body>
        </html>
    `);
});

// Запускаем сервер
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});