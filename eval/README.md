# Evaluation harness

Measures the RAG pipeline on a fixed golden set of questions.

```
npm run eval                 # all questions
npm run eval -- --limit 10   # first 10
```

It only reads from Qdrant and never writes to it. It uses the keys in `.env.local`.

## Metrics

- **Retrieval accuracy (top 5)**: the share of questions where the chunk holding the answer is in the top 5 vector-search results for that ticker. MRR is reported too.
- **Answer faithfulness**: an LLM judge splits each answer from the full pipeline (`runRAGQuery`, production settings) into claims, then checks each claim against the chunks the answer was generated from. Reported as the mean per-answer share of supported claims. Answers with no factual claims are left out.
- **Cost per query**: Groq tokens × price, plus Voyage embedding and Cohere rerank, averaged over the set and converted to ₹ (`EVAL_USD_TO_INR`, default 88). Judge calls are excluded. Prices are in the `LLM_PRICES` table in `run.ts`.

## golden.jsonl format

One JSON object per line:

```json
{"id":"q001","question":"<question>","ticker":"<TICKER>","quarter":"Q2FY26","expected_answer":"<answer>","evidence":"<verbatim quote from the chunk>"}
```

- `quarter` is the quarter of the transcript that contains the answer.
- `evidence` is a short verbatim quote (under ~200 characters) copied from the stored chunk. A retrieved chunk counts as correct when it has the same ticker and quarter and contains this quote, ignoring case and whitespace. Chunk IDs aren't used because they change on every re-ingest. Chunks are around 512 characters, so keep the quote short enough to sit inside one chunk.

## Spot-checking the judge

Each run writes `results/spot-check.md` with 20 judge verdicts, half of them unsupported claims where there are enough. Mark Y/N for each one and report the agreement rate alongside the faithfulness number.
