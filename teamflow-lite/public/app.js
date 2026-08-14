const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { me: null, settings: null, users: [], requirements: [], tasks: [], dashboard: null, page: 'dashboard' };
const APP_BASE = new URL('.', document.baseURI).pathname.replace(/\/$/, '');
const labels = {
  status: { draft: '待评审', planned: '已排期', in_progress: '进行中', done: '已完成', cancelled: '已取消', todo: '待开始', review: '待验收' },
  role: { owner: '负责人', admin: '管理员', member: '成员', viewer: '只读成员' },
  type: { feature: '功能需求', improvement: '体验优化', bug: '问题修复', research: '调研' }
};

const icons = {
  home: '<path d="M3 10.5 10 4l7 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 17.5z"/><path d="M8 19v-6h4v6"/>',
  layers: '<path d="m10 3-8 4 8 4 8-4z"/><path d="m2 11 8 4 8-4M2 15l8 4 8-4"/>',
  check: '<rect x="3" y="3" width="14" height="14" rx="3"/><path d="m6.5 10 2.2 2.2 4.8-5"/>',
  users: '<path d="M14 17v-1.5a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3V17"/><circle cx="8.5" cy="7" r="3"/><path d="M14 4.5a3 3 0 0 1 0 5.8M16 12.7a3 3 0 0 1 2 2.8V17"/>',
  settings: '<circle cx="10" cy="10" r="3"/><path d="M16.5 12.5 18 14l-2 3-2-.7a7 7 0 0 1-2 .9L11.5 19h-3L8 17.2a7 7 0 0 1-2-.9L4 17l-2-3 1.5-1.5a7 7 0 0 1 0-5L2 6l2-3 2 .7a7 7 0 0 1 2-.9L8.5 1h3l.5 1.8a7 7 0 0 1 2 .9L16 3l2 3-1.5 1.5a7 7 0 0 1 0 5Z"/>',
  bell: '<path d="M15 8a5 5 0 0 0-10 0c0 6-2.5 6-2.5 7.5h15C17.5 14 15 14 15 8Z"/><path d="M8 18h4"/>',
  menu: '<path d="M3 5h14M3 10h14M3 15h14"/>',
  search: '<circle cx="9" cy="9" r="6"/><path d="m13.5 13.5 4 4"/>',
  clock: '<circle cx="10" cy="10" r="8"/><path d="M10 5v5l3 2"/>',
  alert: '<path d="M10 3 2 17h16z"/><path d="M10 8v4M10 15h.01"/>'
};

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    el.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg>`;
  });
}

async function api(url, options = {}) {
  const response = await fetch(`${APP_BASE}${url}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2400);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function userName(id) { return state.users.find(user => user.id === id)?.name || '待分配'; }
function avatar(name) { return `<span class="avatar">${escapeHtml((name || '?').slice(0, 1))}</span>`; }
function can(permission) { return state.me?.permissions?.includes(permission); }
function statusPill(status) { return `<span class="status-pill ${status}">${labels.status[status] || status}</span>`; }
function priorityPill(priority) { return `<span class="priority ${priority}">${priority}</span>`; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`)) : '未设置'; }
function relativeTime(value) {
  const diff = Date.now() - new Date(value).getTime(); const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚'; if (minutes < 60) return `${minutes} 分钟前`; if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`; return `${Math.floor(minutes / 1440)} 天前`;
}

async function loadCore() {
  const [me, users, requirements, tasks, dashboard] = await Promise.all([
    api('/api/me'), api('/api/users'), api('/api/requirements'), api('/api/tasks'), api('/api/dashboard')
  ]);
  Object.assign(state, { me: me.user, settings: me.settings, users: users.users, requirements: requirements.requirements, tasks: tasks.tasks, dashboard });
  $('#teamLabel').textContent = state.settings.teamName;
  $('#userCard').innerHTML = `${avatar(state.me.name)}<div><strong>${escapeHtml(state.me.name)}</strong><small>${labels.role[state.me.role]}</small></div><button class="logout-btn" id="logoutBtn" title="退出">↗</button>`;
  $('#logoutBtn').onclick = logout;
  const count = dashboard.reminders.length; $('#reminderBadge').textContent = count; $('#reminderBadge').classList.toggle('hidden', !count);
}

