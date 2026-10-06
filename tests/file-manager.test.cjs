const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const vm=require('node:vm');
function fixture(){
 const files=new Map();const states=new Map();let blocked;let uploads=0;let stalledClose=false;let failRename=false;
 class Client{
  constructor(){this.closed=false;}
  async access(){this.closed=false;}
  async pwd(){return '/';}
  close(){this.closed=true;if(blocked){if(!stalledClose)blocked.reject(Error('connection closed'));blocked=null;}}
  async size(name){if(!files.has(name))throw Error('not found');return files.get(name).length;}
  async list(dir){return [...files.keys()].filter(n=>path.posix.dirname(n)===dir).map(n=>({name:path.posix.basename(n),size:files.get(n).length,isDirectory:false}));}
  trackProgress(fn){this.progress=fn;}
  async uploadFrom(local,remote){uploads++;files.set(remote,Buffer.alloc(0));if(blocked)await blocked.promise;const data=await fsp.readFile(local);files.set(remote,data);if(this.progress)this.progress({bytesOverall:data.length});}
  async appendFrom(local,remote,{localStart}){const data=await fsp.readFile(local);files.set(remote,Buffer.concat([files.get(remote),data.subarray(localStart)]));}
  async rename(from,to){if(failRename){failRename=false;throw Error('rename denied');}files.set(to,files.get(from));files.delete(from);}
  async remove(name){files.delete(name);}
 }
 const exported={exports:{}};
 const context=vm.createContext({require(name){if(name==='./file-workflows')return require('../src/main/file-workflows');if(name==='basic-ftp')return {Client};if(name==='ssh2-sftp-client')return class{};return require(name);},module:exported,Buffer,Promise,Map,Date,setTimeout});
 vm.runInContext(fs.readFileSync('src/main/file-manager.js','utf8'),context);
 return {manager:exported.exports,files,states,uploads:()=>uploads,failRename(){failRename=true;},stallClose(){stalledClose=true;},block(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});blocked={promise,resolve,reject};return blocked;}};
}
async function waitState(f,id,state){for(let i=0;i<150;i++){if(f.states.get(id)?.status===state)return;await new Promise(r=>setTimeout(r,10));}throw Error(JSON.stringify(f.states.get(id)));}
async function setup(f){return f.manager.connect('tab',{fileProtocol:'ftp',allowPlainFtp:true},(_type,job)=>f.states.set(job.id,job));}
async function tempFile(t){const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'onegyeok-files-test-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'source');await fsp.writeFile(file,'payload');return file;}

test('rejects unsupported protocols, unconfirmed plaintext FTP and command-injection paths',async()=>{
 const f=fixture();await assert.rejects(f.manager.connect('bad',{fileProtocol:'http'}));await assert.rejects(f.manager.connect('plain',{fileProtocol:'ftp'}));
 for(const value of ['/file\r\nDELE x','/file\0',''])assert.throws(()=>f.manager.remotePath(value));
});
test('local filesystem listing includes parent and symlink metadata',async t=>{
 const f=fixture();const file=await tempFile(t);await fsp.symlink(file,file+'.link');const listing=await f.manager.localList(path.dirname(file));assert.ok(listing.entries.find(e=>e.name==='source.link'&&e.symlink));assert.equal(listing.parent,path.dirname(path.dirname(file)));
});
test('queued upload commits only after completion and protects existing destinations',async t=>{
 const f=fixture();const file=await tempFile(t);await setup(f);t.after(()=>f.manager.disconnectAll());
 const id=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/file'});await waitState(f,id,'done');assert.equal(f.files.get('/file').toString(),'payload');assert.equal([...f.files.keys()].filter(x=>x.endsWith('.part')).length,0);
 const collision=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/file'});await waitState(f,collision,'error');assert.equal(f.files.get('/file').toString(),'payload');
});
test('cancel interrupts active upload and removes its partial file',async t=>{
 const f=fixture();const file=await tempFile(t);await setup(f);t.after(()=>f.manager.disconnectAll());f.block();
 const id=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/file'});await waitState(f,id,'running');await new Promise(r=>setTimeout(r,20));f.manager.control('tab',id,'cancel');await waitState(f,id,'canceled');await new Promise(r=>setTimeout(r,30));assert.equal(f.files.has('/file'),false);assert.equal(f.files.size,0);
});
test('paused upload reconnects and resumes without starting a second concurrent transfer',async t=>{
 const f=fixture();const file=await tempFile(t);await setup(f);t.after(()=>f.manager.disconnectAll());f.block();
 const id=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/file'});await waitState(f,id,'running');await new Promise(r=>setTimeout(r,20));f.manager.control('tab',id,'pause');await waitState(f,id,'paused');f.manager.control('tab',id,'resume');await waitState(f,id,'done');assert.equal(f.files.get('/file').toString(),'payload');assert.equal(f.uploads(),2);
});
test('root deletion and invalid chmod are rejected',async()=>{
 const f=fixture();await setup(f);await assert.rejects(f.manager.operation('tab','delete','/'),/루트/);await assert.rejects(f.manager.operation('tab','chmod','/file','777'),/SFTP/);f.manager.disconnectAll();
});


test('a transient transport failure retries from the partial file without losing queue order',async t=>{
 const f=fixture();const file=await tempFile(t);await setup(f);t.after(()=>f.manager.disconnectAll());
 const block=f.block();
 const first=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/first'});
 const second=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/second'});
 await waitState(f,first,'running');await new Promise(r=>setTimeout(r,20));
 // Closing through the public pause/resume contract is covered above; this case simulates a transport error.
 block.reject(Error('ECONNRESET connection closed'));
 await waitState(f,first,'done');await waitState(f,second,'done');
 assert.equal(f.files.get('/first').toString(),'payload');assert.equal(f.files.get('/second').toString(),'payload');
});


test('pause releases the queue even when the interrupted stream never settles',async t=>{
 const f=fixture();const file=await tempFile(t);await setup(f);t.after(()=>f.manager.disconnectAll());f.stallClose();f.block();
 const id=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/file'});await waitState(f,id,'running');await new Promise(r=>setTimeout(r,20));
 f.manager.control('tab',id,'pause');f.manager.control('tab',id,'resume');await waitState(f,id,'done');assert.equal(f.files.get('/file').toString(),'payload');
});


test('a final rename failure marks the job as failed and lets the next job finish',async t=>{
 const f=fixture();const file=await tempFile(t);await setup(f);t.after(()=>f.manager.disconnectAll());f.failRename();
 const first=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/first'});
 const second=f.manager.enqueue('tab',{direction:'upload',localPath:file,remotePath:'/second'});
 await waitState(f,first,'error');await waitState(f,second,'done');assert.equal(f.files.has('/first'),false);assert.equal(f.files.get('/second').toString(),'payload');
});
