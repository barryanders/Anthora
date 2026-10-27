// Build from the whole filtered result set, independent of the gallery's loaded pages.
export async function collectBookPhotos(params, request, limit = 200) {
  if (params.type === "video") return { photos: [], total: 0, limited: false };
  const {
    defaultSortApplied,
    cursor: ignoredCursor,
    limit: ignoredLimit,
    ...filters
  } = params;
  const photos = new Map(),
    cursors = new Set();
  let cursor = null,
    total = 0;
  do {
    const query = new URLSearchParams({
      ...filters,
      type: "image",
      limit: String(Math.min(120, limit - photos.size)),
    });
    if (cursor) query.set("cursor", cursor);
    const result = await request(`/api/items?${query}`);
    total = result.total;
    for (const photo of result.items) {
      if (photo.mediaType === "image" && photos.size < limit)
        photos.set(photo.id, photo);
    }
    cursor = result.nextCursor;
    if (cursor && cursors.has(cursor))
      throw new Error(
        "Could not finish loading these photos. Please try again.",
      );
    if (cursor) cursors.add(cursor);
  } while (cursor && photos.size < limit);
  return {
    photos: [...photos.values()],
    total,
    limited: Boolean(cursor) || total > photos.size,
  };
}

export function selectedBookPhotos(items, selectedIds) {
  const photos = [];
  for (const item of items) {
    if (
      selectedIds.has(item.id) &&
      item.mediaType === "image"
    ) {
      photos.push(item);
    }
  }
  return photos;
}
