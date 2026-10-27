export function analysisState(status, failed = false) {
  const care = status?.care;
  if (failed) return {known:false,percent:0,label:"Check paused",detail:"We couldn't refresh analysis status. Try refreshing the dashboard."};
  if (!care) return {known:false,percent:0,label:"Checking your library",detail:"Getting the latest results from your local library."};
  const total = Math.max(0,Number(care.total) || 0);
  const analyzed = Math.min(total,Math.max(0,Number(care.analyzed) || 0));
  if (!total) return {known:true,empty:true,percent:0,label:"No media yet",detail:"Add photos and videos to begin analysis."};
  const complete = analyzed === total && care.current === true;
  return {known:true,complete,percent:Math.round(analyzed / total * 100),label:complete ? "Ready to review" : "Analysis in progress",detail:complete ? "Analysis is up to date. Your review queues are ready." : `${new Intl.NumberFormat().format(total-analyzed)} checks remain. You can review results now.`};
}
export function reviewSuggestion(impact) {
  return Object.entries({exactDuplicates:"Exact copies",downloadedClutter:"Screenshots",lowQuality:"Photo check",accidentalVideo:"Short clips"})
    .map(([key,label])=>({key,label,items:impact?.profiles?.[key]?.items,bytes:impact?.profiles?.[key]?.bytes}))
    .filter(item=>Number.isFinite(item.bytes) && item.bytes > 0 && item.items > 0)
    .sort((a,b)=>b.bytes-a.bytes)[0] || null;
}
