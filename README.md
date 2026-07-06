# Echo

Echo gera um retrato do que você andou ouvindo e o exporta como imagem ou vídeo,
pronto para publicar. A partir do seu histórico no **Last.fm**, ele monta um card
com seus artistas e músicas mais ouvidos e produz arquivos nos formatos de
**story** (1080×1920) e **feed** (1600×900).

Nasceu de uma limitação simples: o Apple Music não oferece um resumo mensal de
escuta — mas o Last.fm registra tudo via scrobble.

## Recursos

- **Recap de escuta** — artista em destaque, top 5 artistas e top 5 músicas do
  período escolhido.
- **Versos em destaque** — busca a letra da faixa e permite marcar trechos para
  imprimir no card.
- **Vídeo no topo** — opção de usar um clipe curto como fundo, exportando o
  resultado em MP4.
- **Exportação pronta para publicar** — download em PNG (story e feed) ou MP4.
- **Períodos** — Semana, Mês, Ano ou Todo o período.

## Como rodar

Pré-requisitos: Node.js e [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm dev
```

O app sobe em `http://localhost:5173`.

### Chave do Last.fm

O Echo consome a API do Last.fm, que exige uma chave. Crie a sua em
<https://www.last.fm/api/account/create>.

Por segurança, a chave **nunca é enviada ao navegador**: as requisições passam
por uma função serverless (`api/lastfm.ts`) que injeta a chave no lado do
servidor. Configure-a na variável de ambiente `LASTFM_API_KEY`.

- **Local:** copie `.env.example` para `.env` e preencha `LASTFM_API_KEY`. Como a
  rota `/api/*` só roda no runtime da Vercel, use **`vercel dev`** para exercitar
  o Last.fm localmente (o `pnpm dev` puro não serve `/api`).
- **Produção (Vercel):** cadastre `LASTFM_API_KEY` em
  *Project Settings → Environment Variables*.

> Nota de segurança: variáveis com prefixo `VITE_` são embutidas no bundle
> público e **não devem guardar segredos**. Por isso a chave do Last.fm usa
> `LASTFM_API_KEY` (somente servidor), e não uma variável `VITE_`.

Com a chave configurada, basta informar o **usuário** do Last.fm e gerar o recap.

## Notas técnicas

Algumas escolhas de implementação decorrem de limitações das APIs envolvidas:

- **Foto do artista:** o Last.fm descontinuou as imagens de artista (retorna
  apenas um placeholder). As fotos são obtidas do **Deezer**, sem backend
  adicional.
- **Minutos ouvidos:** o Last.fm não expõe o tempo real de escuta. Os minutos são
  uma **estimativa** (nº de scrobbles no período × duração média das faixas) e
  aparecem marcados como tal.
- **Letras:** as letras vêm do [lrclib.net](https://lrclib.net) (aberto, sem
  chave). Quando não há letra disponível, o verso pode ser digitado manualmente.
- **Exportação em imagem:** as fotos remotas passam por um proxy de imagens para
  serem servidas com CORS, evitando o erro de *canvas tainted* na geração do PNG.
- **Exportação em vídeo:** o MP4 é gerado no navegador. O Firefox não suporta a
  gravação em MP4, então nele a exportação de vídeo fica indisponível (o PNG
  continua funcionando).

## Estrutura

```
api/
  lastfm.ts              Proxy serverless que injeta a chave do Last.fm
src/
  App.tsx                Interface (usuário, período, exportação, preview)
  components/
    RecapCard.tsx        Card compartilhável (variantes story e feed)
  lib/
    lastfm.ts            Cliente do Last.fm e montagem do recap
    lyrics.ts            Busca de letras (lrclib.net)
    images.ts            Foto do artista (Deezer) e proxy de imagens
    exportPng.ts         Exportação em PNG
    videoExport.ts       Exportação em MP4
```

## Tecnologias

React 19, TypeScript, Vite e funções serverless na Vercel.

---

Desenvolvido por [Mangue House](https://manguehouse.com/).