async function init() {
  hydrateIcons();
  try {
    await loadCore();
    if (!new URLSearchParams(location.search).has('teamflow')) {
      location.replace(APP_BASE + '/hub.html');
      return;
    }
    showApp(); navigate('dashboard');
  } catch { $('#loginView').classList.remove('hidden'); }
}

function showApp() { $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden'); }
async function logout() { await api('/api/logout', { method: 'POST' }); location.reload(); }

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; button.textContent = '正在登录…';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    await loadCore(); location.replace(APP_BASE + '/hub.html'); return; toast('欢迎回来');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.innerHTML = '进入工作台 <span>→</span>'; }
});

$('#nav').addEventListener('click', event => {
  const button = event.target.closest('button[data-page]'); if (button) navigate(button.dataset.page);
});
$('#menuBtn').onclick = () => $('.sidebar').classList.toggle('open');
$('#globalCreateBtn').onclick = openRequirementForm;
$('#settingsBtn').onclick = openSettings;
$('#reminderBtn').onclick = openReminders;
$$('[data-close-modal]').forEach(el => el.onclick = closeModal);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

function navigate(page) {
  state.page = page; $('.sidebar').classList.remove('open');
  $$('#nav button').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  const titles = { dashboard: '工作总览', requirements: '产品需求', tasks: '团队任务', team: '团队成员' }; $('#pageTitle').textContent = titles[page];
  ({ dashboard: renderDashboard, requirements: renderRequirements, tasks: renderTasks, team: renderTeam }[page] || renderDashboard)();
}

function renderDashboard() {
  const d = state.dashboard;
  const stat = (label, value, note, icon) => `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon" data-icon="${icon}"></span></div><div><strong>${value}</strong><br><small>${note}</small></div></article>`;
  $('#content').innerHTML = `
    <div class="welcome-row"><div><h2>你好，${escapeHtml(state.me.name)} 👋</h2><p>这里是团队今天需要关注的事情。</p></div><span class="date-chip">${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span></div>
    <section class="stat-grid">
      ${stat('进行中的需求', d.stats.activeRequirements, '保持聚焦，持续推进', 'layers')}
      ${stat('待完成任务', d.stats.openTasks, '团队当前工作量', 'check')}
      ${stat('已逾期事项', d.stats.overdue, d.stats.overdue ? '需要尽快处理' : '当前没有逾期', 'alert')}
      ${stat('团队成员', d.stats.teamMembers, '当前活跃成员', 'users')}
    </section>
    <section class="dashboard-grid">
      <div class="panel"><div class="panel-head"><h3>重点需求</h3><button class="link-btn" data-go="requirements">查看全部 →</button></div>
        ${d.priorityRequirements.length ? d.priorityRequirements.map(requirementRow).join('') : '<div class="empty">还没有进行中的需求</div>'}
      </div>
      <div class="panel"><div class="panel-head"><h3>近期提醒</h3><button class="link-btn" id="dashReminder">全部提醒</button></div>
        ${d.reminders.length ? d.reminders.slice(0, 5).map(reminderRow).join('') : '<div class="empty">近期没有到期事项</div>'}
      </div>
    </section>
    <section class="panel" style="margin-top:16px"><div class="panel-head"><h3>团队动态</h3></div>
      ${d.activities.length ? d.activities.map(activity => `<div class="activity-item"><span class="reminder-dot" data-icon="check"></span><div><p>${escapeHtml(userName(activity.actorId))} ${escapeHtml(activity.action)}</p><small>${relativeTime(activity.createdAt)}</small></div></div>`).join('') : '<div class="empty">暂无动态</div>'}
    </section>`;
  hydrateIcons($('#content'));
  $$('[data-requirement]').forEach(el => el.onclick = () => openRequirement(el.dataset.requirement));
  $('[data-go="requirements"]').onclick = () => navigate('requirements');
  $('#dashReminder').onclick = openReminders;
}

