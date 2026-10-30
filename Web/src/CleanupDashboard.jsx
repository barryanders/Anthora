import React, { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, FileWarning, FolderPlus, Image as ImageIcon, RefreshCw, RotateCcw, ScanLine, ShieldCheck, Sparkles, ThumbsDown, Trash2, UserRound, Play, HardDrive } from "lucide-react";
import { analysisState } from "./care-dashboard-model";
import "./care-dashboard.css";

const number = new Intl.NumberFormat();
export default function CleanupDashboard({ route, navigate, api, formatBytes }) {
  const scope = route.scope;
  const [data, setData] = useState({});
  const [errors, setErrors] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (scope) return;
    let active = true, running = false;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true; setRefreshing(true);
      const endpoints = [["stats", "/api/cleanup/stats"], ["impact", "/api/cleanup/impact"], ["careStatus", "/api/care/status"]];
      const results = await Promise.allSettled(endpoints.map(([,path]) => api(path)));
      if (active) {
        setData(old => ({...old, ...Object.fromEntries(results.flatMap((r,i) => r.status === "fulfilled" ? [[endpoints[i][0], r.value]] : []))}));
        setErrors(results.flatMap((r,i) => r.status === "rejected" ? [endpoints[i][0]] : []));
        setRefreshing(false);
      }
      running = false;
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [scope, revision, api]);
  const { stats, impact, careStatus } = scope ? {} : data;
  const profile = key => impact?.profiles?.[key];
  const profileDescription = (key, fallback) => fallback;
  const categories = [
    {
      title: "Low-Quality Captures",
      description: profileDescription(
        "lowQuality",
        "Nearly blank, severely dark or bright, and unusually low-detail images. Always review before removal.",
      ),
      icon: ImageIcon,
      route: {
        kind: "media",
        title: "Low-Quality Captures",
        params: { type: "image", ai: "lowQuality", cleanup: "1", sort: "largest" },
        crumbs: ["Library Care", "Low-Quality Captures"],
      },
    },
    {
      title: "Possible Accidental Videos",
      description: profileDescription(
        "accidentalVideo",
        "Very short clips that are static, nearly blank, or under one second. Intentional clips may appear here.",
      ),
      icon: FileWarning,
      route: {
        kind: "media",
        title: "Possible Accidental Videos",
        params: { type: "video", ai: "accidentalVideo", cleanup: "1", sort: "largest" },
        crumbs: ["Library Care", "Possible Accidental Videos"],
      },
    },
    {
      title: "Screenshots",
      description: profileDescription(
        "downloadedClutter",
        "Files identified as screenshots. Ordinary photos with visible text are not included.",
      ),
      icon: Sparkles,
      route: {
        kind: "media",
        title: "Screenshots",
        params: { type: "image", ai: "downloadedClutter", cleanup: "1", sort: "largest" },
        crumbs: ["Library Care", "Screenshots"],
      },
    },
    {
      title: "Profile Suggestions",
      description: "Media recognized as a person but not currently associated with that person's profile.",
      icon: FolderPlus,
      route: {
        kind: "organization",
        title: "Profile Suggestions",
        crumbs: ["Library Care", "Profile Suggestions"],
      },
    },
    {
      title: "Unreadable Media",
      description: stats
        ? `${number.format(stats.invalidItems)} unreadable files. ${number.format(stats.recoverableItems)} recovery sources found.`
        : "Empty, corrupt, or unsupported files, grouped by whether a recovery source is available.",
      icon: FileWarning,
      route: {
        kind: "media",
        title: "Unreadable Media",
        params: { invalid: "1", cleanup: "1", sort: "smallest" },
        crumbs: ["Library Care", "Unreadable Media"],
      },
    },
    {
      title: "Text-Heavy Images",
      description: "Images where OCR finds a large amount of visible text.",
      icon: Sparkles,
      route: {
        kind: "media",
        title: "Text-Heavy Images",
        params: { type: "image", ai: "textHeavy", cleanup: "1" },
        crumbs: ["Library Care", "Text-Heavy Images"],
      },
    },
    {
      title: "No People Detected",
      description:
        "Text-heavy images where face, body, and high-confidence image classification found no person.",
      icon: UserRound,
      route: {
        kind: "media",
        title: "Text-Heavy Images · No People Detected",
        params: {
          type: "image",
          ai: "textHeavy",
          people: "0",
          cleanup: "1",
        },
        crumbs: ["Library Care", "Text-Heavy Images", "No People Detected"],
      },
    },
    {
      title: "No Faces Detected",
      description:
        "Text-heavy images with no detected face. A person may still appear from behind, at a distance, or without a visible face.",
      icon: Sparkles,
      route: {
        kind: "media",
        title: "Text-Heavy Images · No Faces Detected",
        params: {
          type: "image",
          ai: "textHeavy",
          faces: "0",
          cleanup: "1",
        },
        crumbs: ["Library Care", "Text-Heavy Images", "No Faces Detected"],
      },
    },
    {
      title: "Faces Detected",
      description:
        "Text-heavy images containing one or more detected faces.",
      icon: UserRound,
      route: {
        kind: "media",
        title: "Text-Heavy Images · Faces Detected",
        params: {
          type: "image",
          ai: "textHeavy",
          faces: "1",
          cleanup: "1",
        },
        crumbs: ["Library Care", "Text-Heavy Images", "Faces Detected"],
      },
    },
    {
      title: "Very Small",
      description:
        "Images under 0.5 megapixels. Review before deleting; small can still be meaningful.",
      icon: ImageIcon,
      route: {
        kind: "media",
        title: "Very Small Images",
        params: {
          type: "image",
          quality: "tiny",
          sort: "smallest",
          cleanup: "1",
        },
        crumbs: ["Library Care", "Very Small"],
      },
    },
    {
      title: "Duplicate & Similar Media",
      description: careStatus?.duplicates
        ? `${careStatus.duplicates.current ? "Duplicate analysis is current." : `${number.format(careStatus.duplicates.remaining)} checks remain.`} ${careStatus.semanticAvailable === false ? "Exact copies, resized versions, and shared video clips in one review queue." : "Exact copies, resized versions, and likely cropped or edited variants in one review queue."}`
        : "Exact copies, resized versions, and shared video clips in one review queue.",
      icon: Copy,
      route: {
        kind: "duplicates",
        duplicateCategory: "exact",
        title: "Duplicate & Similar Media",
        crumbs: ["Library Care", "Duplicate & Similar Media"],
      },
    },
    {
      title: "Disliked",
      description:
        "Items you disliked while browsing. Review them once, then delete the set when you are ready.",
      icon: ThumbsDown,
      route: {
        kind: "media",
        title: "Disliked",
        params: { disposition: "remove" },
        crumbs: ["Library Care", "Disliked"],
      },
    },
    {
      title: "Deleted Items",
      description:
        "Restore recent deletions, erase them permanently, or review files that returned after deletion.",
      icon: Trash2,
      route: {
        kind: "media",
        title: "Deleted Items",
        params: { trash: "1", deletionMode: "deleted" },
        crumbs: ["Library Care", "Deleted Items"],
      },
    },
  ];
  const byTitle = new Map(categories.map(c => [c.title,c]));
  const openCategory = title => {
    const category = byTitle.get(title);
    if (!scope) return navigate(category.route);
    navigate({...category.route, params:{...category.route.params,...scope.params}, title:`${category.title} · ${scope.label}`, crumbs:[`Care for ${scope.label}`,category.title],parentRoute:route});
  };
  const analysis = analysisState(careStatus, errors.includes("careStatus"));
  const metric = (key, field = "items") => profile(key) ? (field === "bytes" ? formatBytes(profile(key).bytes) : number.format(profile(key).items)) : "—";
  const specs = [
    {title:"Screenshots",label:"Screenshots",key:"downloadedClutter",icon:ScanLine,tone:"violet",description:"Receipts, reminders, and things you meant to come back to.",group:"Space & quality",art:"screens"},
    {title:"Low-Quality Captures",label:"Photo quality",key:"lowQuality",icon:ImageIcon,tone:"peach",description:"Dark, washed-out, or low-detail photos. Some may still be keepers.",group:"Space & quality",art:"photos"},
    {title:"Possible Accidental Videos",label:"Short videos",key:"accidentalVideo",icon:Play,tone:"blue",description:"Very short or still clips worth a second look.",group:"Space & quality",art:"video"},
    {title:"Unreadable Media",label:"Unreadable files",icon:FileWarning,tone:"amber",description:"Check files that could not be read, and see recovery options.",count:stats?.invalidItems,detail:stats ? `${number.format(stats.recoverableItems)} recovery sources` : null,group:"Space & quality"},
    {title:"Very Small",label:"Small images",icon:ImageIcon,tone:"teal",description:"Under half a megapixel. Small doesn't always mean unwanted.",group:"Space & quality"},
    {title:"Disliked",label:"Marked for removal",key:"reviewRemovals",icon:ThumbsDown,tone:"rose",description:"Return to items you marked for removal before taking the next step.",group:"Decisions"},
    {title:"Deleted Items",label:"Recently Deleted",icon:RotateCcw,tone:"slate",count:stats?.pendingItems,detail:stats ? `${formatBytes(stats.pendingBytes)} still on disk` : null,description:"Changed your mind? Review recent removals and restore what you need.",group:"Decisions"},
  ];
  const choices = [
    ...(!scope ? [{title:"Duplicate & Similar Media",label:"Duplicates",key:"exactDuplicates",icon:Copy,tone:"blue",description:"Compare two exact copies. Open the full review to see every version and choose what to keep.",group:"Space & quality"}] : []),
    ...specs,
  ].map(s=>({...s,route:byTitle.get(s.title).route,count:scope ? null : s.key ? profile(s.key)?.items : s.count}));
  const reclaimed = stats?.reclaimedBytes;
  const advanced = ["Text-Heavy Images","No People Detected","No Faces Detected","Faces Detected"];
  return <section className="page care-dashboard calm-care" aria-label="Library Care dashboard">
    <header className="cd-header">
      <div>{scope && route.parentRoute && <button className="cd-back" onClick={()=>navigate(route.parentRoute)}><ArrowLeft size={16}/>Back to collection</button>}
        <h1>{scope ? `Care for ${scope.label}` : "Library Care"}</h1>
        <p>Review what you no longer need.</p>
      </div>
      {!scope && <button className="cd-refresh" disabled={refreshing} onClick={()=>setRevision(v=>v+1)} aria-label="Refresh cleanup dashboard"><RefreshCw size={17}/></button>}
    </header>
    {!!errors.length && !scope && <div className="cd-error" role="status"><span>Some results couldn't refresh.</span><button onClick={()=>setRevision(v=>v+1)}>Try again</button></div>}
    {!scope && <button className="care-primary-task" onClick={()=>openCategory("Duplicate & Similar Media")}>
      <span className="care-task-icon"><Copy size={25}/></span>
      <span><strong>Review duplicates</strong><small>{profile("exactDuplicates") ? `${metric("exactDuplicates")} groups · up to ${metric("exactDuplicates","bytes")} to recover` : "Compare copies and choose what to keep."}</small></span><ArrowUpRight size={21}/>
    </button>}
    <div className="care-task-list">
      {choices.filter(c=>c.title !== "Duplicate & Similar Media").map(c=><button key={c.title} onClick={()=>openCategory(c.title)}>
        <c.icon size={21}/><span><strong>{c.label}</strong><small>{c.description}</small></span>
        {c.count != null && <span className="care-task-count">{number.format(c.count)}</span>}<ArrowUpRight size={17}/>
      </button>)}
    </div>
    <details className="quiet-details"><summary>More ways to review</summary><div className="care-extra-list">
      {!scope && <button onClick={()=>openCategory("Profile Suggestions")}>People suggestions <ArrowUpRight size={16}/></button>}
      {advanced.map(title=><button key={title} onClick={()=>openCategory(title)}>{title}<ArrowUpRight size={16}/></button>)}
    </div></details>
    {!scope && <details className="quiet-details"><summary>Analysis & history</summary>
      <p>{analysis.label}. {analysis.detail}</p>
      <p>{reclaimed == null ? "Loading cleanup history…" : `${formatBytes(reclaimed)} recovered from previous cleanup actions.`}</p>
      <ul>{Object.entries(careStatus?.checks || {}).map(([key,value])=><li key={key}>{({exact:"Exact copies",visual:"Image similarity",video:"Video similarity",quality:"Photo quality",semantic:"Image content"})[key] || key}: {number.format(value.analyzed)} / {number.format(value.total)}</li>)}</ul>
    </details>}
    <p className="care-reassurance">Removed files stay in Recently Deleted for 30 days.</p>
  </section>;
}
