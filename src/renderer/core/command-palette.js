// ---- command palette ----
var paletteOpenBtn = document.getElementById('paletteOpenBtn');
var paletteBackdrop = document.getElementById('paletteBackdrop');
var paletteInput = document.getElementById('paletteInput');
var paletteList = document.getElementById('paletteList');

function allServers(){
  return Array.prototype.map.call(tree.querySelectorAll('.server'), function(s){
    return { id:s.dataset.id, group:s.dataset.group, proto:s.dataset.protocol };
  });
}

function renderPalette(q){
  var items = allServers().filter(function(s){
    return !q || s.id.toLowerCase().indexOf(q.toLowerCase()) > -1;
  });
  paletteList.innerHTML = items.map(function(s, i){
    return '<div class="palette-item'+(i===0?' hi':'')+'" data-id="'+s.id+'">' +
      '<span class="proto-chip sm proto-'+s.proto+'">'+PROTO[s.proto].icon+'</span>' +
      '<span>'+s.id+'</span><span class="grp">'+s.group+' · '+PROTO[s.proto].label+'</span></div>';
  }).join('') || '<div class="palette-item" style="color:var(--text-faint)">결과 없음</div>';
}

function openPalette(){
  appEl.classList.add('palette-open');
  paletteInput.value = '';
  renderPalette('');
  setTimeout(function(){ paletteInput.focus(); }, 0);
}
function closePalette(){ appEl.classList.remove('palette-open'); }

paletteOpenBtn.addEventListener('click', openPalette);
paletteBackdrop.addEventListener('click', function(e){ if(e.target === paletteBackdrop) closePalette(); });
paletteInput.addEventListener('input', function(){ renderPalette(paletteInput.value); });
paletteList.addEventListener('click', function(e){
  var item = e.target.closest('.palette-item[data-id]');
  if(item){ selectServer(item.dataset.id); closePalette(); }
});