function requirementRow(item) {
  return `<div class="requirement-row" data-requirement="${item.id}"><div><div class="item-title">${escapeHtml(item.title)}</div><div class="item-sub">${priorityPill(item.priority)}<span>${escapeHtml(userName(item.ownerId))}</span><span>· ${formatDate(item.targetDate)}</span></div></div><div class="progress-wrap"><div class="progress-track"><i style="width:${item.computedProgress}%"></i></div><small>${item.computedProgress}%</small></div>${statusPill(item.status)}</div>`;
}

function reminderRow(item) {
  return `<div class="reminder-item"><span class="reminder-dot ${item.kind}" data-icon="${item.kind === 'overdue' ? 'alert' : 'clock'}"></span><div><p>${escapeHtml(item.title)}</p><small>${item.kind === 'overdue' ? '已逾期' : '即将到期'} · ${formatDate(item.dueDate)}</small></div></div>`;
}

function renderRequirements(filter = '') {
  const list = state.requirements.filter(item => !filter || item.title.toLowerCase().includes(filter.toLowerCase()));
  $('#content').innerHTML = `<div class="section-head"><div><h2>产品需求</h2><p>从提出到交付，持续看清每个需求的状态。</p></div><button class="btn primary" id="newRequirement"><span>＋</span> 新建需求</button></div>
    <div class="toolbar"><div class="search"><span data-icon="search"></span><input id="requirementSearch" placeholder="搜索需求…" value="${escapeHtml(filter)}"></div><select id="requirementStatus" class="filter-select"><option value="">全部状态</option>${Object.entries(labels.status).slice(0,5).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>需求</th><th>负责人</th><th>状态</th><th>进度</th><th>目标日期</th></tr></thead><tbody id="requirementRows">${renderRequirementTable(list)}</tbody></table></div>`;
  hydrateIcons($('#content')); $('#newRequirement').onclick = openRequirementForm;
  $('#requirementSearch').oninput = event => { $('#requirementRows').innerHTML = renderRequirementTable(state.requirements.filter(i => i.title.toLowerCase().includes(event.target.value.toLowerCase()) && (!$('#requirementStatus').value || i.status === $('#requirementStatus').value))); bindRequirementRows(); };
  $('#requirementStatus').onchange = () => $('#requirementSearch').dispatchEvent(new Event('input')); bindRequirementRows();
}

function renderRequirementTable(list) {
  if (!list.length) return '<tr><td colspan="5"><div class="empty">没有找到需求</div></td></tr>';
  return list.map(item => `<tr class="clickable" data-requirement="${item.id}"><td><div class="item-title">${escapeHtml(item.title)}</div><div class="item-sub">${priorityPill(item.priority)} ${labels.type[item.type] || item.type}</div></td><td><div class="person">${avatar(userName(item.ownerId))}<span>${escapeHtml(userName(item.ownerId))}</span></div></td><td>${statusPill(item.status)}</td><td><div class="progress-wrap"><div class="progress-track"><i style="width:${item.computedProgress}%"></i></div><small>${item.computedProgress}%</small></div></td><td>${formatDate(item.targetDate)}</td></tr>`).join('');
}
function bindRequirementRows() { $$('[data-requirement]').forEach(row => row.onclick = () => openRequirement(row.dataset.requirement)); }

