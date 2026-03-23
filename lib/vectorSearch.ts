import "server-only";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, openai } from "./openai";
import { getSupabaseAdminClient } from "./supabase";
import type { RetrievedDocChunk } from "./types";

const DEFAULT_TOP_K = 5;

// Minimum cosine similarity to consider a result relevant.
// Queries scoring below this across ALL stored docs are considered out-of-scope
// (not about ZecHub / Zcash) and receive a polite "out of scope" response
// instead of a hallucinated answer.
const SIMILARITY_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// Root cause: the IVFFlat index was created before data was loaded.
// With probes=1 (default), only 1 of 100 clusters is searched. Query vectors
// that fall into a cluster different from the stored documents return 0 rows.
// Stored document vectors always find themselves because they ARE in the index.
// Fix: JS cosine similarity on a module-level cache — bypasses the index.
// SQL fix (run in Supabase dashboard): see sql/fix_ivfflat.sql
// ---------------------------------------------------------------------------

// Module-level embedding cache — survives between requests within the same
// Node.js server instance (local dev + Vercel warm instances).
interface CachedEmbedding {
  id: string;
  embedding: Float32Array;
}

let _embeddingCache: CachedEmbedding[] | null = null;
let _cacheLoadPromise: Promise<CachedEmbedding[]> | null = null;

async function loadEmbeddingCache(
  supabase: ReturnType<typeof getSupabaseAdminClient>
): Promise<CachedEmbedding[]> {
  if (_embeddingCache) return _embeddingCache;
  if (_cacheLoadPromise) return _cacheLoadPromise;

  const loadStart = Date.now();
  console.log("[vectorSearch] cache: loading all embeddings from Supabase...");

  _cacheLoadPromise = (async () => {
    const chunks: CachedEmbedding[] = [];
    const PAGE_SIZE = 1000;
    let page = 0;

    while (true) {
      const { data, error } = await supabase
        .from("docs_embeddings")
        .select("id, embedding")
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (error) {
        console.error("[vectorSearch] cache: fetch error:", error.message);
        break;
      }
      if (!data || data.length === 0) break;

      for (const row of data) {
        const arr: number[] =
          typeof row.embedding === "string"
            ? JSON.parse(row.embedding as string)
            : (row.embedding as number[]);

        if (Array.isArray(arr) && arr.length === EMBEDDING_DIMENSIONS) {
          chunks.push({ id: row.id as string, embedding: new Float32Array(arr) });
        }
      }

      page++;
      if (data.length < PAGE_SIZE) break;
    }

    console.log(
      `[vectorSearch] cache: loaded ${chunks.length} embeddings in ${Date.now() - loadStart}ms`
    );
    _embeddingCache = chunks;
    return chunks;
  })();

  return _cacheLoadPromise;
}

