const base = new URL('.', document.baseURI).pathname.replace(/\/$/, '');
async function api(path, options = {}) { const response = await fetch(base + path, { headers: { 'Content-Type': 'application/json' }, ...options }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Request failed'); return data; }
function openTeamFlow() { location.href = base + '/?teamflow=1'; }
function selectAndOpen(teamId) { return api('/api/hub/select-team', { method: 'POST', body: JSON.stringify({ teamId }) }).then(openTeamFlow); }
function renderTeams(teams) {
  const holder = document.querySelector('#teamMembership');
  if (!teams?.length) { holder.textContent = ''; return; }
  holder.innerHTML = '<p class="team-list-title">\u4f60\u5df2\u52a0\u5165\u7684\u56e2\u961f</p>' + teams.map(team => '<button class="text-button team-select" data-team="' + team.id + '">' + (team.active ? '\u5f53\u524d\uff1a' : '') + team.name + '</button>').join('');
  holder.querySelectorAll('[data-team]').forEach(button => button.addEventListener('click', async () => { try { localStorage.setItem('tonaLastTeamId', button.dataset.team); await selectAndOpen(button.dataset.team); } catch (error) { document.querySelector('#teamHint').textContent = error.message; } }));
  const lastTeam = teams.find(team => team.id === localStorage.getItem('tonaLastTeamId')); const direct = document.querySelector('#openLastTeam');
  if (lastTeam) { direct.textContent = '\u76f4\u63a5\u8fdb\u5165\uff1a' + lastTeam.name; direct.classList.remove('hidden'); direct.onclick = async () => { try { await selectAndOpen(lastTeam.id); } catch (error) { document.querySelector('#teamHint').textContent = error.message; } }; } else { direct.classList.add('hidden'); }
}
function renderResearchStudio(feature) {
  if (!feature?.enabled || !feature.url) return;
  const style = document.createElement('style');
  style.textContent = '.hub-shell{max-width:1380px}.hub-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.research-card{border-color:#7e739e;box-shadow:0 20px 45px rgba(73,61,105,.09)}.research-card .card-icon{background:#ece9f5;color:#554a77}.research-tag{background:#ece9f5;color:#554a77}.research-button{border:0;border-radius:7px;padding:12px 15px;background:#554a77;color:#fff;font:inherit;font-weight:750;cursor:pointer}@media(max-width:1000px){.hub-grid{grid-template-columns:1fr 1fr}.research-card{grid-column:1/-1}}@media(max-width:700px){.hub-grid{grid-template-columns:1fr}.research-card{grid-column:auto}}';
  document.head.append(style);
  const card = document.createElement('article');
  card.className = 'hub-card research-card';
  card.innerHTML = '<div class="card-top"><span class="card-icon">RS</span><span class="tag research-tag">\u4ec5\u4f60\u53ef\u89c1</span></div>'
    + '<h2>Research Studio</h2>'
    + '<p>\u91c7\u96c6\u7814\u7a76\u6750\u6599\uff0c\u5ba1\u6838 AI \u5efa\u8bae\uff0c\u8fde\u63a5\u4e0e\u4fee\u8ba2\u89c2\u70b9\uff0c\u5e76\u5c06\u6210\u719f\u601d\u8003\u8f6c\u5316\u4e3a\u53ef\u53d1\u5e03\u5185\u5bb9\u3002</p>'
    + '<div class="card-footer"><span>\u79c1\u4eba\u7814\u7a76\u5de5\u4f5c\u53f0</span><button id="openResearch" class="research-button">\u8fdb\u5165 Research Studio <b>&rarr;</b></button></div>';
  document.querySelector('.hub-grid').append(card);
  card.querySelector('#openResearch').onclick = () => location.assign(feature.url);
}
(async () => { try { const hub = await api('/api/hub'); document.querySelector('#welcome').textContent = hub.user.name + '\uff0c\u4f60\u7684\u4e2a\u4eba AI \u5de5\u4f5c\u533a\u5df2\u7ecf\u51c6\u5907\u597d\u3002'; document.querySelector('#openStudio').onclick = () => location.href = hub.aiStudioUrl; document.querySelector('#teamHint').textContent = '\u8f93\u5165\u56e2\u961f\u8d1f\u8d23\u4eba\u63d0\u4f9b\u7684\u9080\u8bf7\u7801\uff0c\u52a0\u5165\u5171\u4eab TeamFlow \u56e2\u961f\u3002'; renderTeams(hub.teams); renderResearchStudio(hub.researchStudio); } catch { location.href = base + '/'; } })();
document.querySelector('#teamAccess').addEventListener('submit', async event => { event.preventDefault(); const hint = document.querySelector('#teamHint'); try { const result = await api('/api/hub/team-access', { method: 'POST', body: JSON.stringify({ teamKey: document.querySelector('#teamKey').value }) }); localStorage.setItem('tonaLastTeamId', result.team.id); openTeamFlow(); } catch (error) { hint.textContent = error.message; } });
document.querySelector('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = base + '/'; };

const accountModal = document.querySelector('#accountModal');
document.querySelector('#accountSettings').onclick = () => { document.querySelector('#passwordForm').reset(); document.querySelector('#passwordMessage').textContent = ''; accountModal.classList.remove('hidden'); };
document.querySelector('#closeAccount').onclick = () => accountModal.classList.add('hidden');
document.querySelector('#passwordForm').onsubmit = async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const message = document.querySelector('#passwordMessage'); if (form.get('newPassword') !== form.get('confirmPassword')) { message.textContent = '\u4e24\u6b21\u65b0\u5bc6\u7801\u4e0d\u4e00\u81f4\u3002'; return; } try { await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') }) }); message.textContent = '\u5bc6\u7801\u5df2\u66f4\u65b0\u3002'; setTimeout(() => accountModal.classList.add('hidden'), 700); } catch (error) { message.textContent = error.message; } };
