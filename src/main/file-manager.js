'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const SftpClient = require('ssh2-sftp-client');
const { Client: FtpClient } = require('basic-ftp');
const sessions = new Map();

function remotePath(value) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw Error('유효한 원격 경로가 필요합니다');
  return path.posix.resolve('/', value);
}
function getSession(id) { const s = sessions.get(id); if (!s || s.disposed) throw Error('연결되어 있지 않습니다'); return s; }
function event(s, type, data) { if (!s.disposed) s.notify(type, data); }
function publish(s, job) {
  const seconds = Math.max((Date.now() - job.startedAt) / 1000, 0.001);
  const speed = job.status === 'running' ? Math.round((job.bytesTransferred - (job.startBytes || 0)) / seconds) : 0;
  event(s, 'job', { id:job.id, direction:job.direction, localPath:job.localPath, remotePath:job.remotePath,
    status:job.status, bytesTotal:job.bytesTotal, bytesTransferred:job.bytesTransferred, speed,
    etaSeconds:speed ? Math.ceil((job.bytesTotal - job.bytesTransferred) / speed) : null, error:job.error || null, verified:!!job.verified });
}
function serial(s, task) {
  const next = s.tail.then(() => { if(s.disposed) throw Error('연결이 종료되었습니다'); return task(); });
  s.tail = next.catch(() => {}); return next;
}
function closeClient(s, force = false) {
  if(s.client) { if(s.mode === 'sftp') {if(force)s.client.client.destroy();s.client.end().catch(() => {});} else s.client.close(); }
  s.client = null;
}
async function openClient(s) {
  if(s.disposed) throw Error('연결이 종료되었습니다');
  if(s.client && (s.mode === 'sftp' || !s.client.closed)) return;
  s.client = null;
  const p = s.params;
  if(s.mode === 'sftp') {
    const client = new SftpClient(); s.client = client;
    const options = { host:p.host, port:p.port || 22, username:p.username, readyTimeout:10000, keepaliveInterval:15000 };
    if(p.authMethod === 'publickey') {
      options.privateKey = await fsp.readFile(p.keyFilePath);
      if(p.passphrase) options.passphrase = p.passphrase;
    } else options.password = p.password;
    await client.connect(options);
    if(s.disposed){await client.end().catch(()=>{});throw Error('접속이 취소되었습니다');}
  } else {
    const client = new FtpClient(15000); s.client = client;
    await client.access({host:p.host,port:p.port || (s.mode === 'ftps-implicit' ? 990 : 21),user:p.username,password:p.password,
      secure:s.mode === 'ftp' ? false : s.mode === 'ftps-implicit' ? 'implicit' : true,
      secureOptions:{rejectUnauthorized:true}});
    if(s.disposed){client.close();throw Error('접속이 취소되었습니다');}
  }
  if(s.disposed) { closeClient(s); throw Error('접속이 취소되었습니다'); }
}
async function connect(id, params, notify = () => {}) {
  if(sessions.has(id)) throw Error('이미 연결 중인 세션입니다');
  const mode = params.fileProtocol || 'sftp';
  if(!['sftp','ftp','ftps','ftps-implicit'].includes(mode)) throw Error('지원하지 않는 파일 전송 방식입니다');
  if(mode === 'ftp' && params.allowPlainFtp !== true) throw Error('평문 FTP 경고 확인이 필요합니다');
  const s = {id,mode,params:{...params},notify,client:null,tail:Promise.resolve(),jobs:new Map(),disposed:false,active:null};
  sessions.set(id,s);
  try { await openClient(s); return {remotePath:mode === 'sftp' ? await s.client.cwd() : await s.client.pwd(), localPath:os.homedir()}; }
  catch(err) { if(sessions.get(id) === s) await disconnect(id); throw err; }
}
async function localList(directory) {
  const resolved = path.resolve(directory || os.homedir());
  const entries = await fsp.readdir(resolved,{withFileTypes:true});
  const rows = await Promise.all(entries.map(async item => {
    try { const stat = await fsp.lstat(path.join(resolved,item.name)); return {name:item.name,directory:item.isDirectory(),symlink:item.isSymbolicLink(),size:stat.size,modified:stat.mtimeMs}; }
    catch { return null; }
  }));
  return {path:resolved,parent:path.dirname(resolved),entries:rows.filter(Boolean)};
}
async function list(id, directory) {
  const s = getSession(id); const target = remotePath(directory);
  return serial(s, async () => {
    await openClient(s);
    const rows = await s.client.list(target);
    return {path:target,parent:path.posix.dirname(target),entries:rows.map(f => ({name:f.name,directory:s.mode === 'sftp' ? f.type === 'd' : f.isDirectory,
      symlink:s.mode === 'sftp' ? f.type === 'l' : f.isSymbolicLink,size:f.size,modified:s.mode === 'sftp' ? f.modifyTime : f.modifiedAt?.getTime(),
      permissions:f.rights ? rightsToMode(f.rights) : null}))};
  });
}
function rightsToMode(rights) { return ['user','group','other'].map(key => {const v=rights[key] || '';return (v.includes('r')?4:0)+(v.includes('w')?2:0)+(v.includes('x')?1:0);}).join(''); }
async function exists(s, target) {
  if(s.mode === 'sftp') return !!await s.client.exists(target);
  const entries = await s.client.list(path.posix.dirname(target)); return entries.some(f=>f.name === path.posix.basename(target));
}
async function operation(id, action, target, value) {
  const s=getSession(id); target=remotePath(target);
  if(target === '/') throw Error('루트 경로는 변경할 수 없습니다');
  return serial(s, async () => {
    await openClient(s);
    if(action === 'mkdir') return s.mode === 'sftp' ? s.client.mkdir(target) : s.client.send('MKD '+target);
    if(action === 'create') {
      if(await exists(s,target)) throw Error('이미 존재하는 파일입니다');
      return s.mode === 'sftp' ? s.client.put(Buffer.alloc(0),target) : s.client.uploadFrom(require('node:stream').Readable.from([]),target);
    }
    if(action === 'rename') {const destination=remotePath(value);if(await exists(s,destination))throw Error('대상 이름이 이미 존재합니다');return s.client.rename(target,destination);}
    if(action === 'delete') {
      if(s.mode === 'sftp') return await s.client.exists(target) === 'd' ? s.client.rmdir(target,false) : s.client.delete(target);
      const rows=await s.client.list(path.posix.dirname(target)); const entry=rows.find(f=>f.name === path.posix.basename(target));
      return entry?.isDirectory ? s.client.send('RMD '+target) : s.client.remove(target);
    }
    if(action === 'chmod') {
      if(s.mode !== 'sftp') throw Error('권한 변경은 SFTP에서 지원합니다');
      if(!/^[0-7]{3,4}$/.test(String(value))) throw Error('권한은 644, 755 같은 8진수로 입력해주세요');
      return s.client.chmod(target,parseInt(value,8));
    }
    throw Error('지원하지 않는 파일 작업입니다');
  });
}
async function remoteSize(s, target) { return s.mode === 'sftp' ? (await s.client.stat(target)).size : s.client.size(target); }
async function hashLocal(file) { const hash=crypto.createHash('sha256'); for await(const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function hashRemote(s, target) {
  const hash=crypto.createHash('sha256');
  const sink=new (require('node:stream').Writable)({write(chunk,_enc,cb){hash.update(chunk);cb();}});
  if(s.mode === 'sftp') await pipeline(s.client.createReadStream(target),sink);
  else await s.client.downloadTo(sink,target);
  return hash.digest('hex');
}
async function transfer(s, job, generation) {
  await openClient(s);
  if(job.generation !== generation || job.status !== 'running') throw Error('전송이 중단되었습니다');
  // Keep this attempt bound to its original connection, even if a resumed job reconnects.
  s = {...s, client:s.client};
  const upload=job.direction === 'upload';
  const sourceSize = upload ? (await fsp.stat(job.localPath)).size : await remoteSize(s,job.remotePath);
  if(job.bytesTotal !== null && job.bytesTotal !== sourceSize) throw Error('원본 파일 크기가 변경되었습니다. 새 전송을 시작해주세요');
  job.bytesTotal=sourceSize;
  const finalExists=upload ? await exists(s,job.remotePath) : await fsp.access(job.localPath).then(()=>true,()=>false);
  if(finalExists && !job.overwrite) throw Error('대상 파일이 존재합니다. 덮어쓰기를 확인해주세요');
  let offset = upload ? await remoteSize(s,job.partial).catch(()=>0) : await fsp.stat(job.partial).then(st=>st.size,()=>0);
  if(offset > sourceSize) throw Error('부분 파일이 원본보다 큽니다');
  job.bytesTransferred=offset;job.startBytes=offset;job.startedAt=Date.now();
  const report=bytes=> {if(job.generation !== generation || job.status !== 'running')return;job.bytesTransferred=Math.min(sourceSize,offset+bytes); if(Date.now()-(job.lastReport||0)>150){job.lastReport=Date.now();publish(s,job);} };
  if(s.mode === 'sftp') {
    let bytes=0;
    const progress=new Transform({transform(chunk,_enc,cb){bytes+=chunk.length;report(bytes);cb(null,chunk);}});
    const read=upload ? fs.createReadStream(job.localPath,{start:offset}) : s.client.createReadStream(job.remotePath,{start:offset});
    const write=upload ? s.client.createWriteStream(job.partial,{flags:offset?'r+':'w',start:offset}) : fs.createWriteStream(job.partial,{flags:offset?'r+':'w',start:offset});
    job.streams=[read,progress,write]; await pipeline(read,progress,write);job.streams=null;
  } else {
    s.client.trackProgress(info=>report(info.bytes));
    if(upload) { if(offset) await s.client.appendFrom(job.localPath,job.partial,{localStart:offset}); else await s.client.uploadFrom(job.localPath,job.partial); }
    else await s.client.downloadTo(job.partial,job.remotePath,offset);
    s.client.trackProgress();
  }
  if(job.status !== 'running' || s.disposed || job.generation !== generation) throw Error('전송이 중단되었습니다');
  if((upload ? await remoteSize(s,job.partial) : (await fsp.stat(job.partial)).size) !== sourceSize) throw Error('전송 파일 크기가 일치하지 않습니다');
  if(job.verify) {
    if(await hashLocal(upload ? job.localPath : job.partial) !== await hashRemote(s,upload ? job.partial : job.remotePath)) throw Error('SHA-256 검증 실패');
    job.verified=true;
  }
  if(job.status !== 'running' || s.disposed || job.generation !== generation) throw Error('전송이 중단되었습니다');
  job.status='committing';publish(s,job);
  if(upload) {
    if(!job.overwrite && await exists(s,job.remotePath))throw Error('대상 파일이 이미 존재합니다');
    if(s.mode === 'sftp' && job.overwrite) await s.client.posixRename(job.partial,job.remotePath);
    else await s.client.rename(job.partial,job.remotePath);
  }
  else if(job.overwrite) await fsp.rename(job.partial,job.localPath);
  else {await fsp.link(job.partial,job.localPath);await fsp.unlink(job.partial);}
  job.bytesTransferred=sourceSize;
}
function schedule(s, job) {
  serial(s, async () => {
    if(job.status !== 'queued') return;
    s.active=job;job.status='running';publish(s,job);
    var rejectInterrupt;
    const interrupted=new Promise((_resolve,reject)=>{rejectInterrupt=reject;});
    job.interrupt=rejectInterrupt;
    const generation=++job.generation;
    try {
      for(let attempt=0;attempt<3;attempt++) {
        if(job.status !== 'running' || s.disposed) break;
        try { await Promise.race([transfer(s,job,generation),interrupted]);job.status='done';break; }
        catch(err) {
          if(job.status === 'committing') throw err;
          if(job.status !== 'running' || s.disposed) break;
          // Retry transport failures only. Authentication/permission/checksum errors need user action.
          if(attempt === 2 || !/ECONN|ETIMEDOUT|Timeout|connection.*(?:closed|lost|ended)|client.*closed|socket.*closed|No SFTP connection/i.test(err.message)) throw err;
          closeClient(s);await new Promise(r=>setTimeout(r,500*(attempt+1)));
        }
      }
    } catch(err) {job.status='error';job.error=err.message;}
    finally {job.interrupt=null;s.active=null;publish(s,job);}
  }).catch(err=>{if(!s.disposed){job.status='error';job.error=err.message;publish(s,job);}});
}
function enqueue(id, params) {
  const s=getSession(id);
  if(!['upload','download'].includes(params.direction)) throw Error('잘못된 전송 방향입니다');
  if(typeof params.localPath !== 'string' || !path.isAbsolute(params.localPath)) throw Error('로컬 절대 경로가 필요합니다');
  const job={id:crypto.randomUUID(),direction:params.direction,localPath:params.localPath,remotePath:remotePath(params.remotePath),
    status:'queued',generation:0,bytesTotal:null,bytesTransferred:0,startedAt:Date.now(),verify:!!params.verify,overwrite:!!params.overwrite};
  job.partial=job.direction === 'upload' ? job.remotePath+'.onegyeok-'+job.id+'.part' : job.localPath+'.onegyeok-'+job.id+'.part';
  s.jobs.set(job.id,job);publish(s,job);schedule(s,job);return job.id;
}
function control(id, jobId, action) {
  const s=getSession(id);const job=s.jobs.get(jobId);if(!job) throw Error('전송 작업을 찾을 수 없습니다');
  if(action === 'pause' && ['queued','running'].includes(job.status) || action === 'cancel' && ['queued','running','paused','error'].includes(job.status)) {
    job.status=action === 'pause' ? 'paused' : 'canceled';
    if(s.active === job) {job.generation++;if(job.interrupt)job.interrupt(Error('전송 중단'));for(const stream of job.streams || []) stream.destroy(Error('전송 중단'));closeClient(s,true);}
    if(action === 'cancel') serial(s,async()=>{
      if(job.direction === 'download') await fsp.unlink(job.partial).catch(()=>{});
      else {await openClient(s);if(s.mode === 'sftp') await s.client.delete(job.partial,true);else await s.client.remove(job.partial,true);}
    }).catch(()=>{});
  } else if(action === 'resume' && ['paused','error'].includes(job.status)) {job.status='queued';job.error=null;schedule(s,job);}
  publish(s,job);
}
async function disconnect(id) {
  const s=sessions.get(id);if(!s) return;
  sessions.delete(id);s.disposed=true;
  for(const job of s.jobs.values()) { if(!['done','error','canceled'].includes(job.status)) job.status='canceled';job.generation++;if(job.interrupt)job.interrupt(Error('연결 종료'));for(const stream of job.streams || []) stream.destroy(Error('연결 종료')); }
  closeClient(s,true);s.params={};
}
function disconnectAll() {for(const id of sessions.keys()) disconnect(id);}
module.exports={connect,disconnect,disconnectAll,localList,list,operation,enqueue,control,remotePath};
