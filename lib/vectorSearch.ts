import "server-only";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, openai } from "./openai";
import { getSupabaseAdminClient } from "./supabase";
import type { RetrievedDocChunk } from "./types";

const DEFAULT_TOP_K = 5;

interface MatchDocsRpcRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface SearchDocsResult {
  chunks: RetrievedDocChunk[];
  // True when the search ran but found nothing (empty table / no match).
  // False when the search succeeded and returned results.
  // null when the search could not run at all (misconfigured creds, RPC missing, etc).
  searchAvailable: boolean | null;
}

export async function searchDocs(
  query: string,
  pageUrl?: string
): Promise<SearchDocsResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { chunks: [], searchAvailable: true };
  }

  // --- Embed the query ---
  let queryEmbedding: number[];
  try {
    const embeddingRes = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: trimmed,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const vec = embeddingRes.data[0]?.embedding;
    if (!vec) return { chunks: [], searchAvailable: null };
    queryEmbedding = vec;
  } catch (err) {
    console.error("[vectorSearch] embedding failed:", err);
    return { chunks: [], searchAvailable: null };
  }

  // --- Query Supabase vector store ---
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc("match_docs_embeddings", {
      query_embedding: queryEmbedding,
      match_count: DEFAULT_TOP_K,
      match_path: pageUrl ?? null,
    });

    if (error) {
      console.error("[vectorSearch] RPC error:", error.message);
      return { chunks: [], searchAvailable: null };
    }

    const chunks = ((data ?? []) as MatchDocsRpcRow[]).map((row) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata ?? {},
      similarity: row.similarity ?? 0,
    }));

    return { chunks, searchAvailable: true };
  } catch (err) {
    console.error("[vectorSearch] unexpected error:", err);
    return { chunks: [], searchAvailable: null };
  }
}
