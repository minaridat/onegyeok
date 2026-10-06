(function(){
  var sessions = new Map();
  var api = window.onegyeok && window.onegyeok.files;
  var icon='<svg viewBox="0 0 20 20"><path d="M2 6l2-2h4l2 2h8v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6z"></path></svg>';
  function join(dir,name){return dir.replace(/[\\/]$/,'')+(dir.indexOf('\\')>-1?'\\':'/')+name;}
  function message(s,text){s.el.querySelector('.files-message').textContent=text || '';}
  function state(s,value){
    s.state=value;updateServerRowStatus(s.srv.id);
    var tab=tabbar.querySelector('.tab[data-id="'+s.id+'"]');
    if(tab) tab.querySelector('.stat').classList.toggle('on',value==='connected');
    if(currentInspectedId===s.id) updateConnActionButton(s.id);
  }
  async function call(s,fn){
    try {var result=await fn();if(!result.ok) throw Error(result.error);return result.data;}
    catch(err){message(s,err.message);throw err;}
  }
  function panelMarkup(side,label){return '<section class="files-panel" data-side="'+side+'"><h3>'+label+'</h3>'+
    '<div class="files-nav"><button type="button" data-parent="'+side+'">상위</button><input class="files-path" aria-label="'+label+' 경로"><button type="button" data-refresh="'+side+'">이동</button></div>'+
    '<div class="files-crumbs"></div><div class="files-filter"><input class="files-search" placeholder="파일 검색" aria-label="'+label+' 파일 검색"><select class="files-sort" aria-label="'+label+' 정렬"><option value="name">이름순</option><option value="size">크기순</option><option value="modified">수정일순</option></select></div>'+
    '<div class="files-list"><table><thead><tr><th>선택</th><th aria-sort="ascending"><button type="button" data-sort="name">이름 ▲</button></th><th aria-sort="none"><button type="button" data-sort="size">크기</button></th><th aria-sort="none"><button type="button" data-sort="modified">수정일</button></th><th>권한</th></tr></thead><tbody></tbody></table></div></section>';}
  function renderPanel(s,side){
    var p=s.panels[side],el=s.el.querySelector('[data-side="'+side+'"]');
    var query=el.querySelector('.files-search').value.toLowerCase(),sort=p.sort||'name',direction=p.direction||1;
    el.querySelectorAll('[data-sort]').forEach(function(btn){var active=btn.dataset.sort===sort;btn.textContent={name:'이름',size:'크기',modified:'수정일'}[btn.dataset.sort]+(active?(direction===1?' ▲':' ▼'):'');btn.parentElement.setAttribute('aria-sort',active?(direction===1?'ascending':'descending'):'none');});
    var rows=p.entries.filter(function(f){return f.name.toLowerCase().indexOf(query)>-1;}).sort(function(a,b){
      if(a.directory!==b.directory) return a.directory?-1:1;
      var compared=sort==='name'?a.name.localeCompare(b.name,undefined,{numeric:true}):(Number(a[sort])||0)-(Number(b[sort])||0);
      return direction*(compared||a.name.localeCompare(b.name,undefined,{numeric:true}));
    });
    var body=el.querySelector('tbody');body.innerHTML='';
    rows.forEach(function(f){
      var tr=document.createElement('tr');tr.className=f.directory?'files-directory':'files-file';tr.draggable=!f.symlink;tr.dataset.name=f.name;
      tr.innerHTML='<td><input type="checkbox" aria-label="'+escapeHtml(f.name)+' 선택"'+(p.selected.has(f.name)?' checked':'')+'></td><td>'+escapeHtml((f.directory?'📁 ':f.symlink?'↗ ':'')+f.name)+'</td><td>'+f.size+'</td><td>'+escapeHtml(f.modified?new Date(f.modified).toLocaleString():'—')+'</td><td>'+escapeHtml(f.permissions||'—')+'</td>';
      tr.querySelector('input').onchange=function(e){if(e.target.checked)p.selected.add(f.name);else p.selected.delete(f.name);};
      tr.ondblclick=function(){if(f.directory)refresh(s,side,join(p.path,f.name)).catch(function(){});};
      tr.ondragstart=function(e){if(!p.selected.has(f.name)){p.selected.clear();p.selected.add(f.name);}e.dataTransfer.setData('application/x-onegyeok-files',JSON.stringify({id:s.id,side:side,names:Array.from(p.selected)}));};
      body.appendChild(tr);
    });
    var crumbs=el.querySelector('.files-crumbs');crumbs.innerHTML='';
    var separator=p.path.indexOf('\\')>-1?'\\':'/';var accumulated=separator;
    p.path.split(/[\\/]/).filter(Boolean).forEach(function(part,index){
      accumulated=index===0&&/:$/.test(part)?part+separator:join(accumulated,part);
      var target=accumulated,btn=document.createElement('button');btn.type='button';btn.textContent=part;btn.onclick=function(){refresh(s,side,target).catch(function(){});};crumbs.appendChild(btn);
    });
  }
  async function refresh(s,side,directory){
    var version=++s.panels[side].version;
    var data=await call(s,function(){return side==='local'?api.localList(directory):api.list(s.id,directory);});
    if(sessions.get(s.id)!==s || s.panels[side].version!==version) return;
    Object.assign(s.panels[side],data);s.panels[side].selected.clear();
    s.el.querySelector('[data-side="'+side+'"] .files-path').value=data.path;
    renderPanel(s,side);
  }
  function renderJobs(s){
    var list=s.el.querySelector('.files-jobs');list.innerHTML='';
    s.jobs.forEach(function(job){
      var row=document.createElement('div');row.className='files-job';
      var label=document.createElement('span');label.textContent=(job.direction==='upload'?'↑ ':'↓ ')+job.remotePath+' · '+job.status+(job.error?' · '+job.error:'')+(job.verified?' · SHA-256 확인':'')+(job.warning?' · '+job.warning:'');row.appendChild(label);
      var progress=document.createElement('progress');progress.max=job.bytesTotal||1;progress.value=job.bytesTransferred||0;row.appendChild(progress);
      var stats=document.createElement('span');stats.textContent=(job.bytesTransferred||0)+' / '+(job.bytesTotal===null?'?':job.bytesTotal)+' B · '+(job.speed||0)+' B/s'+(job.etaSeconds!==null?' · '+job.etaSeconds+'초 남음':'');row.appendChild(stats);
      var actions=job.status==='running'||job.status==='queued'?['pause','cancel']:job.status==='paused'||job.status==='error'?['resume','cancel']:[];
      actions.forEach(function(action){var btn=document.createElement('button');btn.type='button';btn.textContent={pause:'일시정지',resume:'재개',cancel:'취소'}[action];btn.onclick=function(){call(s,function(){return api.control(s.id,job.id,action);}).catch(function(){});};row.appendChild(btn);});list.appendChild(row);
    });
  }
  async function sendFiles(s,side,names){
    if(s.state!=='connected') return;
    var source=s.panels[side],target=s.panels[side==='local'?'remote':'local'];
    for(var name of names){
      var f=source.entries.find(function(entry){return entry.name===name;});
      if(!f||f.symlink){message(s,'심볼릭 링크는 전송하지 않습니다.');continue;}
      var existing=target.entries.some(function(entry){return entry.name===name;});
      if(existing&&!confirm(name+' 파일을 덮어쓸까요?'))continue;
      await call(s,function(){return (f.directory?api.recursive:api.enqueue)(s.id,{direction:side==='local'?'upload':'download',localPath:join(s.panels.local.path,name),remotePath:join(s.panels.remote.path,name),overwrite:existing,verify:s.el.querySelector('.files-verify').checked});});
    }
  }
  function showPlan(s,plan){
    var box=s.el.querySelector('.files-plans');box.hidden=false;
    var labels={missing:'새 항목',changed:'크기/수정일 다름',same:'동일',conflict:'충돌',"target-only":'대상에만 있음 (유지)'};
    box.innerHTML='<strong>'+(plan.kind==='rename'?'이름 변경 미리보기':'폴더 비교 — 대상 파일은 삭제하지 않습니다')+'</strong><div class="files-plan-list"><table><thead><tr><th>'+(plan.kind==='rename'?'기존 이름':'상대 경로')+'</th><th>'+(plan.kind==='rename'?'새 이름':'비교 결과')+'</th></tr></thead><tbody>'+plan.items.map(function(i){return '<tr><td>'+escapeHtml(i.from||i.relative)+'</td><td>'+escapeHtml(i.to||labels[i.status])+'</td></tr>';}).join('')+'</tbody></table></div><button type="button" class="files-apply">확인 후 실행</button><button type="button" class="files-close-plan">닫기</button>';
    box.querySelector('.files-close-plan').onclick=function(){box.hidden=true;};
    box.querySelector('.files-apply').onclick=async function(){this.disabled=true;try{var result=await call(s,function(){return api.execute(s.id,plan.token);});if(result.error)throw Error('일부 이름 변경 완료 후 중단: '+result.error);box.hidden=true;message(s,plan.kind==='rename'?'이름 변경 완료':result.jobIds.length+'개 파일을 전송 큐에 추가했습니다');await refresh(s,'local',s.panels.local.path);await refresh(s,'remote',s.panels.remote.path);}catch(err){message(s,err.message);}finally{this.disabled=false;}};
  }
  function renderSchedules(s,items){
    var box=s.el.querySelector('.files-schedules');box.innerHTML='';items.forEach(function(item){var row=document.createElement('div');row.textContent=new Date(item.at).toLocaleString()+' · '+({waiting:'예약 대기',running:'준비 중',queued:'전송 큐에 등록됨',error:'실패'}[item.status]||item.status)+(item.error?' · '+item.error:'');if(item.status==='waiting'){var button=document.createElement('button');button.type='button';button.textContent='예약 취소';button.onclick=function(){call(s,function(){return api.cancelReservation(s.id,item.id);}).catch(function(){});};row.appendChild(button);}box.appendChild(row);});
  }
  function showTools(s,kind){
    if(s.state!=='connected'){message(s,'먼저 연결해주세요');return;}
    var box=s.el.querySelector('.files-tools');box.hidden=false;
    var direction='<label>방향 <select class="files-direction"><option value="upload">로컬 → 원격</option><option value="download">원격 → 로컬</option></select></label>';
    if(kind==='sync')box.innerHTML='<strong>현재 폴더 전체 비교·동기화</strong>'+direction+'<label>비교 기준 <select class="files-compare"><option value="size-date">크기 + 수정일</option><option value="size">크기만</option></select></label><span>수정일 2초 허용 · 대상 전용 파일 보존</span><button type="button" class="files-tool-run">비교 미리보기</button>';
    if(kind==='rename')box.innerHTML='<strong>선택 항목 일괄 이름 변경</strong><label>대상 <select class="files-side"><option value="local">로컬</option><option value="remote">원격</option></select></label><label>찾을 문자열 <input class="files-find"></label><label>바꿀 문자열 <input class="files-replace"></label><label>접두사 <input class="files-prefix"></label><label>접미사 <input class="files-suffix"></label><label><input type="checkbox" class="files-number"> 끝에 순번 _001 추가</label><button type="button" class="files-tool-run">변경 미리보기</button>';
    if(kind==='schedule')box.innerHTML='<strong>선택 파일/폴더 예약 전송</strong>'+direction+'<label>실행 시간 <input class="files-at" type="datetime-local"></label><label><input type="checkbox" class="files-overwrite"> 기존 파일 덮어쓰기 허용</label><span>최대 7일 · 앱/연결 유지 필요 · 종료 시 예약 취소</span><button type="button" class="files-tool-run">예약 등록</button>';
    if(kind==='schedule') {var date=new Date(Date.now()+60000);date=new Date(date.getTime()-date.getTimezoneOffset()*60000);box.querySelector('.files-at').value=date.toISOString().slice(0,16);}
    box.querySelector('.files-tool-run').onclick=async function(){this.disabled=true;try{
      if(kind==='rename'){var side=box.querySelector('.files-side').value;var plan=await call(s,function(){return api.renamePreview(s.id,{side:side,root:s.panels[side].path,names:Array.from(s.panels[side].selected),find:box.querySelector('.files-find').value,replace:box.querySelector('.files-replace').value,prefix:box.querySelector('.files-prefix').value,suffix:box.querySelector('.files-suffix').value,number:box.querySelector('.files-number').checked});});showPlan(s,plan);}
      else {var direction=box.querySelector('.files-direction').value;var params={direction:direction,localPath:s.panels.local.path,remotePath:s.panels.remote.path,verify:s.el.querySelector('.files-verify').checked};
        if(kind==='sync'){params.compare=box.querySelector('.files-compare').value;showPlan(s,await call(s,function(){return api.preview(s.id,params);}));}
        else {var side=direction==='upload'?'local':'remote';var names=Array.from(s.panels[side].selected);if(!names.length)throw Error('예약할 파일/폴더를 선택해주세요');var at=new Date(box.querySelector('.files-at').value).getTime();var overwrite=box.querySelector('.files-overwrite').checked;if(overwrite&&!confirm('예약 실행 시 기존 대상 파일을 덮어쓸 수 있습니다. 허용할까요?'))return;for(var name of names){var entry=s.panels[side].entries.find(function(i){return i.name===name;});if(!entry||entry.symlink)throw Error('심볼릭 링크는 예약할 수 없습니다');await call(s,function(){return api.reserve(s.id,Object.assign({},params,{localPath:join(params.localPath,name),remotePath:join(params.remotePath,name),recursive:entry.directory,at:at,overwrite:overwrite}));});}message(s,'예약이 등록되었습니다');}
      }
    }catch(err){message(s,err.message);}finally{this.disabled=false;}};
  }
  async function connect(s){
    if(!api){message(s,'파일 전송 브리지를 사용할 수 없습니다.');return;}
    if(s.state==='connecting'||s.state==='connected')return;
    var username=s.srv.username||s.el.querySelector('.files-user').value.trim();if(!username){message(s,'사용자명을 입력해주세요.');return;}
    var mode=s.srv.fileProtocol||'sftp';
    if(mode==='ftp'&&!confirm('평문 FTP는 사용자명·비밀번호·파일을 암호화하지 않습니다. 접속할까요?'))return;
    var secret=s.el.querySelector('.files-secret');var params={host:s.srv.host,port:s.srv.port,username:username,fileProtocol:mode,authMethod:s.srv.authMethod,keyFilePath:s.srv.keyFilePath,allowPlainFtp:mode==='ftp'};
    params[s.srv.authMethod==='publickey'&&mode==='sftp'?'passphrase':'password']=secret.value;secret.value='';
    state(s,'connecting');s.el.querySelector('.files-connect-btn').disabled=true;
    try {
      var data=await call(s,function(){return api.connect(s.id,params);});
      if(sessions.get(s.id)!==s)return;
      state(s,'connected');s.el.classList.add('connected');message(s,'');
      await Promise.all([refresh(s,'local',data.localPath),refresh(s,'remote',data.remotePath)]);
    } catch(err){if(sessions.get(s.id)===s && s.state==='connecting')state(s,'error');}
    finally {s.el.querySelector('.files-connect-btn').disabled=false;}
  }
  async function disconnect(s){
    if(api)await call(s,function(){return api.disconnect(s.id);});
    state(s,'disconnected');s.el.classList.remove('connected');s.el.querySelector('.files-schedules').innerHTML='';s.el.querySelector('.files-plans').hidden=true;s.el.querySelector('.files-tools').hidden=true;
    s.jobs.forEach(function(job){if(['running','queued','paused'].includes(job.status))job.status='canceled';});renderJobs(s);
  }
  async function remoteAction(s,action){
    var selected=Array.from(s.panels.remote.selected),value;
    if(action==='mkdir'||action==='create'){
      value=await showTextPrompt(action==='mkdir'?'새 원격 폴더':'새 원격 파일','이름');if(!value)return;
      if(/[\\/\r\n\0]/.test(value)||value==='.'||value==='..')throw Error('파일 또는 폴더 이름만 입력해주세요');
      await call(s,function(){return api.operation(s.id,action,join(s.panels.remote.path,value));});
    } else {
      if(!selected.length)throw Error('원격 항목을 선택해주세요');
      if(action!=='delete'&&selected.length!==1)throw Error('한 항목만 선택해주세요');
      if(action==='delete'&&!confirm(selected.length+'개 원격 항목을 삭제할까요? 폴더는 비어 있어야 합니다.'))return;
      if(action==='rename'){value=await showTextPrompt('새 이름','파일명');if(!value)return;if(/[\\/\r\n\0]/.test(value)||value==='.'||value==='..')throw Error('파일 이름만 입력해주세요');value=join(s.panels.remote.path,value);}
      if(action==='chmod'){value=await showTextPrompt('원격 권한 변경','예: 644, 755');if(!value)return;}
      for(var name of selected)await call(s,function(){return api.operation(s.id,action,join(s.panels.remote.path,name),value);});
    }
    await refresh(s,'remote',s.panels.remote.path);
  }
  function start(id,serverId,el){
    var srv=SERVERS.find(function(entry){return entry.id===serverId;});if(!srv)return;
    el.className='pane files-pane';
    el.innerHTML='<div class="files-login"><h3>'+escapeHtml((srv.fileProtocol||'sftp').toUpperCase()+' · '+srv.host)+'</h3><label>사용자명<input class="files-user" autocomplete="off"></label><label>'+(srv.authMethod==='publickey'?'키 Passphrase (없으면 비움)':'비밀번호')+'<input class="files-secret" type="password" autocomplete="off"></label><button type="button" class="files-connect-btn">접속</button></div>'+
      '<div class="files-workspace"><div class="files-toolbar"><button type="button" data-tools="sync">폴더 비교·동기화</button><button type="button" data-tools="rename">일괄 이름 변경</button><button type="button" data-tools="schedule">예약 전송</button><button type="button" data-transfer="local">선택 업로드 →</button><button type="button" data-transfer="remote">← 선택 다운로드</button><label><input class="files-verify" type="checkbox"> SHA-256 검증</label><button type="button" data-op="mkdir">폴더 생성</button><button type="button" data-op="create">파일 생성</button><button type="button" data-op="rename">이름변경</button><button type="button" data-op="delete">삭제</button><button type="button" data-op="chmod">권한</button><button type="button" class="files-disconnect">연결 종료</button></div><div class="files-tools" hidden></div><div class="files-plans" hidden></div><div class="files-schedules"></div><div class="files-panels">'+panelMarkup('local','로컬')+panelMarkup('remote','원격')+'</div><h3 class="files-queue-title">전송 큐</h3><div class="files-jobs"></div></div><div class="files-message" role="status"></div>';
    var s={id:id,srv:srv,el:el,state:'disconnected',jobs:new Map(),panels:{local:{entries:[],selected:new Set(),version:0,sort:"name",direction:1},remote:{entries:[],selected:new Set(),version:0,sort:"name",direction:1}}};sessions.set(id,s);
    var user=el.querySelector('.files-user');user.value=srv.username||'';if(srv.username)user.closest('label').style.display='none';
    el.querySelector('[data-op="chmod"]').disabled=!!srv.fileProtocol&&srv.fileProtocol!=='sftp';
    el.querySelector('.files-connect-btn').onclick=function(){connect(s);};el.querySelector('.files-secret').onkeydown=function(e){if(e.key==='Enter')connect(s);};
    el.querySelector('.files-disconnect').onclick=function(){disconnect(s).catch(function(){});};
    el.querySelectorAll('[data-transfer]').forEach(function(btn){btn.onclick=function(){sendFiles(s,btn.dataset.transfer,Array.from(s.panels[btn.dataset.transfer].selected)).catch(function(err){message(s,err.message);});};});
    el.querySelectorAll('[data-tools]').forEach(function(btn){btn.onclick=function(){showTools(s,btn.dataset.tools);};});
    el.querySelectorAll('[data-op]').forEach(function(btn){btn.onclick=function(){remoteAction(s,btn.dataset.op).catch(function(err){message(s,err.message);});};});
    ['local','remote'].forEach(function(side){
      var panel=el.querySelector('[data-side="'+side+'"]');
      panel.querySelector('[data-parent]').onclick=function(){refresh(s,side,s.panels[side].parent).catch(function(){});};
      var go=function(){refresh(s,side,panel.querySelector('.files-path').value).catch(function(){});};
      panel.querySelector('[data-refresh]').onclick=go;panel.querySelector('.files-path').onkeydown=function(e){if(e.key==='Enter')go();};
      panel.querySelector('.files-search').oninput=function(){renderPanel(s,side);};panel.querySelector('.files-sort').onchange=function(){s.panels[side].sort=this.value;s.panels[side].direction=1;renderPanel(s,side);};
      panel.querySelectorAll('[data-sort]').forEach(function(btn){btn.onclick=function(){var p=s.panels[side],key=btn.dataset.sort;p.direction=p.sort===key?-(p.direction||1):1;p.sort=key;panel.querySelector('.files-sort').value=key;renderPanel(s,side);};});
      panel.ondragover=function(e){if(Array.from(e.dataTransfer.types).includes('application/x-onegyeok-files'))e.preventDefault();};
      panel.ondrop=function(e){var raw=e.dataTransfer.getData('application/x-onegyeok-files');if(!raw)return;e.preventDefault();try{var data=JSON.parse(raw);if(data.id===id&&data.side!==side)sendFiles(s,data.side,data.names).catch(function(err){message(s,err.message);});}catch(err){message(s,err.message);}};
    });
  }
  if(api)api.onEvent(function(id,type,data){
    var s=sessions.get(id);if(!s)return;
    if(type==='schedules'){renderSchedules(s,data);}
    if(type==='job'){s.jobs.set(data.id,data);renderJobs(s);if(data.status==='done'){refresh(s,'local',s.panels.local.path).catch(function(){});refresh(s,'remote',s.panels.remote.path).catch(function(){});}}
  });
  // 탭을 다른 창으로 끌어내 뺄 때(Stage B) 이 창(원래 창)에서 호출된다 — IPC 연결 종료 없이
  // 세션 맵 엔트리만 지운다. main 프로세스의 실제 SFTP/FTP 커넥션(file-manager.js)은 세션 id에만
  // 묶여 있고 특정 창에 종속되지 않으므로 살아남고, 새 창이 이어받는다.
  function detachSftpLocal(id){ sessions.delete(id); }

  // 다른 창에서 넘어온(이미 연결돼 있을 수 있는) 탭을 이 창에서 받을 때 호출된다 — 로그인 폼을
  // 건너뛰고 바로 작업 화면을 연 뒤, 로컬/원격 패널을 기본 경로(로컬은 홈, 원격은 루트)로 다시
  // 조회해 채운다. 이전 탐색 위치·선택·열려 있던 도구 패널은 넘어오지 않는다(알려진 한계) —
  // 연결 자체는 끊기지 않으므로 진행 중이던 전송은 계속되고, 사용자가 다시 탐색하면 된다.
  function attachSftpSession(id, serverId, el){
    start(id, serverId, el);
    var s = sessions.get(id);
    if(!s) return;
    state(s, 'connected');
    el.classList.add('connected');
    Promise.all([refresh(s,'local',undefined), refresh(s,'remote','/')]).catch(function(err){ message(s, err.message); });
  }

  registerProtocol('sftp',{
    meta:{label:'SFTP / FTP',icon:icon},startSession:start,
    detachLocal:detachSftpLocal,attachSession:attachSftpSession,
    hasSession:function(id){return sessions.has(id);},getSession:function(id){return sessions.get(id);},
    disposeSession:function(id){var s=sessions.get(id);if(!s)return;sessions.delete(id);if(api)api.disconnect(id).catch(function(){});updateServerRowStatus(s.srv.id);},
    isServerConnected:function(id){return Array.from(sessions.values()).some(function(s){return s.srv.id===id&&s.state==='connected';});},
    hasConnAction:true,onConnActionClick:function(id){var s=sessions.get(id);if(s){if(s.state==='connected'||s.state==='connecting')disconnect(s).catch(function(){});else connect(s);}},quickReconnect:function(id){var s=sessions.get(id);if(s){s.el.querySelector('.files-secret').focus();activate(id);}},
    registration:{
      renderExtra:function(container,server){
        container.innerHTML='<label>전송 방식<select id="f-file-protocol"><option value="sftp">SFTP (SSH)</option><option value="ftps">FTPS (TLS 권장)</option><option value="ftp">FTP (평문)</option><option value="ftps-implicit">FTPS implicit</option></select></label><label>인증 방식<select id="f-file-auth"><option value="password">비밀번호</option><option value="publickey">SSH Key</option></select></label><label id="f-file-key-row">키 경로<input id="f-file-key"><button type="button" id="f-file-pick">찾아보기</button></label>';
        var mode=container.querySelector('#f-file-protocol'),auth=container.querySelector('#f-file-auth'),key=container.querySelector('#f-file-key');
        mode.value=server&&server.fileProtocol||'sftp';auth.value=server&&server.authMethod||'password';key.value=server&&server.keyFilePath||'';
        function update(){auth.disabled=mode.value!=='sftp';if(auth.disabled)auth.value='password';container.querySelector('#f-file-key-row').style.display=auth.value==='publickey'?'':'none';updatePortPlaceholder();}
        mode.onchange=update;auth.onchange=update;update();
        container.querySelector('#f-file-pick').onclick=function(){window.onegyeok.pickKeyFile().then(function(res){if(!res.canceled)key.value=res.filePath;});};
      },
      collectExtra:function(container){return {fileProtocol:container.querySelector('#f-file-protocol').value,authMethod:container.querySelector('#f-file-auth').value,keyFilePath:container.querySelector('#f-file-key').value.trim()||null};},
      defaultPortPlaceholder:function(container){var mode=container.querySelector('#f-file-protocol');return !mode||mode.value==='sftp'?'22':mode.value==='ftps-implicit'?'990':'21';},
    },
  });
  var openBtn=document.getElementById('openSftpBtn');
  if(openBtn)openBtn.onclick=function(){if(currentInspectedServerId)selectServer(currentInspectedServerId,'sftp');};
})();
