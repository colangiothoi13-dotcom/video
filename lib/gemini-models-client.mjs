export function geminiModelOptions({ catalogModels, fallbackModels = [], savedModel, selectedModel } = {}) {
  const source = Array.isArray(catalogModels) ? 'google' : 'fallback';
  const models = [];
  const seen = new Set();
  const add = (item, itemSource) => {
    if (typeof item?.id !== 'string' || !item.id || seen.has(item.id)) return;
    seen.add(item.id);
    models.push({ id: item.id, label: item.label || item.id, source: itemSource });
  };
  for (const item of source === 'google' ? catalogModels : fallbackModels) add(item, source);
  add({ id: savedModel }, 'saved');
  add({ id: selectedModel }, 'selected');
  return { models, source };
}
