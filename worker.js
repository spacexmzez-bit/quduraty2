// File: worker.js — Quduraty Aptitude and Tahsili API
const STORES=['groups','sections','questions','wordGroups','words','files'];
const MAX_BODY=8*1024*1024;
function validate(op,tahsili=false){
 if(!op||!STORES.includes(op.store)||typeof op.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(op.id))throw new Error('Invalid record ID/store');
 if(op.kind==='delete')return;
 if(op.kind!=='put'||!op.data||op.data.id!==op.id||JSON.stringify(op.data).length>100000)throw new Error('Invalid record');
 const d=op.data;
 if(['groups','wordGroups'].includes(op.store)&&(typeof d.name!=='string'||!d.name.trim()))throw new Error('Missing group name');
 if(['sections','questions','words'].includes(op.store)&&typeof d.groupId!=='string')throw new Error('Missing group ID');
 if(op.store==='questions'&&(typeof d.text!=='string'||!d.text.trim()||typeof d.sectionId!=='string'||!Array.isArray(d.options)||!d.options.length||!d.options.every(x=>typeof x==='string'&&(tahsili||x.trim()))||(tahsili&&d.options.length>4)||!Number.isInteger(d.correct)||d.correct<0||d.correct>=d.options.length||!d.options[d.correct].trim()))throw new Error('Invalid question/answer');
 if(op.store==='words'&&(typeof d.word!=='string'||!d.word.trim()||typeof d.meaning!=='string'||!d.meaning.trim()))throw new Error('Invalid word');
 if(op.store==='files'&&(typeof d.key!=='string'||!/^uploads\/[a-f0-9-]{36}$/.test(d.key)||!(d.type==='application/pdf'||/^image\//.test(d.type))))throw new Error('Invalid attachment');
}
async function snapshot(env){if(!env.DB)throw new Error('D1 binding is missing');const [meta,rows]=await env.DB.batch([env.DB.prepare('SELECT revision FROM meta WHERE id=1'),env.DB.prepare('SELECT store,data FROM records')]);const stores=Object.fromEntries(STORES.map(s=>[s,[]]));for(const row of rows.results)stores[row.store].push(JSON.parse(row.data));return {revision:meta.results[0].revision,stores};}
export default {async fetch(request,bindings,ctx){
 const origin=request.headers.get('Origin'),allowed=(bindings.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim().replace(/\/+$/,'')).filter(Boolean),wild=allowed.includes('*')||!allowed.length,permitted=!origin||wild||allowed.includes(origin);
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-File-Name'};
 if(origin&&(wild||permitted))headers['Access-Control-Allow-Origin']=wild?'*':origin;
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(origin&&!permitted)return json({error:'Origin '+origin+' not allowed. Add it to ALLOWED_ORIGINS in Worker settings.'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 let path=new URL(request.url).pathname;const tahsili=path==='/tahsili'||path.startsWith('/tahsili/');if(tahsili)path=path.slice(8)||'/';
 const env={...bindings,DB:tahsili?bindings.TAH_DB:bindings.DB};
 try{
 if(path==='/health'&&request.method==='GET')return json({ok:true});
 if(path==='/state'&&request.method==='GET')return json(await snapshot(env));
 if(path==='/uploads'&&request.method==='PUT'){
 const type=request.headers.get('Content-Type')||'',limit=type==='application/pdf'?20*1024*1024:type.startsWith('image/')?4*1024*1024:0;if(!limit)return json({error:'Images and PDF only'},415);
 const reader=request.body?.getReader();if(!reader)return json({error:'Empty upload'},400);const chunks=[];let size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){await reader.cancel();return json({error:'File too large'},413);}chunks.push(part.value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const key='uploads/'+crypto.randomUUID();await env.FILES.put(key,bytes,{httpMetadata:{contentType:type}});return json({key,type,name:(request.headers.get('X-File-Name')?decodeURIComponent(request.headers.get('X-File-Name')):'attachment').slice(0,200)});
 }
 if(path.startsWith('/files/')&&request.method==='GET'){const id=decodeURIComponent(path.slice(7));const row=await env.DB.prepare("SELECT data FROM records WHERE store='files' AND id=?").bind(id).first();if(!row)return json({error:'Not found'},404);const data=JSON.parse(row.data),object=await env.FILES.get(data.key);if(!object)return json({error:'Not found'},404);return new Response(object.body,{headers:{...headers,'Content-Type':data.type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(data.name||'attachment')}`,'X-Content-Type-Options':'nosniff'}});}
 if((path==='/batch'||path==='/wipe')&&request.method==='POST'){
 const raw=await request.text();if(new TextEncoder().encode(raw).length>MAX_BODY)return json({error:'Import too large; split into smaller files'},413);const body=JSON.parse(raw);if(!Number.isSafeInteger(body.revision)||body.revision<0)return json({error:'Revision required'},400);const ops=path==='/wipe'?[]:body.ops;if(!Array.isArray(ops)||ops.length>2000)return json({error:'Maximum 2000 operations per batch'},400);ops.forEach(op=>validate(op,tahsili));
 const before=await snapshot(env);if(before.revision!==body.revision)return json({error:'Data changed on another device. Refresh and retry.'},409);
 if(path!=='/wipe'){const next=structuredClone(before.stores);for(const op of ops){next[op.store]=next[op.store].filter(x=>x.id!==op.id);if(op.kind==='put')next[op.store].push(op.data);}for(const s of next.sections)if(!next.groups.some(g=>g.id===s.groupId))throw new Error('Section group is missing');for(const q of next.questions){if(!next.sections.some(s=>s.id===q.sectionId&&s.groupId===q.groupId))throw new Error('Question section is missing');if(q.fileId&&!next.files.some(f=>f.id===q.fileId))throw new Error('Question attachment is missing');}for(const w of next.words)if(!next.wordGroups.some(g=>g.id===w.groupId))throw new Error('Word group is missing');}
 const revision=body.revision,guard='EXISTS(SELECT 1 FROM meta WHERE id=1 AND revision=?)',statements=[];if(path==='/wipe')statements.push(env.DB.prepare(`DELETE FROM records WHERE ${guard}`).bind(revision));for(const op of ops){if(op.kind==='put')statements.push(env.DB.prepare(`INSERT INTO records(store,id,data) SELECT ?,?,? WHERE ${guard} ON CONFLICT(store,id) DO UPDATE SET data=excluded.data`).bind(op.store,op.id,JSON.stringify(op.data),revision));else statements.push(env.DB.prepare(`DELETE FROM records WHERE store=? AND id=? AND ${guard}`).bind(op.store,op.id,revision));}statements.push(env.DB.prepare('UPDATE meta SET revision=revision+1 WHERE id=1 AND revision=?').bind(revision));const results=await env.DB.batch(statements);if(!results.at(-1).meta.changes)return json({error:'Data changed on another device. Refresh and retry.'},409);const deleted=before.stores.files.filter(f=>path==='/wipe'||ops.some(op=>op.store==='files'&&op.id===f.id&&(op.kind==='delete'||op.data.key!==f.key)));if(deleted.length)ctx.waitUntil(env.FILES.delete(deleted.map(f=>f.key)).catch(console.error));return json({revision:revision+1});
 }
 return json({error:'Not found'},404);
 }catch(error){console.error(error);return json({error:error.message||'Server error'},400);}
}};