function renderTasks() {
  const columns = [['todo', '待开始'], ['in_progress', '进行中'], ['done', '已完成']];
  $('#content').innerHTML = `<div class="section-head"><div><h2>团队任务</h2><p>按状态推进任务，优先处理即将到期的工作。</p></div>${can('task.manage') ? '<button class="btn primary" id="newTask"><span>＋</span> 新建任务</button>' : ''}</div>
    <div class="toolbar"><div class="search"><span data-icon="search"></span><input id="taskSearch" placeholder="搜索任务…"></div><select id="taskPerson" class="filter-select"><option value="">所有成员</option>${state.users.filter(u=>u.status==='active').map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}</select></div><div id="kanban" class="kanban">${renderKanban(columns, state.tasks)}</div>`;
  hydrateIcons($('#content')); if ($('#newTask')) $('#newTask').onclick = openTaskForm;
  const filter = () => { const q = $('#taskSearch').value.toLowerCase(), person = $('#taskPerson').value; $('#kanban').innerHTML = renderKanban(columns, state.tasks.filter(t => (!q || t.title.toLowerCase().includes(q)) && (!person || t.assigneeId === person))); bindTasks(); };
  $('#taskSearch').oninput = filter; $('#taskPerson').onchange = filter; bindTasks();
}

function renderKanban(columns, tasks) {
  return columns.map(([status, title]) => { const items = tasks.filter(task => task.status === status || (status === 'in_progress' && task.status === 'review'));
    return `<section class="kanban-col"><div class="kanban-head"><span>${title}</span><span class="count">${items.length}</span></div>${items.map(task => `<article class="task-card" data-task="${task.id}">${priorityPill(task.priority)}<p>${escapeHtml(task.title)}</p><div class="task-card-footer"><span>${formatDate(task.dueDate)}</span><span class="mini-avatar">${escapeHtml(userName(task.assigneeId).slice(0,1))}</span></div></article>`).join('') || '<div class="empty">暂无任务</div>'}</section>`;
  }).join('');
}
function bindTasks() { $$('[data-task]').forEach(card => card.onclick = () => openTask(card.dataset.task)); }

