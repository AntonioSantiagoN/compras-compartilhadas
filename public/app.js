const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const fmt = date => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
const state = { role: null, selected: null, lists: [], details: null };
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
  return data;
}
function toast(message) { const el = $('toast'); el.textContent = message; el.style.display = 'block'; clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.style.display = 'none', 3500); }
function showApp() {
  $('loginView').hidden = !!state.role; $('appView').hidden = !state.role; $('topActions').hidden = !state.role;
  $('newListButton').hidden = state.role !== 'admin'; $('roleTag').textContent = state.role === 'admin' ? 'Administrador' : 'Participante';
}
function status(l) { const current = Date.now(), start = Date.parse(l.starts_at), end = Date.parse(l.ends_at); return current < start ? ['Em breve','soon'] : current < end ? ['Aberta',''] : ['Encerrada','closed']; }
async function refreshLists() {
  const data = await request('/api/lists'); state.lists = data.lists; renderLists();
}
function renderLists() {
  $('listCards').hidden = state.selected !== null; $('emptyList').hidden = !!state.lists.length || state.selected !== null;
  if (state.selected !== null) return;
  $('listCards').innerHTML = state.lists.map(l => { const [label, cls] = status(l); return `<button class="list-card" data-list="${l.id}"><span class="status ${cls}">${label}</span><h3>${escapeHTML(l.title)}</h3><p>${escapeHTML(l.description || 'Lista compartilhada de produtos.')}</p><p>📅 ${fmt(l.starts_at)}<br>⏳ ${l.duration_days} dia(s) · até ${fmt(l.ends_at)}</p></button>`; }).join('');
  $('listCards').querySelectorAll('[data-list]').forEach(btn => btn.onclick = () => selectList(Number(btn.dataset.list)));
}
async function selectList(id) { state.selected = id; $('detail').hidden = false; renderLists(); await refreshDetail(); $('detail').scrollIntoView({ behavior: 'smooth' }); }
async function refreshDetail() {
  if (state.selected === null) return;
  const data = await request(`/api/lists/${state.selected}`); state.details = data.list; renderDetail();
}
function renderDetail() {
  const l = state.details; if (!l) return;
  const [label, cls] = status(l);
  const products = l.products.map(p => {
    const last = p.lots[p.lots.length - 1];
    const showLots = last.registrations.length === 4 && l.open ? [...p.lots, { number: last.number + 1, registrations: [] }] : p.lots;
    return `<article class="product-card"><div class="product-head"><span class="eyebrow">PRODUTO</span><h3>${escapeHTML(p.name)}</h3><div class="count">${p.total_participants} participante(s) · ${p.total_quantity} unidade(s) solicitada(s)</div></div><div class="lots">${showLots.map(lot => `<div class="lot"><div class="lot-top"><strong>Lote ${lot.number}</strong><span class="spots">${lot.registrations.length}/4 participantes</span></div><div class="progress"><span style="width:${lot.registrations.length * 25}%"></span></div>${lot.registrations.length ? `<div class="people">${lot.registrations.map(r => `<div class="person"><div><strong>${escapeHTML(r.name)}</strong><small>☎ ${escapeHTML(r.phone)}</small></div><div class="qty">${r.quantity} un.${state.role === 'admin' ? `<button class="delete" data-remove="${r.id}" title="Remover inscrição">✕</button>` : ''}</div></div>`).join('')}</div>` : '<div class="hint">Novo lote pronto para receber participantes.</div>'}</div>`).join('')}</div><div class="product-foot">${l.open ? `<button class="primary full" data-product="${p.id}" data-name="${escapeHTML(p.name)}">+ Quero participar</button>` : `<button class="ghost full" disabled>Inscrições indisponíveis</button>`}</div></article>`;
  }).join('');
  $('detailBody').innerHTML = `<div class="detail-header"><span class="status ${cls}">${label}</span><h2>${escapeHTML(l.title)}</h2><p>${escapeHTML(l.description)}</p><p>📅 Início: ${fmt(l.starts_at)} &nbsp; · &nbsp; Término: ${fmt(l.ends_at)}</p></div><div class="product-grid">${products}</div>`;
  $('detailBody').querySelectorAll('[data-product]').forEach(b => b.onclick = () => openRegistration(Number(b.dataset.product), b.dataset.name));
  $('detailBody').querySelectorAll('[data-remove]').forEach(b => b.onclick = () => removeRegistration(Number(b.dataset.remove)));
}
function openModal(title, html) { $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').hidden = false; }
function closeModal() { $('modal').hidden = true; $('modalBody').innerHTML = ''; }
function openRegistration(id, productName) {
  openModal('Participar da compra', `<p class="muted">Produto: <strong>${escapeHTML(productName)}</strong></p><form id="registerForm"><label>Seu nome completo<input name="name" maxlength="90" placeholder="Ex.: Maria Silva" required minlength="2"></label><label>Telefone / WhatsApp<input name="phone" inputmode="tel" maxlength="22" placeholder="(61) 99999-9999" required></label><label>Quantidade que deseja comprar<input name="quantity" type="number" min="1" max="10000" value="1" required></label><p class="help">Cada lote reúne até 4 participantes, independentemente da quantidade comprada. Uma inscrição por telefone em cada produto.</p><div class="row-actions"><button type="button" class="ghost" id="cancelForm">Cancelar</button><button class="primary" type="submit">Confirmar participação</button></div></form>`);
  $('cancelForm').onclick = closeModal;
  $('registerForm').onsubmit = async event => {
    event.preventDefault(); const form = new FormData(event.target); const submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
    try { const result = await request(`/api/products/${id}/register`, { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); closeModal(); await refreshDetail(); toast(`Inscrição confirmada no lote ${result.lot}!`); }
    catch (error) { toast(error.message); submit.disabled = false; }
  };
}
function openNewList() {
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  openModal('Criar nova lista', `<form id="newListForm"><label>Nome da lista<input name="title" required maxlength="100" placeholder="Ex.: Compras de novembro"></label><label>Descrição (opcional)<textarea name="description" maxlength="500" placeholder="Orientações para o grupo"></textarea></label><div class="date-grid"><label>Data e hora de início<input name="starts_at" type="datetime-local" value="${local}" required></label><label>Duração em dias<input name="duration_days" type="number" min="1" max="365" value="7" required></label></div><label>Produtos (um por linha)<textarea name="products" required placeholder="Arroz 5 kg&#10;Feijão 1 kg&#10;Café 500 g"></textarea></label><p class="help">Cada produto abre automaticamente um novo lote após reunir 4 participantes. Você pode criar quantas listas quiser.</p><div class="row-actions"><button type="button" class="ghost" id="cancelForm">Cancelar</button><button class="primary" type="submit">Criar lista</button></div></form>`);
  $('cancelForm').onclick = closeModal;
  $('newListForm').onsubmit = async event => {
    event.preventDefault(); const form = Object.fromEntries(new FormData(event.target).entries());
    form.starts_at = new Date(form.starts_at).toISOString();
    form.products = form.products.split('\n').map(s => s.trim()).filter(Boolean);
    const submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
    try { const result = await request('/api/lists', { method: 'POST', body: JSON.stringify(form) }); closeModal(); await refreshLists(); await selectList(result.id); toast('Lista criada com sucesso!'); }
    catch (error) { toast(error.message); submit.disabled = false; }
  };
}
async function removeRegistration(id) {
  if (!confirm('Remover esta inscrição? Os lotes serão reorganizados automaticamente.')) return;
  try { await request(`/api/registrations/${id}`, { method: 'DELETE' }); await refreshDetail(); toast('Inscrição removida.'); }
  catch (error) { toast(error.message); }
}
$('loginForm').onsubmit = async e => {
  e.preventDefault(); $('loginError').hidden = true;
  try { const data = await request('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); state.role = data.role; $('password').value = ''; showApp(); await refreshLists(); }
  catch (error) { $('loginError').textContent = error.message; $('loginError').hidden = false; }
};
$('logout').onclick = async () => { await request('/api/logout', { method: 'POST' }); state.role = null; state.selected = null; state.details = null; $('detail').hidden = true; showApp(); };
$('back').onclick = () => { state.selected = null; state.details = null; $('detail').hidden = true; renderLists(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
$('refresh').onclick = () => refreshDetail().catch(err => toast(err.message));
$('newListButton').onclick = openNewList;
$('closeModal').onclick = closeModal;
$('modal').onclick = event => { if (event.target === $('modal')) closeModal(); };
setInterval(async () => { if (!state.role || !$('modal').hidden) return; try { await refreshLists(); if (state.selected !== null) await refreshDetail(); } catch {} }, 5000);
(async () => { try { const session = await request('/api/session'); state.role = session.role; showApp(); if (state.role) await refreshLists(); } catch { showApp(); } })();
