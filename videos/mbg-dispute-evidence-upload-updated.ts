// MBG private dispute evidence. Deploy with --no-verify-jwt because guest buyers
// use an order access code. Every action is independently authorized here.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const url=Deno.env.get('SUPABASE_URL')!;
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
const bucket='mbg-dispute-evidence';
const cors={'Access-Control-Allow-Origin':'https://fayaa91000.github.io','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const contentTypes:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'};
function magicOK(b:Uint8Array,mime:string){if(mime==='image/jpeg')return b[0]===255&&b[1]===216&&b[2]===255;
if(mime==='image/png')return [137,80,78,71,13,10,26,10].every((x,i)=>b[i]===x);
if(mime==='image/webp')return new TextDecoder().decode(b.slice(0,4))==='RIFF'&&new TextDecoder().decode(b.slice(8,12))==='WEBP';
if(mime==='application/pdf')return new TextDecoder().decode(b.slice(0,5))==='%PDF-';return false;}
async function authn(req:Request,mode:string,dispute:any,code:string){
 const bearer=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 if(mode==='buyer'){
   const hashbuf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code.trim().toUpperCase()));
   const hash=Array.from(new Uint8Array(hashbuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
   const {data:order,error}=await db.from('orders').select('guest_access_hash').eq('id',dispute.order_id).maybeSingle();
   if(error||!order||hash!==order.guest_access_hash)return false;return true;
 }
 if(!bearer)return false;
 const {data:{user},error}=await db.auth.getUser(bearer);
 if(error||!user)return false;
 if(mode==='customer'){
  const {data:link,error:le}=await db.from('meg_customer_order_links').select('order_id').eq('order_id',dispute.order_id).eq('user_id',user.id).maybeSingle();
  return !le && !!link;
 }
 if(mode==='seller'){
  const {data:business}=await db.from('businesses').select('owner_id').eq('id',dispute.business_id).maybeSingle();
  return business?.owner_id===user.id;
 }
 if(mode==='admin'){
  const {data:admin}=await db.from('mbg_admins').select('user_id').eq('user_id',user.id).maybeSingle();return !!admin;
 }
 return false;
}
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 try{
  const form=await req.formData();const action=String(form.get('action')||'');
  const mode=String(form.get('mode')||'');let disputeId=String(form.get('dispute_id')||'');
  if(['buyer','customer'].includes(mode) && !uuid.test(disputeId)){const orderId=String(form.get('order_id')||'');if(!uuid.test(orderId))return json({error:'Invalid order reference'},400);const {data:ds}=await db.from('order_disputes').select('id').eq('order_id',orderId).order('opened_at',{ascending:false}).limit(1);disputeId=ds?.[0]?.id||'';}
  if(!uuid.test(disputeId)||!['buyer','customer','seller','admin'].includes(mode)||!['upload','link'].includes(action))return json({error:'Invalid request'},400);
  const {data:dispute,error:de}=await db.from('order_disputes').select('id,order_id,business_id,status').eq('id',disputeId).maybeSingle();
  if(de||!dispute)return json({error:'Dispute not found'},404);
  const allowed=await authn(req,mode,dispute,String(form.get('access_code')||''));
  if(!allowed)return json({error:'Evidence access denied'},403);
  if(action==='upload'){
   if(mode==='admin'||['resolved','rejected'].includes(dispute.status))return json({error:'Uploads not allowed at this stage'},403);
   const file=form.get('file');if(!(file instanceof File))return json({error:'Select a file'},400);
   if(file.size===0||file.size>10*1024*1024||!contentTypes[file.type])return json({error:'Use JPG, PNG, WebP or PDF, maximum 10 MB'},400);
   const data=new Uint8Array(await file.arrayBuffer());if(!magicOK(data,file.type))return json({error:'File contents do not match supported type'},400);
   const note=String(form.get('statement')||'').trim();if(note.length<10||note.length>3000)return json({error:'Description must be 10–3000 characters'},400);
   const ext=contentTypes[file.type],actor=mode==='customer'?'buyer':mode,path=`${disputeId}/${actor}/${crypto.randomUUID()}.${ext}`;
   const {error:up}=await db.storage.from(bucket).upload(path,data,{contentType:file.type,upsert:false});
   if(up)return json({error:'Private upload failed: '+up.message},500);
   const {error:ie}=await db.from('mbg_dispute_evidence').insert({dispute_id:disputeId,order_id:dispute.order_id,actor:mode==='customer'?'buyer':mode,statement:note,storage_path:path,mime_type:file.type});
   if(ie){await db.storage.from(bucket).remove([path]);return json({error:'Evidence record failed: '+ie.message},500);}
   return json({ok:true,message:'Private file and description submitted for Admin review'});
  }
  const evidenceId=String(form.get('evidence_id')||'');if(!uuid.test(evidenceId))return json({error:'Invalid evidence reference'},400);
  const {data:e}=await db.from('mbg_dispute_evidence').select('actor,storage_path').eq('id',evidenceId).eq('dispute_id',disputeId).maybeSingle();
  if(!e?.storage_path)return json({error:'No attachment found'},404);
  if(mode==='seller'&&e.actor!=='seller')return json({error:'Only your own files are available'},403);
  if(['buyer','customer'].includes(mode)&&e.actor!=='buyer')return json({error:'Only your own files are available'},403);
  const {data:signed,error:se}=await db.storage.from(bucket).createSignedUrl(e.storage_path,90);
  if(se||!signed)return json({error:'Cannot open private file'},500);
  return json({ok:true,url:signed.signedUrl});
 }catch(e){return json({error:'Request could not be processed: '+(e instanceof Error?e.message:'Unknown error')},400)}
});
