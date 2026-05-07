import 'dotenv/config';
import { buildToolsFallbackChain, buildFallbackChain, FALLBACK_PRIORITY } from '../src/llm.js';

const tests = [
  'openrouter:qwen/qwen3-coder:free',
  'openai:gpt-4o',
  'claude:claude-sonnet-4-6',
];

for (const t of tests) {
  console.log(`\n=== ${t} ===`);
  console.log('Tools chain:');
  for (const id of buildToolsFallbackChain(t)) console.log('  - ' + id);
  console.log('Generic chain:');
  for (const id of buildFallbackChain(t)) console.log('  - ' + id);
}

console.log('\n=== Static FALLBACK_PRIORITY ===');
for (const id of FALLBACK_PRIORITY) console.log('  - ' + id);
