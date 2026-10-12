# Aconchega Shop — sincronização Korpus

Coletor do catálogo público da Korpus para uso interno da Aconchega Shop.

## Fluxo

`Korpus → Playwright → Supabase → Metricool → Instagram`

Este repositório cuida da primeira metade: localizar produtos, extrair os dados, baixar as fotos oficiais da galeria e salvar tudo no Supabase da Aconchega.

## Supabase da Aconchega

Projeto já criado e estruturado:

- Project ref: `uqsvagvtqzacpnphwzkb`
- Bucket: `korpus-products`
- Tabelas: `products`, `product_images`, `sync_runs`

O preço da Korpus é armazenado somente como `supplier_price` para uso interno. Não deve ser publicado automaticamente no Instagram.

## Teste local

```bash
npm install
npx playwright install chromium
npm run sync -- --limit=2
```

Sem baixar as imagens:

```bash
npm run sync -- --limit=2 --no-download
```

## GitHub Actions

O workflow pode ser disparado manualmente em **Actions → Sync Korpus catalog → Run workflow**.

Para gravar no Supabase, configure estes Secrets do repositório:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Nunca coloque a Service Role Key dentro de arquivos do repositório.

Depois do primeiro teste real com 2 produtos, podemos ativar a execução automática 2× ao dia.

## Postagem no Instagram

A postagem continua separada de propósito. Primeiro validamos que nome, código e fotos capturados são realmente os produtos corretos. Só então o fluxo do Metricool escolhe itens ainda não publicados, monta a legenda da Aconchega e envia para aprovação/publicação.