function renderTeam() {
  const cards = state.users.map(member => {
    const controls = can('team.manage') && member.role !== 'owner' ? `<select class="role-select" data-member-role="${member.id}">${['admin','member','viewer'].map(role => `<option value="${role}" ${member.role === role ? 'selected' : ''}>${labels.role[role]}</option>`).join('')}</select><select class="role-select" data-member-status="${member.id}"><option value="active" ${member.status === 'active' ? 'selected' : ''}>在团队中</option><option value="disabled" ${member.status === 'disabled' ? 'selected' : ''}>暂停团队访问</option></select>` : `<span class="role-select">${labels.role[member.role]}</span>`;
    return `<article class="member-card"><div class="member-card-head">${avatar(member.name)}${member.status === 'disabled' ? '<span class="status-pill">已暂停</span>' : ''}</div><h3>${escapeHtml(member.name)}</h3><p>${escapeHtml(member.title || member.email)}</p><div class="member-meta"><span>${escapeHtml(member.email)}</span>${controls}</div></article>`;
  }).join('');
  $('#content').innerHTML = `<div class="section-head"><div><h2>团队成员</h2><p>管理当前团队的角色与成员状态。密码仅能由用户在 Tona AI Hub 中自行修改。</p></div>${can('team.manage') ? '<button class="btn primary" id="newMember"><span>+</span> 添加已注册账号</button>' : ''}</div><div class="member-grid">${cards}</div>`;
  if ($('#newMember')) $('#newMember').onclick = openMemberForm;
  $$('[data-member-role]').forEach(select => select.onchange = async () => { try { await api(`/api/users/${select.dataset.memberRole}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); await refresh('team'); toast('成员角色已更新'); } catch (error) { toast(error.message); } });
  $$('[data-member-status]').forEach(select => select.onchange = async () => { try { await api(`/api/users/${select.dataset.memberStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); await refresh('team'); toast('团队成员状态已更新'); } catch (error) { toast(error.message); } });
}

function openModal(html, wide = false) { $('#modalContent').innerHTML = html; $('.modal-card').classList.toggle('wide-modal', wide); $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('.modal-card').classList.remove('wide-modal'); }
function options(items, selected = '') { return items.map(([value,label]) => `<option value="${value}" ${value===selected?'selected':''}>${label}</option>`).join(''); }

function openRequirementForm() {
  openModal(`<p class="eyebrow">New requirement</p><h2>提出一个新需求</h2><p class="modal-desc">先说清问题与目标，细节可以在评审中继续补充。</p><form id="requirementForm" class="form-grid"><label class="full">需求标题<input name="title" required placeholder="例如：新增客户反馈收集入口"></label><label class="full">背景与目标<textarea name="summary" placeholder="为什么要做？希望解决什么问题？"></textarea></label><label>需求类型<select name="type">${options(Object.entries(labels.type))}</select></label><label>优先级<select name="priority">${options([['P0','P0 · 紧急重要'],['P1','P1 · 重要'],['P2','P2 · 常规'],['P3','P3 · 待观察']], 'P2')}</select></label><label>负责人<select name="ownerId">${state.users.filter(u=>u.status==='active').map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}</select></label><label>目标日期<input name="targetDate" type="date"></label><div class="modal-actions full"><button type="button" class="btn secondary" data-close>取消</button><button class="btn primary" type="submit">创建需求</button></div></form>`);
  $('[data-close]').onclick = closeModal; $('#requirementForm').onsubmit = async event => { event.preventDefault(); try { await api('/api/requirements', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); await refresh('requirements'); toast('需求已创建'); } catch(error) { toast(error.message); } };
}

async function openRequirement(requirementId) {
  try {
    const data = await api(`/api/requirements/${requirementId}`); const item = data.requirement;
    openModal(`<p class="eyebrow">${labels.type[item.type] || item.type}</p><h2>${escapeHtml(item.title)}</h2><div class="detail-meta">${priorityPill(item.priority)}${statusPill(item.status)}<span class="muted">负责人：${escapeHtml(userName(item.ownerId))} · ${formatDate(item.targetDate)}</span></div><div class="detail-summary">${escapeHtml(item.summary || '暂时没有补充需求背景。')}</div>
      <div class="detail-section"><div class="panel-head"><h3>任务拆解 · ${data.tasks.length}</h3>${can('requirement.manage') && !data.tasks.length ? '<button class="link-btn" id="decomposeBtn">智能拆解</button>' : ''}</div>${data.tasks.length ? data.tasks.map(task => `<div class="mini-task"><button class="${task.status==='done'?'done':''}" data-toggle-task="${task.id}">${task.status==='done'?'✓':''}</button><span>${escapeHtml(task.title)}</span><small>${escapeHtml(userName(task.assigneeId))} · ${formatDate(task.dueDate)}</small></div>`).join('') : '<div class="empty">尚未拆解任务</div>'}</div>
      <div class="detail-section"><div class="panel-head"><h3>时间节点 · ${data.milestones.length}</h3>${can('requirement.manage') ? '<button class="link-btn" id="addMilestone">＋ 添加节点</button>' : ''}</div>${data.milestones.map(m=>`<div class="mini-task"><span>◆ ${escapeHtml(m.title)}</span><small>${formatDate(m.dueDate)}</small></div>`).join('') || '<div class="empty">还没有设置节点</div>'}</div>
      ${can('requirement.manage') ? `<div class="modal-actions"><select id="requirementStatusEdit" class="filter-select">${options(Object.entries(labels.status).slice(0,5),item.status)}</select><button class="btn primary" id="saveRequirementStatus">更新状态</button></div>` : ''}`, true);
    if ($('#decomposeBtn')) $('#decomposeBtn').onclick = async () => { try { await api(`/api/requirements/${item.id}/decompose`, { method:'POST' }); toast('已生成 4 个基础任务'); openRequirement(item.id); await loadCore(); } catch(error) { toast(error.message); } };
    if ($('#addMilestone')) $('#addMilestone').onclick = () => openMilestoneForm(item.id);
    if ($('#saveRequirementStatus')) $('#saveRequirementStatus').onclick = async () => { try { await api(`/api/requirements/${item.id}`, { method:'PATCH', body: JSON.stringify({ status: $('#requirementStatusEdit').value }) }); closeModal(); await refresh(state.page); toast('需求状态已更新'); } catch(error){ toast(error.message); } };
    $$('[data-toggle-task]').forEach(button => button.onclick = async () => { const task = state.tasks.find(t=>t.id===button.dataset.toggleTask) || data.tasks.find(t=>t.id===button.dataset.toggleTask); try { await api(`/api/tasks/${task.id}`, { method:'PATCH', body: JSON.stringify({ status: task.status==='done'?'todo':'done' }) }); await loadCore(); openRequirement(item.id); } catch(error){ toast(error.message); } });
  } catch(error) { toast(error.message); }
}

function openTaskForm() {
  openModal(`<p class="eyebrow">New task</p><h2>新建团队任务</h2><p class="modal-desc">明确负责人和截止日期，任务才真正开始。</p><form id="taskForm" class="form-grid"><label class="full">任务标题<input name="title" required></label><label class="full">任务说明<textarea name="description"></textarea></label><label>关联需求<select name="requirementId"><option value="">不关联需求</option>${state.requirements.map(r=>`<option value="${r.id}">${escapeHtml(r.title)}</option>`).join('')}</select></label><label>负责人<select name="assigneeId">${state.users.filter(u=>u.status==='active').map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}</select></label><label>截止日期<input type="date" name="dueDate"></label><label>优先级<select name="priority">${options([['P0','P0'],['P1','P1'],['P2','P2'],['P3','P3']],'P2')}</select></label><div class="modal-actions full"><button type="button" class="btn secondary" data-close>取消</button><button class="btn primary">创建任务</button></div></form>`);
  $('[data-close]').onclick=closeModal; $('#taskForm').onsubmit=async event=>{event.preventDefault();try{await api('/api/tasks',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});closeModal();await refresh('tasks');toast('任务已创建');}catch(error){toast(error.message);}};
}

