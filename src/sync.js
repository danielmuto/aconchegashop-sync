// Categorias Aconchega organizadas automaticamente.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const BASE_URL = process.env.KORPUS_BASE_URL || 'https://korpuslingerie.com.br';
const START_URL = process.env.KORPUS_START_URL || `${BASE_URL}/produtos/`;
const OUT_DIR = path.resolve(process.env.OUT_DIR || 'data');
const BUCKET = process.env.SUPABASE_BUCKET || 'korpus-products';
const USER_AGENT = process.env.USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const args = new Set(process.argv.slice(2));
const limitArg = process.argv.find((x) => x.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Number(process.env.SYNC_LIMIT || 20);
const NO_DOWNLOAD = args.has('--no-download');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '')
  .trim()
  .replace(/^["']|["']$/g, '');

const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value = '') => String(value).replace(/\s+/g, ' ').trim();
const sha1 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex');

const commonHeaders = {
  'user-agent': USER_AGENT,
  'accept-language': 'pt-BR,pt;q=0.9,en;q=0.7',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'cache-control': 'no-cache'
};

function absoluteUrl(raw, base = BASE_URL) {
  if (!raw || typeof raw !== 'string' || raw.startsWith('data:')) return null;
  try {
    return new URL(raw.trim(), base).href;
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function pickSrcset(value) {
  if (!value) return null;
  const parts = String(value)
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
  return parts.at(-1) || null;
}

function looksLikeProductImage(url) {
  if (!url) return false;
  const low = url.toLowerCase();
  if (/logo|favicon|sprite|payment|banner|placeholder|loader|icon|flags\//.test(low)) return false;
  if (/\.svg(?:\?|$)/i.test(low)) return false;
  return /\.(jpe?g|png|webp|avif)(\?|$)/i.test(low) ||
    /cdn|cloudfront|tiendanube|nuvemshop|static/.test(low);
}

function extFromType(contentType = '', url = '') {
  const type = contentType.toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('avif')) return 'avif';
  if (/\.png(?:\?|$)/i.test(url)) return 'png';
  if (/\.webp(?:\?|$)/i.test(url)) return 'webp';
  if (/\.avif(?:\?|$)/i.test(url)) return 'avif';
  return 'jpg';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: controller.signal,
      headers: { ...commonHeaders, ...(options.headers || {}) }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} em ${url}`);
    }
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Timeout após ${Math.round(timeoutMs / 1000)}s em ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  return response.text();
}

function findProductJsonLd(value) {
  const queue = Array.isArray(value) ? [...value] : [value];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object') continue;
    const type = item['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return item;
    if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
    for (const child of Object.values(item)) {
      if (child && typeof child === 'object' && child !== item['@graph']) {
        if (Array.isArray(child)) queue.push(...child);
        else queue.push(child);
      }
    }
  }
  return null;
}

function normalizedText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function classifyProduct(name = '', description = '') {
  const text = normalizedText(`${name} ${description}`);

  if (/gestante|amament|maternidade|materno/.test(text)) {
    return { category: 'Gestante e Amamentação', slug: 'gestante-amamentacao' };
  }

  if (/infantil|crianca|menina|menino|kids?|bebe/.test(text)) {
    return { category: 'Infantil', slug: 'infantil' };
  }

  if (/pijama|shortdoll|shortdool|camisola|robe|penhoar|baby doll|babydoll/.test(text) &&
      /masculin|homem|men/.test(text)) {
    return { category: 'Pijamas Masculinos', slug: 'pijamas-masculinos' };
  }

  if (/pijama|shortdoll|shortdool|camisola|robe|penhoar|baby doll|babydoll/.test(text)) {
    return { category: 'Pijamas Femininos', slug: 'pijamas-femininos' };
  }

  if (/cueca|boxer|samba cancao|masculin/.test(text)) {
    return { category: 'Moda Íntima Masculina', slug: 'moda-intima-masculina' };
  }

  if (/sexy|sensual|fetiche|fantasia|plug|vibr|lubrificante|excitante|adulto/.test(text)) {
    return { category: 'Sexyshop', slug: 'sexyshop' };
  }

  if (/sutia|calcinha|tanga|lingerie|conjunto|body|cinta|modelador/.test(text)) {
    return { category: 'Moda Íntima Feminina', slug: 'moda-intima-feminina' };
  }

  return { category: 'Outros', slug: 'outros' };
}

async function collectProductLinks(maxLinks) {
  console.log(`Abrindo catálogo: ${START_URL}`);
  const html = await fetchText(START_URL);
  const $ = cheerio.load(html);
  const candidates = [];

  const selectors = [
    '[data-store*="product-item"] a[href]',
    '.item-product a[href]',
    '.product-item a[href]',
    '.js-item-product a[href]',
    'a[href*="/produtos/"]'
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const href = $(el).attr('href');
      const url = absoluteUrl(href, START_URL);
      if (!url) return;
      try {
        const u = new URL(url);
        const base = new URL(BASE_URL);
        if (u.host !== base.host) return;
        const pathname = u.pathname.replace(/\/{2,}/g, '/');
        if (!pathname.startsWith('/produtos/')) return;
        if (pathname === '/produtos/' || pathname === '/produtos') return;
        candidates.push(normalizeUrl(url));
      } catch {}
    });
  }

  const links = [...new Set(candidates.filter(Boolean))];
  console.log(`Links de produto encontrados no catálogo: ${links.length}`);
  if (!links.length) {
    throw new Error('Nenhum link de produto foi encontrado no catálogo da Korpus.');
  }
  return links.slice(0, maxLinks);
}

async function extractProduct(url) {
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  let productLd = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (productLd) return;
    try {
      const parsed = JSON.parse($(el).text() || '{}');
      productLd = findProductJsonLd(parsed);
    } catch {}
  });

  const h1 = clean($('h1').first().text());
  const ogTitle = clean($('meta[property="og:title"]').attr('content') || '');
  const name = clean(productLd?.name || h1 || ogTitle || $('title').text());
  if (!name) throw new Error('Produto sem nome identificável.');

  const description = clean(
    productLd?.description ||
    $('meta[name="description"]').attr('content') ||
    $('[data-store="product-description"]').text() ||
    $('.product-description').text() ||
    $('.user-content').first().text() ||
    ''
  );

  const bodyText = clean($('body').text());
  const sourceCode = clean(productLd?.sku || '') ||
    name.match(/\b(\d{5,})\b/)?.[1] ||
    bodyText.match(/(?:SKU|C[oó]d(?:igo)?)[\s:#-]*(\d{5,})/i)?.[1] ||
    null;

  const offers = Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers;
  const priceText = clean(
    offers?.price ||
    $('[data-product-price]').first().text() ||
    $('.js-price-display').first().text() ||
    $('.price').first().text() ||
    ''
  );

  const supplierPrice = (() => {
    const match = String(priceText).match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+(?:\.\d{2})?/);
    if (!match) return null;
    const raw = match[0];
    const normalized = raw.includes(',')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  })();

  const preferredImages = [];
  const allImages = [];

  const addImage = (raw) => {
    const normalized = normalizeUrl(absoluteUrl(raw, url));
    if (normalized && looksLikeProductImage(normalized)) allImages.push(normalized);
  };
  const addPreferred = (raw) => {
    const normalized = normalizeUrl(absoluteUrl(raw, url));
    if (normalized && looksLikeProductImage(normalized)) {
      preferredImages.push(normalized);
      allImages.push(normalized);
    }
  };

  const ldImages = Array.isArray(productLd?.image)
    ? productLd.image
    : productLd?.image
      ? [productLd.image]
      : [];
  for (const image of ldImages) {
    addPreferred(typeof image === 'string' ? image : image?.url || image?.contentUrl);
  }

  addPreferred($('meta[property="og:image"]').attr('content'));
  addPreferred($('meta[name="twitter:image"]').attr('content'));

  const gallerySelectors = [
    '[data-store*="product-image"] img',
    '.js-product-slide img',
    '.product-image img',
    '.product-gallery img',
    '.swiper-slide img',
    'img[data-product-image]'
  ];

  for (const selector of gallerySelectors) {
    $(selector).each((_, el) => {
      addPreferred($(el).attr('data-src'));
      addPreferred($(el).attr('data-original'));
      addPreferred($(el).attr('src'));
      addPreferred(pickSrcset($(el).attr('srcset')));
      addPreferred(pickSrcset($(el).attr('data-srcset')));
    });
  }

  $('img').each((_, el) => {
    addImage($(el).attr('data-src'));
    addImage($(el).attr('data-original'));
    addImage($(el).attr('src'));
    addImage(pickSrcset($(el).attr('srcset')));
    addImage(pickSrcset($(el).attr('data-srcset')));
  });
  $('source').each((_, el) => {
    addImage(pickSrcset($(el).attr('srcset')));
    addImage(pickSrcset($(el).attr('data-srcset')));
  });

  const imagePool = preferredImages.length ? preferredImages : allImages;
  const sourceImages = [...new Set(imagePool)].slice(0, 10);

  const optionTexts = [];
  $('select option, [data-variant], .js-variation-option, .variant-option, .attribute-value').each((_, el) => {
    const value = clean($(el).attr('data-value') || $(el).text());
    if (value) optionTexts.push(value);
  });

  const validSize = (value) =>
    /^(PP|P|M|G|GG|XG|G1|G2|G3|G4|G\s*PLUS|GG\s*PLUS|PP\s*PLUS|P\s*PLUS|M\s*PLUS|\d{1,3}(?:\/\d{1,3})?)$/i.test(value);

  const descriptionSizeMatch = description.match(/Tamanhos?\s*:\s*([^.;|]+)/i);
  const descriptionSizes = descriptionSizeMatch
    ? descriptionSizeMatch[1].split(/[,\s]+/).map(clean).filter(validSize)
    : [];

  const sizes = [...new Set(
    descriptionSizes.length
      ? descriptionSizes
      : optionTexts.filter(validSize)
  )];

  const classification = classifyProduct(name, description);

  const product = {
    source: 'korpus',
    source_code: sourceCode,
    source_url: url,
    name,
    description: description || null,
    category: classification.category,
    category_slug: classification.slug,
    supplier_price: supplierPrice,
    sizes,
    colors: [],
    source_images: sourceImages
  };

  product.content_hash = sha1(JSON.stringify({
    name: product.name,
    description: product.description,
    supplier_price: product.supplier_price,
    sizes: product.sizes,
    source_images: product.source_images
  }));

  return product;
}

async function downloadImage(url, dir, index) {
  const response = await fetchWithTimeout(url, {
    headers: {
      referer: BASE_URL,
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  }, 30000);

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Conteúdo não é imagem: ${contentType}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1500) throw new Error('Imagem pequena demais para ser foto de produto.');

  const ext = extFromType(contentType, url);
  const filename = `${String(index + 1).padStart(2, '0')}.${ext}`;
  await fs.writeFile(path.join(dir, filename), bytes);

  return { filename, bytes, contentType, sourceUrl: url };
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
    const file = localFiles[i];
    const categorySlug = product.category_slug || 'outros';
    const objectPath = `korpus/${categorySlug}/${folder}/${file.filename}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(objectPath, file.bytes, {
        contentType: file.contentType,
        upsert: true,
        cacheControl: '86400'
      });
    if (uploadError) throw uploadError;

    const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);

    const row = {
      product_id: productId,
      source_url: file.sourceUrl,
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

  if (saved.length) {
    const legacyPrefix = `korpus/${folder}`;
    const { data: legacyFiles, error: legacyListError } = await supabase.storage
      .from(BUCKET)
      .list(legacyPrefix, { limit: 1000 });

    if (!legacyListError && Array.isArray(legacyFiles) && legacyFiles.length) {
      const legacyPaths = legacyFiles
        .filter((item) => item?.name && !item?.id?.endsWith('/'))
        .map((item) => `${legacyPrefix}/${item.name}`);
      if (legacyPaths.length) {
        const { error: legacyRemoveError } = await supabase.storage
          .from(BUCKET)
          .remove(legacyPaths);
        if (legacyRemoveError) {
          console.warn(`  não foi possível limpar pasta antiga: ${legacyRemoveError.message}`);
        }
      }
    }

    const { error: statusError } = await supabase
      .from('products')
      .update({ status: 'ready', updated_at: new Date().toISOString() })
      .eq('id', productId)
      .in('status', ['new', 'error']);
    if (statusError) throw statusError;
  }

  return saved;
}

async function createRun() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('sync_runs')
    .insert({ source: 'korpus' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function finishRun(id, patch) {
  if (!supabase || !id) return;
  const { error } = await supabase
    .from('sync_runs')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const runId = await createRun();
  let productsFound = 0;
  let productsCreated = 0;
  let productsUpdated = 0;
  let imagesSaved = 0;

  try {
    const links = await collectProductLinks(LIMIT);
    productsFound = links.length;
    const manifest = [];

    for (let i = 0; i < links.length; i++) {
      const url = links[i];
      console.log(`[${i + 1}/${links.length}] ${url}`);

      try {
        const product = await extractProduct(url);
        const dirName = `${product.source_code || 'produto'}-${sha1(url).slice(0, 10)}`;
        const productDir = path.join(OUT_DIR, dirName);
        await fs.mkdir(productDir, { recursive: true });

        const localFiles = [];
        if (!NO_DOWNLOAD) {
          for (let j = 0; j < product.source_images.length; j++) {
            try {
              localFiles.push(await downloadImage(product.source_images[j], productDir, j));
            } catch (error) {
              console.warn(`  imagem ${j + 1} ignorada: ${error.message}`);
            }
          }
        }

        let dbProduct = null;
        if (supabase) {
          const { data: existing, error: existingError } = await supabase
            .from('products')
            .select('id')
            .eq('source_url', product.source_url)
            .maybeSingle();
          if (existingError) throw existingError;

          dbProduct = await upsertProduct(product);
          if (existing?.id) productsUpdated += 1;
          else productsCreated += 1;

          const stored = await uploadImages(dbProduct.id, product, localFiles);
          imagesSaved += stored.length;
        }

        const output = {
          ...product,
          product_id: dbProduct?.id || null,
          downloaded_images: localFiles.map((file) => file.filename)
        };
        await fs.writeFile(path.join(productDir, 'product.json'), JSON.stringify(output, null, 2));
        manifest.push(output);

        console.log(
          `  OK: ${product.name} | ${product.source_images.length} URL(s) de imagem | ${localFiles.length} baixada(s)`
        );
      } catch (error) {
        console.warn(`  produto ignorado: ${error.message}`);
      }

      await sleep(500);
    }

    await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

    if (!manifest.length) {
      throw new Error('Nenhum produto pôde ser processado.');
    }

    await finishRun(runId, {
      status: 'success',
      products_found: productsFound,
      products_created: productsCreated,
      products_updated: productsUpdated,
      images_saved: imagesSaved
    });

    console.log(
      `Concluído: ${manifest.length} produto(s), ${imagesSaved} imagem(ns) salva(s) no Supabase.`
    );
  } catch (error) {
    await finishRun(runId, {
      status: 'error',
      products_found: productsFound,
      products_created: productsCreated,
      products_updated: productsUpdated,
      images_saved: imagesSaved,
      error_message: error.message
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
