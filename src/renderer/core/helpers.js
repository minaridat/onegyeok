function escapeHtml(str){
  return String(str == null ? '' : str).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function parseHostPort(str){
  str = str || '';
  var idx = str.lastIndexOf(':');
  if(idx > -1 && /^\d+$/.test(str.slice(idx+1))){
    return { host: str.slice(0, idx), port: parseInt(str.slice(idx+1), 10) };
  }
  return { host: str, port: null };
}
function joinHostPort(host, port){ return port ? (host + ':' + port) : host; }

// 인증정보(비밀번호·Passphrase)는 저장하지 않는다(F-301/601) — authMethod/keyFilePath는
// "어떻게 물어볼지"를 결정하는 메타데이터일 뿐, 실제 비밀값은 접속 시점에만 메모리에 存在한다.
function authLabel(s){
  if(s.authMethod === 'publickey'){
    var base = s.keyFilePath ? s.keyFilePath.split('/').pop() : null;
    return 'SSH Key' + (base ? ' (' + base + ')' : '');
  }
  return '비밀번호';
}
