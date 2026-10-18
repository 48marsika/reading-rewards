/*
 * GitHub Pages + Supabase Free backend adapter for Reading Rewards.
 * Public config contains ONLY the Project URL and PUBLISHABLE/anon key.
 * Never paste a service_role key, real email password, or adult PIN in config.js.
 */
(() => {
'use strict';
const c=window.READING_CONFIG||{};
const base=String(c.url||'').trim().replace(/\/+$/,'');
const key=String(c.publishableKey||'').trim();
const active=/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)&&key.length>12;
const SESSION_KEY='rr_supabase_session_v1';
const authHeaders=()=>({'apikey':key,'Content-Type':'application/json'});
let session=null;
let adminPIN='';
let getSessionPromise=null;
function readSession(){try{const v=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');return v&&v.access_token&&v.refresh_token?v:null;}catch{return null;}}
function saveSession(v){session=v; if(v)localStorage.setItem(SESSION_KEY,JSON.stringify(v));else localStorage.removeItem(SESSION_KEY);}
function explain(http, data){
 const msg=(data?.msg||data?.message||data?.error_description||data?.error||'Ошибка облачного сервиса');
 if(http===401||http===403){if(/invalid login credentials/i.test(msg))return 'Неверная почта или пароль приложения.';if(/email not confirmed/i.test(msg))return 'Почта ещё не подтверждена в Supabase.';return 'Нет доступа. Войди заново или проверь настройки прав доступа.';}
 if(http===413)return 'Запись слишком большая для загрузки.';
 if(/Failed to fetch/i.test(msg))return 'Нет связи с облаком. Проверь подключение без VPN на обоих устройствах.';
 return msg;
}
async function request(path,{method='GET',data,body,auth=true,contentType='application/json',extraHeaders={},retry=true}={}){
 if(!active)throw Error('Облако ещё не настроено.');
 if(auth)await validSession();
 let headers={'apikey':key,...extraHeaders};
 if(auth&&session?.access_token)headers.Authorization='Bearer '+session.access_token;
 if(body!==undefined){if(contentType)headers['Content-Type']=contentType;}
 else if(data!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(data);}
 let res;
 try{res=await fetch(base+path,{method,headers,body,cache:'no-store'});}catch(e){throw Error('Нет соединения с облачным хранилищем. Проверь интернет и доступность Supabase без VPN.');}
 if(res.status===401&&auth&&retry&&session?.refresh_token){await refreshSession();return request(path,{method,data,body,auth,contentType,extraHeaders,retry:false});}
 const ct=res.headers.get('content-type')||'';
 const responseData=ct.includes('json')?await res.json().catch(()=>null):await res.text().catch(()=>null);
 if(!res.ok)throw Error(explain(res.status,responseData));
 return responseData;
}
async function refreshSession(){
 if(!session?.refresh_token){saveSession(null);throw Error('Войди в приложение заново.');}
 const r=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',data:{refresh_token:session.refresh_token},auth:false});
 saveSession(r);return r;
}
async function validSession(){
 if(!session)session=readSession();
 if(!session)throw Error('Войди в приложение.');
 const expires=Number(session.expires_at||(Math.floor(Date.now()/1000)+Number(session.expires_in||300)));
 if(expires<=Date.now()/1000+60){
   if(!getSessionPromise)getSessionPromise=refreshSession().finally(()=>getSessionPromise=null);
   await getSessionPromise;
 }
 return session;
}
async function login(email,password){
 const s=await request('/auth/v1/token?grant_type=password',{method:'POST',data:{email,password},auth:false});
 s.expires_at=s.expires_at||Math.floor(Date.now()/1000)+(s.expires_in||3600);
 saveSession(s);adminPIN='';return {configured:true,logged:true,admin:false};
}
async function logout(){
 try{if(session)await request('/auth/v1/logout',{method:'POST'});}catch{}
 saveSession(null);adminPIN='';return {configured:true,logged:false,admin:false};
}
function dayInMoscow(){const f=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const p=Object.fromEntries(f.map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;}
function earns(records){
 const days=new Map();
 for(const r of records){if(!['ok','great'].includes(r.rating))continue;
  const k=(r.reviewed_at||'9999')+'|'+r.id;
  if(!days.has(r.day)||k<days.get(r.day))days.set(r.day,k);
 }
 const months=new Map();
 for(const [day,stamp] of days){const m=day.slice(0,7);const list=months.get(m)||[];list.push({day,stamp});months.set(m,list);}
 return [...months.values()].flatMap(list=>list.sort((a,b)=>a.stamp.localeCompare(b.stamp)).slice(0,15).map(x=>x.day)).sort();
}
async function bootstrap(){
 const [passages,records]=await Promise.all([
  request('/rest/v1/rr_passages?select=id,title,level,text,completed_at&order=created_at.asc&limit=2000'),
  request('/rest/v1/rr_recordings?select=id,passage_id,reading_day,created_at,rating,rated_at,audio_path,audio_size&order=created_at.desc&limit=5000')
 ]);
 const list=records.map(r=>({id:r.id,passage_id:r.passage_id,day:r.reading_day,created_at:r.created_at,rating:r.rating,reviewed_at:r.rated_at,audio_path:r.audio_path,size:r.audio_size}));
 return {passages,recordings:list,earned_days:earns(list),server_today:dayInMoscow(),storage_type:'supabase'};
}
function escapePath(path){return String(path).split('/').map(encodeURIComponent).join('/');}
async function upload(form){
 const audio=form.get('audio');const passage_id=form.get('passage_id');
 if(!(audio instanceof Blob)||audio.size<1000||audio.size>12582912)throw Error('Размер записи должен быть от 1 КБ до 12 МБ.');
 const s=await validSession();const uid=s.user?.id;
 if(!uid)throw Error('Учётная запись не найдена. Войди ещё раз.');
 const id=crypto.randomUUID();
 const type=(audio.type||'audio/webm').split(';')[0];
 const ext=type.includes('mp4')?'m4a':type.includes('ogg')?'ogg':type.includes('mpeg')?'mp3':type.includes('wav')?'wav':'webm';
 const path=uid+'/'+id+'.'+ext;
 await request('/storage/v1/object/reading-audio/'+escapePath(path),{method:'POST',body:audio,contentType:type,extraHeaders:{'x-upsert':'false'}});
 try{
  const rows=await request('/rest/v1/rr_recordings?select=id',{method:'POST',data:{id,owner_id:uid,passage_id,audio_path:path,audio_size:audio.size},extraHeaders:{'Prefer':'return=representation'}});
  return {id:rows[0]?.id||id};
 }catch(e){
  // Orphaned file: no delete permission is granted to children. Admin may clean via dashboard.
  throw Error('Аудио загружено, но запись в журнал не добавилась. '+e.message);
 }
}
async function audioURL(id){
 const rows=await request('/rest/v1/rr_recordings?select=audio_path&id=eq.'+encodeURIComponent(id)+'&limit=1');
 if(!rows.length)throw Error('Запись не найдена.');
 const path=rows[0].audio_path;
 await validSession();
 const r=await fetch(base+'/storage/v1/object/authenticated/reading-audio/'+escapePath(path),{headers:{apikey:key,Authorization:'Bearer '+session.access_token}}).catch(()=>null);
 if(!r?.ok)throw Error('Не удалось получить закрытое аудио. Проверь соединение.');
 const blob=await r.blob();return URL.createObjectURL(blob);
}
async function checkPin(pin){
 if(!/^\d{6,10}$/.test(pin))throw Error('Введи секретный код из 6–10 цифр.');
 const ok=await request('/rest/v1/rpc/rr_check_pin',{method:'POST',data:{p_pin:pin}});
 if(ok!==true)throw Error('Неверный код взрослого или временная блокировка после ошибок.');
 adminPIN=pin;return {admin:true};
}
async function review(id,rating){
 if(!adminPIN)throw Error('Сначала открой режим взрослого.');
 if(!['bad','ok','great'].includes(rating))throw Error('Неизвестная оценка.');
 const ok=await request('/rest/v1/rpc/rr_review',{method:'POST',data:{p_id:id,p_rating:rating,p_pin:adminPIN}});
 if(ok!==true){adminPIN='';throw Error('Проверка не прошла. Повтори вход в режим взрослого.');}
 return {ok:true};
}
async function completePassage(id){
 if(!adminPIN)throw Error('Открой режим взрослого.');
 const ok=await request('/rest/v1/rpc/rr_complete_passage',{method:'POST',data:{p_id:id,p_pin:adminPIN}});
 if(ok!==true)throw Error('Нужна сохранённая оценка «Средне» или «Отлично».');
 return {ok:true};
}
async function addPassage({title,level,text}){
 if(!adminPIN)throw Error('Сначала открой режим взрослого.');
 const id=await request('/rest/v1/rpc/rr_add_passage',{method:'POST',data:{p_title:title,p_level:level,p_text:text,p_pin:adminPIN}});
 if(!id){adminPIN='';throw Error('Код взрослого не подтверждён.');}
 return {ok:true,id};
}
async function api(action,opts={}){
 const data=opts.body;
 switch(action){
  case 'session': {
    session=readSession();
    if(!session)return {configured:true,logged:false,admin:false};
    try{const u=await request('/auth/v1/user');
      if(u?.id)return {configured:true,logged:true,admin:!!adminPIN};
    }catch{saveSession(null);}
    return {configured:true,logged:false,admin:false};
  }
  case 'login':return login(data.email,data.password);
  case 'logout':return logout();
  case 'bootstrap':return bootstrap();
  case 'upload':return upload(data);
  case 'admin':return checkPin(data.pin);
  case 'review':return review(data.id,data.rating);
  case 'passage':return addPassage(data);
  case 'complete-passage':return completePassage(data.id);
  case 'lock':adminPIN='';return {admin:false};
  case 'storage':throw Error('Хранение аудио уже настроено: закрытый Supabase Storage.');
  default:throw Error('Неизвестная команда: '+action);
 }
}
window.ReadingCloud={active,api,audioURL};
})();
