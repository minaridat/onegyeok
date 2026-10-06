// ==================================================================
// S7. 서버 관리 (전체 목록/편집)
// ==================================================================
var manageSort = { key:'name', dir:1 };
var manageSearchQ = '';
var manageProtoF = 'all';
var manageGroupF = 'all';
var selectedManageIds = new Set();
var editingId = null; // null = 서버 추가 모드

function populateGroupSelectors(){
  var opts = GROUP_ORDER.map(function(g){ return '<option value="'+escapeHtml(g)+'">'+escapeHtml(g)+'</option>'; }).join('');
  var gf = document.getElementById('manageGroupFilter');
  gf.innerHTML = '<option value="all">그룹 전체</option>' + opts;
  gf.value = manageGroupF;
  document.getElementById('manageBulkGroup').innerHTML = '<option value="">그룹 이동...</option>' + opts;
  var fGroup = document.getElementById('f-group');
  var prevValue = fGroup.value;
  fGroup.innerHTML = opts + '<option value="__new__">+ 새 그룹 추가...</option>';
  if(GROUP_ORDER.indexOf(prevValue) > -1) fGroup.value = prevValue;
}

function filteredSortedServers(){
  var q = manageSearchQ.trim().toLowerCase();
  var list = SERVERS.filter(function(s){
    var matchQ = !q || s.name.toLowerCase().indexOf(q) > -1 || s.host.toLowerCase().indexOf(q) > -1 ||
      s.group.toLowerCase().indexOf(q) > -1;
    var matchP = manageProtoF === 'all' || s.protocol === manageProtoF;
    var matchG = manageGroupF === 'all' || s.group === manageGroupF;
    return matchQ && matchP && matchG;
  });
  var key = manageSort.key, dir = manageSort.dir;
  list.sort(function(a, b){
    if(key === 'port'){ return ((a.port||0) - (b.port||0)) * dir; }
    var av = (a[key]||'').toString().toLowerCase(), bv = (b[key]||'').toString().toLowerCase();
    return av < bv ? -dir : av > bv ? dir : 0;
  });
  return list;
}

function renderManageTable(){
  var list = filteredSortedServers();
  var tbody = document.getElementById('manageTbody');
  document.getElementById('manageCount').textContent = SERVERS.length + '개 서버';
  if(!list.length){
    tbody.innerHTML = '<tr><td colspan="9"><div class="manage-empty">조건에 맞는 서버가 없습니다.</div></td></tr>';
  } else {
    tbody.innerHTML = list.map(function(s){
      var checked = selectedManageIds.has(s.id) ? ' checked' : '';
      return '<tr data-id="'+s.id+'">' +
        '<td><input type="checkbox" class="row-check" data-id="'+s.id+'"'+checked+'></td>' +
        '<td><div class="row-name"><span class="proto-chip sm proto-'+s.protocol+'">'+PROTO[s.protocol].icon+'</span>'+escapeHtml(s.name)+'</div></td>' +
        '<td>'+escapeHtml(s.group)+'</td>' +
        '<td>'+PROTO[s.protocol].label+'</td>' +
        '<td>'+escapeHtml(s.host)+'</td>' +
        '<td class="num">'+(s.port || '—')+'</td>' +
        '<td>'+escapeHtml(s.auth || '—')+'</td>' +
        '<td>'+escapeHtml(s.since || '-')+'</td>' +
        '<td><div class="manage-row-actions">' +
          '<button class="manage-icon-btn" data-edit="'+s.id+'" title="편집"><svg class="icon" viewBox="0 0 20 20" style="width:14px;height:14px"><path d="M4 16l.7-3L14 3.7a1.5 1.5 0 0 1 2.1 0l.2.2a1.5 1.5 0 0 1 0 2.1L7 15.3 4 16z"></path></svg></button>' +
          '<button class="manage-icon-btn danger" data-del="'+s.id+'" title="삭제"><svg class="icon" viewBox="0 0 20 20" style="width:14px;height:14px"><path d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6M5.5 6l.6 10a1.5 1.5 0 0 0 1.5 1.4h4.8a1.5 1.5 0 0 0 1.5-1.4L14.5 6"></path></svg></button>' +
        '</div></td></tr>';
    }).join('');
  }
  document.getElementById('manageSelCount').textContent = '선택된 항목: ' + selectedManageIds.size + '개';
  document.getElementById('manageSelectAll').checked = list.length > 0 && list.every(function(s){ return selectedManageIds.has(s.id); });
}

