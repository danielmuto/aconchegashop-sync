import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const url='https://korpuslingerie.com.br/produtos/613356-shortdool-bicolor-iris-hnice/';
const supabase=createClient(
  process.env.SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim().replace(/^["']|["']$/g,''),
  {auth:{persistSession:false,autoRefreshToken:false}}
);
const bucket=process.env.SUPABASE_BUCKET||'korpus-products';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  viewport:{width:1440,height:1200}
});
await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(3000);

const data=await page.evaluate(()=>{
  const abs=(x)=>{try{return new URL(x,location.href).href}catch{return null}};
  const pick=(s)=>s?.split(',').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean).at(-1)||null;
  const imgs=[];
  const sels=['[data-store*="product-image"] img','.js-product-slide img','.product-image img','.product-gallery img','.swiper-slide img','img[data-product-image]'];
  for(const sel of sels){
    document.querySelectorAll(sel).forEach(img=>{
      for(const v of [img.dataset.src,img.dataset.original,img.src,pick(img.srcset),pick(img.dataset.srcset)]){
        const u=abs(v); if(u) imgs.push(u);
      }
    })
  }
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
    try{
      const j=JSON.parse(s.textContent||'{}');
      const arr=Array.isArray(j)?j:[j];
      for(const x of arr){
        if(x?.['@type']==='Product'){
          const im=Array.isArray(x.image)?x.image:[x.image];
          im.filter(Boolean).forEach(v=>imgs.push(typeof v==='string'?v:(v?.url||v?.contentUrl)));
        }
      }
    }catch{}
  });
  const clean=s=>(s||'').replace(/\s+/g,' ').trim();
  const h1=clean(document.querySelector('h1')?.textContent);
  const desc=clean(document.querySelector('[data-store="product-description"]')?.textContent||document.querySelector('.product-description')?.textContent||document.querySelector('meta[name="description"]')?.content);
  const sizes=[...document.querySelectorAll('select option')].map(o=>clean(o.textContent)).filter(x=>/^(M|G|GG)$/i.test(x));
  return {title:h1,description:desc,sizes:[...new Set(sizes)],images:[...new Set(imgs.filter(Boolean))]};
});
console.log(JSON.stringify(data,null,2));

const norm=(u)=>u.replace(/-(?:50|100|240|320|480|640)-0(?=\.webp(?:\?|$))/,'-1024-1024');
const unique=[];
const seen=new Set();
for(const raw of data.images){
  let u=norm(raw);
  const key=u.replace(/-(?:50|100|240|320|480|640|1024)-?(?:0|1024)?(?=\.webp(?:\?|$))/,'');
  if(seen.has(key)) continue;
  seen.add(key); unique.push(u);
}
const selected=unique.slice(0,6);
const {data:prod,error:perr}=await supabase.from('products').upsert({
  source:'korpus',source_code:'613356',source_url:url,name:data.title||'613356- Shortdool Bicolor Iris',
  description:data.description||'Shortdool Bicolor Iris Tamanho: M,G,GG',
  category:'Pijamas Femininos',sizes:data.sizes.length?data.sizes:['M','G','GG'],colors:[],
  last_seen_at:new Date().toISOString(),updated_at:new Date().toISOString(),status:'ready'
},{onConflict:'source_url'}).select('id').single();
if(perr) throw perr;

let pos=0;
for(const u of selected){
  const res=await page.request.get(u,{headers:{referer:url}});
  if(!res.ok()) { console.warn('falha imagem',res.status(),u); continue; }
  const body=await res.body();
  const ct=res.headers()['content-type']||'image/webp';
  if(!ct.startsWith('image/')) continue;
  const ext=ct.includes('png')?'png':ct.includes('jpeg')?'jpg':'webp';
  const objectPath=`korpus/pijamas-femininos/613356/${String(pos+1).padStart(2,'0')}.${ext}`;
  const {error:ue}=await supabase.storage.from(bucket).upload(objectPath,body,{contentType:ct,upsert:true,cacheControl:'86400'});
  if(ue) throw ue;
  const publicUrl=supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
  const {error:ie}=await supabase.from('product_images').upsert({
    product_id:prod.id,source_url:u,storage_path:objectPath,public_url:publicUrl,position:pos
  },{onConflict:'product_id,source_url'});
  if(ie) throw ie;
  console.log('saved',publicUrl); pos++;
}
await browser.close();
console.log('saved_count',pos);
