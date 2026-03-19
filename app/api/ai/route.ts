import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CHAT_MODEL, openai } from "@/lib/openai";
import { searchDocs } from "@/lib/vectorSearch";
import { checkRateLimit } from "@/lib/rateLimit";
import type { ChatMessage } from "@/lib/types";
import type { RetrievedDocChunk } from "@/lib/types";

// ---------------- Sensitive data patterns ----------------
// Block Zcash private keys, seed phrases, and addresses from being sent to OpenAI.
const SENSITIVE_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Zcash unified / sapling / transparent addresses
  { pattern: /\bu[a-z0-9]{80,}\b/i,      label: "Zcash unified address" },
  { pattern: /\bzs1[a-z0-9]{76,}\b/i,    label: "Zcash shielded address" },
  { pattern: /\bt1[a-zA-Z0-9]{33}\b/,    label: "Zcash transparent address" },
  // Viewing / spending keys
  { pattern: /\bzxviews[a-z0-9]{80,}\b/i, label: "Zcash viewing key" },
  { pattern: /\bsecret-spending-key\b/i,  label: "Zcash spending key" },
  // Generic 24-word BIP39 seed phrase heuristic (12–24 words)
  {
    pattern: /\b([a-z]{3,8}\s){11,23}[a-z]{3,8}\b/,
    label: "seed phrase",
  },
  // Long raw hex strings (private key candidate)
  { pattern: /\b[0-9a-f]{60,}\b/i, label: "private key" },
];

function containsSensitiveData(text: string): string | null {
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

// ---------------- Input validation schema ----------------
const RequestSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  pageUrl: z.string().url().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(2000),
      })
    )
    .max(20)
    .optional(),
});

// ---------------- Constants ----------------
const REQUEST_TIMEOUT_MS = 30_000;

// Used when we have retrieved doc chunks to ground the answer.
const SYSTEM_PROMPT_WITH_DOCS = `You are the ZecHub AI assistant — an expert on Zcash and the ZecHub wiki.
Answer the user's question using ONLY the documentation excerpts provided below.
Be concise and accurate. When relevant, mention which section or file the information comes from.
If the answer cannot be fully found in the provided excerpts, say what you do know from them and note that more detail may exist in the full docs.`;

// Used when vector search returned nothing (empty DB, no match, or search unavailable).
const SYSTEM_PROMPT_FALLBACK = `You are the ZecHub AI assistant — a knowledgeable assistant about Zcash, ZecHub, and the broader Zcash ecosystem.
The documentation search did not return results for this question, so answer from your general knowledge about Zcash and ZecHub.
Be accurate and helpful. Remind the user at the end of your answer that for the most up-to-date details they can visit zechub.wiki.`;

// ---------------- Helpers ----------------
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Request timed out")), ms)
  );
  return Promise.race([promise, timeout]);
}

function getCallerIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

function buildContextBlock(chunks: RetrievedDocChunk[]): string {
  return chunks
    .map((c, i) => {
      const src = c.metadata?.path ?? c.metadata?.url ?? "doc";
      return `--- Excerpt ${i + 1} (source: ${src}) ---\n${c.content}`;
    })
    .join("\n\n");
}

// ---------------- Route handler ----------------
export async function POST(req: NextRequest) {
  // Rate limiting
  const ip = getCallerIp(req);
  const { allowed, retryAfterMs } = checkRateLimit(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
      }
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate inputs
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { message, pageUrl, history = [] } = parsed.data;

  // Block sensitive Zcash data from ever reaching OpenAI
  const sensitiveMatch = containsSensitiveData(message);
  if (sensitiveMatch) {
    return NextResponse.json(
      {
        error: `Your message appears to contain a ${sensitiveMatch}. For your security, private keys, seed phrases, and wallet addresses should never be shared with any third-party service.`,
      },
      { status: 400 }
    );
  }

  try {
    const answer = await withTimeout(
      (async () => {
        // 1. Retrieve relevant doc chunks — never throws, always returns a result
        const { chunks, searchAvailable } = await searchDocs(message, pageUrl);
        const hasContext = chunks.length > 0;

        // 2. Choose system prompt and context injection based on what we found
        let systemPrompt: string;
        let contextInjection: string;

        if (hasContext) {
          systemPrompt = SYSTEM_PROMPT_WITH_DOCS;
          contextInjection = `Use the following documentation excerpts to answer:\n\n${buildContextBlock(chunks)}`;
        } else {
          systemPrompt = SYSTEM_PROMPT_FALLBACK;
          contextInjection =
            searchAvailable === null
              ? "Note: The documentation search is currently unavailable. Answer from general knowledge."
              : "Note: No documentation excerpts matched this query. Answer from general knowledge about Zcash and ZecHub.";
        }

        // 3. Assemble messages
        const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: contextInjection },
          ...history.map((h: ChatMessage) => ({
            role: h.role as "user" | "assistant",
            content: h.content,
          })),
          { role: "user", content: message },
        ];

        // 4. Call OpenAI Responses API
        const response = await openai.responses.create({
          model: CHAT_MODEL,
          input: messages,
        });

        return response.output_text ?? "";
      })(),
      REQUEST_TIMEOUT_MS
    );

    return NextResponse.json({ answer });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "An unexpected error occurred.";
    const isTimeout = msg === "Request timed out";

    console.error("[/api/ai] error:", msg);
    return NextResponse.json(
      { error: isTimeout ? "The request took too long. Try again." : "Failed to get answer." },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