function openTask(taskId) {
  const task = state.tasks.find(item => item.id === taskId); if (!task) return;
  openModal(`<p class="eyebrow">Team task</p><h2>${escapeHtml(task.title)}</h2><p class="modal-desc">${escapeHtml(task.description || '暂无任务说明')}</p><form id="taskEditForm" class="form-grid"><label>任务状态<select name="status">${options([['todo','待开始'],['in_progress','进行中'],['review','待验收'],['done','已完成']],task.status)}</select></label><label>负责人<select name="assigneeId">${state.users.filter(u=>u.status==='active').map(u=>`<option value="${u.id}" ${u.id===task.assigneeId?'selected':''}>${escapeHtml(u.name)}</option>`).join('')}</select></label><label>截止日期<input type="date" name="dueDate" value="${task.dueDate || ''}"></label><label>优先级<select name="priority">${options([['P0','P0'],['P1','P1'],['P2','P2'],['P3','P3']],task.priority)}</select></label><div class="modal-actions full"><button type="button" class="btn secondary" data-close>取消</button><button class="btn primary">保存更新</button></div></form>`);
  $('[data-close]').onclick=closeModal; $('#taskEditForm').onsubmit=async event=>{event.preventDefault();try{await api(`/api/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});closeModal();await refresh('tasks');toast('任务已更新');}catch(error){toast(error.message);}};
}

function openMemberForm() {
  openModal(`<p class="eyebrow">Existing Hub account</p><h2>添加已注册成员</h2><p class="modal-desc">这里只管理是否加入当前团队，不设置密码。</p><form id="memberForm" class="form-grid"><label class="full">已注册的工作邮箱<input type="email" name="email" required></label><label>团队内岗位<input name="title"></label><label>角色<select name="role">${options([['member','成员'],['admin','管理员'],['viewer','只读成员']])}</select></label><div class="modal-actions full"><button type="button" class="btn secondary" data-close>取消</button><button class="btn primary">加入团队</button></div></form>`);
  $('[data-close]').onclick = closeModal; $('#memberForm').onsubmit = async event => { event.preventDefault(); try { await api('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); await refresh('team'); toast('成员已加入当前团队'); } catch (error) { toast(error.message); } };
}

function openMilestoneForm(requirementId) {
  openModal(`<p class="eyebrow">Milestone</p><h2>添加时间节点</h2><p class="modal-desc">关键节点将自动进入团队提醒。</p><form id="milestoneForm" class="form-grid"><input type="hidden" name="requirementId" value="${requirementId}"><label class="full">节点名称<input name="title" required placeholder="例如：产品评审 / 内部验收 / 正式上线"></label><label class="full">计划日期<input type="date" name="dueDate" required></label><div class="modal-actions full"><button type="button" class="btn secondary" data-close>取消</button><button class="btn primary">添加节点</button></div></form>`);
  $('[data-close]').onclick=closeModal; $('#milestoneForm').onsubmit=async event=>{event.preventDefault();try{await api('/api/milestones',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});toast('时间节点已添加');openRequirement(requirementId);await loadCore();}catch(error){toast(error.message);}};
}

function openSettings() {
  if (!can('settings.manage')) return toast('仅团队负责人可以修改设置');
  openModal(`<p class="eyebrow">Team settings</p><h2>团队设置</h2><p class="modal-desc">配置团队名称和到期提醒范围。</p><form id="settingsForm" class="form-grid"><label class="full">团队名称<input name="teamName" value="${escapeHtml(state.settings.teamName)}"></label><label class="full">提前提醒天数<input type="number" min="1" max="30" name="reminderDays" value="${state.settings.reminderDays}"></label><label class="full">Team Key<input name="teamKey" value="${escapeHtml(state.settings.teamKey || '')}" placeholder="&#30041;&#31354;&#34920;&#31034;&#19981;&#38480;&#21046;&#36827;&#20837;"></label><div class="modal-actions full"><button type="button" class="btn secondary" data-close>取消</button><button class="btn primary">保存设置</button></div></form>`);
  $('[data-close]').onclick=closeModal; $('#settingsForm').onsubmit=async event=>{event.preventDefault();try{await api('/api/settings',{method:'PATCH',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});closeModal();await refresh(state.page);toast('设置已保存');}catch(error){toast(error.message);}};
}

function openReminders() {
  const reminders = state.dashboard.reminders;
  openModal(`<p class="eyebrow">Reminders</p><h2>待办提醒</h2><p class="modal-desc">提前 ${state.settings.reminderDays} 天提醒，逾期事项会持续显示。</p>${reminders.length ? reminders.map(reminderRow).join('') : '<div class="empty">没有需要提醒的事项，进展很顺利。</div>'}`);
  hydrateIcons($('#modalContent'));
}

async function refresh(page = state.page) { await loadCore(); navigate(page); }
init();
let registrationConfig = { mode: 'closed', canRegister: false, inviteRequired: false };
async function loadRegistrationConfig() {
  try { registrationConfig = await api('/api/registration-config'); } catch {}
  $('#showRegister').classList.toggle('hidden', !registrationConfig.canRegister);
  $('#inviteCodeField').classList.toggle('hidden', !registrationConfig.inviteRequired);
}
function showAuthForm(register) {
  if (register && !registrationConfig.canRegister) return toast('Registration is currently closed.');
  $('#loginForm').classList.toggle('hidden', register); $('#registerForm').classList.toggle('hidden', !register);
}
loadRegistrationConfig();
$('#showRegister').addEventListener('click', () => showAuthForm(true));
$('#showLogin').addEventListener('click', () => showAuthForm(false));
$('#registerForm').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; button.textContent = 'Creating...'; try { await api('/api/register', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); location.replace(APP_BASE + '/hub.html'); } catch (error) { toast(error.message); } finally { button.disabled = false; button.innerHTML = 'Create and enter <span>?</span>'; } });
