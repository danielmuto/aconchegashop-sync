-- Estrutura usada pelo coletor Aconchega × Korpus.
-- Já aplicada no projeto Supabase da Aconchega Shop.

create extension if not exists pgcrypto;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'korpus',
  source_code text unique,
  source_url text not null unique,
  name text not null,
  description text,
  category text,
  supplier_price numeric(12,2),
  sizes text[] not null default '{}',
  colors text[] not null default '{}',
  content_hash text,
  status text not null default 'new'
    check (status in ('new','ready','scheduled','posted','ignored','error')),
  instagram_posted_at timestamptz,
  instagram_metricool_id text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  source_url text not null,
  storage_path text not null,
  public_url text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique(product_id, source_url)
);

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'korpus',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  products_found integer not null default 0,
  products_created integer not null default 0,
  products_updated integer not null default 0,
  images_saved integer not null default 0,
  status text not null default 'running'
    check (status in ('running','success','error')),
  error_message text
);

alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.sync_runs enable row level security;
