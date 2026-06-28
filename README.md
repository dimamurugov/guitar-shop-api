# Tilda Sync — синхронизация каталога поставщика с Tilda

Сервер на **Express.js + SQLite**, который ежедневно забирает CSV от поставщика,
сохраняет в локальную БД и загружает товары в **Tilda Store**.

---

## Структура проекта

```
tilda-sync/
├── src/
│   ├── server.js      — Express сервер + cron-планировщик
│   ├── sync.js        — оркестратор синхронизации
│   ├── fetcher.js     — скачивание и парсинг CSV
│   ├── tilda.js       — Tilda Store API
│   └── db.js          — SQLite (better-sqlite3)
├── data/
│   └── catalog.db     — БД (создаётся автоматически)
├── tilda-catalog-widget.js  — JS-виджет для Tilda Zero Block
├── .env.example
└── package.json
```

---

## Установка

```bash
cd tilda-sync
npm install

cp .env.example .env
# Откройте .env и заполните переменные
```

---

## Настройка .env

| Переменная | Описание |
|---|---|
| `SUPPLIER_CSV_URL` | URL для скачивания CSV от поставщика |
| `TILDA_PUBLIC_KEY` | Публичный ключ Tilda API |
| `TILDA_SECRET_KEY` | Секретный ключ Tilda API |
| `TILDA_PROJECT_ID` | ID проекта в Tilda |
| `TILDA_PAGE_ID` | ID страницы каталога |
| `SYNC_SECRET` | Пароль для ручного запуска синхронизации |
| `SYNC_CRON` | Cron-расписание (по умолч. `0 3 * * *` = 3:00 ночи) |
| `CSV_DELIMITER` | Разделитель CSV (`,` или `;`) |
| `PORT` | Порт сервера (по умолч. 3000) |

### Где взять ключи Tilda API

1. Войдите на tilda.cc
2. Профиль → **API Keys**
3. Скопируйте Public Key и Secret Key
4. ID проекта — в URL редактора: `tilda.cc/projects/edit/XXXXXXX/`

---

## Запуск

```bash
# Запуск сервера (с автосинхронизацией по расписанию)
npm start

# Режим разработки (с автоперезапуском)
npm run dev

# Разовая ручная синхронизация без сервера
npm run sync
```

---

## API сервера

### Публичные эндпоинты (для Tilda)

```
GET /api/products                    — весь каталог (50 на стр.)
GET /api/products?category=Мебель    — фильтр по категории
GET /api/products?search=диван       — поиск
GET /api/products?page=2&limit=24    — пагинация
GET /api/products/:id                — один товар
GET /api/categories                  — список категорий
GET /health                          — проверка работоспособности
```

### Служебные (требуют заголовок `X-Sync-Secret: ваш_секрет`)

```
POST /admin/sync    — ручной запуск синхронизации
GET  /admin/logs    — журнал последних синхронизаций
GET  /admin/status  — статус системы
```

**Пример ручного запуска:**
```bash
curl -X POST http://localhost:3000/admin/sync \
     -H "X-Sync-Secret: ваш_секрет"
```

---

## Настройка Tilda Zero Block

1. В редакторе страницы добавьте блок **«T—Zero Block»**
2. Внутри него добавьте HTML-элемент с `id="tsc-root"`:
   ```html
   <div id="tsc-root"></div>
   ```
3. В раздел **«JS»** Zero Block вставьте содержимое файла `tilda-catalog-widget.js`
4. В начале скрипта замените:
   ```js
   const API_BASE = 'https://YOUR_SERVER_URL';
   ```
   на адрес вашего развёрнутого сервера.

> ⚠️ Сервер должен быть доступен по HTTPS (браузер не загрузит HTTP с HTTPS-страницы Tilda).

---

## Формат CSV поставщика

Поддерживаемые названия колонок (регистр не важен):

| Поле | Варианты заголовка в CSV |
|---|---|
| ID | `id`, `sku`, `article`, `артикул`, `код` |
| Название | `name`, `title`, `наименование`, `название` |
| Цена | `price`, `цена`, `стоимость` |
| Описание | `description`, `описание` |
| Изображение | `image`, `image_url`, `photo`, `фото` |
| Категория | `category`, `категория`, `group` |
| Наличие | `stock`, `quantity`, `остаток`, `наличие` |

Если название колонки не совпадает — добавьте маппинг в `src/fetcher.js` функция `normalize()`.

---

## Деплой на сервер

### С PM2 (рекомендуется)

```bash
npm install -g pm2
pm2 start src/server.js --name tilda-sync
pm2 save
pm2 startup   # автозапуск при перезагрузке
```

### С Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t tilda-sync .
docker run -d --name tilda-sync \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -p 3000:3000 \
  tilda-sync
```

---

## Возможные проблемы

**CSV не парсится** — проверьте разделитель (`CSV_DELIMITER=;` для точки с запятой).
Поставщик использует CP1251? — `fetcher.js` автоматически это определяет.

**Tilda API возвращает ошибку** — проверьте, что `TILDA_PROJECT_ID` совпадает с ключами.

**CORS-ошибка в браузере** — добавьте в `server.js`:
```js
const cors = require('cors');
app.use(cors({ origin: 'https://your-tilda-site.tilda.ws' }));
```
и `npm install cors`.
