// src/fetcher.js — скачивание и парсинг CSV от поставщика
const axios  = require('axios');
const { parse } = require('csv-parse/sync');

/**
 * Скачивает CSV и возвращает массив нормализованных объектов-товаров.
 * Нормализация: все ключи → нижний регистр, маппинг типичных вариантов колонок.
 */
async function fetchCatalog(url, delimiter = ',') {
  console.log(`[fetcher] Скачиваем CSV: ${url}`);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { 'Accept': 'text/csv,text/plain,*/*' },
  });

  // Пробуем определить кодировку (windows-1251 у многих поставщиков)
  const raw = detectAndDecodeBuffer(response.data);

  const records = parse(raw, {
    delimiter,
    columns: true,          // первая строка = заголовки
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  console.log(`[fetcher] Получено строк: ${records.length}`);
  return records.map(normalize);
}

/** Нормализует одну строку CSV → объект продукта */
function normalize(row) {
  // Ключи в нижний регистр и без пробелов
  const r = {};
  for (const [k, v] of Object.entries(row)) {
    r[k.toLowerCase().trim().replace(/\s+/g, '_')] = v?.trim() ?? '';
  }

  return {
    id:          pick(r, ['id', 'sku', 'article', 'артикул', 'код', 'product_id']) || generateId(r),
    name:        pick(r, ['name', 'title', 'наименование', 'название', 'товар']) || '(без названия)',
    price:       parsePrice(pick(r, ['price', 'цена', 'стоимость', 'cost'])),
    description: pick(r, ['description', 'описание', 'desc', 'about']) || '',
    image_url:   pick(r, ['image', 'image_url', 'photo', 'фото', 'картинка', 'изображение']) || '',
    category:    pick(r, ['category', 'категория', 'раздел', 'group', 'группа']) || '',
    in_stock:    parseStock(pick(r, ['stock', 'quantity', 'qty', 'остаток', 'наличие', 'количество'])),
    raw_data:    JSON.stringify(r),
  };
}

// ── Вспомогательные ───────────────────────────────────────────────────────────

/** Возвращает первое непустое значение из списка возможных ключей */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return '';
}

function parsePrice(val) {
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[^\d.,]/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function parseStock(val) {
  if (!val || val === '') return 1; // нет поля = считаем в наличии
  const lower = String(val).toLowerCase();
  if (['0', 'нет', 'no', 'false', 'out', 'отсутствует'].includes(lower)) return 0;
  const n = parseInt(val, 10);
  return isNaN(n) ? 1 : (n > 0 ? 1 : 0);
}

function generateId(row) {
  // fallback: хэш из name+price
  const str = (row.name || '') + (row.price || '') + (row.category || '');
  let hash = 0;
  for (const ch of str) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  return 'auto_' + Math.abs(hash).toString(16);
}

/**
 * Простое определение кодировки по BOM или попытка decode как CP1251.
 * Если буфер уже UTF-8 — возвращает как есть.
 */
function detectAndDecodeBuffer(buffer) {
  const buf = Buffer.from(buffer);

  // UTF-8 BOM
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }

  // Пробуем UTF-8
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8; // нет знаков замены → валидный UTF-8

  // Иначе CP1251 через latin1 → ручная перекодировка
  return cp1251ToUtf8(buf);
}

const CP1251_MAP = [
  0x0402,0x0403,0x201A,0x0453,0x201E,0x2026,0x2020,0x2021,0x20AC,0x2030,0x0409,0x2039,0x040A,0x040C,0x040B,0x040F,
  0x0452,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0x0000,0x2122,0x0459,0x203A,0x045A,0x045C,0x045B,0x045F,
  0x00A0,0x040E,0x045E,0x0408,0x00A4,0x0490,0x00A6,0x00A7,0x0401,0x00A9,0x0404,0x00AB,0x00AC,0x00AD,0x00AE,0x0407,
  0x00B0,0x00B1,0x0406,0x0456,0x0491,0x00B5,0x00B6,0x00B7,0x0451,0x2116,0x0454,0x00BB,0x0458,0x0405,0x0455,0x0457,
];

function cp1251ToUtf8(buf) {
  let out = '';
  for (const byte of buf) {
    if (byte < 0x80) { out += String.fromCharCode(byte); }
    else if (byte < 0xC0) { out += String.fromCharCode(CP1251_MAP[byte - 0x80] || 0xFFFD); }
    else { out += String.fromCharCode(0x0410 + byte - 0xC0); } // А-я
  }
  return out;
}

module.exports = { fetchCatalog };
