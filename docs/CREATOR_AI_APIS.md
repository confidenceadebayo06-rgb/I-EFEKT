# Creator APIs and AI Lab

This change adds creator-facing APIs and a small Creator AI Lab panel to the staging application.

## Social discovery APIs

All endpoints require an authenticated I-EFEKT session.

- `GET /api/reels?limit=30` — recent video/reel posts from real accounts.
- `POST /api/reels` — publish a reel with `mediaUrl`, optional `caption`, `genre`, and `track`.
- `PATCH /api/reels/:id` — update the caption of a reel owned by the signed-in user.
- `DELETE /api/reels/:id` — delete a reel owned by the signed-in user.
- `GET /api/feed` and `GET /api/feed/ranked` — existing personalized and ranked feed APIs.
- `GET /api/trending?limit=30` — recent seven-day posts ordered by public likes/comments.
- `GET /api/explore?q=...` — recent public posts, optionally searched by caption or creator.
- `GET /api/search/suggestions?q=...` — creator and hashtag suggestions.
- `GET /api/search/autocomplete?q=...` — matching creators and posts.
- `GET /api/users/search?q=...` — existing creator lookup endpoint.

Trending currently uses public engagement counts as a simple transparent ranking, not a trained recommendation model. The Explore endpoint returns real database content; it does not seed fictional creators.

## AI writing and analysis APIs

Configure these environment variables on the staging service to enable the AI tools:

- `AI_API_KEY` — secret key for an OpenAI-compatible chat-completions provider.
- `AI_API_BASE_URL` — optional API base URL; defaults to `https://api.openai.com/v1`.
- `AI_MODEL` — optional text model; defaults to `gpt-4o-mini`.
- `AI_VISION_MODEL` — optional vision model; defaults to `AI_MODEL`.

No AI key is committed to the repository. Without `AI_API_KEY`, the AI endpoints return HTTP 503 with a configuration message rather than pretending to process text.

- `GET /api/ai/tools`
- `POST /api/ai/spell-checker`
- `POST /api/ai/grammar-checker`
- `POST /api/ai/plagiarism-checker`
- `POST /api/ai/summarizer`
- `POST /api/ai/paraphraser`
- `POST /api/ai/translator`
- `POST /api/ai/sentiment-analyzer`
- `POST /api/ai/keyword-extractor`
- `POST /api/ai/topic-classifier`
- `POST /api/ai/image-classifier`

Text endpoints accept JSON with `text`. Translator also requires `targetLanguage`. Plagiarism checker requires `comparisonSources`, an array of text supplied by the user. It compares only those supplied sources; it is not a web-wide or commercial plagiarism-database scan. Image classification accepts an `imageUrl` and optional `question`.

## Safety and rollout

- All routes are authenticated.
- AI provider credentials are environment secrets and are not stored in source control.
- No Prisma schema or database migration is added by this feature branch.
- No Cloudflare R2 change is required.
- This branch targets `staging` only. Do not merge to production or change Railway production settings as part of this work.
- Before staging use, set AI provider secrets in the staging service and verify provider terms, data handling, usage limits and cost.
