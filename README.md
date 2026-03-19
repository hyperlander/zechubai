# ZecHub AI

An AI-powered documentation assistant for the [ZecHub](https://zechub.wiki) Zcash wiki.

Built with Next.js, OpenAI, and Supabase pgvector. Uses Retrieval-Augmented Generation (RAG) to answer questions grounded in real ZecHub wiki content.

---

## Features

- Floating chat widget on every page (ZEC gold theme)
- Semantic search across 816 ZecHub markdown docs (2,329 chunks)
- Answers grounded in real wiki content with source citations
- Graceful fallback to general Zcash knowledge when no doc match is found
- Page-aware context — prioritizes docs relevant to the current URL
- Quick-start question chips for new users
- Rate limiting (20 req/min per IP)
- Server-side only OpenAI and Supabase calls — API keys never reach the browser
- Sensitive data guardrails — blocks seed phrases, private keys, and wallet addresses

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| AI | OpenAI `gpt-4.1-mini` + `text-embedding-3-large` |
| Vector DB | Supabase with pgvector |
| Styling | Tailwind CSS v4 |
| Deployment | Vercel |

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/hyperlander/zechubai.git
cd zechubai
npm install
```

### 2. Configure environment variables

Create `.env.local` and fill in your keys:

```bash
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

> `SUPABASE_SERVICE_ROLE_KEY` is used only in server-side code and the embed script. It is never sent to the browser.

### 3. Run the Supabase SQL migration

Open the [Supabase SQL Editor](https://supabase.com/dashboard) and run the contents of `sql/schema.sql`. This creates:

- `public.docs_embeddings` table with `vector(1536)` column
- IVFFlat ANN index for cosine similarity search
- `match_docs_embeddings` RPC function

### 4. Add markdown docs

Place `.md` files in the `docs/` directory. The project ships with 816 markdown files fetched from:

- [ZecHub/zechub](https://github.com/ZecHub/zechub) — `/site/` and `/newsletter/` folders
- [ZecHub/zechub-wiki](https://github.com/ZecHub/zechub-wiki)

To re-fetch them:

```bash
# zechub/site (657 files) and zechub/newsletter (156 files)
git clone --depth=1 https://github.com/ZecHub/zechub.git /tmp/zechub
cp -r /tmp/zechub/site/. docs/zechub/
cp -r /tmp/zechub/newsletter/. docs/newsletter/
```

### 5. Embed docs into Supabase

```bash
npm run embed
```

This reads every `.md` file under `docs/`, splits them into ~500-token chunks, creates embeddings with `text-embedding-3-large` (1536 dims), and upserts all vectors into Supabase. Expect ~2,300+ chunks from the full ZecHub corpus.

### 6. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The gold floating button appears in the bottom-right corner of every page.

---

## How It Works

```
User question
     │
     ▼
POST /api/ai
     │
     ├─ Rate limit check (20 req/min per IP)
     ├─ Input validation (Zod)
     ├─ Sensitive data block (seed phrases, private keys, addresses)
     │
     ├─ Embed question → text-embedding-3-large (1536 dims)
     ├─ Cosine similarity search → Supabase match_docs_embeddings RPC → top 5 chunks
     │
     ├─ Build context prompt from retrieved chunks
     └─ Call gpt-4.1-mini → return answer
```

When the vector DB returns results, answers are grounded strictly in the retrieved docs with source citations. When no match is found, the assistant falls back to general Zcash knowledge and directs the user to [zechub.wiki](https://zechub.wiki).

---

## Embedding Model Note

`text-embedding-3-large` outputs 3072 dimensions by default. This project pins embeddings to **1536 dimensions** via OpenAI's `dimensions` parameter (Matryoshka representation learning). This keeps quality high while staying within pgvector's 2000-dimension index limit for IVFFlat/HNSW.

---

## Privacy

- No user identity, chat history, or IP addresses are stored
- Conversation history lives only in browser memory (cleared on tab close)
- The `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY` are `server-only` guarded and never bundled into client code
- Questions are forwarded to OpenAI's API. OpenAI does not use API traffic to train models by default ([policy](https://openai.com/policies/api-data-usage-policies))
- Seed phrases, private keys, and Zcash addresses are blocked both client-side (live warning) and server-side (hard reject) before reaching OpenAI

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run embed` | Ingest docs → create embeddings → upsert to Supabase |

---

## License

MIT
