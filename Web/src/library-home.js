const count = (value) => Math.max(0, Number(value) || 0);

export function librarySummary(libraries) {
  return libraries.reduce((summary, library) => {
    summary.items += count(library.itemCount);
    summary.photos += count(library.imageCount);
    summary.videos += count(library.videoCount);
    if (library.available === false) summary.offline += 1;
    else if (["queued", "scanning"].includes(library.scanStatus)) summary.scanning += 1;
    else if (library.scanStatus === "error") summary.failed += 1;
    summary.missing += count(library.missingCount);
    return summary;
  }, { items: 0, photos: 0, videos: 0, scanning: 0, offline: 0, failed: 0, missing: 0 });
}

// A cancelled native picker never creates a source. Paths come from the
// existing native permission flow, not a browser-supplied file path.
export async function connectChosenFolder(chooseFolder, request) {
  const folder = await chooseFolder();
  if (!folder?.path) return null;
  return request("/api/libraries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder.path, name: folder.name || "" }),
  });
}
