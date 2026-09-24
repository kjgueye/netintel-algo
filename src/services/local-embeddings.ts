import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

// Self-hosted multilingual-e5-small, served in-process via transformers.js
// (ONNX runtime, native onnxruntime-node backend on Node). No OpenAI dependency,
// no per-token upstream cost — COGS is a fixed slice of process RAM. Backs
// POST /embeddings (see src/routes/embeddings-local.ts).
//
// ⚠ netintel-embed-small is a PERMANENT PUBLIC CONTRACT (see the route file for
// the full warning). NEVER swap HF_REPO under this id.

export const EMBED_MODEL_ID = "netintel-embed-small";
export const EMBED_SOURCE_MODEL = "multilingual-e5-small";
const HF_REPO = "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/** Singleton loader — one model load per process, shared by every request and warmup. */
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", HF_REPO, { quantized: true });
  }
  return extractorPromise;
}

/** Embed already-prefixed texts ("query: "/"passage: ") → 384-dim L2-normalized vectors. */
export async function embedTexts(prefixed: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const out = await extractor(prefixed, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}

/** Fire-and-forget at boot so the first real call isn't the cold-load. */
export async function warmupLocalEmbeddings(): Promise<void> {
  try {
    await embedTexts(["passage: warmup"]);
  } catch (err) {
    console.error("local-embeddings warmup failed (will retry on first request):", err);
    extractorPromise = null;
  }
}
