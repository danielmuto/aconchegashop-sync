import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const BASE_URL = process.env.KORPUS_BASE_URL || 'https://korpuslingerie.com.br';
const START_URL = process.env.KORPUS_START_URL || `${BASE_URL}/produtos/`;
const OUT_DIR = path.resolve(process.env.OUT_DIR || 'data');
const BUCKET = process.env.SUPABASE_BUCKET || 'korpus-products';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; AconchegaShopCatalogSync/1.0)';

const args = new Set(process.argv.slice(2));
const limitArg = process.argv.find((x) => x.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Number(process.env.SYNC_LIMIT || 20);
const NO_DOWNLOAD = args.has('--no-download');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } })
  : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s = '') => String(s).replace(/\s+/g, ' ').trim();
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function absoluteUrl(raw, base = BASE_URL) {
  if (!raw || raw.startsWith('data:')) return null;
  try { return new URL(raw, base).href; } catch { return null; }
}

function normalizeImageUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch { return null; }
}

function looksLikeProductImage(url) {
  if (!url) return false;
  const low = url.toLowerCase();
  if (/logo|icon|sprite|payment|banner|favicon|placeholder|loader|flags\//.test(low)) return false;
  return /\.(jpe?g|png|webp)(\?|$)/i.test(low) || /cloudfront|cdn|nuvem|tiendanube|static/.test(low);
}

function extFromType(contentType = '', url = '') {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (/\.png(?:\?|$)/i.test(url)) return 'png';
  if (/\.webp(?:\?|$)/i.test(url)) return 'webp';
  return 'jpg';
}

async function collectProductLinks(page, maxLinks) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2200);

  const links = await page.evaluate(() => {
    const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.href);
    return [...new Set(hrefs.filter((h) => /\/produtos\//i.test(h) && !/\/produtos\/?(?:\?.*)?$/.test(h)))];
  });

  return links.slice(0, maxLinks);
}

async function extractProduct(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1800);

  const data = await page.evaluate(() => {
    const clean = (s = '') => String(s).replace(/\s+/g, ' ').trim();
    const attrs = (selector, attr) => [...document.querySelectorAll(selector)]
      .map((el) => el.getAttribute(attr))
      .filter(Boolean);

    const jsonLd = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(el.textContent || '{}');
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item?.['@graph']) jsonLd.push(...item['@graph']);
          else jsonLd.push(item);
        }
      } catch {}
    }
    const productLd = jsonLd.find((x) => {
      const t = x?.['@type'];
      return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
    });

    const title = clean(productLd?.name || document.querySelector('h1')?.textContent || document.title);
    const description = clean(
      productLd?.description ||
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('[data-store="product-description"]')?.textContent ||
      document.querySelector('.product-description')?.textContent || ''
    );

    const bodyText = document.body?.innerText || '';
    const sku = clean(productLd?.sku || '') ||
      (title.match(/\b(\d{5,})\b/)?.[1] || bodyText.match(/(?:SKU|C[oó]d(?:igo)?)[\s:#-]*(\d{5,})/i)?.[1] || null);

    const offers = Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers;
    const priceText = clean(
      offers?.price ||
      document.querySelector('[data-product-price]')?.textContent ||
      document.querySelector('.js-price-display')?.textContent ||
      document.querySelector('.price')?.textContent || ''
    );

    const rawImages = [
      ...(Array.isArray(productLd?.image) ? productLd.image : productLd?.image ? [productLd.image] : []),
      ...attrs('meta[property="og:image"]', 'content'),
      ...attrs('meta[name="twitter:image"]', 'content'),
      ...attrs('img[src]', 'src'),
      ...attrs('img[data-src]', 'data-src'),
      ...attrs('img[data-original]', 'data-original'),
      ...attrs('[data-image]', 'data-image'),
      ...attrs('source[srcset]', 'srcset').flatMap((s) => s.split(',').map((x) => x.trim().split(/\s+/)[0])),
      ...attrs('[data-srcset]', 'data-srcset').flatMap((s) => s.split(',').map((x) => x.trim().split(/\s+/)[0]))
    ];

    const optionTexts = [...document.querySelectorAll('select option, [data-variant], .js-variation-option, .variant-option, .attribute-value')]
      .map((e) => clean(e.textContent || e.getAttribute('data-value') || ''))
      .filter(Boolean);

    const sizes = [...new Set(optionTexts.filter((x) => /^(PP|P|M|G|GG|XG|G1|G2|G3|G4|\d{1,3}(?:\/\d{1,3})?)$/i.test(x)))];

    return { title, description, sku, priceText, rawImages, sizes };
  });

  const supplierPrice = (() => {
    const m = String(data.priceText || '').match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+(?:\.\d{2})?/);
    if (!m) return null;
    const n = Number(m[0].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  })();

  const images = [...new Set(data.rawImages
    .map((x) => typeof x === 'string' ? x : x?.url || x?.contentUrl || '')
    .map((x) => absoluteUrl(x, url))
    .map(normalizeImageUrl)
    .filter(looksLikeProductImage))];

  const contentHash = sha1(JSON.stringify({
    name: data.title,
    description: data.description,
    supplierPrice,
    sizes: data.sizes,
    images
  }));

  return {
    source: 'korpus',
    source_code: data.sku || null,
    source_url: url,
    name: data.title,
    description: data.description || null,
    category: null,
    supplier_price: supplierPrice,
    sizes: data.sizes,
    colors: [],
    content_hash: contentHash,
    source_images: images
  };
}

