// Process one drop sequentially so server overlap checks also see earlier additions.
export async function connectDroppedSources(folders, existing, connect) {
  const known = new Set(existing.map((source) => source.rootPath));
  const result = { added: 0, skipped: 0, errors: [] };
  for (const folder of folders) {
    if (known.has(folder.path)) { result.skipped++; continue; }
    try {
      await connect(folder);
      known.add(folder.path);
      result.added++;
    } catch (error) {
      result.errors.push(`${folder.name || "Folder"}: ${error.message || "Could not connect."}`);
    }
  }
  return result;
}
