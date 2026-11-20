import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

const textTools = new Set([
  'spell-checker', 'grammar-checker', 'plagiarism-checker', 'summarizer',
  'paraphraser', 'translator', 'sentiment-analyzer', 'keyword-extractor',
  'topic-classifier'
]);

const instructions: Record<string, string> = {
  'spell-checker': 'Correct spelling only. Preserve the author\'s wording and tone. Return corrected text and a concise list of changes.',
  'grammar-checker': 'Correct grammar, punctuation and sentence structure while preserving meaning and tone. Return corrected text and a concise list of changes.',
  'plagiarism-checker': 'Compare the submitted text only with the comparisonSources supplied by the user. Identify matching or closely similar passages and explain the limits of this comparison. Never claim to have searched the public web or a plagiarism database.',
  summarizer: 'Produce a faithful summary of the supplied text. Do not add facts.',
  paraphraser: 'Rewrite the supplied text in fresh wording while preserving its meaning. Do not imitate a named living author.',
  translator: 'Translate the supplied text into the requested target language. Preserve names, numbers and meaning.',
  'sentiment-analyzer': 'Classify the sentiment of the supplied text and explain the main textual signals. Avoid inferring the author\'s personal traits.',
  'keyword-extractor': 'Extract the most important keywords and short key phrases from the supplied text.',
  'topic-classifier': 'Classify the supplied text into a small set of relevant topics and explain the textual evidence.'
};

const requestSchema = z.object({
  text: z.string().trim().min(1).max(20000),
  targetLanguage: z.string().trim().min(2).max(80).optional(),
  comparisonSources: z.array(z.string().max(20000)).max(20).optional()
});

async function callTextModel(tool: string, input: z.infer<typeof requestSchema>) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    const error = new Error('AI tools are not configured. Set AI_API_KEY and, optionally, AI_MODEL in the staging service environment.');
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }
  const base = (process.env.AI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: instructions[tool] || 'Help with the supplied text accurately and safely.' },
        { role: 'user', content: JSON.stringify({ text: input.text, targetLanguage: input.targetLanguage, comparisonSources: input.comparisonSources }) }
      ]
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`AI provider request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const output = payload.choices?.[0]?.message?.content?.trim();
  if (!output) throw new Error('AI provider returned an empty result.');
  return { tool, model, result: output };
}

export function registerAiToolRoutes(app: FastifyInstance, auth: preHandlerHookHandler) {
  app.get('/api/ai/tools', { preHandler: auth }, async () => ({
    tools: [...textTools, 'image-classifier'],
    configured: Boolean(process.env.AI_API_KEY),
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    note: 'AI requests are sent to the configured AI_API_BASE_URL provider. Plagiarism checking compares only sources supplied by the user; it is not a web-wide originality scan.'
  }));

  app.post('/api/ai/:tool', { preHandler: auth }, async (req, reply) => {
    const tool = String((req.params as { tool: string }).tool);
    if (!textTools.has(tool)) return reply.code(404).send({ error: 'Unknown text tool.' });
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide text (1–20,000 characters) and valid optional tool settings.' });
    if (tool === 'translator' && !parsed.data.targetLanguage) return reply.code(400).send({ error: 'targetLanguage is required for translation.' });
    if (tool === 'plagiarism-checker' && !parsed.data.comparisonSources?.length) return reply.code(400).send({ error: 'Provide comparisonSources. This tool does not search the public web.' });
    try {
      return await callTextModel(tool, parsed.data);
    } catch (error) {
      req.log.error({ error, tool }, 'AI text tool failed');
      const status = (error as Error & { statusCode?: number }).statusCode || 502;
      return reply.code(status).send({ error: status === 503 ? (error as Error).message : 'The AI provider could not complete this request.' });
    }
  });

  app.post('/api/ai/image-classifier', { preHandler: auth }, async (req, reply) => {
    const parsed = z.object({ imageUrl: z.string().url(), question: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A valid imageUrl is required.' });
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) return reply.code(503).send({ error: 'Image classification is not configured. Set AI_API_KEY and AI_VISION_MODEL in staging.' });
    const base = (process.env.AI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'gpt-4o-mini',
          temperature: 0.1,
          messages: [{ role: 'user', content: [
            { type: 'text', text: parsed.data.question || 'Classify the visible contents of this image. Describe only observable content and give likely categories with confidence expressed qualitatively.' },
            { type: 'image_url', image_url: { url: parsed.data.imageUrl, detail: 'auto' } }
          ] }]
        }),
        signal: AbortSignal.timeout(45000)
      });
      if (!response.ok) throw new Error(`Provider returned ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const result = payload.choices?.[0]?.message?.content?.trim();
      if (!result) throw new Error('AI provider returned an empty result.');
      return { tool: 'image-classifier', model: process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'gpt-4o-mini', result };
    } catch (error) {
      req.log.error({ error }, 'AI image classifier failed');
      return reply.code(502).send({ error: 'The image classification provider could not complete this request.' });
    }
  });
}