async function downloadImage(request, url, dir, index) {
  const resp = await request.get(url, {
    timeout: 30000,
    headers: { referer: BASE_URL }
  });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()} em ${url}`);

  const contentType = resp.headers()['content-type'] || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error(`Conteúdo não é imagem: ${contentType}`);

  const ext = extFromType(contentType, url);
  const filename = `${String(index + 1).padStart(2, '0')}.${ext}`;
  const bytes = await resp.body();
  await fs.writeFile(path.join(dir, filename), bytes);
  return { filename, bytes, contentType };
}

async function upsertProduct(product) {
  if (!supabase) return null;
  const now = new Date().toISOString();
  const row = {
    source: product.source,
    source_code: product.source_code,
    source_url: product.source_url,
    name: product.name,
    description: product.description,
    category: product.category,
    supplier_price: product.supplier_price,
    sizes: product.sizes,
    colors: product.colors,
    content_hash: product.content_hash,
    last_seen_at: now,
    updated_at: now
  };
  const { data, error } = await supabase
    .from('products')
    .upsert(row, { onConflict: 'source_url' })
    .select('id,status')
    .single();
  if (error) throw error;
  return data;
}

async function uploadImages(productId, product, localFiles) {
  if (!supabase || !productId) return [];
  const folder = product.source_code || sha1(product.source_url).slice(0, 16);
  const saved = [];

  for (let i = 0; i < localFiles.length; i++) {
    const f = localFiles[i];
    const objectPath = `${folder}/${f.filename}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(objectPath, f.bytes, {
      contentType: f.contentType,
      upsert: true,
      cacheControl: '86400'
    });
    if (uploadError) throw uploadError;

    const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
    const row = {
      product_id: productId,
      source_url: product.source_images[i],
      storage_path: objectPath,
      public_url: publicData.publicUrl,
      position: i
    };
    const { error: imageError } = await supabase
      .from('product_images')
      .upsert(row, { onConflict: 'product_id,source_url' });
    if (imageError) throw imageError;
    saved.push(row);
  }
  return saved;
}

async function createRun() {
  if (!supabase) return null;
  const { data, error } = await supabase.from('sync_runs').insert({ source: 'korpus' }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function finishRun(id, patch) {
  if (!supabase || !id) return;
  const { error } = await supabase.from('sync_runs').update({ ...patch, finished_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1365, height: 900 },
    locale: 'pt-BR'
  });
  const page = await context.newPage();
  const request = context.request;
  const runId = await createRun();

  let productsFound = 0;
  let productsCreated = 0;
  let productsUpdated = 0;
  let imagesSaved = 0;

  try {
    const links = await collectProductLinks(page, LIMIT);
    productsFound = links.length;
    console.log(`Encontrados ${links.length} links de produtos.`);
    const manifest = [];

    for (let i = 0; i < links.length; i++) {
      const url = links[i];
      console.log(`[${i + 1}/${links.length}] ${url}`);
      try {
        const product = await extractProduct(page, url);
        const dirName = `${product.source_code || 'produto'}-${sha1(url).slice(0, 10)}`;
        const productDir = path.join(OUT_DIR, dirName);
        await fs.mkdir(productDir, { recursive: true });

        const localFiles = [];
        if (!NO_DOWNLOAD) {
          for (let j = 0; j < product.source_images.length; j++) {
            try {
              localFiles.push(await downloadImage(request, product.source_images[j], productDir, j));
            } catch (e) {
              console.warn(`  imagem ${j + 1} ignorada: ${e.message}`);
            }
          }
        }

        let dbProduct = null;
        if (supabase) {
          const { data: existing } = await supabase.from('products').select('id').eq('source_url', product.source_url).maybeSingle();
          dbProduct = await upsertProduct(product);
          if (existing?.id) productsUpdated += 1; else productsCreated += 1;
          const stored = await uploadImages(dbProduct.id, product, localFiles);
          imagesSaved += stored.length;
        }

        const output = { ...product, product_id: dbProduct?.id || null };
        await fs.writeFile(path.join(productDir, 'product.json'), JSON.stringify(output, null, 2));
        manifest.push(output);
        console.log(`  ${product.name} | ${product.source_images.length} URL(s) de imagem | ${localFiles.length} baixada(s)`);
      } catch (e) {
        console.warn(`  produto ignorado: ${e.message}`);
      }
      await sleep(900);
    }

    await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await finishRun(runId, {
      status: 'success',
      products_found: productsFound,
      products_created: productsCreated,
      products_updated: productsUpdated,
      images_saved: imagesSaved
    });
    console.log(`Concluído: ${manifest.length} produtos processados.`);
  } catch (e) {
    await finishRun(runId, {
      status: 'error',
      products_found: productsFound,
      products_created: productsCreated,
      products_updated: productsUpdated,
      images_saved: imagesSaved,
      error_message: e.message
    });
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
