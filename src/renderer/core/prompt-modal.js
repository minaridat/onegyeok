// ---- 범용 텍스트 입력 모달 (Electron은 window.prompt()를 지원하지 않아 직접 구현) ----
var promptBackdrop = document.getElementById('promptBackdrop');
var promptInput = document.getElementById('promptInput');
var promptTitleEl = document.getElementById('promptTitle');
var promptErrorEl = document.getElementById('promptError');
var promptOkBtn = document.getElementById('promptOkBtn');
var promptCancelBtn = document.getElementById('promptCancelBtn');

function showTextPrompt(title, placeholder){
  return new Promise(function(resolve){
    promptTitleEl.textContent = title;
    promptInput.placeholder = placeholder || '';
    promptInput.value = '';
    promptErrorEl.textContent = '';
    promptBackdrop.classList.add('show');
    setTimeout(function(){ promptInput.focus(); }, 0);

    function cleanup(){
      promptBackdrop.classList.remove('show');
      promptOkBtn.removeEventListener('click', onOk);
      promptCancelBtn.removeEventListener('click', onCancel);
      promptInput.removeEventListener('keydown', onKeydown);
      promptBackdrop.removeEventListener('click', onBackdropClick);
    }
    function onOk(){
      var v = promptInput.value.trim();
      cleanup();
      resolve(v || null);
    }
    function onCancel(){ cleanup(); resolve(null); }
    function onKeydown(e){
      if(e.key === 'Enter'){ e.preventDefault(); e.stopPropagation(); onOk(); }
      else if(e.key === 'Escape'){ e.stopPropagation(); onCancel(); }
    }
    function onBackdropClick(e){ if(e.target === promptBackdrop) onCancel(); }

    promptOkBtn.addEventListener('click', onOk);
    promptCancelBtn.addEventListener('click', onCancel);
    promptInput.addEventListener('keydown', onKeydown);
    promptBackdrop.addEventListener('click', onBackdropClick);
  });
}

function addNewGroup(){
  return showTextPrompt('새 그룹 추가', '예: 모니터링').then(function(name){
    if(!name) return null;
    if(GROUP_ORDER.indexOf(name) === -1) GROUP_ORDER.push(name);
    renderTree();
    populateGroupSelectors();
    return name;
  });
}

document.querySelector('.add-group').addEventListener('click', function(){ addNewGroup(); });
document.getElementById('manageAddGroupBtn').addEventListener('click', function(){
  addNewGroup().then(function(name){ if(name) renderManageTable(); });
});
