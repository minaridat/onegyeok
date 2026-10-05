// ---- keyboard shortcuts (전역) ----
document.addEventListener('keydown', function(e){
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); openPalette(); return; }
  if(e.key === 'Escape'){
    if(appEl.classList.contains('edit-open')){ closeEdit(); return; }
    if(appEl.classList.contains('manage-open')){ closeManage(); return; }
    closePalette(); return;
  }
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i'){ e.preventDefault(); toggleInspector(); return; }
  if((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)){
    e.preventDefault();
    var tabs = visibleTabs();
    var idx = parseInt(e.key, 10) - 1;
    if(tabs[idx]) activate(tabs[idx].dataset.id);
    return;
  }
  var next = (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) || (e.metaKey && e.altKey && e.key === 'ArrowRight') ||
    ((e.metaKey || e.ctrlKey) && e.key === '>');
  var prev = (e.ctrlKey && e.key === 'Tab' && e.shiftKey) || (e.metaKey && e.altKey && e.key === 'ArrowLeft') ||
    ((e.metaKey || e.ctrlKey) && e.key === '<');
  if(next || prev){
    e.preventDefault();
    var list = visibleTabs();
    if(!list.length) return;
    var cur = list.findIndex(function(t){ return t.classList.contains('active'); });
    var to = next ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
    activate(list[to].dataset.id);
  }
});
