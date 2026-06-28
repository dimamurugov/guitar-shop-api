/**
 * tilda-catalog-widget.js
 * ────────────────────────────────────────────────────────────────────────────
 * Вставьте этот код в Zero Block (HTML-виджет) на странице Tilda с каталогом.
 *
 * Как добавить на Tilda:
 *   1. В редакторе добавьте блок "Zero Block" (раздел Other → T—Zero Block)
 *   2. Внутри Zero Block создайте HTML-элемент
 *   3. Вставьте весь этот код в поле «JS» Zero Block
 *
 * Замените YOUR_SERVER_URL на адрес вашего сервера (например https://myapp.ru)
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
  const API_BASE = 'https://YOUR_SERVER_URL'; // ← замените!

  // ── Состояние ──────────────────────────────────────────────────────────────
  let state = {
    products:   [],
    categories: [],
    category:   '',
    search:     '',
    page:       1,
    totalPages: 1,
  };

  // ── Точка входа ────────────────────────────────────────────────────────────
  window.addEventListener('load', function () {
    injectStyles();
    render();
    loadCategories();
    loadProducts();
  });

  // ── Загрузка данных ────────────────────────────────────────────────────────
  async function loadCategories() {
    try {
      const res  = await fetch(`${API_BASE}/api/categories`);
      const data = await res.json();
      state.categories = data.categories || [];
      renderSidebar();
    } catch (e) { console.error('Не удалось загрузить категории', e); }
  }

  async function loadProducts() {
    showLoading(true);
    try {
      const params = new URLSearchParams({
        page:  state.page,
        limit: 24,
        ...(state.category && { category: state.category }),
        ...(state.search   && { search: state.search }),
      });
      const res  = await fetch(`${API_BASE}/api/products?${params}`);
      const data = await res.json();

      state.products   = data.products || [];
      state.totalPages = data.pagination?.pages || 1;
      renderGrid();
      renderPagination();
    } catch (e) {
      console.error('Не удалось загрузить товары', e);
      document.getElementById('tsc-grid').innerHTML =
        '<p class="tsc-error">Ошибка загрузки каталога. Попробуйте позже.</p>';
    } finally {
      showLoading(false);
    }
  }

  // ── Рендер ─────────────────────────────────────────────────────────────────
  function render() {
    const root = document.getElementById('tsc-root');
    if (!root) return console.error('[TildaCatalog] Не найден элемент #tsc-root');

    root.innerHTML = `
      <div class="tsc-layout">
        <aside class="tsc-sidebar">
          <div class="tsc-search-wrap">
            <input class="tsc-search" id="tsc-search" type="text" placeholder="Поиск товаров…" />
          </div>
          <nav id="tsc-categories"></nav>
        </aside>
        <main class="tsc-main">
          <div id="tsc-loader" class="tsc-loader hidden">Загрузка…</div>
          <div id="tsc-grid"  class="tsc-grid"></div>
          <div id="tsc-pagination" class="tsc-pagination"></div>
        </main>
      </div>
    `;

    document.getElementById('tsc-search').addEventListener('input', debounce(function (e) {
      state.search = e.target.value;
      state.page   = 1;
      loadProducts();
    }, 400));
  }

  function renderSidebar() {
    const nav = document.getElementById('tsc-categories');
    if (!nav) return;

    const all = makeLink('Все товары', '', state.category === '');
    const cats = state.categories.map(c => makeLink(c, c, state.category === c)).join('');
    nav.innerHTML = all + cats;

    nav.querySelectorAll('.tsc-cat-link').forEach(a => {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        state.category = this.dataset.cat;
        state.page     = 1;
        renderSidebar();
        loadProducts();
      });
    });
  }

  function renderGrid() {
    const grid = document.getElementById('tsc-grid');
    if (!grid) return;

    if (!state.products.length) {
      grid.innerHTML = '<p class="tsc-empty">Товары не найдены</p>';
      return;
    }

    grid.innerHTML = state.products.map(p => `
      <div class="tsc-card" data-id="${p.id}">
        <div class="tsc-card-img">
          ${p.image_url
            ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" />`
            : '<div class="tsc-card-no-img">📦</div>'
          }
          ${!p.in_stock ? '<span class="tsc-badge-out">Нет в наличии</span>' : ''}
        </div>
        <div class="tsc-card-body">
          <div class="tsc-card-title">${esc(p.name)}</div>
          <div class="tsc-card-price">${formatPrice(p.price)}</div>
          ${p.category ? `<div class="tsc-card-cat">${esc(p.category)}</div>` : ''}
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.tsc-card').forEach(card => {
      card.addEventListener('click', function () {
        openDetail(this.dataset.id);
      });
    });
  }

  function renderPagination() {
    const el = document.getElementById('tsc-pagination');
    if (!el || state.totalPages <= 1) { if (el) el.innerHTML = ''; return; }

    let html = '';
    if (state.page > 1)
      html += `<button class="tsc-btn" data-p="${state.page - 1}">← Назад</button>`;
    html += `<span class="tsc-pages">Стр. ${state.page} / ${state.totalPages}</span>`;
    if (state.page < state.totalPages)
      html += `<button class="tsc-btn" data-p="${state.page + 1}">Вперёд →</button>`;

    el.innerHTML = html;
    el.querySelectorAll('.tsc-btn[data-p]').forEach(btn => {
      btn.addEventListener('click', function () {
        state.page = parseInt(this.dataset.p);
        loadProducts();
        document.getElementById('tsc-root')?.scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  // ── Модальное окно с деталями ──────────────────────────────────────────────
  async function openDetail(id) {
    try {
      const res  = await fetch(`${API_BASE}/api/products/${id}`);
      const data = await res.json();
      const p    = data.product;
      if (!p) return;

      const modal = document.createElement('div');
      modal.className = 'tsc-modal-overlay';
      modal.innerHTML = `
        <div class="tsc-modal">
          <button class="tsc-modal-close">✕</button>
          ${p.image_url ? `<img class="tsc-modal-img" src="${esc(p.image_url)}" alt="${esc(p.name)}" />` : ''}
          <h2 class="tsc-modal-title">${esc(p.name)}</h2>
          <div class="tsc-modal-price">${formatPrice(p.price)}</div>
          ${p.category ? `<div class="tsc-modal-cat">Категория: ${esc(p.category)}</div>` : ''}
          ${p.description ? `<div class="tsc-modal-desc">${esc(p.description)}</div>` : ''}
          <div class="tsc-modal-stock">${p.in_stock ? '✅ В наличии' : '❌ Нет в наличии'}</div>
        </div>
      `;

      document.body.appendChild(modal);
      modal.querySelector('.tsc-modal-close').addEventListener('click', () => modal.remove());
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    } catch (e) { console.error('Ошибка загрузки товара', e); }
  }

  // ── Вспомогательные ────────────────────────────────────────────────────────
  function makeLink(label, cat, active) {
    return `<a href="#" class="tsc-cat-link${active ? ' active' : ''}" data-cat="${cat}">${label}</a>`;
  }

  function showLoading(flag) {
    const el = document.getElementById('tsc-loader');
    if (el) el.classList.toggle('hidden', !flag);
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatPrice(n) {
    return Number(n).toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ── Стили (инжектируются один раз) ────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('tsc-styles')) return;
    const s = document.createElement('style');
    s.id = 'tsc-styles';
    s.textContent = `
      .tsc-layout{display:flex;gap:24px;font-family:inherit}
      .tsc-sidebar{width:220px;flex-shrink:0}
      .tsc-main{flex:1;min-width:0}
      .tsc-search{width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box}
      .tsc-cat-link{display:block;padding:7px 10px;border-radius:5px;text-decoration:none;color:#333;font-size:14px;margin-top:4px}
      .tsc-cat-link:hover,.tsc-cat-link.active{background:#f0f0f0;font-weight:600}
      .tsc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
      .tsc-card{border:1px solid #eee;border-radius:8px;overflow:hidden;cursor:pointer;transition:box-shadow .2s}
      .tsc-card:hover{box-shadow:0 4px 16px rgba(0,0,0,.12)}
      .tsc-card-img{position:relative;aspect-ratio:1;background:#f9f9f9;display:flex;align-items:center;justify-content:center}
      .tsc-card-img img{width:100%;height:100%;object-fit:cover}
      .tsc-card-no-img{font-size:40px}
      .tsc-badge-out{position:absolute;top:8px;right:8px;background:#e74c3c;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px}
      .tsc-card-body{padding:12px}
      .tsc-card-title{font-weight:600;font-size:14px;margin-bottom:6px;line-height:1.3}
      .tsc-card-price{color:#e74c3c;font-size:16px;font-weight:700}
      .tsc-card-cat{font-size:12px;color:#999;margin-top:4px}
      .tsc-loader{text-align:center;padding:20px;color:#999}
      .tsc-loader.hidden{display:none}
      .tsc-empty,.tsc-error{text-align:center;color:#999;padding:40px}
      .tsc-error{color:#e74c3c}
      .tsc-pagination{display:flex;align-items:center;gap:16px;justify-content:center;margin-top:24px}
      .tsc-btn{padding:8px 18px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font-size:14px}
      .tsc-btn:hover{background:#f0f0f0}
      .tsc-pages{font-size:14px;color:#666}
      .tsc-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}
      .tsc-modal{background:#fff;border-radius:12px;max-width:520px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative}
      .tsc-modal-close{position:absolute;top:14px;right:14px;background:none;border:none;font-size:18px;cursor:pointer;color:#666}
      .tsc-modal-img{width:100%;border-radius:8px;margin-bottom:16px}
      .tsc-modal-title{font-size:20px;font-weight:700;margin:0 0 10px}
      .tsc-modal-price{font-size:22px;color:#e74c3c;font-weight:700;margin-bottom:10px}
      .tsc-modal-cat{font-size:13px;color:#999;margin-bottom:10px}
      .tsc-modal-desc{font-size:14px;line-height:1.6;color:#444;margin-bottom:14px}
      .tsc-modal-stock{font-size:14px}
      @media(max-width:640px){.tsc-layout{flex-direction:column}.tsc-sidebar{width:100%}.tsc-grid{grid-template-columns:repeat(2,1fr)}}
    `;
    document.head.appendChild(s);
  }
})();