function cosineSimilarity(a: Float32Array, b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

async function searchDocsJS(
  queryEmbedding: number[],
  topK: number,
  matchPath: string | null,
  supabase: ReturnType<typeof getSupabaseAdminClient>
): Promise<RetrievedDocChunk[]> {
  const t0 = Date.now();
  const cache = await loadEmbeddingCache(supabase);

  if (cache.length === 0) {
    console.error("[vectorSearch] JS search: cache empty — no embeddings loaded");
    return [];
  }

  // Compute cosine similarity for every cached embedding (brute-force)
  const scored = cache.map(({ id, embedding }) => ({
    id,
    similarity: cosineSimilarity(embedding, queryEmbedding),
  }));

  // Sort descending by similarity, take topK × 3 candidates for path filtering
  scored.sort((a, b) => b.similarity - a.similarity);
  const candidates = scored.slice(0, topK * 3).map((s) => s.id);
  const simMap = new Map(scored.map((s) => [s.id, s.similarity]));

  console.log(
    `[vectorSearch] JS cosine computed in ${Date.now() - t0}ms | top similarity=${scored[0]?.similarity.toFixed(3)}`
  );

  // Fetch full content + metadata for candidates
  let q = supabase
    .from("docs_embeddings")
    .select("id, content, metadata")
    .in("id", candidates);

  const { data: fullRows, error } = await q;
  if (error || !fullRows) {
    console.error("[vectorSearch] JS search: full row fetch error:", error?.message);
    return [];
  }

  let results: RetrievedDocChunk[] = fullRows.map((row: any) => ({
    id: row.id,
    content: row.content,
    metadata: row.metadata ?? {},
    similarity: simMap.get(row.id) ?? 0,
  }));

  // Apply path filter if the user is viewing a specific doc page
  if (matchPath) {
    const filtered = results.filter(
      (r) => r.metadata?.path === matchPath || r.metadata?.url === matchPath
    );
    // Fall back to unfiltered if path filter eliminates everything
    results = filtered.length > 0 ? filtered : results;
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

function extractDocPath(pageUrl: string): string | null {
  try {
    const { pathname } = new URL(pageUrl);
    const clean = pathname.replace(/^\/+/, "").trim();
    return clean || null;
  } catch {
    return null;
  }
}

interface MatchDocsRpcRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface SearchDocsResult {
  chunks: RetrievedDocChunk[];
  // true  — search ran and found results
  // false — search ran but nothing scored above the similarity threshold
  // null  — search could not run (misconfigured creds, RPC missing, etc.)
  searchAvailable: boolean | null;
  // true when the top similarity score is below SIMILARITY_THRESHOLD,
  // meaning the query is likely unrelated to ZecHub / Zcash docs.
  outOfScope: boolean;
}

export async function searchDocs(
  query: string,
  pageUrl?: string
): Promise<SearchDocsResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { chunks: [], searchAvailable: true, outOfScope: false };
  }

  // --- Embed the query ---
  let queryEmbedding: number[];
  const embedStart = Date.now();
  try {
    const embeddingRes = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: trimmed,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const vec = embeddingRes.data[0]?.embedding;
    if (!vec) {
      console.error("[vectorSearch] no embedding vector returned from OpenAI");
      return { chunks: [], searchAvailable: null, outOfScope: false };
    }
    queryEmbedding = vec;
    console.log(`[vectorSearch] embedding ok — ${Date.now() - embedStart}ms`);
  } catch (err) {
    console.error(`[vectorSearch] embedding failed (${Date.now() - embedStart}ms):`, err);
    return { chunks: [], searchAvailable: null, outOfScope: false };
  }

  const supabase = getSupabaseAdminClient();
  const docPath = pageUrl ? extractDocPath(pageUrl) : null;
  const searchStart = Date.now();

  // --- Primary: JS cosine similarity (bypasses broken IVFFlat index) ---
  console.log(`[vectorSearch] JS search | match_path=${docPath ?? "null (all docs)"}`);
  try {
    const chunks = await searchDocsJS(queryEmbedding, DEFAULT_TOP_K, docPath, supabase);
    const elapsed = Date.now() - searchStart;

    if (chunks.length > 0) {
      const topSim = chunks[0].similarity;
      const outOfScope = topSim < SIMILARITY_THRESHOLD;

      console.log(
        `[vectorSearch] search ok (JS) — ${elapsed}ms | chunks=${chunks.length}` +
        ` | top similarity=${topSim.toFixed(3)}` +
        ` | outOfScope=${outOfScope}` +
        (outOfScope ? "" : ` | sources=[${chunks.map((c) => c.metadata?.path ?? "?").join(", ")}]`)
      );

      // Return no chunks when out-of-scope so the route returns a scoped message
      if (outOfScope) {
        return { chunks: [], searchAvailable: true, outOfScope: true };
      }
      return { chunks, searchAvailable: true, outOfScope: false };
    }

    // Fallback: attempt RPC in case JS cache is empty or server just started
    console.log("[vectorSearch] JS returned 0 chunks, trying SQL RPC fallback...");
  } catch (err) {
    console.error(`[vectorSearch] JS search error:`, err);
  }

  // --- Fallback: SQL RPC (may work after index is fixed) ---
  try {
    const { data, error } = await supabase.rpc("match_docs_embeddings", {
      query_embedding: `[${queryEmbedding.join(",")}]`,
      match_count: DEFAULT_TOP_K,
      match_path: docPath,
    });

    if (error) {
      console.error(`[vectorSearch] RPC error:`, error.message);
      return { chunks: [], searchAvailable: null, outOfScope: false };
    }

    const chunks = ((data ?? []) as MatchDocsRpcRow[]).map((row) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata ?? {},
      similarity: row.similarity ?? 0,
    }));

    const topSim = chunks[0]?.similarity ?? 0;
    const outOfScope = chunks.length > 0 && topSim < SIMILARITY_THRESHOLD;

    console.log(
      `[vectorSearch] search ok (RPC) — ${Date.now() - searchStart}ms | chunks=${chunks.length}` +
      (chunks.length > 0 ? ` | top similarity=${topSim.toFixed(3)} | outOfScope=${outOfScope}` : " | no matches")
    );

    if (outOfScope) {
      return { chunks: [], searchAvailable: true, outOfScope: true };
    }
    return { chunks, searchAvailable: true, outOfScope: false };
  } catch (err) {
    console.error(`[vectorSearch] RPC unexpected error:`, err);
    return { chunks: [], searchAvailable: null, outOfScope: false };
  }
}
