// ---- sidebar / inspector panel resize (드래그로 좌우 폭 조절, 끝까지 밀면 접힘) ----
var SIDEBAR_FALLBACK_W = 236;
var INSPECTOR_FALLBACK_W = 272;
var INSPECTOR_COLLAPSE_AT = 90;

function setupResizer(handleEl, cssVar, opts){
  var dragging = false, startX = 0, startWidth = 0;
  handleEl.addEventListener('mousedown', function(e){
    dragging = true;
    handleEl.classList.add('dragging');
    appEl.classList.add('resizing');
    startX = e.clientX;
    startWidth = parseInt(getComputedStyle(appEl).getPropertyValue(cssVar), 10) || opts.fallback;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e){
    if(!dragging) return;
    var delta = (e.clientX - startX) * (opts.reverse ? -1 : 1);
    // 범위를 작은 고정값으로 가두지 않고, 창 폭 기준으로 넉넉하게만 제한한다 (끝까지 밀면 0까지 줄어들어 접힘).
    var maxW = Math.max(opts.fallback, window.innerWidth - opts.reserve);
    var newW = Math.min(maxW, Math.max(0, startWidth + delta));
    appEl.style.setProperty(cssVar, newW + 'px');
    if(opts.onWidthChange) opts.onWidthChange(newW);
  });
  document.addEventListener('mouseup', function(){
    if(!dragging) return;
    dragging = false;
    handleEl.classList.remove('dragging');
    appEl.classList.remove('resizing');
    document.body.style.userSelect = '';
  });
}

setupResizer(document.getElementById('resizerSidebar'), '--sidebar-w', {
  reverse:false, fallback:SIDEBAR_FALLBACK_W, reserve:600
});
setupResizer(document.getElementById('resizerInspector'), '--inspector-w', {
  reverse:true, fallback:INSPECTOR_FALLBACK_W, reserve:600,
  onWidthChange: function(w){
    // 연결정보 패널은 이미 있는 접힘 상태(아이콘/핸들로 재오픈)로 스냅시킨다.
    if(w < INSPECTOR_COLLAPSE_AT && inspOpen){
      setInspector(false);
      appEl.style.setProperty('--inspector-w', INSPECTOR_FALLBACK_W + 'px');
    }
  }
});
