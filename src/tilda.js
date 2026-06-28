// src/tilda.js — интеграция с Tilda Store API
const axios = require('axios');

const TILDA_API = 'https://api.tildacdn.info/v1';

/**
 * Отправляет список товаров в Tilda Store.
 *
 * Ключевой момент: используем externalid (не uid).
 * Tilda при импорте ищет товар по externalid и ОБНОВЛЯЕТ его,
 * а не создаёт дубль. Это позволяет редактировать товары в админке
 * Tilda вручную — синхронизация перезапишет только поля из CSV,
 * остальные (доп. фото, вкладки, SEO) сохранятся.
 *
 * Документация: https://help-ru.tilda.cc/online-store/import-export
 */
async function uploadProducts(products) {
  const publicKey = process.env.TILDA_PUBLIC_KEY;
  const secretKey = process.env.TILDA_SECRET_KEY;
  const projectId = process.env.TILDA_PROJECT_ID;

  if (!publicKey || !secretKey || !projectId) {
    throw new Error('Не заданы TILDA_PUBLIC_KEY, TILDA_SECRET_KEY или TILDA_PROJECT_ID в .env');
  }

  const tildaProducts = products.map(toTildaFormat);

  const active  = tildaProducts.filter(p => p.quantity !== '0').length;
  const hidden  = tildaProducts.filter(p => p.quantity === '0').length;
  console.log(`[tilda] Загружаем в Tilda: ${active} активных, ${hidden} скрытых (нет в наличии)...`);

  // Tilda ограничивает размер запроса — отправляем пачками по 100
  const BATCH = 100;
  let uploaded = 0;

  for (let i = 0; i < tildaProducts.length; i += BATCH) {
    const chunk = tildaProducts.slice(i, i + BATCH);

    const res = await axios.post(
      `${TILDA_API}/project/products/import/`,
      { products: chunk },
      {
        params: { publickey: publicKey, secretkey: secretKey, projectid: projectId },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
      }
    );

    if (res.data?.status !== 'FOUND' && res.data?.status !== 'OK') {
      throw new Error(`Tilda API вернул ошибку: ${JSON.stringify(res.data)}`);
    }

    uploaded += chunk.length;
    console.log(`[tilda] Загружено ${uploaded}/${tildaProducts.length}`);
  }

  return { uploaded, active, hidden };
}

/**
 * Конвертирует внутренний объект товара в формат Tilda Store.
 *
 * externalid — ID из вашей системы (CSV поставщика).
 *   Tilda ищет товар по этому полю при повторном импорте и обновляет его,
 *   не создавая дубль. Именно это поле связывает вашу БД с каталогом Tilda.
 *
 * quantity — '0' означает «нет в наличии». Товар остаётся в каталоге
 *   и в админке Tilda, но отображается покупателям как недоступный.
 *   Это безопаснее удаления: ручные правки в Tilda сохраняются.
 */
function toTildaFormat(p) {
  return {
    externalid:   String(p.id),
    title:        p.name,
    price:        String(p.price),
    description:  p.description || '',
    imgpath:      p.image_url   || '',
    sku:          String(p.id),
    quantity:     p.in_stock ? '999' : '0',
    characteristics: p.category
      ? [{ name: 'Категория', value: p.category }]
      : [],
  };
}

/**
 * Проверяет доступность Tilda API.
 */
async function testConnection() {
  const res = await axios.get(`${TILDA_API}/getprojectslist/`, {
    params: {
      publickey: process.env.TILDA_PUBLIC_KEY,
      secretkey: process.env.TILDA_SECRET_KEY,
    },
    timeout: 10_000,
  });
  return res.data;
}

module.exports = { uploadProducts, testConnection };
