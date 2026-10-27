import React, { useEffect, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Copy, Image as ImageIcon, RefreshCw } from "lucide-react";

function PreviewImage({ item }) {
  const [failed, setFailed] = useState(false);
  return failed || !item ? <span className="cw-unavailable"><ImageIcon size={28}/>Preview unavailable</span>
    : <img src={`/api/items/${Number(item.id)}/thumbnail?size=700`} alt={item.name || "Library photo"} onError={()=>setFailed(true)}/>;
}

// A read-only sample of the selected queue. Decisions use the existing review
// screens, which own confirmations, licenses, undo, and recovery.
export default function CareWorkbench({ choices, selected, onSelect, api, scope, openCategory, formatBytes, revision }) {
  const [response, setResult] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [index, setIndex] = useState(0);
  const [comparison, setComparison] = useState("side");
  const [split, setSplit] = useState(50);
  const current = choices.find(c=>c.title===selected) || choices[0];
  const duplicates = current?.route.kind === "duplicates";
  const query = duplicates ? "/api/duplicates?category=exact&offset=0&limit=8&sort=largest"
    : `/api/items?${new URLSearchParams({...current?.route.params,...scope?.params,limit:"8"})}`;
  useEffect(()=>{
    let active = true;
    setResult(null); setError(""); setIndex(0); setSplit(50);
    api(query).then(data=>{if(active) setResult({query,data});}).catch(()=>{if(active) setError("We couldn't load these previews. Your files haven't changed.");});
    return ()=>{active=false;};
  },[query,api,retry,revision]);
  const result = response?.query === query ? response.data : null;
  const entries = duplicates ? result?.page?.groups || result?.groups || [] : result?.items || [];
  const entry = entries[index];
  const photos = duplicates ? entry?.items?.slice(0,2) || [] : entry ? [entry] : [];
  const total = duplicates ? result?.page?.total ?? result?.summary?.exact?.groups ?? result?.total : result?.total;
  const step = delta => {setIndex(i=>Math.max(0,Math.min(entries.length-1,i+delta)));setSplit(50);};
  return <section className="cw-workbench" aria-label="Quick look at your review queues">
    <div className="cw-queues" role="group" aria-label="Preview a category">
      {choices.map(choice=>{const Icon=choice.icon;return <button key={choice.title} className={`cw-queue cd-${choice.tone}`} aria-pressed={current.title===choice.title} onClick={()=>onSelect(choice.title)}>
        <span className="cd-icon"><Icon size={19}/></span><span><strong>{choice.label}</strong><small>{choice.count == null ? "Explore" : new Intl.NumberFormat().format(choice.count) + (choice.route.kind === "duplicates" ? " groups" : " items")}</small></span><ChevronRight size={16}/>
      </button>;})}
    </div>
    <div className="cw-detail" key={current.title}>
      <header><div><h3>{current.label}</h3><p>{current.description}</p></div>{duplicates && <div className="cw-modes" role="group" aria-label="Comparison layout"><button aria-pressed={comparison==="side"} onClick={()=>setComparison("side")}>Side by side</button><button aria-pressed={comparison==="overlay"} onClick={()=>setComparison("overlay")}>Slide to compare</button></div>}</header>
      <div className={`cw-stage ${duplicates ? "cw-pair" : ""}`}>
        {error ? <div className="cw-empty" role="status"><RefreshCw size={27}/><strong>Previews couldn't load</strong><p>{error}</p><button onClick={()=>setRetry(v=>v+1)}>Try again</button></div>
          : !result ? <div className="cw-empty" role="status"><span className="cw-loading"/><p>Loading your previews…</p></div>
          : !photos.length ? <div className="cw-empty" role="status"><ImageIcon size={34}/><strong>No items in this queue</strong><p>Choose another category, or check back as analysis continues.</p></div>
          : <>
            <div className={`cw-photos ${duplicates && comparison==="overlay" && photos.length===2 ? "cw-overlay" : ""}`}>
              {photos.map((photo,i)=><figure key={photo.id} style={duplicates && comparison==="overlay" && i===1 ? {clipPath:`inset(0 0 0 ${split}%)`} : undefined}><PreviewImage key={photo.id} item={photo}/><figcaption><span>{photo.name}</span>{photo.width && photo.height ? <small>{photo.width} × {photo.height}</small> : null}</figcaption></figure>)}
              {duplicates && comparison==="overlay" && photos.length===2 && <><span className="cw-divider" style={{left:`${split}%`}} aria-hidden="true"><ChevronLeft size={14}/><ChevronRight size={14}/></span><input className="cw-slider" type="range" min="0" max="100" value={split} onChange={e=>setSplit(Number(e.target.value))} aria-label="Slide between the two copies"/></>}
            </div>
            <nav className="cw-paging" aria-label="Preview navigation"><button aria-label="Previous preview" disabled={index===0} onClick={()=>step(-1)}><ChevronLeft size={19}/></button><span aria-live="polite">{index+1} of {entries.length} {duplicates ? "sample groups" : "previews"}{total > entries.length ? ` · ${new Intl.NumberFormat().format(total)} total` : ""}</span><button aria-label="Next preview" disabled={index>=entries.length-1} onClick={()=>step(1)}><ChevronRight size={19}/></button></nav>
          </>}
      </div>
      <footer><span>{duplicates && entry ? <><Copy size={16}/>{entry.items.length} copies{entry.potentialBytes != null ? ` · ${formatBytes(entry.potentialBytes)} potential space` : ""}</> : "Take a closer look before deciding what to keep."}</span><button onClick={()=>openCategory(current.title)}>Open {current.label.toLowerCase()} review <ArrowRight size={17}/></button></footer>
    </div>
  </section>;
}
