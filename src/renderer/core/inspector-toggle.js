// ---- inspector toggle ----
var inspOpen = true;
function setInspector(open){
  inspOpen = open;
  appEl.classList.toggle('insp-collapsed', !open);
  inspToggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
}
function toggleInspector(){ setInspector(!inspOpen); }
inspToggleBtn.addEventListener('click', toggleInspector);
inspHandle.addEventListener('click', toggleInspector);
inspCollapseBtn.addEventListener('click', toggleInspector);
