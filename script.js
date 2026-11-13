/* ==========================================================
   Voorraadbeheer – vanilla JavaScript
   Opslag: localStorage  |  PDF: jsPDF + jsPDF-AutoTable (CDN)
   ========================================================== */
(() => {
  'use strict';

  /* ---------- Configuratie ---------- */
  const STORAGE_KEY = 'voorraad-app-v1';
  const REPORTS_KEY = 'voorraad-rapporten-v1';
  const LOW_STOCK = 3;      // vanaf dit aantal of lager: "Bijna op"
  const MAX_STOCK = 99999;

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mrt', 'Apr', 'Mei', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
  const MONTHS_LONG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

  /* ---------- Hulpfuncties ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const collator = new Intl.Collator('nl', { sensitivity: 'base', numeric: true });
  const byName = (a, b) => collator.compare(a.name, b.name);
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const pad = (n) => String(n).padStart(2, '0');
  const shortDate = (d) => `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  const longDate = (d) => `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
  const timeStr = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const clampStock = (v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(MAX_STOCK, Math.max(0, n)) : 0;
  };
  const clampPrice = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(99999.99, Math.max(0, Math.round(n * 100) / 100)) : 0;
  };
  const euroFmt = new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' });
  const numFmt = new Intl.NumberFormat('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const euro = (n) => euroFmt.format(n);               // in de app: € 12,50
  const pdfEuro = (n) => `EUR ${numFmt.format(n)}`;    // in de PDF: EUR 12,50
  const lineValue = (price, stock) => Math.round((price || 0) * 100) * stock / 100;

  // "12,50", "12.5" of "1.234,50" omzetten naar een getal; leeg = 0; ongeldig = NaN
  function parsePrice(str) {
    let s = String(str).trim().replace(/\s|€/g, '');
    if (s === '') return 0;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    const n = Number(s);
    return n <= 99999.99 ? n : NaN;
  }

  function statusOf(stock) {
    if (stock <= 0) return { key: 'out', label: 'Uitverkocht' };
    if (stock <= LOW_STOCK) return { key: 'low', label: 'Bijna op' };
    return { key: 'ok', label: 'Op voorraad' };
  }

  /* ---------- DOM-referenties ---------- */
  const tabsEl = $('#tabs');
  const listEl = $('#list');
  const listHeadEl = $('#listHead');
  const searchInput = $('#search');
  const searchClear = $('#searchClear');
  const toastEl = $('#toast');

  /* ---------- Opslag ---------- */
  function seedData() {
    const mk = (name) => ({ id: uid(), name });
    const fuji = mk('Fujifilm');
    const pola = mk('Polaroid');
    const ilford = mk('Ilford');
    const p = (s, name, category, stock, price = 0) => ({ id: uid(), supplierId: s.id, name, category, stock, price });
    return {
      suppliers: [fuji, pola, ilford],
      products: [
        p(fuji, 'Instax Mini film (10 stuks)', 'Instantfilm', 14, 14.99),
        p(fuji, 'Instax Mini 12', 'Camera', 5, 89.99),
        p(fuji, 'Instax Wide film (10 stuks)', 'Instantfilm', 2, 17.99),
        p(pola, 'i-Type film kleur', 'Instantfilm', 9, 16.99),
        p(pola, 'Now Generatie 2', 'Camera', 3, 119.99),
        p(pola, '600 film zwart-wit', 'Instantfilm', 0, 19.99),
        p(ilford, 'HP5 Plus 400 (35mm)', 'Zwart-witfilm', 20, 7.49),
        p(ilford, 'Delta 100 (120)', 'Zwart-witfilm', 8, 9.99),
        p(ilford, 'Ilfosol 3 ontwikkelaar', 'Chemicaliën', 4, 12.5),
      ],
      activeSupplierId: fuji.id,
    };
  }

  function sanitizeState(raw) {
    const suppliers = (raw.suppliers || [])
      .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({ id: s.id, name: s.name.trim() }));
    const ids = new Set(suppliers.map((s) => s.id));
    const products = (raw.products || [])
      .filter((p) => p && typeof p.id === 'string' && ids.has(p.supplierId) && typeof p.name === 'string' && p.name.trim())
      .map((p) => ({
        id: p.id,
        supplierId: p.supplierId,
        name: p.name.trim(),
        category: String(p.category || '').trim(),
        stock: clampStock(p.stock),
        price: clampPrice(p.price),
      }));
    const active = ids.has(raw.activeSupplierId) ? raw.activeSupplierId : (suppliers[0] ? suppliers[0].id : null);
    return { suppliers, products, activeSupplierId: active };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.suppliers) && Array.isArray(parsed.products)) {
          return sanitizeState(parsed);
        }
      }
    } catch (e) { /* ga door met voorbeelddata */ }
    return seedData(); // alleen bij het allereerste bezoek
  }

  function loadReports() {
    try {
      const raw = JSON.parse(localStorage.getItem(REPORTS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((r) => r && typeof r.id === 'string' && typeof r.createdAt === 'string' && Array.isArray(r.suppliers))
        .map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          suppliers: r.suppliers.map((s) => ({
            name: String(s.name || ''),
            products: (Array.isArray(s.products) ? s.products : []).map((p) => ({
              name: String(p.name || ''),
              category: String(p.category || ''),
              stock: clampStock(p.stock),
              price: clampPrice(p.price),
            })),
          })),
        }));
    } catch (e) {
      return [];
    }
  }

  let state = loadState();
  let reports = loadReports();
  let search = '';

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      toast('Opslaan in de browser is mislukt.');
      return false;
    }
  }

  function saveReports() {
    try {
      localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
      return true;
    } catch (e) {
      return false;
    }
  }

  const supplierById = (id) => state.suppliers.find((s) => s.id === id);
  const activeSupplier = () => supplierById(state.activeSupplierId) || null;

  function ensureActive() {
    if (!supplierById(state.activeSupplierId)) {
      state.activeSupplierId = state.suppliers[0] ? state.suppliers[0].id : null;
    }
  }

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3400);
  }

  /* ---------- Weergave: tabs ---------- */
  function renderTabs() {
    if (!state.suppliers.length) {
      tabsEl.innerHTML = '<span class="tabs-empty">Nog geen leveranciers</span>';
      return;
    }
    const searching = search.trim() !== '';
    const counts = {};
    state.products.forEach((p) => { counts[p.supplierId] = (counts[p.supplierId] || 0) + 1; });

    tabsEl.innerHTML = state.suppliers.map((s) => {
      const on = !searching && s.id === state.activeSupplierId;
      return `<button class="tab" type="button" data-id="${s.id}" aria-pressed="${on}">
        <span>${esc(s.name)}</span><span class="n">${counts[s.id] || 0}</span>
      </button>`;
    }).join('');
  }

  function centerActiveTab() {
    const el = $('.tab[aria-pressed="true"]', tabsEl);
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  /* ---------- Weergave: lijst ---------- */
  function visibleProducts() {
    const q = search.trim().toLowerCase();
    const items = q
      ? state.products.filter((p) => `${p.name} ${p.category}`.toLowerCase().includes(q))
      : state.products.filter((p) => p.supplierId === state.activeSupplierId);
    return items.sort(byName);
  }

  function emptyHTML({ ic, title, text, button, action }) {
    return `<div class="empty">
      <div class="ring">${icon(ic)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${button ? `<button class="btn primary" type="button" data-action="${action}" style="flex:none;padding:0 26px">${esc(button)}</button>` : ''}
    </div>`;
  }

  function cardHTML(p, showSupplier) {
    const st = statusOf(p.stock);
    const sup = showSupplier ? supplierById(p.supplierId) : null;
    return `<article class="card" data-id="${p.id}">
      <h3 class="card-name">${esc(p.name)}</h3>
      <button class="del" type="button" data-action="delete" aria-label="Product ${esc(p.name)} verwijderen" title="Product verwijderen">${icon('trash')}</button>
      <div class="meta">
        <span class="chip">${esc(p.category || 'Overig')}</span>
        <span class="price">${euro(p.price || 0)} <small>per stuk</small></span>
        ${sup ? `<span class="sup">${esc(sup.name)}</span>` : ''}
        <span class="status ${st.key}" data-role="status"${st.key === 'ok' ? ' hidden' : ''}>${st.label}</span>
      </div>
      <div class="stepper" role="group" aria-label="Voorraad van ${esc(p.name)}">
        <button class="step minus" type="button" data-action="dec" aria-label="Voorraad met 1 verlagen"${p.stock <= 0 ? ' aria-disabled="true"' : ''}>${icon('minus')}</button>
        <div class="qty"><strong data-role="qty" aria-live="polite">${p.stock}</strong><small>voorraad</small></div>
        <button class="step plus" type="button" data-action="inc" aria-label="Voorraad met 1 verhogen">${icon('plus')}</button>
      </div>
    </article>`;
  }

  function renderListHead(items) {
    if (!state.suppliers.length) { listHeadEl.innerHTML = ''; return; }
    const total = items.reduce((sum, p) => sum + p.stock, 0);
    if (search.trim()) {
      listHeadEl.innerHTML = `<div><h2>Zoekresultaten</h2>
        <p>${pl(items.length, 'product', 'producten')} gevonden bij alle leveranciers</p></div>`;
      return;
    }
    const s = activeSupplier();
    if (!s) { listHeadEl.innerHTML = ''; return; }
    listHeadEl.innerHTML = `<div><h2>${esc(s.name)}</h2>
      <p>${pl(items.length, 'product', 'producten')}, ${pl(total, 'stuk', 'stuks')} op voorraad</p></div>
      <button class="link-danger" type="button" data-action="delete-supplier">${icon('trash')}<span>Leverancier verwijderen</span></button>`;
  }

  function renderList() {
    if (!state.suppliers.length) {
      listHeadEl.innerHTML = '';
      listEl.innerHTML = emptyHTML({
        ic: 'camera',
        title: 'Nog geen leveranciers',
        text: 'Voeg je eerste leverancier toe om producten en voorraad bij te houden.',
        button: 'Leverancier toevoegen',
        action: 'add-supplier',
      });
      return;
    }

    const items = visibleProducts();
    renderListHead(items);

    if (!items.length) {
      const q = search.trim();
      listEl.innerHTML = q
        ? emptyHTML({ ic: 'search', title: 'Geen resultaten', text: `Geen producten gevonden voor “${q}”. Probeer een andere zoekterm.` })
        : emptyHTML({ ic: 'box', title: 'Nog geen producten', text: `Bij ${activeSupplier().name} staat nog niets. Tik op “Nieuw Product” om te beginnen.` });
      return;
    }

    listEl.innerHTML = items.map((p) => cardHTML(p, search.trim() !== '')).join('');
  }

  function renderAll() {
    renderTabs();
    renderList();
    renderReports();
  }

  /* ---------- Voorraad aanpassen ---------- */
  function refreshCard(card, p) {
    const qty = $('[data-role="qty"]', card);
    qty.textContent = p.stock;
    qty.classList.remove('bump');
    void qty.offsetWidth; // herstart animatie
    qty.classList.add('bump');

    const st = statusOf(p.stock);
    const badge = $('[data-role="status"]', card);
    badge.className = `status ${st.key}`;
    badge.textContent = st.label;
    badge.hidden = st.key === 'ok';

    $('[data-action="dec"]', card).setAttribute('aria-disabled', p.stock <= 0 ? 'true' : 'false');
  }

  function changeStock(id, delta) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    const next = clampStock(p.stock + delta);
    if (next === p.stock) return;
    p.stock = next;
    saveState();

    const card = listEl.querySelector(`.card[data-id="${id}"]`);
    if (card) refreshCard(card, p);
    renderListHead(visibleProducts());
  }

  /* ---------- Modals ---------- */
  let openedModal = null;
  let restoreFocusTo = null;

  function openModal(id, focusEl) {
    if (openedModal) closeModal(true);
    closeDropdown();
    const modal = document.getElementById(id);
    restoreFocusTo = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    openedModal = modal;
    setTimeout(() => {
      const target = focusEl || $('input', modal) || $('[data-close]', modal);
      if (target) target.focus();
    }, 40);
  }

  function closeModal(skipRestore) {
    if (!openedModal) return;
    openedModal.hidden = true;
    openedModal = null;
    document.body.classList.remove('modal-open');
    if (!skipRestore && restoreFocusTo && document.contains(restoreFocusTo)) restoreFocusTo.focus();
  }

  document.querySelectorAll('.overlay').forEach((overlay) => {
    // Klik op de donkere achtergrond sluit de pop-up
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeModal(); });
    // Kruisje / Annuleren
    overlay.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  });

  // Focus binnen de geopende modal houden
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (openedModal) { closeModal(); return; }
      if (!$('#reportsPanel').hidden) { closeDropdown(); $('#btnReports').focus(); return; }
      if (document.activeElement === searchInput && search) { clearSearch(); }
      return;
    }
    if (e.key === 'Tab' && openedModal) {
      const focusables = [...openedModal.querySelectorAll('button:not([disabled]), input:not([disabled]), [href]')]
        .filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Bevestigen ---------- */
  let confirmCb = null;
  function askConfirm({ title, text, label = 'Verwijderen', onConfirm }) {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = label;
    confirmCb = onConfirm;
    openModal('modal-confirm', $('#confirm-cancel'));
  }
  $('#confirm-ok').addEventListener('click', () => {
    const cb = confirmCb;
    confirmCb = null;
    closeModal(true);
    if (cb) cb();
  });

  /* ---------- Leveranciers ---------- */
  const supplierForm = $('#form-supplier');
  const supplierInput = $('#supplier-name');
  const supplierError = $('#supplier-error');

  function showError(el, message) { el.textContent = message; el.hidden = false; }
  function hideError(el) { el.hidden = true; el.textContent = ''; }

  function openSupplierModal() {
    supplierForm.reset();
    hideError(supplierError);
    openModal('modal-supplier', supplierInput);
  }

  supplierInput.addEventListener('input', () => hideError(supplierError));

  supplierForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = supplierInput.value.trim().replace(/\s+/g, ' ');
    if (!name) return showError(supplierError, 'Vul de naam van de leverancier in.');
    if (state.suppliers.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      return showError(supplierError, 'Deze leverancier bestaat al.');
    }
    const supplier = { id: uid(), name };
    state.suppliers.push(supplier);
    state.activeSupplierId = supplier.id;
    clearSearch(true);
    saveState();
    renderAll();
    closeModal(true);
    centerActiveTab();
    toast(`Leverancier “${name}” toegevoegd`);
  });

  function deleteSupplier() {
    const s = activeSupplier();
    if (!s) return;
    const n = state.products.filter((p) => p.supplierId === s.id).length;
    askConfirm({
      title: `${s.name} verwijderen?`,
      text: n
        ? `Deze leverancier en ${pl(n, 'bijbehorend product', 'bijbehorende producten')} worden verwijderd. Eerdere rapporten blijven bewaard.`
        : 'Deze leverancier wordt verwijderd. Eerdere rapporten blijven bewaard.',
      label: 'Leverancier verwijderen',
      onConfirm: () => {
        state.products = state.products.filter((p) => p.supplierId !== s.id);
        state.suppliers = state.suppliers.filter((x) => x.id !== s.id);
        ensureActive();
        saveState();
        renderAll();
        centerActiveTab();
        toast(`Leverancier “${s.name}” verwijderd`);
      },
    });
  }

  /* ---------- Producten ---------- */
  const productForm = $('#form-product');
  const productName = $('#product-name');
  const productCategory = $('#product-category');
  const productStock = $('#product-stock');
  const productPrice = $('#product-price');
  const productError = $('#product-error');

  function openProductModal() {
    const s = activeSupplier();
    if (!s) {
      toast('Voeg eerst een leverancier toe.');
      openSupplierModal();
      return;
    }
    productForm.reset();
    productStock.value = '0';
    hideError(productError);
    $('#product-sup').textContent = s.name;

    const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort((a, b) => collator.compare(a, b));
    $('#category-list').innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');

    openModal('modal-product', productName);
  }

  [productName, productCategory, productStock, productPrice].forEach((el) => el.addEventListener('input', () => hideError(productError)));

  productForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const s = activeSupplier();
    if (!s) return;
    const name = productName.value.trim().replace(/\s+/g, ' ');
    if (!name) return showError(productError, 'Vul de naam van het product in.');
    const category = productCategory.value.trim().replace(/\s+/g, ' ') || 'Overig';
    const stock = clampStock(productStock.value === '' ? 0 : productStock.value);
    const price = parsePrice(productPrice.value);
    if (Number.isNaN(price)) return showError(productError, 'Vul een geldige prijs in, bijvoorbeeld 12,50.');

    const product = { id: uid(), supplierId: s.id, name, category, stock, price };
    state.products.push(product);
    clearSearch(true);
    saveState();
    renderAll();
    closeModal(true);

    const card = listEl.querySelector(`.card[data-id="${product.id}"]`);
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1300);
    }
    toast(`“${name}” toegevoegd aan ${s.name}`);
  });

  function deleteProduct(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    askConfirm({
      title: 'Product verwijderen?',
      text: `“${p.name}” wordt uit de voorraad verwijderd.`,
      label: 'Product verwijderen',
      onConfirm: () => {
        state.products = state.products.filter((x) => x.id !== id);
        saveState();
        renderAll();
        toast(`“${p.name}” verwijderd`);
      },
    });
  }

  /* ---------- Zoeken ---------- */
  function clearSearch(silent) {
    search = '';
    searchInput.value = '';
    searchClear.hidden = true;
    if (!silent) { renderTabs(); renderList(); }
  }

  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    searchClear.hidden = search === '';
    renderTabs();
    renderList();
  });
  searchClear.addEventListener('click', () => { clearSearch(); searchInput.focus(); });

  /* ---------- Events: tabs, lijst, knoppen ---------- */
  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.activeSupplierId = tab.dataset.id;
    clearSearch(true);
    saveState();
    renderTabs();
    renderList();
    centerActiveTab();
  });

  // Muiswiel scrolt de tabs horizontaal (handig op laptop)
  tabsEl.addEventListener('wheel', (e) => {
    if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      tabsEl.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  function onActionClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.card');
    switch (btn.dataset.action) {
      case 'inc': if (card) changeStock(card.dataset.id, 1); break;
      case 'dec': if (card) changeStock(card.dataset.id, -1); break;
      case 'delete': if (card) deleteProduct(card.dataset.id); break;
      case 'delete-supplier': deleteSupplier(); break;
      case 'add-supplier': openSupplierModal(); break;
    }
  }
  listEl.addEventListener('click', onActionClick);
  listHeadEl.addEventListener('click', onActionClick);

  $('#btnAddSupplier').addEventListener('click', openSupplierModal);
  $('#fab').addEventListener('click', openProductModal);
  $('#btnWhy').addEventListener('click', () => openModal('modal-info', $('#modal-info [data-close]')));

  /* ---------- Rapporten: dropdown ---------- */
  const reportsBtn = $('#btnReports');
  const reportsPanel = $('#reportsPanel');
  const reportList = $('#reportList');

  function openDropdown() {
    reportsPanel.hidden = false;
    reportsBtn.setAttribute('aria-expanded', 'true');
  }
  function closeDropdown() {
    reportsPanel.hidden = true;
    reportsBtn.setAttribute('aria-expanded', 'false');
  }

  reportsBtn.addEventListener('click', () => (reportsPanel.hidden ? openDropdown() : closeDropdown()));
  document.addEventListener('click', (e) => {
    if (!reportsPanel.hidden && !e.target.closest('#reportsWrap')) closeDropdown();
  });

  function renderReports() {
    const count = $('#reportCount');
    count.textContent = reports.length;
    count.hidden = reports.length === 0;

    if (!reports.length) {
      reportList.innerHTML = '<li class="report-empty">Nog geen rapporten. Maak je eerste Eindejaarsrapport met de knop hierboven.</li>';
      return;
    }

    const sorted = [...reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    reportList.innerHTML = sorted.map((r) => {
      const d = new Date(r.createdAt);
      const nProducts = r.suppliers.reduce((s, x) => s + x.products.length, 0);
      const total = r.suppliers.reduce((s, x) => s + x.products.reduce((t, p) => t + p.stock, 0), 0);
      const title = `Rapport - ${shortDate(d)}`;
      return `<li><button class="report-item" type="button" data-report="${r.id}" aria-label="${esc(title)} opnieuw downloaden">
        <span class="r-ico">${icon('file')}</span>
        <span class="r-txt">
          <strong>${esc(title)}</strong>
          <small>${timeStr(d)} uur, ${pl(r.suppliers.length, 'leverancier', 'leveranciers')}, ${pl(nProducts, 'product', 'producten')}, ${pl(total, 'stuk', 'stuks')}</small>
        </span>
        <span class="r-dl">${icon('download')}</span>
      </button></li>`;
    }).join('');
  }

  reportList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-report]');
    if (!btn) return;
    const report = reports.find((r) => r.id === btn.dataset.report);
    if (!report) return;
    try {
      downloadPdf(report);
      toast(`Rapport - ${shortDate(new Date(report.createdAt))} opnieuw gedownload`);
    } catch (err) {
      console.error(err);
      toast('PDF maken is mislukt. Controleer je internetverbinding en probeer opnieuw.');
    }
    closeDropdown();
  });

  /* ---------- PDF ---------- */
  // Standaard PDF-lettertypes kennen alleen Latijns-1: andere tekens worden veilig omgezet.
  function pdfSafe(text) {
    return String(text)
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/[^\u0000-\u00ff]/g, (ch) => {
        const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return /^[\x20-\x7e]+$/.test(base) ? base : '?';
      });
  }

  function buildPdf(report) {
    const lib = window.jspdf;
    if (!lib || !lib.jsPDF) throw new Error('jsPDF is niet geladen');
    const doc = new lib.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    if (typeof doc.autoTable !== 'function') throw new Error('jsPDF-AutoTable is niet geladen');

    const created = new Date(report.createdAt);
    const W = 210, H = 297, M = 16;
    const MINT = [183, 209, 205], TEAL = [111, 148, 150], TEAL_D = [59, 98, 100];
    const INK = [35, 58, 60], SOFT = [231, 240, 238], MUTED = [86, 112, 111];

    let totalProducts = 0;
    let totalStock = 0;
    let totalValue = 0;
    report.suppliers.forEach((s) => s.products.forEach((p) => {
      totalProducts += 1;
      totalStock += p.stock;
      totalValue += lineValue(p.price, p.stock);
    }));

    doc.setProperties({ title: `Eindejaarsrapport - ${shortDate(created)}`, subject: 'Voorraadoverzicht per leverancier' });

    // Kop in de kleuren van het logo
    doc.setFillColor(...MINT);
    doc.rect(0, 0, W, 42, 'F');
    doc.setFillColor(...TEAL);
    doc.rect(0, 42, W, 1.2, 'F');

    doc.setTextColor(...INK);
    doc.setFont('times', 'bold');
    doc.setFontSize(27);
    doc.text('Eindejaarsrapport', M, 22);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('photostudioalltech, De Fotograaf, Zottegem', M, 31);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(longDate(created), W - M, 22, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`${timeStr(created)} uur`, W - M, 29, { align: 'right' });

    // Samenvatting
    const stats = [['Leveranciers', report.suppliers.length], ['Totale voorraad', totalStock], ['Totale waarde', pdfEuro(totalValue)]];
    const gap = 6;
    const bw = (W - 2 * M - 2 * gap) / 3;
    stats.forEach(([label, value], i) => {
      const x = M + i * (bw + gap);
      doc.setFillColor(...SOFT);
      doc.roundedRect(x, 52, bw, 22, 3, 3, 'F');
      doc.setTextColor(...MUTED);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(label, x + 5, 60);
      doc.setTextColor(...TEAL_D);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(17);
      doc.text(String(value), x + 5, 69);
    });

    // Een tabel per leverancier
    let y = 86;
    const columnStyles = {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 30 },
      2: { cellWidth: 26 },
      3: { cellWidth: 20, halign: 'right' },
      4: { cellWidth: 27, halign: 'right' },
      5: { cellWidth: 34, halign: 'right' },
    };

    report.suppliers.forEach((s) => {
      if (y > H - 22 - 45) { doc.addPage(); y = M; }

      const subStock = s.products.reduce((sum, p) => sum + p.stock, 0);
      const subValue = s.products.reduce((sum, p) => sum + lineValue(p.price, p.stock), 0);
      const rows = s.products.length
        ? s.products.map((p) => [
            pdfSafe(p.name),
            pdfSafe(p.category || 'Overig'),
            statusOf(p.stock).label,
            String(p.stock),
            pdfEuro(p.price || 0),
            pdfEuro(lineValue(p.price, p.stock)),
          ])
        : [[{ content: 'Geen producten bij deze leverancier', colSpan: 6, styles: { halign: 'center', fontStyle: 'italic', textColor: MUTED } }]];

      doc.autoTable({
        startY: y,
        margin: { left: M, right: M, top: M, bottom: 22 },
        theme: 'grid',
        head: [
          [{ content: pdfSafe(s.name), colSpan: 6, styles: { halign: 'left', fillColor: TEAL_D, textColor: [255, 255, 255], fontSize: 11 } }],
          ['Product', 'Categorie', 'Status', 'Voorraad', 'Prijs/stuk', 'Waarde'],
        ],
        body: rows,
        foot: [['Subtotaal', { content: pl(s.products.length, 'product', 'producten'), colSpan: 2 }, String(subStock), '', pdfEuro(subValue)]],
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.6, textColor: INK, lineColor: [214, 228, 225], lineWidth: 0.2, valign: 'middle' },
        headStyles: { fillColor: SOFT, textColor: INK, fontStyle: 'bold', fontSize: 9 },
        alternateRowStyles: { fillColor: [247, 251, 250] },
        footStyles: { fillColor: SOFT, textColor: INK, fontStyle: 'bold' },
        columnStyles,
        didParseCell: (data) => {
          if (data.section !== 'body' || data.column.index < 2 || data.column.index > 3) return;
          const raw = data.row.raw;
          if (!Array.isArray(raw) || raw.length < 4) return;
          const stock = Number(raw[3]);
          if (Number.isNaN(stock)) return;
          if (stock <= 0) { data.cell.styles.textColor = [156, 47, 40]; data.cell.styles.fontStyle = 'bold'; }
          else if (stock <= LOW_STOCK) { data.cell.styles.textColor = [125, 82, 8]; data.cell.styles.fontStyle = 'bold'; }
        },
      });
      y = doc.lastAutoTable.finalY + 9;
    });

    // Eindtotaal hele winkel
    if (y > H - 22 - 20) { doc.addPage(); y = M; }
    doc.autoTable({
      startY: y,
      margin: { left: M, right: M, bottom: 22 },
      theme: 'plain',
      body: [[{ content: 'Eindtotaal hele winkel', colSpan: 3 }, String(totalStock), '', pdfEuro(totalValue)]],
      styles: { font: 'helvetica', fontSize: 10.5, fontStyle: 'bold', cellPadding: { top: 3.4, bottom: 3.4, left: 3, right: 3 }, fillColor: TEAL_D, textColor: [255, 255, 255] },
      columnStyles,
    });

    // Voetregel op elke pagina
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i += 1) {
      doc.setPage(i);
      doc.setDrawColor(...MINT);
      doc.setLineWidth(0.4);
      doc.line(M, H - 14, W - M, H - 14);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text('All rights reserved to Elif Pekdemir.', M, H - 8.5);
      doc.text(`Pagina ${i} van ${pages}`, W - M, H - 8.5, { align: 'right' });
    }
    return doc;
  }

  function downloadPdf(report) {
    const d = new Date(report.createdAt);
    const file = `Eindejaarsrapport_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.pdf`;
    buildPdf(report).save(file);
  }

  function snapshot() {
    return {
      id: uid(),
      createdAt: new Date().toISOString(),
      suppliers: state.suppliers.map((s) => ({
        name: s.name,
        products: state.products
          .filter((p) => p.supplierId === s.id)
          .sort(byName)
          .map((p) => ({ name: p.name, category: p.category, stock: p.stock, price: p.price })),
      })),
    };
  }

  function generateReport() {
    if (!state.products.length) {
      toast('Er is nog geen voorraad om te rapporteren.');
      return;
    }
    const report = snapshot();
    try {
      downloadPdf(report);
    } catch (err) {
      console.error(err);
      toast('PDF maken is mislukt. Controleer je internetverbinding en probeer opnieuw.');
      return;
    }
    reports.push(report);
    const saved = saveReports();
    renderReports();
    toast(saved
      ? `Rapport - ${shortDate(new Date(report.createdAt))} is gedownload en bewaard`
      : 'Rapport gedownload, maar kon niet in de geschiedenis worden bewaard.');
  }

  $('#btnReport').addEventListener('click', generateReport);

  /* ---------- Start ---------- */
  ensureActive();
  saveState();
  renderAll();
})();