function openManage(){
  populateGroupSelectors();
  renderManageTable();
  appEl.classList.add('manage-open');
}
function closeManage(){ appEl.classList.remove('manage-open'); }

document.getElementById('manageOpenBtn').addEventListener('click', openManage);
document.getElementById('manageCloseBtn').addEventListener('click', closeManage);
document.getElementById('manageBackdrop').addEventListener('click', function(e){
  if(e.target.id === 'manageBackdrop') closeManage();
});
document.getElementById('manageSearch').addEventListener('input', function(e){ manageSearchQ = e.target.value; renderManageTable(); });
document.getElementById('manageProtoFilter').addEventListener('change', function(e){ manageProtoF = e.target.value; renderManageTable(); });
document.getElementById('manageGroupFilter').addEventListener('change', function(e){ manageGroupF = e.target.value; renderManageTable(); });

document.querySelectorAll('.manage-table thead th[data-sort]').forEach(function(th){
  th.addEventListener('click', function(){
    if(manageSort.key === th.dataset.sort){ manageSort.dir *= -1; } else { manageSort = { key: th.dataset.sort, dir: 1 }; }
    document.querySelectorAll('.manage-table thead th').forEach(function(t){ t.classList.remove('sorted'); t.removeAttribute('data-dir'); });
    th.classList.add('sorted');
    th.setAttribute('data-dir', manageSort.dir === 1 ? '▲' : '▼');
    renderManageTable();
  });
});

document.getElementById('manageSelectAll').addEventListener('change', function(e){
  var list = filteredSortedServers();
  list.forEach(function(s){ if(e.target.checked) selectedManageIds.add(s.id); else selectedManageIds.delete(s.id); });
  renderManageTable();
});

document.getElementById('manageTbody').addEventListener('click', function(e){
  var editBtn = e.target.closest('[data-edit]');
  var delBtn = e.target.closest('[data-del]');
  var check = e.target.closest('.row-check');
  if(editBtn){ openEdit(editBtn.dataset.edit); return; }
  if(delBtn){ deleteServerConfirm(delBtn.dataset.del); return; }
  if(check){
    if(check.checked) selectedManageIds.add(check.dataset.id); else selectedManageIds.delete(check.dataset.id);
    document.getElementById('manageSelCount').textContent = '선택된 항목: ' + selectedManageIds.size + '개';
    document.getElementById('manageSelectAll').checked = filteredSortedServers().every(function(s){ return selectedManageIds.has(s.id); });
    return;
  }
  var tr = e.target.closest('tr[data-id]');
  if(tr){ openEdit(tr.dataset.id); }
});

document.getElementById('manageBulkDeleteBtn').addEventListener('click', function(){
  if(!selectedManageIds.size) return;
  if(!confirm(selectedManageIds.size + '개 서버를 삭제할까요? 열려 있는 세션도 함께 종료됩니다.')) return;
  Array.from(selectedManageIds).forEach(removeServerById);
  selectedManageIds.clear();
  renderTree(); renderManageTable();
});

document.getElementById('manageBulkMoveBtn').addEventListener('click', function(){
  var target = document.getElementById('manageBulkGroup').value;
  if(!target || !selectedManageIds.size) return;
  SERVERS.forEach(function(s){ if(selectedManageIds.has(s.id)) s.group = target; });
  selectedManageIds.clear();
  document.getElementById('manageBulkGroup').value = '';
  renderTree(); renderManageTable();
});

function deleteServerConfirm(id){
  var s = SERVERS.find(function(x){ return x.id === id; });
  if(!s) return;
  if(!confirm('"'+s.name+'" 서버를 삭제할까요?')) return;
  removeServerById(id);
  renderTree(); renderManageTable();
}
