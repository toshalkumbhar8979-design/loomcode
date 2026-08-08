const { encoding_for_model, get_encoding } = require('tiktoken');

const FALLBACK = 'cl100k_base';

function getEncoder(modelId) {
  try {
    if (modelId && modelId.indexOf('claude') >= 0) return get_encoding(FALLBACK);
    if (modelId) return encoding_for_model(modelId);
    return get_encoding(FALLBACK);
  } catch (e) {
    return get_encoding(FALLBACK);
  }
}

function countTokens(text, modelId) {
  if (!text) return 0;
  const enc = getEncoder(modelId);
  return enc.encode(text).length;
}

function countMessages(messages, modelId) {
  let total = 0;
  for (const m of messages) {
    const text = (m.content || '') + '';
    if (text) total += countTokens(text, modelId);
  }
  total += messages.length * 3;
  return total;
}

module.exports = { countTokens, countMessages };