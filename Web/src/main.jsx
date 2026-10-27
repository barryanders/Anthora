import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Masonry } from "masonic";
import anthoraMonogram from "./assets/anthora-monogram.png";
import {
  Aperture,
  ArrowLeft,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  FlipHorizontal2,
  FlipVertical2,
  ExternalLink,
  FileWarning,
  Folder,
  FolderPlus,
  HardDrive,
  Heart,
  House,
  Image as ImageIcon,
  Info,
  Infinity as InfinityIcon,
  KeyRound,
  LockKeyhole,
  Menu,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Moon,
  Pause,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Undo2,
  UserRound,
  Users,
  RefreshCw,
  X,
} from "lucide-react";
import brand from "../../Sources/LibraryCore/Resources/Branding.json";
import "./styles.css";
import Books from "./Books";
import CleanupDashboard from "./CleanupDashboard";
import { selectedBookPhotos } from "./books-source";
import { connectDroppedSources } from "./source-drop.js";
import { librarySummary, connectChosenFolder } from "./library-home.js";
import "./calm.css";
import "./instrument.css";
import RotaryControl from "./RotaryControl";

const api = async (path, options) => {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (payload.code === "license_required")
      window.dispatchEvent(new CustomEvent("anthora-license-required"));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
};
const transitionUpdate = (update) => {
  if (!document.startViewTransition) return update();
  document.startViewTransition(() => flushSync(update));
};
let bodyScrollLockCount = 0;
let bodyScrollPreviousOverflow = "";
const useBodyScrollLock = (active) => {
  useEffect(() => {
    if (!active) return undefined;
    if (bodyScrollLockCount === 0) {
      bodyScrollPreviousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    bodyScrollLockCount += 1;
    return () => {
      bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
      if (bodyScrollLockCount === 0) {
        document.body.style.overflow = bodyScrollPreviousOverflow;
        bodyScrollPreviousOverflow = "";
      }
    };
  }, [active]);
};
const number = new Intl.NumberFormat();
const MAX_IMAGE_ZOOM = 32;
const formatBytes = (bytes = 0) => {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};
const formatDuration = (seconds = 0) => {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
};
const formatDate = (timestamp) =>
  timestamp
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(timestamp * 1000),
      )
    : "Not scanned yet";
const MediaSelectionContext = createContext(null);
const DialogContext = createContext(null);
const LicenseContext = createContext({ licensed: true });

const thumbnailQueue = [];
let activeThumbnailRequests = 0;
const MAX_ACTIVE_THUMBNAILS = 10;
const scheduleThumbnail = (start) => {
  let cancelled = false;
  const entry = () => {
    if (cancelled) {
      drainThumbnailQueue();
      return;
    }
    activeThumbnailRequests += 1;
    start(() => {
      activeThumbnailRequests = Math.max(0, activeThumbnailRequests - 1);
      drainThumbnailQueue();
    });
  };
  thumbnailQueue.push(entry);
  drainThumbnailQueue();
  return () => {
    cancelled = true;
  };
};
const drainThumbnailQueue = () => {
  while (activeThumbnailRequests < MAX_ACTIVE_THUMBNAILS && thumbnailQueue.length) {
    thumbnailQueue.shift()();
  }
};

function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const dialogRef = useRef(null);
  useBodyScrollLock(Boolean(dialog));
  const settle = (value) => {
    dialog?.resolve(value);
    setDialog(null);
  };
  const confirmAction = ({
    title,
    message,
    confirmLabel = "Continue",
    danger = false,
  }) =>
    new Promise((resolve) =>
      setDialog({ kind: "confirm", title, message, confirmLabel, danger, resolve }),
    );
  const promptAction = ({ title, message, value = "", confirmLabel = "Save" }) =>
    new Promise((resolve) =>
      setDialog({
        kind: "prompt",
        title,
        message,
        value,
        confirmLabel,
        resolve,
      }),
    );
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement;
    const form = dialogRef.current;
    // Enter activates the focused control. In particular, Enter on Cancel
    // must never confirm a deletion or discard an unsaved book.
    form.querySelector(dialog.kind === "prompt" ? "input" : 'button[type="button"]')?.focus();
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settle(false);
        return;
      }
      if (event.key === "Tab") {
        const controls = [...form.querySelectorAll("button:not(:disabled), input:not(:disabled)")];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    form.addEventListener("keydown", keydown);
    return () => { form.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [dialog?.resolve]);
  return (
    <DialogContext.Provider value={{ confirmAction, promptAction }}>
      {children}
      {dialog && (
        <div
          className="modal-backdrop action-dialog-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && settle(false)}
        >
          <form
            ref={dialogRef}
            className="action-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="action-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              settle(dialog.kind === "prompt" ? dialog.value.trim() : true);
            }}
          >
            <h2 id="action-dialog-title">{dialog.title}</h2>
            {dialog.message && <p>{dialog.message}</p>}
            {dialog.kind === "prompt" && (
              <input
                autoFocus
                aria-label={dialog.title}
                value={dialog.value}
                onChange={(event) =>
                  setDialog((current) => ({ ...current, value: event.target.value }))
                }
              />
            )}
            <div className="action-dialog-buttons">
              <button type="button" onClick={() => settle(false)}>Cancel</button>
              <button className={dialog.danger ? "danger" : "primary"}>
                {dialog.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      )}
    </DialogContext.Provider>
  );
}

function useDialog() {
  return useContext(DialogContext);
}

function useLicense() {
  return useContext(LicenseContext);
}


function searchTitle(filters) {
  const query = filters.query.trim();
  const labels = [];
  if (query) labels.push(query);
  if (filters.favorite) labels.push("Favorites");
  if (filters.aiFilter === "textHeavy") labels.push("Text-Heavy Images");
  if (filters.aiFilter === "screenshot") labels.push("Screenshots");
  if (filters.type === "video") labels.push("Videos");
  if (filters.aspect)
    labels.push(filters.aspect[0].toUpperCase() + filters.aspect.slice(1));
  if (filters.resolution === "large") labels.push("8 MP+");
  if (filters.resolution === "medium") labels.push("2-8 MP");
  if (filters.resolution === "small") labels.push("Under 2 MP");
  if (filters.faces === "1") labels.push("With Faces");
  if (filters.faces === "many") labels.push("Multiple Faces");
  if (filters.faces === "0") labels.push("No Faces");
  if (filters.people === "1") labels.push("People Detected");
  if (filters.people === "0") labels.push("No People Detected");
  if (filters.presentation === "feminine") labels.push("Feminine-Presenting");
  if (filters.presentation === "masculine") labels.push("Masculine-Presenting");
  if (filters.quality === "tiny") labels.push("Under 0.5 MP");
  return `${
    labels.join(" · ") ||
      (filters.type === "video"
        ? "Videos"
        : filters.type === "image"
          ? "Images"
          : "Search results")
  }`;
}

function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      return stored === null ? initial : stored;
    } catch {
      localStorage.removeItem(key);
      return initial;
    }
  });
  useEffect(
    () => localStorage.setItem(key, JSON.stringify(value)),
    [key, value],
  );
  return [value, setValue];
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error(
      `${brand.appName} render failed: ${error?.message || "Unknown error"}`,
      error?.stack || error,
    );
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="recovery-screen">
        <Aperture size={24} />
        <h1>{brand.appName} hit a display problem</h1>
        <p>Your media is safe. Reload the interface to continue.</p>
        <button onClick={() => window.location.reload()}>
          Reload {brand.appName}
        </button>
      </main>
    );
  }
}

function App() {
  const { confirmAction, promptAction } = useDialog();
  const [booksDirty, setBooksDirty] = useState(false);
  const [bookSelection, setBookSelection] = useState([]);
  const [bookContext, setBookContext] = useState(null);
  const [sidebar, setSidebar] = useStored("anthology.sidebar", true);
  const [appearance, setAppearance] = useStored("anthology.appearance", "system");
  const [homeRows, setHomeRows] = useStored("anthology.homeRows", true);
  const [defaultMediaSort, setDefaultMediaSort] = useStored(
    "anthology.defaultMediaSort",
    "newest",
  );
  const [defaultPeopleSort, setDefaultPeopleSort] = useStored(
    "anthology.defaultPeopleSort",
    "newest",
  );
  const [viewerSwipeDirection, setViewerSwipeDirection] = useStored(
    "anthology.viewerSwipeDirection",
    "horizontal",
  );
  const [route, setRoute] = useStored("anthology.route", {
    kind: "home",
    crumbs: [],
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFilters, setSearchFilters] = useStored(
    "anthology.searchFilters",
    defaultSearchFilters,
  );
  const [operation, setOperation] = useState(null);
  const [savedSearches, setSavedSearches] = useState([]);
  const [savedSearchMenu, setSavedSearchMenu] = useState("");
  const [savedSearchError, setSavedSearchError] = useState("");
  const [dismissedOperationId, setDismissedOperationId] = useStored(
    "anthology.dismissedOperationId",
    "",
  );
  const [license, setLicense] = useState({ licensed: true, edition: "free" });
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [nativeLibraryState, setNativeLibraryState] = useState(null);
  const [nativeLibraryError, setNativeLibraryError] = useState("");
  const refreshNativeLibraries = async () => {
    if (!window.anthoraNative?.libraries) return;
    try {
      setNativeLibraryState(await window.anthoraNative.libraries());
      setNativeLibraryError("");
    } catch (error) {
      setNativeLibraryError(error.message || "Libraries could not be loaded.");
    }
  };
  const refreshLicense = () =>
    api("/api/license")
      .then(setLicense)
      .catch(() => setLicense({ licensed: true, edition: "free" }));

  useEffect(() => {
    refreshLicense();
    refreshNativeLibraries();
    const openLicense = () => setLicenseOpen(true);
    window.addEventListener("anthora-license-required", openLicense);
    return () => window.removeEventListener("anthora-license-required", openLicense);
  }, []);
  const createNativeLibrary = async () => {
    try {
      const state = await window.anthoraNative?.createLibrary?.();
      if (state) setNativeLibraryState(state);
    } catch (error) {
      setNativeLibraryError(error.message || "The library could not be created.");
    }
  };
  const openNativeLibrary = async () => {
    try {
      const state = await window.anthoraNative?.openLibrary?.();
      if (state) setNativeLibraryState(state);
    } catch (error) {
      setNativeLibraryError(error.message || "The library could not be opened.");
    }
  };
  const switchNativeLibrary = async (id) => {
    if (!id || id === nativeLibraryState?.activeLibraryId) return;
    if (booksDirty && !await confirmAction({title: "Switch libraries?", message: "Unsaved book changes will be lost.", confirmLabel: "Switch library"})) return;
    setNativeLibraryError("");
    try {
      setBookSelection([]);
      setBookContext(null);
      await window.anthoraNative?.switchLibrary?.(id);
    } catch (error) {
      setNativeLibraryError(error.message || "The library could not be opened.");
    }
  };

  useEffect(() => {
    document.documentElement.dataset.theme = "instrument";
    document.documentElement.dataset.appearance = appearance;
  }, [appearance]);
  useBodyScrollLock(searchOpen);
  useEffect(() => {
    if (
      ![
        "home",
        "books",
        "sources",
        "folders",
        "people",
        "duplicates",
        "cleanup",
        "impact",
        "organization",
        "media",
        "settings",
      ].includes(route?.kind)
    ) {
      setRoute({ kind: "home", crumbs: [] });
    }
  }, [route?.kind]);
  useEffect(() => {
    if (!route?.title?.startsWith("Anthology of ")) return;
    setRoute((current) => ({
      ...current,
      title: current.title.slice("Anthology of ".length),
    }));
  }, [route?.title]);
  useEffect(() => {
    if (
      route?.kind === "media" &&
      route.title === "All Media" &&
      (!route.params?.sort ||
        route.params.sort === "relevance" ||
        route.params.defaultSortApplied === "1") &&
      (route.params?.sort !== defaultMediaSort ||
        route.params.defaultSortApplied !== "1")
    ) {
      setRoute({
        ...route,
        params: {
          ...route.params,
          sort: defaultMediaSort,
          defaultSortApplied: "1",
        },
      });
    }
  }, [route, defaultMediaSort]);
  useEffect(() => {
    if (
      route?.kind === "people" &&
      (!route.peopleSort || route.defaultPeopleSortApplied === "1") &&
      (route.peopleSort !== defaultPeopleSort ||
        route.defaultPeopleSortApplied !== "1")
    ) {
      setRoute({
        ...route,
        peopleSort: defaultPeopleSort,
        defaultPeopleSortApplied: "1",
      });
    }
  }, [route, defaultPeopleSort]);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    const closeForNarrowWindow = (event) => {
      if (event.matches) setSidebar(false);
    };
    if (narrow.matches) setSidebar(false);
    narrow.addEventListener("change", closeForNarrowWindow);
    return () => narrow.removeEventListener("change", closeForNarrowWindow);
  }, []);
  const refreshSavedSearches = () =>
    api("/api/saved-searches")
      .then((data) => {
        setSavedSearches(data.savedSearches || []);
        setSavedSearchError("");
      })
      .catch((error) => setSavedSearchError(error.message));
  useEffect(() => {
    refreshSavedSearches();
  }, []);
  const openSavedSearch = (savedSearch) =>
    navigate({
      kind: "media",
      title: savedSearch.name,
      params: savedSearch.params,
      savedSearchId: savedSearch.id,
      crumbs: ["Smart Searches", savedSearch.name],
    });
  const renameSavedSearch = async (savedSearch) => {
    setSavedSearchMenu("");
    const name = await promptAction({
      title: "Rename Smart Search",
      message: "Choose the name shown in the sidebar.",
      value: savedSearch.name,
      confirmLabel: "Rename",
    });
    if (!name) return;
    try {
      await api(`/api/saved-searches/${savedSearch.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (route.savedSearchId === savedSearch.id)
        setRoute((current) => ({
          ...current,
          title: name,
          crumbs: ["Smart Searches", name],
        }));
      refreshSavedSearches();
    } catch (error) {
      setSavedSearchError(error.message);
    }
  };
  const removeSavedSearch = async (savedSearch) => {
    setSavedSearchMenu("");
    if (!await confirmAction({
      title: `Remove “${savedSearch.name}”?`,
      message: "This removes the shortcut from the sidebar. It does not change or delete any media.",
      confirmLabel: "Remove",
      danger: true,
    })) return;
    try {
      await api(`/api/saved-searches/${savedSearch.id}/remove`, { method: "POST" });
      if (route.savedSearchId === savedSearch.id)
        navigate({ kind: "home", crumbs: [], stack: [] });
      refreshSavedSearches();
    } catch (error) {
      setSavedSearchError(error.message);
    }
  };
  useEffect(() => {
    if (!savedSearchMenu) return;
    const dismiss = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && event.target.closest(".saved-search-row")) return;
      setSavedSearchMenu("");
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [savedSearchMenu]);
  useEffect(() => {
    let active = true;
    const refreshOperation = () =>
      api("/api/operations")
        .then((data) => active && setOperation(data.operation))
        .catch(() => {});
    refreshOperation();
    const timer = window.setInterval(refreshOperation, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const keydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  const navigate = async (next) => {
    if (booksDirty && !await confirmAction({title: "Leave this book?", message: "Unsaved changes will be lost.", confirmLabel: "Leave book"})) return;
    setBooksDirty(false);
    setBookSelection(next.bookPhotos || []);
    setBookContext(next.bookContext || null);
    const {bookPhotos, bookContext, ...persistedRoute} = next;
    setRoute(persistedRoute);
    if (window.matchMedia("(max-width: 760px)").matches) setSidebar(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const nav = [
    [
      "Collections",
      House,
      () => navigate({ kind: "home", crumbs: [], stack: [] }),
    ],
    [
      "All Media",
      ImageIcon,
      () =>
        navigate({
          kind: "media",
          title: "All Media",
          params: {
            sort: defaultMediaSort,
            defaultSortApplied: "1",
          },
          crumbs: ["All Media"],
        }),
    ],
    [
      "Favorites",
      Heart,
      () =>
        navigate({
          kind: "media",
          title: "Favorites",
          params: { favorite: "1" },
          crumbs: ["Favorites"],
        }),
    ],
    ["Books", Bookmark, () => navigate({kind: "books", title: "Books", crumbs: ["Books"]})],
    [
      "Library Care",
      Stethoscope,
      () =>
        navigate({
          kind: "cleanup",
          title: "Library Care",
          crumbs: ["Library Care"],
        }),
    ],
  ];

  return (
    <LicenseContext.Provider value={{ ...license, openLicense: () => setLicenseOpen(true), refreshLicense }}>
    <div className={`app-shell ${sidebar ? "sidebar-open" : "sidebar-closed"}`}>
      {sidebar && (
          <button
            className="sidebar-backdrop"
            aria-label="Close menu"
            onClick={() => setSidebar(false)}
          />
      )}
          <aside className="sidebar" aria-hidden={!sidebar} inert={!sidebar ? true : undefined}>
            {nativeLibraryState && (
              <div className="library-switcher">
                <label htmlFor="active-library">Library</label>
                <select
                  id="active-library"
                  value={nativeLibraryState.activeLibraryId}
                  onChange={(event) => switchNativeLibrary(event.target.value)}
                >
                  {nativeLibraryState.libraries.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </div>
            )}
            <nav>
              {nav.map(([label, Icon, action]) => (
                <button
                  key={label}
                  className={
                    route.title === label ||
                    (label === "Collections" && ["home", "folders", "people"].includes(route.kind))
                      ? "active"
                      : ""
                  }
                  onClick={action}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            {savedSearches.length > 0 && <section className="saved-searches" aria-label="Smart Searches">
                <header>Smart Searches</header>
                {savedSearches.map((savedSearch) => (
                  <div className="saved-search-row" key={savedSearch.id}>
                    <button
                      className={route.savedSearchId === savedSearch.id ? "active" : ""}
                      onClick={() => openSavedSearch(savedSearch)}
                    >
                      <Bookmark size={15} />
                      <span>{savedSearch.name}</span>
                    </button>
                    <button
                      className="saved-search-more"
                      aria-label={`Actions for ${savedSearch.name}`}
                      aria-expanded={savedSearchMenu === savedSearch.id}
                      onClick={() => setSavedSearchMenu((current) =>
                        current === savedSearch.id ? "" : savedSearch.id
                      )}
                    >
                      <MoreHorizontal size={15} />
                    </button>
                    {savedSearchMenu === savedSearch.id && (
                      <div className="saved-search-menu">
                        <button onClick={() => renameSavedSearch(savedSearch)}>Rename</button>
                        <button className="danger" onClick={() => removeSavedSearch(savedSearch)}>Remove</button>
                      </div>
                    )}
                  </div>
                ))}
              </section>}
            <div className="sidebar-bottom">
              <button
                className={route.kind === "sources" ? "active" : ""}
                onClick={() => navigate({ kind: "sources", title: "Sources", crumbs: ["Sources"] })}
              >
                <HardDrive size={17} />
                <span>Sources</span>
              </button>
              <button
                className={route.kind === "settings" ? "active" : ""}
                onClick={() => navigate({ kind: "settings", title: "Settings", crumbs: ["Settings"] })}
              >
                <Settings size={17} />
                <span>Settings</span>
              </button>
            </div>
          </aside>
      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button"
            aria-label="Toggle sidebar"
            aria-expanded={sidebar}
            title={sidebar ? "Hide sidebar" : "Show sidebar"}
            onClick={() => setSidebar(!sidebar)}
          >
            <span className="desktop-sidebar-icon">
              {sidebar ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
            </span>
            <span className="mobile-sidebar-icon"><Menu size={19} /></span>
          </button>
          {!sidebar && (
            <>
              <span className="topbar-toggle-divider" aria-hidden="true" />
              <div className="compact-nav">
              {nav.map(([label, Icon, action]) => (
                <button
                  key={label}
                  aria-label={label}
                  data-tooltip={label}
                  title={label}
                  onClick={action}
                >
                  <Icon size={17} />
                </button>
              ))}
              <span className="compact-nav-divider" aria-hidden="true" />
              <button
                aria-label="Sources"
                data-tooltip="Sources"
                title="Sources"
                onClick={() => navigate({ kind: "sources", title: "Sources", crumbs: ["Sources"] })}
              >
                <HardDrive size={17} />
              </button>
              <button
                aria-label="Settings"
                data-tooltip="Settings"
                title="Settings"
                onClick={() => navigate({ kind: "settings", title: "Settings", crumbs: ["Settings"] })}
              >
                <Settings size={17} />
              </button>
              </div>
            </>
          )}
          <QuickSearch
            navigate={navigate}
            openAdvanced={(query = "") => {
              if (query) setSearchFilters((current) => ({ ...current, query }));
              setSearchOpen(true);
            }}
          />
        </header>
        {operation &&
          (["queued", "running"].includes(operation.status) ||
            operation.id !== dismissedOperationId) &&
          (["queued", "running"].includes(operation.status) ||
            ["failed", "completed_with_errors"].includes(operation.status) ||
            Date.now() / 1000 - operation.updatedAt < 300) && (
            <OperationStatus
              operation={operation}
              navigate={navigate}
              onDismiss={() => setDismissedOperationId(operation.id)}
            />
          )}
        {route.crumbs?.[0] === "Library Care" && route.kind !== "cleanup" && (
          <CareQuickSwitcher route={route} navigate={navigate} />
        )}
        {route.kind === "books" && <Books key={nativeLibraryState?.activeLibraryId || "current"} initialPhotos={bookSelection} initialContext={bookContext} canCreate={license.licensed} onUpgrade={() => setLicenseOpen(true)} onDirty={setBooksDirty} confirmAction={confirmAction} />}
        {route.kind === "home" && (
          <CollectionsHome
            navigate={navigate}
            showRows={homeRows}
            defaultMediaSort={defaultMediaSort}
            defaultPeopleSort={defaultPeopleSort}
          />
        )}
        {route.kind === "sources" && (
          <SourcesView
            navigate={navigate}
            defaultPeopleSort={defaultPeopleSort}
            nativeLibraryState={nativeLibraryState}
            nativeLibraryError={nativeLibraryError}
            createNativeLibrary={createNativeLibrary}
            openNativeLibrary={openNativeLibrary}
          />
        )}
        {route.kind === "folders" && (
          <FoldersView route={route} navigate={navigate} />
        )}
        {route.kind === "people" && (
          <PeopleView route={route} navigate={navigate} />
        )}
        {route.kind === "duplicates" && <DuplicatesView route={route} />}
        {route.kind === "cleanup" && <CleanupDashboard route={route} navigate={navigate} api={api} formatBytes={formatBytes} licensed={license.licensed} onUpgrade={() => setLicenseOpen(true)} />}
        {route.kind === "impact" && <SpaceImpactView navigate={navigate} />}
        {route.kind === "organization" && <OrganizationView navigate={navigate} />}
        {route.kind === "settings" && (
          <SettingsPage
            appearance={appearance}
            setAppearance={setAppearance}
            homeRows={homeRows}
            setHomeRows={setHomeRows}
            defaultMediaSort={defaultMediaSort}
            setDefaultMediaSort={setDefaultMediaSort}
            defaultPeopleSort={defaultPeopleSort}
            setDefaultPeopleSort={setDefaultPeopleSort}
            viewerSwipeDirection={viewerSwipeDirection}
            setViewerSwipeDirection={setViewerSwipeDirection}
          />
        )}
        {route.kind === "media" && (
          <MediaView
            key={JSON.stringify(route.params)}
            route={route}
            navigate={navigate}
            operation={operation}
            onSavedSearchChange={refreshSavedSearches}
            viewerSwipeDirection={viewerSwipeDirection}
          />
        )}
      </main>
      {searchOpen && (
        <SearchPanel
          close={() => setSearchOpen(false)}
          navigate={navigate}
          filters={searchFilters}
          setFilters={setSearchFilters}
        />
      )}
    </div>
    </LicenseContext.Provider>
  );
}

function QuickSearch({ navigate, openAdvanced }) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [focused, setFocused] = useState(false);
  const rootRef = useRef(null);
  useBodyScrollLock(focused && window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    api("/api/people")
      .then((data) => setPeople(data.people || []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!focused) return;
    const dismiss = (event) => {
      if (!rootRef.current?.contains(event.target)) setFocused(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [focused]);
  const normalized = query.trim().toLowerCase();
  const suggestions = normalized
    ? people
        .filter((person) => person.name.toLowerCase().includes(normalized))
        .sort((left, right) => {
          const leftStarts = left.name.toLowerCase().startsWith(normalized) ? 0 : 1;
          const rightStarts = right.name.toLowerCase().startsWith(normalized) ? 0 : 1;
          return leftStarts - rightStarts || right.itemCount - left.itemCount;
        })
        .slice(0, 6)
    : [];
  const runSearch = () => {
    if (!query.trim()) {
      setFocused(false);
      openAdvanced();
      return;
    }
    navigate({
      kind: "media",
      title: query.trim(),
      params: { q: query.trim(), sort: "relevance" },
      crumbs: ["Search"],
    });
    setFocused(false);
  };
  const openPerson = (person) => {
    navigate({
      kind: "media",
      title: person.name,
      params: { peopleKey: person.key },
      crumbs: ["People", person.name],
    });
    setQuery("");
    setFocused(false);
  };
  return (
    <div className="quick-search" ref={rootRef}>
      <Search size={16} />
      <input
        value={query}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setFocused(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (suggestions[0]?.name.toLowerCase() === normalized) openPerson(suggestions[0]);
            else runSearch();
          }
          if (event.key === "Escape") setFocused(false);
        }}
        placeholder="Search photos and videos…"
        aria-label="Search Anthora"
      />
      <button
        title="Advanced search"
        onClick={() => {
          setFocused(false);
          openAdvanced(query);
        }}
      ><SlidersHorizontal size={15} /></button>
      {focused && normalized && (
        <div className="quick-search-results">
          {suggestions.map((person) => (
            <button key={person.key} onClick={() => openPerson(person)}>
              <span>{person.name}<small>{number.format(person.itemCount)} media</small></span>
              <strong>Person</strong>
            </button>
          ))}
          <button className="create-result" onClick={runSearch}>
            <Sparkles size={16} />
            <span>Search for “{query.trim()}”<small>Search concepts, appearance, places, objects, and filenames</small></span>
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function OperationStatus({ operation, navigate, onDismiss }) {
  const reviewed = operation.completedUnits + operation.failedUnits;
  const progress = operation.totalUnits
    ? Math.min(100, (reviewed / operation.totalUnits) * 100)
    : 0;
  const working = ["queued", "running"].includes(operation.status);
  const needsAttention = ["failed", "completed_with_errors"].includes(operation.status);
  const purgingTrash = operation.kind === "purgeTrash";
  const review = () => {
    onDismiss();
    navigate(
      purgingTrash
        ? {
            kind: "media",
            title: "Recently Deleted",
            params: { trash: "1" },
            crumbs: ["Library Care", "Recently Deleted"],
          }
        : {
            kind: "duplicates",
            duplicateCategory: "exact",
            title: "Exact Copies · Needs Attention",
            crumbs: ["Library Care", "Exact Copies", "Needs Attention"],
          },
    );
  };
  const title = purgingTrash
    ? working
      ? "Emptying Recently Deleted"
      : operation.status === "completed"
        ? "Recently Deleted is empty"
        : "Permanent deletion needs attention"
    : working
      ? "Keeping recommended copies"
      : operation.status === "completed"
        ? "Exact-copy care complete"
        : "Exact-copy care needs attention";
  return (
    <section className={`operation-status ${working ? "working" : operation.status}`} role="status" aria-live="polite">
      <details className="operation-details"><summary><span>{title}</span><span>{Math.round(progress)}%</span></summary>
      <button className="operation-main" type="button" disabled={!needsAttention} onClick={needsAttention ? review : undefined}>
        <div>
          <strong>{title}</strong>
          <span>
            {number.format(reviewed)} of {number.format(operation.totalUnits)} {purgingTrash ? "items" : "groups"}
            {operation.failedUnits ? ` · ${number.format(operation.failedUnits)} need review` : ""}
            {!purgingTrash && operation.processedItems ? ` · ${number.format(operation.processedItems)} copies consolidated` : ""}
            {operation.estimatedBytes ? ` · ${formatBytes(operation.estimatedBytes)} ${purgingTrash ? "reclaimed" : "saved"}` : ""}
          </span>
        </div>
        {needsAttention && <span className="operation-review">{purgingTrash ? "Review remaining items" : "Review exact copies"} <ChevronRight size={14} /></span>}
      </button>
      </details>
      {!working && (
        <button
          className="operation-dismiss"
          type="button"
          aria-label="Dismiss operation status"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      )}
      <div className="operation-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
    </section>
  );
}

function CareIndexProgress({ status, duplicateOnly = false }) {
  if (!status) return null;
  if (status.error) {
    return (
      <div className="video-index-progress care-index-progress" role="status" aria-live="polite">
        <strong>Care analysis status is temporarily unavailable. Results may be incomplete.</strong>
      </div>
    );
  }
  const overall = duplicateOnly ? status.duplicates : status.care;
  const checks = status.checks || {};
  const detail = [
    ["Byte-for-byte", checks.exact],
    ["Visual", checks.visual],
    ["AI similarity", checks.semantic],
    ["Video", checks.video],
    ...(!duplicateOnly ? [["Quality", checks.quality]] : []),
  ].filter(([, value]) => value);
  const label = duplicateOnly ? "Duplicate analysis" : "Library Care analysis";
  return (
    <details className="quiet-details care-analysis-details">
      <summary>{overall.current ? "Analysis up to date" : "Analysis in progress"}</summary>
      <div>
        <strong>{overall.current ? `${label} is current` : `${label} in progress`}</strong>
        <span>{number.format(overall.analyzed)} of {number.format(overall.total)} checks</span>
      </div>
      <progress max={overall.total || 1} value={overall.analyzed || 0} />
      <div className="care-index-details" aria-label="Analysis progress by type">
        {detail.map(([name, value]) => (
          <span key={name}>{name} {number.format(value.analyzed)}/{number.format(value.total)}</span>
        ))}
      </div>
      <small>
        {overall.current
          ? "Every eligible current file has been checked. Zero-result categories are current."
          : `${number.format(overall.remaining)} checks remain. Progress updates automatically, and zero-result categories may still change.`}
      </small>
    </details>
  );
}

function OrganizationView({ navigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filterText, setFilterText] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    api("/api/organization/suggestions?limit=200")
      .then(setData)
      .catch((requestError) => setError(requestError.message));
  }, []);
  useEffect(() => {
    if (!pendingAction) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setPendingAction(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pendingAction]);
  const normalized = filterText.trim().toLowerCase();
  const suggestions = (data?.suggestions || []).filter(
    (suggestion) =>
      !normalized ||
      suggestion.personName.toLowerCase().includes(normalized) ||
      suggestion.name.toLowerCase().includes(normalized),
  );
  const openPerson = (suggestion) =>
    navigate({
      kind: "media",
      title: suggestion.personName,
      params: { person: suggestion.personKey },
      crumbs: ["People", suggestion.personName],
    });
  const applyDecision = async () => {
    if (!pendingAction || busy) return;
    const { suggestion, action } = pendingAction;
    const previous = data;
    setBusy(true);
    setError("");
    setPendingAction(null);
    setData((current) => ({
      ...current,
      total: Math.max(0, (current?.total || 1) - 1),
      suggestions: (current?.suggestions || []).filter(
        (item) => item.id !== suggestion.id || item.personKey !== suggestion.personKey,
      ),
    }));
    try {
      await api(`/api/organization/suggestions/${suggestion.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personKey: suggestion.personKey, action }),
      });
      setMessage(
        action === "associate"
          ? `${suggestion.name} now appears in ${suggestion.personName}. The file stayed in its original folder.`
          : `Suggestion dismissed. The file and its existing profile associations were not changed.`,
      );
    } catch (requestError) {
      setData(previous);
      setError(`Anthora could not save that choice. ${requestError.message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageTitle
        title="Profile Suggestions"
        subtitle="Anthora compares recognized people with existing profile associations. Suggestions never move originals automatically."
      />
      {message && <div className="gallery-action-status success">{message}</div>}
      <div className="organization-intro">
        <div>
          <strong>{number.format(data?.total || 0)} possible associations</strong>
          <span>Review the person Anthora recognized and the media together.</span>
        </div>
        <label className="live-filter">
          <Search size={16} />
          <input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="Filter people or files…"
          />
          {filterText && <button onClick={() => setFilterText("")}><X size={14} /></button>}
        </label>
      </div>
      {error && <div className="notice">{error}</div>}
      {!data && !error && <div className="notice-neutral">Finding profile suggestions…</div>}
      {data && !suggestions.length && (
        <div className="notice-neutral">
          {normalized
            ? "No suggestions match this filter."
            : "Everything Anthora recognizes is already associated with the expected profile."}
        </div>
      )}
      <div className="organization-grid">
        {suggestions.map((suggestion) => (
          <article className="organization-card" key={`${suggestion.id}-${suggestion.personKey}`}>
            <button className="organization-preview" onClick={() => openPerson(suggestion)}>
              <img src={`${suggestion.thumbnailUrl}?size=500`} loading="lazy" />
            </button>
            <div>
              <span className="eyebrow">{suggestion.confidence === "confirmed" ? "Confirmed identity" : "Recognized person"}</span>
              <h2>{suggestion.personName}</h2>
              <p>{suggestion.name}</p>
              <div className="organization-actions">
                <button onClick={() => openPerson(suggestion)}>Review together</button>
                <button
                  className="organization-associate"
                  disabled={busy}
                  onClick={() => setPendingAction({ suggestion, action: "associate" })}
                >
                  Add to profile
                </button>
                <button
                  className="organization-dismiss"
                  disabled={busy}
                  onClick={() => setPendingAction({ suggestion, action: "dismiss" })}
                >
                  Not this person
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {data?.total > suggestions.length && (
        <p className="organization-limit">
          Showing the first {number.format(data.suggestions.length)} suggestions. Refine the filter or review these first.
        </p>
      )}
      {pendingAction && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && setPendingAction(null)}
        >
          <section className="source-dialog organization-dialog" role="dialog" aria-modal="true">
            <div className="eyebrow">
              {pendingAction.action === "associate" ? "Add profile association" : "Dismiss suggestion"}
            </div>
            <h2>
              {pendingAction.action === "associate"
                ? `Show this in ${pendingAction.suggestion.personName}?`
                : `This is not ${pendingAction.suggestion.personName}?`}
            </h2>
            {pendingAction.action === "associate" ? (
              <>
                <p>This changes how Anthora organizes the item, not where the file is stored.</p>
                <ul className="organization-effects">
                  <li>It will appear when you open {pendingAction.suggestion.personName}.</li>
                  <li>The original file stays in its current folder.</li>
                  <li>No copy, symlink, rename, or filesystem move is created.</li>
                  <li>The same item can still belong to another person too.</li>
                </ul>
              </>
            ) : (
              <>
                <p>Anthora will stop suggesting this person for this item.</p>
                <ul className="organization-effects">
                  <li>The file stays exactly where it is.</li>
                  <li>Existing profile associations are not changed.</li>
                  <li>This does not delete the media or retrain the face model.</li>
                </ul>
              </>
            )}
            <div className="source-dialog-actions">
              <button onClick={() => setPendingAction(null)}>Cancel</button>
              <button className="primary" onClick={applyDecision}>
                {pendingAction.action === "associate" ? "Add to profile" : "Dismiss suggestion"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SpaceImpactView({ navigate }) {
  const [impact, setImpact] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api("/api/cleanup/impact").then(setImpact).catch((requestError) => setError(requestError.message));
  }, []);
  const definitions = {
    exactDuplicates: ["Exact duplicates", "Byte-for-byte copies", { kind: "duplicates", duplicateCategory: "exact" }],
    lowQuality: ["Low-quality captures", "Conservative quality signals", { kind: "media", title: "Low-Quality Captures", params: { type: "image", ai: "lowQuality", cleanup: "1", sort: "largest" } }],
    accidentalVideo: ["Possible accidental videos", "Short, static, or nearly blank clips", { kind: "media", title: "Possible Accidental Videos", params: { type: "video", ai: "accidentalVideo", cleanup: "1", sort: "largest" } }],
    downloadedClutter: ["Screenshots", "Captured screens only", { kind: "media", title: "Screenshots", params: { type: "image", ai: "downloadedClutter", cleanup: "1", sort: "largest" } }],
    reviewRemovals: ["Disliked", "Items waiting for a final delete decision", { kind: "media", title: "Disliked", params: { disposition: "remove" } }],
    recentlyDeleted: ["Recently Deleted", "Still recoverable for 30 days", { kind: "media", title: "Recently Deleted", params: { trash: "1" } }],
  };
  const rows = impact
    ? Object.entries(impact.profiles)
        .filter(([key]) => definitions[key])
        .sort((left, right) => right[1].bytes - left[1].bytes)
    : [];
  return (
    <div className="page">
      <PageTitle
        title="Space Impact"
        subtitle="Potential bytes are ranked by queue. Categories can overlap, and nothing is removed automatically."
      />
      {error && <div className="notice">{error}</div>}
      {!impact && !error && (
        <div className="notice-neutral" role="status">Calculating current storage impact…</div>
      )}
      {impact && (
        <div className="impact-index-status">
          Quality index · {number.format(impact.qualityAnalyzed)} of {number.format(impact.qualityTotal)} eligible media
        </div>
      )}
      <div className="impact-list">
        {rows.map(([key, value]) => {
          const [title, description, route] = definitions[key];
          return (
            <button key={key} onClick={() => navigate({ ...route, crumbs: ["Library Care", title] })}>
              <span><strong>{title}</strong><small>{description}</small></span>
              <span><strong>{formatBytes(value.bytes)}</strong><small>{number.format(value.items)} {key === "exactDuplicates" ? "groups" : "items"}</small></span>
              <ChevronRight size={17} />
            </button>
          );
        })}
      </div>
      {impact && <p className="impact-warning">{impact.overlapWarning}</p>}
    </div>
  );
}

function CareQuickSwitcher({ route, navigate }) {
  const destinations = [
    ["Library Care", { kind: "cleanup", title: "Library Care", crumbs: ["Library Care"] }],
    ["Duplicate review", { kind: "duplicates", title: "Duplicate & Similar Media", crumbs: ["Library Care", "Duplicate & Similar Media"] }],
    ["Screenshots", { kind: "media", title: "Screenshots", params: { type: "image", ai: "downloadedClutter", cleanup: "1", sort: "largest" }, crumbs: ["Library Care", "Screenshots"] }],
    ["Low-Quality Captures", { kind: "media", title: "Low-Quality Captures", params: { type: "image", ai: "lowQuality", cleanup: "1", sort: "largest" }, crumbs: ["Library Care", "Low-Quality Captures"] }],
    ["Possible Accidental Videos", { kind: "media", title: "Possible Accidental Videos", params: { type: "video", ai: "accidentalVideo", cleanup: "1", sort: "largest" }, crumbs: ["Library Care", "Possible Accidental Videos"] }],
    ["Deleted Items", { kind: "media", title: "Deleted Items", params: { trash: "1", deletionMode: "deleted" }, crumbs: ["Library Care", "Deleted Items"] }],
  ];
  const currentCrumb = route.crumbs?.[route.crumbs.length - 1];
  const currentIndex = Math.max(0, destinations.findIndex(([, destination]) =>
    destination.title === route.title ||
    (destination.duplicateCategory && destination.duplicateCategory === route.duplicateCategory) ||
    destination.crumbs?.[destination.crumbs.length - 1] === currentCrumb ||
    (destination.kind === "impact" && route.kind === "impact")
  ));
  return (
    <nav className="care-quick-switcher" aria-label="Switch Library Care category">
      <button onClick={()=>navigate(destinations[0][1])}><ArrowLeft size={15}/>Library Care</button>
      <details className="care-switch-options"><summary>Switch view</summary>
      <select
        id="care-category-switcher"
        aria-label="Library Care view"
        value={String(currentIndex)}
        onChange={(event) => navigate(destinations[Number(event.target.value)][1])}
      >
        {destinations.map(([label], index) => <option key={label} value={index}>{label}</option>)}
      </select>
      </details>
    </nav>
  );
}

function PageTitle({ breadcrumbs, title, subtitle, back, action }) {
  return (
    <div className="page-heading">
      {back && (
        <button className="back" onClick={back}>
          <ArrowLeft size={16} /> Back
        </button>
      )}
      {breadcrumbs?.length ? (
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={`${crumb.label}-${index}`}>
              <button onClick={crumb.onClick}>{crumb.label}</button>
              {index < breadcrumbs.length - 1 && <span>/</span>}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      <div className="page-heading-title">
        <h1>{title}</h1>
        {action}
      </div>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

function CollectionsHome({ navigate, showRows, defaultMediaSort, defaultPeopleSort }) {
  const [libraries, setLibraries] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [revision, setRevision] = useState(0);
  const addingRef = useRef(false);
  const summary = librarySummary(libraries);
  const sources = () => navigate({ kind: "sources", title: "Sources", crumbs: ["Sources"] });
  const allPhotos = () => navigate({ kind: "media", title: "All Media", params: { sort: defaultMediaSort, defaultSortApplied: "1" }, crumbs: ["All Media"] });
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function refresh() {
      let scanning = false;
      try {
        const data = await api("/api/libraries", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setLibraries(data.libraries);
        scanning = librarySummary(data.libraries).scanning > 0;
        setError("");
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e.message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          // Discover changes made by the scanner and newly connected drives.
          // Requests never overlap and are cancelled when leaving the home.
          timer = window.setTimeout(refresh, !document.hidden && scanning ? 5000 : 30000);
        }
      }
    }
    refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [revision]);
  const chooseFolder = async () => {
    if (addingRef.current) return;
    if (!window.anthoraNative?.chooseFolder) return sources();
    addingRef.current = true;
    setAdding(true);
    setError("");
    try {
      const result = await connectChosenFolder(() => window.anthoraNative.chooseFolder(), api);
      if (result) {
        setLibraries((current) => [...current.filter((item) => item.id !== result.library.id), result.library]);
        setRevision((value) => value + 1);
      }
    } catch (e) {
      setError(e.message || "The folder could not be added. Try again.");
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };
  const addButton = <button className="source-add" disabled={adding} onClick={chooseFolder}><FolderPlus size={17} />{adding ? "Opening folder…" : "Add folder"}</button>;
  if (loading) return <div className="page home" role="status"><PageTitle title="Your library" subtitle="Opening your collections…" /><div className="home-loading" /></div>;
  if (libraries.length === 0) {
    return (
      <div className="page welcome-home">
        <section className="welcome-intro">
          <img className="welcome-icon" src={anthoraMonogram} alt="" />
          <h1>Your photos.<br />Right where you left them.</h1>
          <p>Bring folders from your Mac and drives into one place to browse, search, and make photo books. Your originals stay where they are.</p>
          <button className="first-run-primary" disabled={adding} onClick={chooseFolder}>
            <FolderPlus size={18} />{adding ? "Opening folder…" : "Choose a photo folder"}
          </button>
          <span className="welcome-note">Unlimited browsing. No account needed.</span>
        </section>
        {error && <div className="home-status home-error" role="alert"><FileWarning size={18} /><span>{error}</span><button onClick={() => setRevision((n) => n + 1)}>Try again</button></div>}
        <section className="welcome-features" aria-label="What you can do">
          <article><ImageIcon size={22} /><h2>See it all together</h2><p>Photos and videos across your folders, without importing another copy.</p></article>
          <article><Heart size={22} /><h2>Find the ones that matter</h2><p>Browse people, mark favorites, and save searches you come back to.</p></article>
          <article><Bookmark size={22} /><h2>Try a photo book</h2><p>Make a photo book, save it, and export a PDF. All free.</p><button onClick={() => navigate({ kind: "books", title: "Books", crumbs: ["Books"] })}>Explore book designs <ChevronRight size={15} /></button></article>
        </section>
      </div>
    );
  }
  return (
    <div className="page home library-home">
      <PageTitle title="Your library" action={addButton}
        subtitle={`${number.format(summary.photos)} photos · ${number.format(summary.videos)} videos · ${libraries.length} ${libraries.length === 1 ? "source" : "sources"}`} />
      {error && <div className="home-status home-error" role="alert"><FileWarning size={18} /><span>{error}</span><button onClick={() => setRevision((n) => n + 1)}>Try again</button></div>}
      {summary.scanning > 0 && <div className="home-status" role="status"><RefreshCw size={18} /><span><strong>Adding your photos</strong> · {number.format(summary.items)} items found so far. You can browse while Anthora continues.</span><button onClick={sources}>View progress</button></div>}
      {(summary.offline > 0 || summary.failed > 0 || summary.missing > 0) && <div className="home-status"><HardDrive size={18} /><span>{summary.offline > 0 ? `${summary.offline} ${summary.offline === 1 ? "source is" : "sources are"} disconnected. Reconnect the drive to open its originals.` : "Some files need attention. Check your sources for details."}</span><button onClick={sources}>Check sources</button></div>}
      {!summary.scanning && summary.items === 0 && <div className="home-status"><ImageIcon size={18} /><span>No photos found yet. Check that your folder contains supported photos or videos.</span><button onClick={sources}>Check folder</button></div>}
      <div className="home-actions" aria-label="Start with your photos">
        <button onClick={allPhotos}><ImageIcon size={23} /><strong>Browse everything</strong><span>Your photos and videos, together.</span><ChevronRight size={17} /></button>
        <button onClick={() => navigate({ kind: "books", title: "Books", crumbs: ["Books"] })}><Bookmark size={23} /><strong>Make a photo book</strong><span>Start with a design. Make it yours.</span><ChevronRight size={17} /></button>
        <button onClick={() => navigate({ kind: "cleanup", title: "Library Care", crumbs: ["Library Care"] })}><Stethoscope size={23} /><strong>Review your library</strong><span>Compare duplicates before deciding.</span><ChevronRight size={17} /></button>
      </div>
      <div className="section-title home-collections-title"><h2>Collections</h2><button onClick={() => navigate({ kind: "people", title: "People", peopleSort: defaultPeopleSort, defaultPeopleSortApplied: "1", crumbs: ["Collections", "People"] })}><UserRound size={16} /> Browse people <ChevronRight size={15} /></button></div>
      <div className="collection-grid">
        {libraries.map((library) => (
          <CollectionCard
            key={library.id}
            item={library}
            onClick={() =>
              library.name === "Social Archive"
                ? navigate({
                    kind: "people",
                    title: "Social Archive",
                    peopleScope: "social",
                    peopleSort: defaultPeopleSort,
                    defaultPeopleSortApplied: "1",
                    crumbs: ["Social Archive"],
                  })
                : navigate({
                    kind: library.folderCount === 0 && library.rootFolderId ? "media" : "folders",
                    libraryId: library.id,
                    parentId: library.rootFolderId || null,
                    title: library.name,
                    params: library.folderCount === 0 && library.rootFolderId
                      ? { folderId: String(library.rootFolderId) }
                      : undefined,
                    crumbs: [library.name],
                    stack: [],
                    isLibraryRoot: true,
                  })
            }
          />
        ))}
      </div>
      {showRows && (
        <>
          <MediaRail
            title="Recently added"
            params={{ type: "image", sort: "newest" }}
            navigate={navigate}
          />
          <MediaRail
            title="Favorites"
            params={{ favorite: "1" }}
            navigate={navigate}
          />
        </>
      )}
    </div>
  );
}

function SourcesView({ navigate, defaultPeopleSort, nativeLibraryState, nativeLibraryError, createNativeLibrary, openNativeLibrary }) {
  const [libraries, setLibraries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [message, setMessage] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [pendingRemove, setPendingRemove] = useState(null);
  const [pendingEdit, setPendingEdit] = useState(null);
  const [editName, setEditName] = useState("");
  const [folderDrag, setFolderDrag] = useState(false);
  const [dropError, setDropError] = useState("");
  const dropInProgress = useRef(false);
  const canDropFolders = Boolean(window.anthoraNative?.readDroppedFolders);
  const hasFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const dropFolders = async (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setFolderDrag(false);
    if (!event.nativeEvent.isTrusted || !canDropFolders || busy || dropInProgress.current) return;
    dropInProgress.current = true;
    setBusy("drop");
    setDropError("");
    setMessage("");
    try {
      const folders = await window.anthoraNative.readDroppedFolders();
      const current = await api("/api/libraries");
      const result = await connectDroppedSources(folders, current.libraries, (folder) =>
        api("/api/libraries", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(folder),
        }));
      const notes = [];
      if (result.added) notes.push(`${result.added} ${result.added === 1 ? "folder connected" : "folders connected"}. Scanning now.`);
      if (result.skipped) notes.push(`${result.skipped} already connected.`);
      setMessage(notes.join(" "));
      setDropError(result.errors.join(" "));
      await refresh();
    } catch (error) {
      setDropError(error.message || "The folders could not be connected. Try Add folder instead.");
    } finally {
      dropInProgress.current = false;
      setBusy("");
    }
  };

  const refresh = () =>
    api("/api/libraries")
      .then((data) => {
        setLibraries(data.libraries);
        setError("");
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, []);
  const saveSource = async (sourcePath, sourceName) => {
    setBusy("add");
    setDialogError("");
    try {
      const result = await api("/api/libraries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourcePath, name: sourceName }),
      });
      setMessage(`${result.library.name} was added. Anthora is scanning it now.`);
      setPath("");
      setName("");
      setAddOpen(false);
      refresh();
    } catch (requestError) {
      setDialogError(requestError.message);
    } finally {
      setBusy("");
    }
  };
  const addSource = async (event) => {
    event.preventDefault();
    await saveSource(path, name);
  };
  const chooseSource = async () => {
    setDialogError("");
    if (window.anthoraNative?.chooseFolder) {
      try {
        const folder = await window.anthoraNative.chooseFolder();
        if (folder?.path) await saveSource(folder.path, folder.name || "");
      } catch (requestError) {
        setError(requestError.message || "The folder picker could not open.");
      }
      return;
    }
    setAddOpen(true);
  };
  const rescan = async (library) => {
    setBusy(`scan-${library.id}`);
    setError("");
    try {
      await api(`/api/libraries/${library.id}/scan`, { method: "POST" });
      setMessage(`${library.name} is being rescanned.`);
      refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  };
  const cancelScan = async (library) => {
    setBusy(`cancel-${library.id}`);
    setError("");
    try {
      await api(`/api/libraries/${library.id}/scan/cancel`, { method: "POST" });
      setMessage(`Stopping the scan of ${library.name}. Media already found will stay indexed.`);
      refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  };
  const remove = async () => {
    if (!pendingRemove) return;
    setBusy(`remove-${pendingRemove.id}`);
    setError("");
    try {
      await api(`/api/libraries/${pendingRemove.id}/remove`, { method: "POST" });
      setMessage(`${pendingRemove.name} was removed from Anthora. Its files were not changed.`);
      setPendingRemove(null);
      refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  };
  const beginEdit = (library) => {
    setPendingEdit(library);
    setEditName(library.name);
    setDialogError("");
  };
  const editSource = async (event) => {
    event.preventDefault();
    if (!pendingEdit) return;
    setBusy(`edit-${pendingEdit.id}`);
    setDialogError("");
    try {
      const result = await api(`/api/libraries/${pendingEdit.id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName }),
      });
      setMessage(`${result.library.name} was updated.`);
      setPendingEdit(null);
      refresh();
    } catch (requestError) {
      setDialogError(requestError.message);
    } finally {
      setBusy("");
    }
  };
  const openLibrary = (library) =>
    library.name === "Social Archive"
      ? navigate({
          kind: "people",
          title: "Social Archive",
          peopleScope: "social",
          peopleSort: defaultPeopleSort,
          defaultPeopleSortApplied: "1",
          crumbs: ["Social Archive"],
        })
      : navigate({
          kind: library.folderCount === 0 && library.rootFolderId ? "media" : "folders",
          libraryId: library.id,
          parentId: library.rootFolderId || null,
          title: library.name,
          params: library.folderCount === 0 && library.rootFolderId
            ? { folderId: String(library.rootFolderId) }
            : undefined,
          crumbs: [library.name],
          stack: [],
          isLibraryRoot: true,
        });
  const revealLibrary = async (library) => {
    try {
      await window.anthoraNative?.revealPath?.(library.rootPath);
    } catch (requestError) {
      setError(requestError.message || "The folder could not be revealed in Finder.");
    }
  };
  return (
    <div className={`page sources-page ${folderDrag ? "is-folder-drag" : ""}`}
      onDragEnter={(event) => {
        if (!hasFileDrag(event)) return;
        event.preventDefault();
        setFolderDrag(canDropFolders && !busy);
      }}
      onDragOver={(event) => {
        if (!hasFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = canDropFolders && !busy ? "copy" : "none";
        setFolderDrag(canDropFolders && !busy);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFolderDrag(false);
      }}
      onDrop={dropFolders}
    >
      <PageTitle
        title="Sources"
        subtitle="The folders in your library. Your originals stay where they are."
      />
      {nativeLibraryState && (
        <section className="library-manager">
          <div>
            <small>Current library</small>
            <strong>{nativeLibraryState.libraries.find((item) => item.id === nativeLibraryState.activeLibraryId)?.name}</strong>
            <span>Its sources, people, searches, and cleanup history are kept separate.</span>
          </div>
          <div>
            <button onClick={createNativeLibrary}>New library</button>
            <button onClick={openNativeLibrary}>Open library…</button>
          </div>
        </section>
      )}
      {nativeLibraryError && <div className="notice">{nativeLibraryError}</div>}
      <div className="sources-toolbar">
        <button className="source-add" disabled={Boolean(busy)} onClick={chooseSource}>
          <FolderPlus size={16} /> Add folder
        </button>
      </div>
      {canDropFolders && <button className="source-drop-zone" disabled={Boolean(busy)} onClick={chooseSource}>
        <FolderPlus size={26} />
        <span><strong>{busy === "drop" ? "Connecting folders…" : "Drop folders here"}</strong>
        <small>Drag from Finder, or click to choose. Photos and videos stay in their original folders.</small></span>
      </button>}
      {dropError && <div className="notice" role="alert">{dropError}</div>}
      {error && <div className="notice">{error}</div>}
      {message && <div className="gallery-action-status success" role="status">{message}</div>}
      {loading ? (
        <div className="source-list"><div className="source-card source-loading" /></div>
      ) : libraries.length ? (
        <div className="source-list">
          {libraries.map((library) => {
            const scanning = ["queued", "scanning"].includes(library.scanStatus);
            const queued = library.scanStatus === "queued";
            const status = !library.available
              ? "Unavailable"
              : scanning
                ? "Scanning"
                : library.scanStatus === "error"
                  ? "Needs attention"
                  : "Connected";
            return (
              <article className="source-card" key={library.id}>
                <div className="source-card-head">
                  <span className="source-icon"><HardDrive size={19} /></span>
                  <div>
                    <h2>{library.name}</h2>
                    <p className="source-count">{number.format(library.imageCount)} photos · {number.format(library.videoCount)} videos</p>
                  </div>
                  <span className={`source-status ${status.toLowerCase().replace(" ", "-")}`}>
                    {scanning && <RefreshCw size={11} />} {status}
                  </span>
                </div>
                <button className="source-open-primary" onClick={() => openLibrary(library)}><ImageIcon size={16}/> Open photos <ChevronRight size={16}/></button>
                {scanning && <p className="source-scan-status">{queued ? "Waiting to scan…" : `${number.format(library.scanItemsIndexed)} items found…`}</p>}
                <details className="quiet-details source-manage"><summary>Folder details{library.missingCount ? " · Some files unavailable" : ""}</summary>
                <code className="source-path">{library.rootPath}</code>
                <div className="source-metrics">
                  <span><strong>{number.format(library.itemCount)}</strong><small>Media</small></span>
                  <span><strong>{number.format(library.imageCount)}</strong><small>Images</small></span>
                  <span><strong>{number.format(library.videoCount)}</strong><small>Videos</small></span>
                  <span><strong>{formatBytes(library.totalBytes)}</strong><small>Storage</small></span>
                  <span><strong>{number.format(library.folderCount)}</strong><small>Folders</small></span>
                </div>
                <div className="source-foot">
                  <span>
                    {queued
                      ? "Waiting to scan. Media will appear as it is found."
                      : scanning
                        ? `${number.format(library.scanItemsIndexed)} indexed so far. New media appears as it is found.`
                      : `Last scanned ${formatDate(library.lastScannedAt)}`}
                    {library.missingCount ? ` · ${number.format(library.missingCount)} missing` : ""}
                  </span>
                  <div>
                    {window.anthoraNative?.revealPath && (
                      <button onClick={() => revealLibrary(library)}><Folder size={13} /> Reveal in Finder</button>
                    )}
                    {scanning ? (
                      <button disabled={Boolean(busy)} onClick={() => cancelScan(library)}>
                        <X size={13} /> Stop scan
                      </button>
                    ) : (
                      <button disabled={Boolean(busy)} onClick={() => rescan(library)}>
                        <RefreshCw size={13} /> Rescan
                      </button>
                    )}
                    <button disabled={Boolean(busy)} onClick={() => beginEdit(library)}>
                      Edit
                    </button>
                    <button className="danger" disabled={scanning || Boolean(busy)} onClick={() => setPendingRemove(library)}>
                      Remove
                    </button>
                  </div>
                </div>
                </details>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="source-empty">
          <HardDrive size={24} />
          <h2>No folders connected</h2>
          <p>Add a folder available to the Mac running Anthora.</p>
          <button onClick={chooseSource}>Add your first folder</button>
        </div>
      )}
      {addOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setAddOpen(false)}>
          <form className="source-dialog" onSubmit={addSource}>
            <div className="settings-head">
              <div><div className="eyebrow">Connect storage</div><h2>Add a folder</h2></div>
              <button type="button" className="icon-button" onClick={() => setAddOpen(false)}><X size={17} /></button>
            </div>
            <p>Choose a folder path on this Mac, an external drive, or a mounted network share.</p>
            {dialogError && <div className="notice">{dialogError}</div>}
            <label>Folder path<input required autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Volumes/Media/Photos" /></label>
            <label>Display name <small>Optional</small><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Family Photos" /></label>
            <div className="source-dialog-note">Anthora indexes the folder in place. Your files stay where they are.</div>
            <div className="source-dialog-actions">
              <button type="button" onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="primary" disabled={busy === "add"}>{busy === "add" ? "Connecting…" : "Add folder"}</button>
            </div>
          </form>
        </div>
      )}
      {pendingRemove && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPendingRemove(null)}>
          <section className="source-dialog source-remove-dialog">
            <div className="eyebrow">Remove source</div>
            <h2>Stop watching {pendingRemove.name}?</h2>
            <p>Its files will remain untouched. Anthora will remove this source’s index, analysis, favorites, and folder associations.</p>
            <code>{pendingRemove.rootPath}</code>
            <div className="source-dialog-actions">
              <button onClick={() => setPendingRemove(null)}>Cancel</button>
              <button className="danger" disabled={busy === `remove-${pendingRemove.id}`} onClick={remove}>Remove from Anthora</button>
            </div>
          </section>
        </div>
      )}
      {pendingEdit && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPendingEdit(null)}>
          <form className="source-dialog" onSubmit={editSource}>
            <div className="settings-head">
              <div><div className="eyebrow">Edit source</div><h2>{pendingEdit.name}</h2></div>
              <button type="button" className="icon-button" onClick={() => setPendingEdit(null)}><X size={17} /></button>
            </div>
            {dialogError && <div className="notice">{dialogError}</div>}
            <label>Display name<input required autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
            <label>Folder path<input value={pendingEdit.rootPath} readOnly /></label>
            <div className="source-dialog-note">To use a different folder, add it as a new source. Anthora will not silently repoint an existing index.</div>
            <div className="source-dialog-actions">
              <button type="button" onClick={() => setPendingEdit(null)}>Cancel</button>
              <button className="primary" disabled={busy === `edit-${pendingEdit.id}`}>{busy ? "Saving…" : "Save changes"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function CollectionCard({ item, onClick, preloadAhead = false }) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverRequested, setCoverRequested] = useState(!preloadAhead);
  const coverRef = useRef(null);
  useEffect(() => {
    setCoverFailed(false);
    setCoverRequested(!preloadAhead);
  }, [item.coverUrl, preloadAhead]);
  useEffect(() => {
    if (!preloadAhead || coverRequested || !item.coverUrl) return undefined;
    const target = coverRef.current;
    if (!target || !("IntersectionObserver" in window)) {
      setCoverRequested(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setCoverRequested(true);
      observer.disconnect();
    }, { rootMargin: "2400px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [coverRequested, item.coverUrl, preloadAhead]);
  const faceBox = item.coverFaceBox;
  const faceStyle = faceBox?.length === 4
    ? {
        "--cover-face-x": `${(faceBox[0] + faceBox[2] / 2) * 100}%`,
        "--cover-face-y": `${(1 - faceBox[1] - faceBox[3] / 2) * 100}%`,
        "--cover-face-scale": Math.min(
          3.2,
          Math.max(1.35, 0.5 / Math.max(faceBox[2], faceBox[3])),
        ),
      }
    : undefined;
  return (
    <button className="collection-card" onClick={onClick}>
      <span ref={coverRef} className={`cover ${faceStyle ? "face-focused" : ""}`} style={faceStyle}>
        {item.coverUrl && coverRequested && !coverFailed ? (
          <img
            src={item.coverUrl}
            loading={preloadAhead ? "eager" : "lazy"}
            decoding="async"
            onError={() => setCoverFailed(true)}
          />
        ) : item.coverUrl && !coverRequested ? (
          <span className="cover-placeholder cover-pending" />
        ) : (
          <span className="cover-placeholder">
            <Folder size={28} />
          </span>
        )}
        <span className="cover-shade" />
      </span>
      <span className="collection-meta">
        <strong>{item.name}</strong>
        <small>
          {item.subtitle || `${number.format(item.itemCount)} items`}
        </small>
      </span>
    </button>
  );
}

function PeopleView({ route, navigate }) {
  const { promptAction } = useDialog();
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [faceStatus, setFaceStatus] = useState(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [selectedPeople, setSelectedPeople] = useState(() => new Set());
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeTargetKey, setMergeTargetKey] = useState("");
  const [renderedPeopleCount, setRenderedPeopleCount] = useState(96);
  const sortMenuRef = useRef(null);
  const peopleGridRef = useRef(null);
  const peopleLoadMoreRef = useRef(null);
  const pendingViewportAnchorRef = useRef(null);
  const endpoint =
    route.peopleScope === "social" ? "/api/people?scope=social" : "/api/people";

  const captureViewportAnchor = (excludedKeys = new Set()) => {
    const cards = [...(peopleGridRef.current?.querySelectorAll("[data-person-key]") || [])];
    const visibleCards = cards.filter((card) => card.getBoundingClientRect().bottom > 78);
    const card = visibleCards.find((candidate) => !excludedKeys.has(candidate.dataset.personKey)) ||
      cards
        .filter((candidate) => !excludedKeys.has(candidate.dataset.personKey))
        .sort((left, right) => (
          Math.abs(left.getBoundingClientRect().top - (visibleCards[0]?.getBoundingClientRect().top || 78)) -
          Math.abs(right.getBoundingClientRect().top - (visibleCards[0]?.getBoundingClientRect().top || 78))
        ))[0] || visibleCards[0];
    if (!card) return null;
    return {
      key: card.dataset.personKey,
      top: card.getBoundingClientRect().top,
    };
  };

  const preserveViewportForNextRender = (excludedKeys) => {
    pendingViewportAnchorRef.current = captureViewportAnchor(excludedKeys);
  };

  useLayoutEffect(() => {
    const anchor = pendingViewportAnchorRef.current;
    if (!anchor) return;
    const card = [...(peopleGridRef.current?.querySelectorAll("[data-person-key]") || [])]
      .find((candidate) => candidate.dataset.personKey === anchor.key);
    pendingViewportAnchorRef.current = null;
    if (!card) return;
    const delta = card.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: "instant" });
  }, [people, mergeMode]);

  const refresh = ({ silent = false, preserveViewport = false } = {}) => {
    if (preserveViewport) preserveViewportForNextRender();
    if (!silent) setLoading(true);
    setError("");
    return api(endpoint)
      .then((data) => {
        setPeople(data.people);
        return data;
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => { if (!silent) setLoading(false); });
  };
  useEffect(() => {
    refresh();
  }, [endpoint]);
  useEffect(() => {
    let active = true;
    const update = () => api("/api/ai/status")
      .then((status) => { if (active) setFaceStatus(status); })
      .catch(() => { if (active) setFaceStatus({ error: true }); });
    update();
    const timer = window.setInterval(update, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const peopleSort = route.peopleSort || "newest";
  const sortedPeople = [...people].sort((left, right) => {
    if (peopleSort === "oldest")
      return (left.newestAt || Number.POSITIVE_INFINITY) -
        (right.newestAt || Number.POSITIVE_INFINITY) ||
        left.name.localeCompare(right.name);
    if (peopleSort === "largest")
      return right.itemCount - left.itemCount || left.name.localeCompare(right.name);
    if (peopleSort === "smallest")
      return left.itemCount - right.itemCount || left.name.localeCompare(right.name);
    if (peopleSort === "name") return left.name.localeCompare(right.name);
    return (right.newestAt || 0) - (left.newestAt || 0) ||
      left.name.localeCompare(right.name);
  });
  const changeSort = (nextSort) => {
    setSortOpen(false);
    const { defaultPeopleSortApplied: _, ...nextRoute } = route;
    navigate({ ...nextRoute, peopleSort: nextSort });
  };
  useEffect(() => {
    if (!sortOpen) return;
    const dismiss = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && sortMenuRef.current?.contains(event.target)) return;
      setSortOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [sortOpen]);
  const rename = async (person) => {
    const displayName = await promptAction({
      title: "Rename person",
      message: "This changes the display name in Anthora without renaming the source folder.",
      value: person.name,
      confirmLabel: "Rename",
    });
    if (!displayName || displayName === person.name) return;
    await api("/api/people/alias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: person.key,
        target: person.key,
        displayName,
      }),
    });
    refresh({ silent: true, preserveViewport: true });
  };
  const toggleMergePerson = (key) => {
    setSelectedPeople((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const cancelMerge = () => {
    preserveViewportForNextRender();
    setMergeMode(false);
    setSelectedPeople(new Set());
    setMergeQuery("");
    setMergeTargetKey("");
  };
  const startMerge = () => {
    preserveViewportForNextRender();
    setMergeMode(true);
  };
  const mergeSelected = async () => {
    const primary = people.find((person) => person.key === mergeTargetKey);
    const chosen = people.filter((person) => selectedPeople.has(person.key) || person.key === mergeTargetKey);
    if (!primary || chosen.length < 2) return;
    const displayName = await promptAction({
      title: `Add to ${primary.name}?`,
      message: `${number.format(chosen.length - 1)} selected ${chosen.length - 1 === 1 ? "group" : "groups"} will become part of ${primary.name}. The original files are not changed.`,
      value: primary.name,
      confirmLabel: `Add to ${primary.name}`,
    });
    if (!displayName) return;
    setError("");
    try {
      preserveViewportForNextRender(new Set(
        chosen.filter((person) => person.key !== primary.key).map((person) => person.key),
      ));
      await api("/api/people/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keys: chosen.map((person) => person.key),
          target: primary.key,
          displayName,
        }),
      });
      const data = await api(endpoint);
      setMergeMode(false);
      setSelectedPeople(new Set());
      setMergeQuery("");
      setMergeTargetKey("");
      setPeople(data.people);
    } catch (requestError) {
      pendingViewportAnchorRef.current = null;
      setError(requestError.message);
    }
  };
  const visiblePeople = sortedPeople.filter((person) =>
    person.name.toLowerCase().includes(filterText.trim().toLowerCase()),
  );
  const normalizedMergeQuery = mergeQuery.trim().toLocaleLowerCase();
  const mergeSuggestions = normalizedMergeQuery
    ? people
      .filter((person) => person.name.toLocaleLowerCase().includes(normalizedMergeQuery))
      .sort((left, right) => {
        const leftStarts = left.name.toLocaleLowerCase().startsWith(normalizedMergeQuery);
        const rightStarts = right.name.toLocaleLowerCase().startsWith(normalizedMergeQuery);
        return Number(rightStarts) - Number(leftStarts) ||
          right.itemCount - left.itemCount ||
          left.name.localeCompare(right.name);
      })
      .slice(0, 6)
    : [];
  const addMergePerson = (person) => {
    setMergeTargetKey(person.key);
    setMergeQuery("");
  };
  const mergeTarget = people.find((person) => person.key === mergeTargetKey);
  const mergeTotal = new Set([...selectedPeople, ...(mergeTargetKey ? [mergeTargetKey] : [])]).size;
  const renderedPeople = visiblePeople.slice(0, renderedPeopleCount);
  useEffect(() => {
    setRenderedPeopleCount(96);
  }, [endpoint, peopleSort, filterText]);
  useEffect(() => {
    const target = peopleLoadMoreRef.current;
    if (!target || renderedPeopleCount >= visiblePeople.length) return undefined;
    if (!("IntersectionObserver" in window)) {
      setRenderedPeopleCount(visiblePeople.length);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setRenderedPeopleCount((current) => Math.min(current + 96, visiblePeople.length));
    }, { rootMargin: "4200px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [renderedPeopleCount, visiblePeople.length]);
  return (
    <div className={`page people-page ${mergeMode ? "people-page-merging" : ""}`}>
      <PageTitle
        title={route.peopleScope === "social" ? "Social Archive" : "People"}
        subtitle={route.peopleScope === "social"
          ? "Browse people found in your Social Archive."
          : "Browse identified people across all your collections."}
      />
      <div className="people-controls">
        <label className="live-filter">
          <Search size={15} />
          <input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="Filter people…"
          />
          {filterText && <button aria-label="Clear filter" onClick={() => setFilterText("")}><X size={14} /></button>}
        </label>
        <div className="gallery-sort" ref={sortMenuRef}>
          <div className="sort-menu">
            <button
              className="sort-trigger"
              type="button"
              aria-haspopup="listbox"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((open) => !open)}
            >
              <SlidersHorizontal size={15} />
              <span className="sort-trigger-copy">
                <small>Sort by</small>
                <strong>{peopleSortOptions.find(([value]) => value === peopleSort)?.[1]}</strong>
              </span>
              <ChevronDown className="sort-chevron" size={14} />
            </button>
            {sortOpen && (
              <div className="sort-options" role="listbox" aria-label="Sort people">
                {peopleSortOptions.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="option"
                    aria-selected={value === peopleSort}
                    className={value === peopleSort ? "selected" : ""}
                    onClick={() => changeSort(value)}
                  >
                    {label}
                    {value === peopleSort && <Check size={13} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          className={`people-merge-toggle ${mergeMode ? "selected" : ""}`}
          type="button"
          onClick={() => {
            if (mergeMode) cancelMerge();
            else startMerge();
          }}
        >
          <Users size={16} />
          {mergeMode ? "Cancel" : "Merge people"}
        </button>
      </div>
      {mergeMode && (
        <div className="people-merge-bar" aria-label="Merge people">
          <div className="people-merge-mobile-head">
            <span>{selectedPeople.size ? `${selectedPeople.size} selected` : "Tap people to select"}</span>
            <button type="button" aria-label="Cancel merging people" onClick={cancelMerge}><X size={18} /></button>
          </div>
          <div className="people-merge-picker">
            <label htmlFor="merge-person-search">
              {selectedPeople.size ? `${selectedPeople.size} selected · add to an existing person` : "Select stray groups, then choose their person"}
            </label>
            {mergeTarget && (
              <div className="people-merge-target">
                <span className="people-merge-avatar">
                  {mergeTarget.coverUrl ? (
                    <img
                      src={mergeTarget.coverUrl}
                      alt=""
                      style={mergeTarget.coverFaceBox?.length === 4 ? {
                        objectPosition: `${(mergeTarget.coverFaceBox[0] + mergeTarget.coverFaceBox[2] / 2) * 100}% ${(1 - mergeTarget.coverFaceBox[1] - mergeTarget.coverFaceBox[3] / 2) * 100}%`,
                        transform: `scale(${Math.min(3.2, Math.max(1.35, 0.5 / Math.max(mergeTarget.coverFaceBox[2], mergeTarget.coverFaceBox[3])))})`,
                        transformOrigin: `${(mergeTarget.coverFaceBox[0] + mergeTarget.coverFaceBox[2] / 2) * 100}% ${(1 - mergeTarget.coverFaceBox[1] - mergeTarget.coverFaceBox[3] / 2) * 100}%`,
                      } : undefined}
                    />
                  ) : <Users size={17} />}
                </span>
                <span><small>Add selected groups to</small><strong>{mergeTarget.name}</strong></span>
                <button type="button" aria-label={`Remove ${mergeTarget.name} as merge target`} onClick={() => setMergeTargetKey("")}><X size={16} /></button>
              </div>
            )}
            <div className="people-merge-search">
              <Search size={16} />
              <input
                id="merge-person-search"
                type="search"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="merge-person-suggestions"
                aria-expanded={Boolean(normalizedMergeQuery)}
                value={mergeQuery}
                onChange={(event) => setMergeQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMergeQuery("");
                  if (event.key === "Enter" && mergeSuggestions.length === 1) {
                    event.preventDefault();
                    addMergePerson(mergeSuggestions[0]);
                  }
                }}
                placeholder={mergeTarget ? "Choose a different person…" : "Search existing people…"}
                autoComplete="off"
              />
              {mergeQuery && (
                <button type="button" className="people-merge-clear" aria-label="Clear people search" onClick={() => setMergeQuery("")}>
                  <X size={15} />
                </button>
              )}
            </div>
            {normalizedMergeQuery && (
              <div className="people-merge-suggestions" id="merge-person-suggestions" role="listbox">
                {mergeSuggestions.length ? mergeSuggestions.map((person) => (
                  <button
                    key={person.key}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => addMergePerson(person)}
                  >
                    <span className="people-merge-avatar">
                      {person.coverUrl ? (
                        <img
                          src={person.coverUrl}
                          alt=""
                          style={person.coverFaceBox?.length === 4 ? {
                            objectPosition: `${(person.coverFaceBox[0] + person.coverFaceBox[2] / 2) * 100}% ${(1 - person.coverFaceBox[1] - person.coverFaceBox[3] / 2) * 100}%`,
                            transform: `scale(${Math.min(3.2, Math.max(1.35, 0.5 / Math.max(person.coverFaceBox[2], person.coverFaceBox[3])))})`,
                            transformOrigin: `${(person.coverFaceBox[0] + person.coverFaceBox[2] / 2) * 100}% ${(1 - person.coverFaceBox[1] - person.coverFaceBox[3] / 2) * 100}%`,
                          } : undefined}
                        />
                      ) : <Users size={17} />}
                    </span>
                    <span>
                      <strong>{person.name}</strong>
                      <small>{number.format(person.itemCount)} {person.itemCount === 1 ? "photo" : "photos"}</small>
                    </span>
                    <span className="people-merge-add">Choose</span>
                  </button>
                )) : (
                  <p>No existing people match “{mergeQuery.trim()}”.</p>
                )}
              </div>
            )}
          </div>
          <button className="people-merge-submit" type="button" disabled={!mergeTarget || mergeTotal < 2} onClick={mergeSelected}>
            {mergeTarget ? `Add to ${mergeTarget.name}` : "Choose person"}
          </button>
        </div>
      )}
      {!mergeMode && (
        <button className="people-mobile-merge-start" type="button" onClick={startMerge}>
          <Users size={18} />
          Select and merge people
        </button>
      )}
      {error && (
        <div className="notice">
          {error}
          <button onClick={refresh}>Try again</button>
        </div>
      )}
      {!loading && !error && people.length === 0 && (
        <section className="people-index-state" role="status" aria-live="polite">
          <span className="people-index-icon"><Users size={22} /></span>
          <div>
            <strong>{faceStatus?.facesRemaining ? "Finding faces" : "No people groups yet"}</strong>
            <p>
              {faceStatus?.facesRemaining
                ? `${number.format(faceStatus.facesAnalyzed || 0)} of ${number.format(faceStatus.facesTotal || 0)} images checked. People will appear as face analysis finishes and matches are confirmed.`
                : faceStatus?.facesDetected
                  ? `${number.format(faceStatus.facesDetected)} faces were found. Anthora has finished face detection, but none have been grouped into named people yet.`
                  : "Anthora has not found any faces it can group into people yet."}
            </p>
            {faceStatus?.facesRemaining > 0 && <progress max={faceStatus.facesTotal || 1} value={faceStatus.facesAnalyzed || 0} />}
          </div>
        </section>
      )}
      {loading ? (
        <SkeletonCards />
      ) : (
        <div className="collection-grid" ref={peopleGridRef}>
          {renderedPeople.map((person) => (
            <div
              className={`person-card ${selectedPeople.has(person.key) ? "merge-selected" : ""}`}
              data-person-key={person.key}
              key={person.key}
            >
              <CollectionCard
                preloadAhead
                item={{
                  ...person,
                  subtitle: person.profileCount
                    ? `${number.format(person.itemCount)} ${person.itemCount === 1 ? "item" : "items"} · ${person.profileCount} ${person.profileCount === 1 ? "profile" : "profiles"}`
                    : `${number.format(person.itemCount)} ${person.itemCount === 1 ? "photo" : "photos"}`,
                }}
                onClick={() => {
                  if (mergeMode) return toggleMergePerson(person.key);
                  navigate({
                    kind: "media",
                    title: person.name,
                    params: { peopleKey: person.key },
                    personKey: person.key,
                    crumbs: [
                      route.peopleScope === "social"
                        ? "Social Archive"
                        : "People",
                      person.name,
                    ],
                    parentRoute: route,
                  });
                }}
              />
              {mergeMode && (
                <button
                  className="person-merge-check"
                  type="button"
                  aria-label={`${selectedPeople.has(person.key) ? "Remove" : "Add"} ${person.name} ${selectedPeople.has(person.key) ? "from" : "to"} merge`}
                  aria-pressed={selectedPeople.has(person.key)}
                  onClick={() => toggleMergePerson(person.key)}
                >
                  {selectedPeople.has(person.key) && <Check size={16} />}
                </button>
              )}
              <div>
                {!mergeMode && <button onClick={() => rename(person)}>Rename</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && renderedPeopleCount < visiblePeople.length && (
        <div className="people-load-more" ref={peopleLoadMoreRef} aria-hidden="true" />
      )}
    </div>
  );
}

function DuplicatesView({ route }) {
  const { confirmAction } = useDialog();
  const [data, setData] = useState(null);
  const [indexStatus, setIndexStatus] = useState(null);
  const [error, setError] = useState("");
  const [actionStatus, setActionStatus] = useState(null);
  const [selectedExactHashes, setSelectedExactHashes] = useState(() => new Set());
  const [category, setCategory] = useStored("anthology.duplicateCategory", "exact");
  const [duplicateSort, setDuplicateSort] = useStored("anthology.duplicateSort", "largest");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [comparison, setComparison] = useState(null);
  const [undoAction, setUndoAction] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [exitingGroupKeys, setExitingGroupKeys] = useState(() => new Set());
  const [exitingItemIds, setExitingItemIds] = useState(() => new Set());
  const duplicateRequest = useRef(0);
  const resultCache = useRef(new Map());
  const pendingGroupKeys = useRef(new Set());
  const exitTimers = useRef(new Map());
  const itemExitTimers = useRef(new Map());
  const pageSize = 12;
  useEffect(() => {
    let active = true;
    const refreshStatus = () => api("/api/care/status")
      .then((nextStatus) => { if (active) setIndexStatus(nextStatus); })
      .catch(() => { if (active) setIndexStatus({ error: true }); });
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    if (route?.duplicateCategory && route.duplicateCategory !== category) {
      duplicateRequest.current += 1;
      setData(null);
      setLoading(true);
      setCategory(route.duplicateCategory);
      setOffset(0);
    }
  }, [route?.duplicateCategory]);
  const refresh = ({ silent = false } = {}) => {
    const request = ++duplicateRequest.current;
    setError("");
    if (!silent) setLoading(true);
    return api(`/api/duplicates?category=${category}&offset=${offset}&limit=${pageSize}&sort=${duplicateSort}`)
      .then((nextData) => {
        if (request === duplicateRequest.current && nextData.category === category) {
          const filtered = removeDuplicateGroupsByKeys(nextData, pendingGroupKeys.current, category);
          resultCache.current.set(`${category}:${offset}:${duplicateSort}`, filtered);
          setData(filtered);
        }
      })
      .catch((requestError) => {
        if (request === duplicateRequest.current) setError(requestError.message);
      })
      .finally(() => {
        if (!silent && request === duplicateRequest.current) setLoading(false);
      });
  };
  useEffect(() => {
    const cached = resultCache.current.get(`${category}:${offset}:${duplicateSort}`);
    if (cached) {
      setData(cached);
      setLoading(false);
    } else {
      refresh();
    }
  }, [category, offset, duplicateSort]);
  useEffect(() => {
    if (data) resultCache.current.set(`${category}:${offset}:${duplicateSort}`, data);
  }, [data, category, offset, duplicateSort]);
  const consolidate = async (group, keep) => {
    const confirmed = await confirmAction({
      title: "Keep this exact copy?",
      message: "Anthora will remove redundant paths from the same profile and preserve links only where the media belongs to another profile.",
      confirmLabel: "Keep this copy",
    });
    if (!confirmed) return;
    const previous = data;
    removeDuplicateGroup(group);
    setError("");
    setActionStatus({ group: group.hash, state: "working", message: "Consolidating exact copies…" });
    try {
      const result = await api("/api/duplicates/consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keepId: keep.id,
          removeIds: group.items.filter((x) => x.id !== keep.id).map((x) => x.id),
        }),
      });
      setActionStatus({
        group: null,
        state: "success",
        message: `Kept the recommended copy, consolidated ${number.format(result.consolidated)} ${result.consolidated === 1 ? "copy" : "copies"}, and saved ${formatBytes(result.estimatedBytes)}.`,
      });
      window.setTimeout(() => refresh({ silent: true }), 280);
    } catch (requestError) {
      setData(previous);
      setError(requestError.message);
      setActionStatus({ group: null, state: "error", message: `Anthora could not confirm the consolidation. ${requestError.message}` });
    }
  };
  const applyExactAction = async (action, { hashes = [], all = false } = {}) => {
    const selectedCount = all ? total : hashes.length;
    if (!selectedCount) return;
    const prompt = action === "trash"
      ? `Delete every copy in ${number.format(selectedCount)} selected exact ${selectedCount === 1 ? "group" : "groups"}? They remain recoverable for 30 days.`
      : all
        ? `Keep Anthora's recommended copy in all ${number.format(total)} exact groups, removing same-profile redundancy while preserving other profile associations?`
        : `Keep Anthora's recommended copy in ${number.format(selectedCount)} selected exact ${selectedCount === 1 ? "group" : "groups"}, removing same-profile redundancy while preserving other profile associations?`;
    if (!await confirmAction({
      title: action === "trash" ? "Delete these exact-copy groups?" : "Keep the recommended copies?",
      message: prompt,
      confirmLabel: action === "trash" ? "Delete copies" : "Keep recommended",
      danger: action === "trash",
    })) return;
    if (!all) {
      setData((current) => removeDuplicateGroupsByHashes(current, new Set(hashes), category));
    }
    setError("");
    setActionStatus({
      group: null,
      state: "working",
      message: action === "trash" ? "Moving exact-copy groups to Recently Deleted…" : "Keeping recommended copies…",
    });
    let completedGroups = 0;
    let affectedItems = 0;
    let estimatedBytes = 0;
    let failedGroups = 0;
    let lastResult = null;
    try {
      if (all) {
        const job = await api("/api/duplicates/exact/job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        setSelectedExactHashes(new Set());
        setActionStatus({
          group: null,
          state: "success",
          message: `${number.format(job.totalGroups)} groups queued. You can keep browsing; progress remains visible throughout Anthora.`,
        });
        return;
      } else {
        for (let index = 0; index < hashes.length; index += 250) {
          lastResult = await api("/api/duplicates/exact/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, hashes: hashes.slice(index, index + 250) }),
          });
          completedGroups += lastResult.groups;
          affectedItems += lastResult.items;
          estimatedBytes += lastResult.estimatedBytes;
          failedGroups += lastResult.failedGroups;
          if (lastResult.failedGroups) break;
        }
      }
      setSelectedExactHashes(new Set());
      setActionStatus({
        group: null,
        state: failedGroups ? "error" : "success",
        message: failedGroups
          ? `${number.format(completedGroups)} groups completed; ${number.format(failedGroups)} need another review.`
          : action === "trash"
            ? `${number.format(completedGroups)} ${completedGroups === 1 ? "group" : "groups"} and ${number.format(affectedItems)} copies moved to Recently Deleted.`
            : `Kept the recommended copy in ${number.format(completedGroups)} ${completedGroups === 1 ? "group" : "groups"}, consolidated ${number.format(affectedItems)} copies, and saved ${formatBytes(estimatedBytes)}.`,
      });
      const remainingGroups = lastResult?.remainingExactGroups ?? 0;
      if (offset && offset >= remainingGroups) setOffset(Math.max(0, offset - pageSize));
      else refresh({ silent: true });
    } catch (requestError) {
      setError(requestError.message);
      setActionStatus({ group: null, state: "error", message: `Anthora could not finish the exact-copy action. ${requestError.message}` });
    }
  };
  const toggleExactGroup = (hash) => {
    setSelectedExactHashes((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };
  const removeDuplicateGroup = (group) => {
    const key = duplicateGroupKey(group);
    setExitingGroupKeys((current) => new Set([...current, key]));
    const existingTimer = exitTimers.current.get(key);
    if (existingTimer) window.clearTimeout(existingTimer);
    const timer = window.setTimeout(() => {
      transitionUpdate(() =>
        setData((current) => removeDuplicateGroupsByKeys(current, new Set([key]), category)),
      );
      setExitingGroupKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      exitTimers.current.delete(key);
    }, 240);
    exitTimers.current.set(key, timer);
  };
  const cancelGroupExit = (group) => {
    const key = duplicateGroupKey(group);
    const timer = exitTimers.current.get(key);
    if (timer) window.clearTimeout(timer);
    exitTimers.current.delete(key);
    setExitingGroupKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };
  const removeDuplicateItemWithTransition = (itemIds) => {
    const ids = new Set(itemIds);
    setExitingItemIds((current) => new Set([...current, ...ids]));
    ids.forEach((id) => {
      const existingTimer = itemExitTimers.current.get(id);
      if (existingTimer) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        transitionUpdate(() =>
          setData((current) => removeDuplicateItems(current, ids, category)),
        );
        setExitingItemIds((current) => {
          const next = new Set(current);
          ids.forEach((itemId) => next.delete(itemId));
          return next;
        });
        ids.forEach((itemId) => itemExitTimers.current.delete(itemId));
      }, 240);
      itemExitTimers.current.set(id, timer);
    });
  };
  const cancelItemExits = (itemIds) => {
    const ids = new Set(itemIds);
    ids.forEach((id) => {
      const timer = itemExitTimers.current.get(id);
      if (timer) window.clearTimeout(timer);
      itemExitTimers.current.delete(id);
    });
    setExitingItemIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };
  useEffect(() => () => {
    exitTimers.current.forEach((timer) => window.clearTimeout(timer));
    itemExitTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);
  useEffect(() => {
    if (!undoAction) return undefined;
    const timer = window.setTimeout(() => setUndoAction(null), 600_000);
    return () => window.clearTimeout(timer);
  }, [undoAction]);
  const offerUndo = (result, group, message, previousData = null) => {
    if (!result?.undoToken) return;
    setUndoAction({
      token: result.undoToken,
      group,
      category,
      message,
      previousData,
    });
  };
  const undoLastAction = async () => {
    if (!undoAction || undoing) return;
    const action = undoAction;
    setUndoing(true);
    setError("");
    try {
      await api("/api/care/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: action.token }),
      });
      if (action.group && action.category === category) {
        cancelGroupExit(action.group);
        pendingGroupKeys.current.delete(duplicateGroupKey(action.group));
        setData((current) => restoreDuplicateGroup(current, action.group, category));
      } else if (action.previousData && action.category === category) {
        setData(action.previousData);
      }
      setUndoAction(null);
      setActionStatus({
        group: null,
        state: "success",
        message: "Action undone. Your previous review choices are restored.",
      });
      refresh({ silent: true });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setUndoing(false);
    }
  };
  const runOptimisticGroupAction = async (group, request, successMessage) => {
    const key = duplicateGroupKey(group);
    pendingGroupKeys.current.add(key);
    removeDuplicateGroup(group);
    setActionStatus({ group: key, state: "saving", message: "Saving your decision in the background…" });
    try {
      const result = await request();
      pendingGroupKeys.current.delete(key);
      setActionStatus({
        group: null,
        state: "success",
        message: typeof successMessage === "function" ? successMessage(result) : successMessage,
      });
      offerUndo(
        result,
        group,
        typeof successMessage === "function" ? successMessage(result) : successMessage,
      );
      window.setTimeout(() => refresh({ silent: true }), 280);
      return result;
    } catch (requestError) {
      pendingGroupKeys.current.delete(key);
      cancelGroupExit(group);
      setData((current) => restoreDuplicateGroup(current, group, category));
      setError(requestError.message);
      setActionStatus({ group: null, state: "error", message: `That decision was restored because Anthora could not save it. ${requestError.message}` });
      return null;
    }
  };
  const keepVersion = async (group, item) => {
    if (item.disposition === "keep") return;
    const previous = data;
    setData((current) => updateDuplicateItem(current, item.id, { disposition: "keep" }));
    setActionStatus({
      group: duplicateGroupKey(group),
      state: "saving",
      message: "Liking this version without resolving the rest of the group…",
    });
    try {
      const result = await api("/api/items/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.id], action: "keep" }),
      });
      const message = `Liked ${item.name || "this version"}. You can like another version or decide what to remove.`;
      setActionStatus({ group: null, state: "success", message });
      offerUndo(result, null, message, previous);
      return result;
    } catch (requestError) {
      setData(previous);
      setError(requestError.message);
      setActionStatus({
        group: null,
        state: "error",
        message: `That Like choice was restored because Anthora could not save it. ${requestError.message}`,
      });
      return null;
    }
  };
  const deleteVersion = async (group, item) => {
    if (!await confirmAction({
      title: "Delete this version?",
      message: "This version will move to Recently Deleted everywhere the same underlying file appears. Other versions in this comparison stay here until you review them.",
      confirmLabel: "Delete version",
      danger: true,
    })) return;
    const previous = data;
    removeDuplicateItemWithTransition([item.id]);
    setActionStatus({
      group: duplicateGroupKey(group),
      state: "saving",
      message: "Deleting this version in the background. Other versions remain undecided.",
    });
    try {
      const result = await api("/api/items/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.id], action: "trash" }),
      });
      const affectedIds = new Set(result.updatedIds || [item.id]);
      removeDuplicateItemWithTransition(affectedIds);
      const message = "Version deleted. The remaining versions are still available for review.";
      setActionStatus({ group: null, state: "success", message });
      offerUndo(result, null, message, previous);
      return result;
    } catch (requestError) {
      cancelItemExits([item.id]);
      setData(previous);
      setError(requestError.message);
      setActionStatus({
        group: null,
        state: "error",
        message: `That version was restored because Anthora could not delete it. ${requestError.message}`,
      });
      return null;
    }
  };
  const dismissGroup = async (group) => {
    return runOptimisticGroupAction(
      group,
      () => api("/api/duplicates/not-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: group.items.map((item) => item.id),
          kind: group.kind,
        }),
      }),
      "Match dismissed.",
    );
  };
  const markOtherVersions = async (group) => {
    const ids = group.items
      .filter((item) => item.id !== group.recommendedId && !item.favorite && item.disposition !== "keep")
      .map((item) => item.id);
    if (!ids.length) return;
    return runOptimisticGroupAction(
      group,
      () => api("/api/duplicates/use-recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keepId: group.recommendedId,
          removeIds: ids,
          kind: group.kind,
        }),
      }),
      `Kept the recommended version and sent ${number.format(ids.length)} alternatives to deletion review.`,
    );
  };
  const keepOnlyVersion = async (group, keep) => {
    const removeIds = group.items.filter((item) => item.id !== keep.id).map((item) => item.id);
    if (!removeIds.length || !await confirmAction({
      title: "Keep this one?",
      message: `Anthora will keep this version and move the other ${number.format(removeIds.length)} ${removeIds.length === 1 ? "version" : "versions"} to Recently Deleted.`,
      confirmLabel: "Keep this one",
    })) return;
    return runOptimisticGroupAction(
      group,
      () => api("/api/duplicates/use-recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keepId: keep.id,
          removeIds,
          kind: group.kind,
          trashOthers: true,
        }),
      }),
      (result) => `Kept this version and moved ${number.format(result.movedToTrash)} ${result.movedToTrash === 1 ? "other version" : "other versions"} to Recently Deleted.`,
    );
  };
  const keepLikedVersions = async (group) => {
    const keepIds = group.items
      .filter((item) => item.disposition === "keep" || item.favorite)
      .map((item) => item.id);
    const keepIdSet = new Set(keepIds);
    const removeIds = group.items
      .filter((item) => !keepIdSet.has(item.id))
      .map((item) => item.id);
    if (!keepIds.length || !removeIds.length || !await confirmAction({
      title: "Keep the liked versions?",
      message: `Anthora will keep ${number.format(keepIds.length)} ${keepIds.length === 1 ? "version" : "versions"} and move the other ${number.format(removeIds.length)} ${removeIds.length === 1 ? "version" : "versions"} to Recently Deleted.`,
      confirmLabel: "Keep liked versions",
    })) return;
    return runOptimisticGroupAction(
      group,
      () => api("/api/duplicates/use-recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keepIds,
          removeIds,
          kind: group.kind,
          trashOthers: true,
        }),
      }),
      (result) => `Kept ${number.format(result.keptIds?.length || keepIds.length)} ${keepIds.length === 1 ? "version" : "versions"} and moved ${number.format(result.movedToTrash)} ${result.movedToTrash === 1 ? "other version" : "other versions"} to Recently Deleted.`,
    );
  };
  const deleteEntireGroup = async (group) => {
    const ids = [...new Set(group.items.map((item) => item.id))];
    if (!ids.length || !await confirmAction({
      title: "Delete every version?",
      message: `All ${number.format(ids.length)} items will disappear now and remain recoverable in Recently Deleted for 30 days.`,
      confirmLabel: "Delete all versions",
      danger: true,
    })) return;
    return runOptimisticGroupAction(
      group,
      () => api("/api/items/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "trash" }),
      }),
      (result) => `${number.format(result.updated)} ${result.updated === 1 ? "item" : "items"} deleted.`,
    );
  };
  const resizedGroups = data?.resizedGroups || data?.similarGroups || [];
  const croppedGroups = data?.croppedGroups || [];
  const groups = data?.page?.groups || (
    category === "exact" ? data?.groups
      : category === "resized" ? resizedGroups
        : category === "cropped" ? croppedGroups
          : []
  ) || [];
  const total = data?.page?.total || groups.length;
  const summary = data?.summary || null;
  const potentialBytes = Object.values(summary || {}).reduce(
    (sum, value) => sum + (value.potentialBytes || 0),
    0,
  );
  const chooseCategory = (nextCategory) => {
    if (nextCategory === category) return;
    duplicateRequest.current += 1;
    const cached = resultCache.current.get(`${nextCategory}:0:${duplicateSort}`) || null;
    setData(cached);
    setOffset(0);
    setActionStatus(null);
    setLoading(!cached);
    setCategory(nextCategory);
  };
  const changePage = (nextOffset) => {
    duplicateRequest.current += 1;
    setData(null);
    setLoading(true);
    setOffset(nextOffset);
  };
  const changeDuplicateSort = (nextSort) => {
    if (nextSort === duplicateSort) return;
    duplicateRequest.current += 1;
    setData(null);
    setOffset(0);
    setLoading(true);
    setDuplicateSort(nextSort);
  };
  return (
    <div className="page calm-duplicates">
      <PageTitle
        title={duplicateCategoryContent[category][0]}
        subtitle={duplicateCategoryContent[category][1]}
      />
      {indexStatus?.semanticAvailable === false && category === "best" && (
        <div className="notice-neutral" role="status">
          Best Shot Review needs Anthora’s optional visual-comparison model. This library has not enabled that model, so no best-shot groups are available.
        </div>
      )}
      {error && <div className="notice">{error}</div>}
      {data && (
        <div className="duplicate-summary" aria-label="Duplicate match summary">
          <span><strong>{Object.values(summary).reduce((sum, value) => sum + value.groups, 0)}</strong> groups to review</span>
          <span><strong>{formatBytes(potentialBytes)}</strong> potential space</span>
        </div>
      )}
      <div className="duplicate-simple-controls"><label>Show <select aria-label="Duplicate category" value={category} onChange={e=>chooseCategory(e.target.value)}>{duplicateCategories.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
      <details className="quiet-details duplicate-options"><summary>Options</summary>
      <label className="duplicate-sort">
        <SlidersHorizontal size={15} />
        <span>Sort groups</span>
        <select value={duplicateSort} onChange={(event) => changeDuplicateSort(event.target.value)}>
          <option value="largest">Largest potential savings</option>
          <option value="items">Most files</option>
          <option value="confidence">Highest confidence</option>
        </select>
      </label>
      <CareIndexProgress status={indexStatus} duplicateOnly />
      {data && <p>{number.format(data.reviewedGroups || 0)} groups already reviewed.</p>}
      </details></div>
      {indexStatus?.error ? <p role="status">Analysis status is unavailable. Results may be incomplete.</p> : indexStatus?.duplicates && !indexStatus.duplicates.current ? <p role="status">Still checking files. More groups may appear.</p> : null}
      {category !== "exact" && actionStatus?.message && !undoAction && (
        <div className={`duplicate-action-status ${actionStatus.state}`} role="status" aria-live="polite">
          {actionStatus.message}
        </div>
      )}
      {category !== "exact" && undoAction && (
        <div className="care-undo-toast" role="status" aria-live="polite">
          <div>
            <strong>Review choice saved</strong>
            <span>{undoAction.message}</span>
          </div>
          <button disabled={undoing} onClick={undoLastAction}>
            {undoing ? "Undoing…" : "Undo"}
          </button>
          <button
            className="icon-button"
            aria-label="Dismiss undo"
            onClick={() => setUndoAction(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {category === "exact" && (
        <ExactDuplicateSection
          groups={groups}
          loading={loading}
          status={indexStatus?.checks?.exact}
          summary={summary}
          consolidate={consolidate}
          actionStatus={actionStatus}
          selectedHashes={selectedExactHashes}
          toggleGroup={toggleExactGroup}
          selectPage={() => setSelectedExactHashes((current) => new Set([...current, ...groups.map((group) => group.hash)]))}
          clearSelection={() => setSelectedExactHashes(new Set())}
          applyExactAction={applyExactAction}
          total={total}
          semanticAvailable={indexStatus?.semanticAvailable !== false}
        />
      )}
      {category === "best" && (
        <SimilarDuplicateSection
          title="Best Shot Review"
          description="These images were captured close together in the same folder and are strongly visually related. Anthora recommends the best balance of detail, exposure, and resolution; the choice remains yours."
          empty={indexStatus?.semanticAvailable === false
            ? "Best-shot grouping is unavailable until the optional visual-comparison model is enabled."
            : "No confident best-shot groups found yet. Quality analysis continues in the background."}
          groups={groups}
          loading={loading}
          keepVersion={keepVersion}
          keepOnlyVersion={keepOnlyVersion}
          keepLikedVersions={keepLikedVersions}
          deleteVersion={deleteVersion}
          compareGroup={setComparison}
          dismissGroup={dismissGroup}
          markOtherVersions={markOtherVersions}
          deleteEntireGroup={deleteEntireGroup}
          busy={actionStatus?.state === "working"}
          exitingGroupKeys={exitingGroupKeys}
          exitingItemIds={exitingItemIds}
        />
      )}
      {category === "resized" && (
        <SimilarDuplicateSection
          title="Resized or recompressed"
          description="These look like the same complete image at a different resolution or compression level. Anthora recommends the highest-resolution file but never consolidates these automatically."
          empty={indexStatus?.duplicates?.current
            ? "No resized or recompressed matches found. Visual similarity analysis is current."
            : "No resized or recompressed matches found in the media checked so far. Visual similarity analysis is still running."}
          groups={groups}
          loading={loading}
          keepVersion={keepVersion}
          keepOnlyVersion={keepOnlyVersion}
          keepLikedVersions={keepLikedVersions}
          deleteVersion={deleteVersion}
          compareGroup={setComparison}
          dismissGroup={dismissGroup}
          markOtherVersions={markOtherVersions}
          deleteEntireGroup={deleteEntireGroup}
          busy={actionStatus?.state === "working"}
          exitingGroupKeys={exitingGroupKeys}
          exitingItemIds={exitingItemIds}
        />
      )}
      {category === "cropped" && (
        <SimilarDuplicateSection
          title="Cropped or edited variants"
          description="These likely come from the same original but have a different crop, border, or light edit. Keep both when the composition matters; otherwise mark the unwanted version for removal."
          empty={indexStatus?.duplicates?.current
            ? "No confident cropped or edited matches found. Visual similarity analysis is current."
            : "No confident cropped or edited matches found in the media checked so far. Visual similarity analysis is still running."}
          groups={groups}
          loading={loading}
          keepVersion={keepVersion}
          keepOnlyVersion={keepOnlyVersion}
          keepLikedVersions={keepLikedVersions}
          deleteVersion={deleteVersion}
          compareGroup={setComparison}
          dismissGroup={dismissGroup}
          markOtherVersions={markOtherVersions}
          deleteEntireGroup={deleteEntireGroup}
          busy={actionStatus?.state === "working"}
          exitingGroupKeys={exitingGroupKeys}
          exitingItemIds={exitingItemIds}
        />
      )}
      {category === "video" && (
        <VideoDuplicateSection
          groups={groups}
          loading={loading}
          status={data?.videoStatus}
          keepVersion={keepVersion}
          keepOnlyVersion={keepOnlyVersion}
          keepLikedVersions={keepLikedVersions}
          deleteVersion={deleteVersion}
          compareGroup={setComparison}
          dismissGroup={dismissGroup}
          markOtherVersions={markOtherVersions}
          deleteEntireGroup={deleteEntireGroup}
          busy={actionStatus?.state === "working"}
          exitingGroupKeys={exitingGroupKeys}
          exitingItemIds={exitingItemIds}
        />
      )}
      {total > pageSize && (
        <nav className="duplicate-pagination" aria-label="Duplicate groups pages">
          <button disabled={!offset || loading} onClick={() => changePage(Math.max(0, offset - pageSize))}>Previous</button>
          <span>{Math.floor(offset / pageSize) + 1} / {Math.ceil(total / pageSize)}</span>
          <button disabled={offset + pageSize >= total || loading} onClick={() => changePage(offset + pageSize)}>Next</button>
        </nav>
      )}
      {comparison && (
        <ComparisonViewer
          group={comparison}
          close={() => setComparison(null)}
          keepOnlyVersion={async (item) => {
            const result = await keepOnlyVersion(comparison, item);
            if (result) setComparison(null);
          }}
          keepLikedVersions={async () => {
            const result = await keepLikedVersions(comparison);
            if (result) setComparison(null);
          }}
          keepVersion={async (item) => {
            const result = await keepVersion(comparison, item);
            if (result) {
              setComparison((current) => ({
                ...current,
                items: current.items.map((candidate) =>
                  candidate.id === item.id
                    ? { ...candidate, disposition: "keep" }
                    : candidate
                ),
              }));
            }
          }}
          deleteVersion={async (item) => {
            const result = await deleteVersion(comparison, item);
            if (result) setComparison(null);
          }}
        />
      )}
    </div>
  );
}

function ExactDuplicateSection({
  groups,
  loading,
  status,
  summary,
  consolidate,
  actionStatus,
  selectedHashes,
  toggleGroup,
  selectPage,
  clearSelection,
  applyExactAction,
  total,
  semanticAvailable,
}) {
  const busy = actionStatus?.state === "working";
  return (
    <>
      {actionStatus?.message && (
        <div className={`duplicate-action-status ${actionStatus.state}`} role="status" aria-live="polite">
          {actionStatus.message}
        </div>
      )}
      {groups.length > 0 && (
        <details className="quiet-details exact-bulk-details"><summary>{selectedHashes.size ? `${number.format(selectedHashes.size)} selected · Group actions` : "Select multiple groups"}</summary>
        <div className="exact-bulk-toolbar" aria-label="Exact-copy bulk actions">
          <div>
            <button disabled={busy} onClick={selectPage}>Select page</button>
            {selectedHashes.size > 0 && <button disabled={busy} onClick={clearSelection}>Clear</button>}
            <span>{number.format(selectedHashes.size)} selected</span>
          </div>
          <div>
            {selectedHashes.size > 0 && (
              <>
                <button disabled={busy} onClick={() => applyExactAction("consolidate", { hashes: [...selectedHashes] })}>Keep best in selected</button>
                <button className="danger" disabled={busy} onClick={() => applyExactAction("trash", { hashes: [...selectedHashes] })}>Delete selected groups</button>
              </>
            )}
            <button disabled={busy} onClick={() => applyExactAction("consolidate", { all: true })}>
              Keep best in all {number.format(total)}
            </button>
          </div>
        </div>
        </details>
      )}
      {groups.length ? groups.map((group) => {
        const recommended = group.items.find((item) => item.id === group.recommendedId) || group.items[0];
        const isConsolidating = busy && actionStatus.group === group.hash;
        const selected = selectedHashes.has(group.hash);
        return (
          <section className={`duplicate-group ${selected ? "selected-group" : ""}`} key={group.hash}>
            <div className="section-title duplicate-group-title">
              <div>
                <label className="duplicate-group-select">
                  <input type="checkbox" checked={selected} disabled={busy} onChange={() => toggleGroup(group.hash)} />
                  <h2>{group.items.length} identical files</h2>
                </label>
                <span>{formatBytes(group.potentialBytes)} recoverable</span>
              </div>
              <div className="duplicate-group-actions">
                <details className="quiet-details duplicate-more"><summary>More</summary><button className="danger" disabled={busy} onClick={() => applyExactAction("trash", { hashes: [group.hash] })}>Delete all copies</button></details>
              </div>
            </div>
            <div className="rail-scroll">
              {group.items.map((item) => {
                const isRecommended = item.id === recommended.id;
                return (
                  <figure className={isRecommended ? "recommended-duplicate" : ""} key={item.id}>
                    <span className="duplicate-image-shell">
                      <img src={`${item.thumbnailUrl}?size=400`} loading="lazy" />
                      {isRecommended && <strong>Recommended keeper</strong>}
                    </span>
                    <figcaption>{item.width} × {item.height} · {formatBytes(item.sizeBytes)}</figcaption>
                    <DuplicateSourceInfo item={item} />
                    <button className="keep-best" disabled={busy} onClick={() => consolidate(group, item)}>
                      {isConsolidating ? "Consolidating…" : isRecommended ? "Keep best copy" : "Keep this copy"}
                    </button>
                  </figure>
                );
              })}
            </div>
          </section>
        );
      }) : (
        <div className="notice-neutral">
          {loading
            ? "Loading byte-for-byte duplicate groups…"
            : !status
              ? "Loading byte-for-byte analysis status…"
              : status.remaining
              ? `No exact-copy groups found in checked files yet. ${number.format(status.remaining)} byte-for-byte candidates still need hashing.`
              : `Byte-for-byte analysis is current: no exact duplicate files found.${summary
                ? ` Anthora found ${number.format(summary.resized?.groups || 0)} resized or recompressed groups and ${number.format(summary.cropped?.groups || 0)} cropped or edited groups.`
                : " Check Resized and Cropped & edited for visual variants."}`}
        </div>
      )}
    </>
  );
}

function DuplicateDecisionFooter({ group, busy, keepOnlyVersion, keepLikedVersions, compareGroup, dismissGroup, markOtherVersions, deleteEntireGroup }) {
  const likedCount = group.items.filter((item) => item.disposition === "keep" || item.favorite).length;
  return (
    <div className="duplicate-decision-footer">
      <div>
        <strong>Ready to decide?</strong>
        <span>Use the large buttons beneath each version, or finish the whole group here.</span>
      </div>
      <div className="duplicate-final-actions">
        <button className="primary" disabled={busy} onClick={() => markOtherVersions(group)}>Keep best quality</button>
        {likedCount > 0 && likedCount < group.items.length && (
          <button disabled={busy} onClick={() => keepLikedVersions(group)}>Keep chosen ({likedCount})</button>
        )}
        <button disabled={busy} onClick={() => compareGroup(group)}>Compare</button>
        <button disabled={busy} onClick={() => dismissGroup(group)}>Not duplicates</button>
        <button className="danger" disabled={busy} onClick={() => deleteEntireGroup(group)}>Delete all</button>
      </div>
    </div>
  );
}

function VideoDuplicateSection({ groups, loading, status, keepVersion, keepOnlyVersion, keepLikedVersions, deleteVersion, compareGroup, dismissGroup, markOtherVersions, deleteEntireGroup, busy, exitingGroupKeys, exitingItemIds }) {
  const percent = status?.total
    ? Math.min(100, Math.round((status.indexed / status.total) * 100))
    : 0;
  const percentLabel = status?.indexed > 0 && percent === 0 ? "<1%" : `${percent}%`;
  return (
    <>
      {status && status.indexed < status.total && (
        <div className="video-index-progress">
          <div>
            <strong>Video comparison index</strong>
            <span>{number.format(status.indexed)} of {number.format(status.total)} videos · {percentLabel}</span>
          </div>
          <progress max={status.total || 1} value={status.indexed} />
          <small>Analysis continues inside your private library. New matches appear automatically.</small>
        </div>
      )}
      {groups.length ? groups.map((group, index) => {
        return (
        <section
          className={`duplicate-group ${exitingGroupKeys.has(duplicateGroupKey(group)) ? "exiting" : ""}`}
          key={`video-${group.items.map((item) => item.id).join("-")}`}
        >
          <div className="section-title duplicate-group-title">
            <div>
              <h2>Shared-footage match {index + 1}</h2>
              <span>{group.items.length > 2 ? "Each version shares at least" : "About"} {Math.round(group.sharedPercent)}% of the shorter video · {formatDuration(group.sharedSeconds)} shared · {Math.round(group.confidence)}% frame confidence</span>
            </div>
          </div>
          <div className="compare-grid video-compare-grid">
            {group.items.map((item, itemIndex) => {
              const recommended = item.id === group.recommendedId;
              return (
                <figure className={`${recommended ? "recommended-duplicate" : ""} ${exitingItemIds.has(item.id) ? "exiting" : ""}`} key={item.id}>
                  <span className="duplicate-image-shell video-duplicate-poster">
                    <img src={`${item.thumbnailUrl}?size=600`} loading="lazy" />
                    {recommended && <strong>{group.sharedPercent >= 90 ? "Best version" : "Longer version"}</strong>}
                  </span>
                  <figcaption>{item.width || "?"} × {item.height || "?"} · {formatDuration(item.durationSeconds)} · {formatBytes(item.sizeBytes)}</figcaption>
                  <DuplicateSourceInfo item={item} />
                  <span className={`review-decision ${item.disposition === "keep" ? "keep" : "undecided"}`}>
                    Version {itemIndex + 1} · {item.disposition === "keep" ? "Keeping" : "Undecided"}
                  </span>
                  <div className="duplicate-review-actions">
                    <button className="keep-only" disabled={busy} onClick={() => keepOnlyVersion(group, item)}>
                      <Check size={14} /> Keep only this
                    </button>
                    <button
                      className={item.disposition === "keep" ? "selected" : ""}
                      disabled={busy}
                      onClick={() => keepVersion(group, item)}
                    ><Check size={14} /> {item.disposition === "keep" ? "Keeping too" : "Keep this too"}</button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => deleteVersion(group, item)}
                    ><Trash2 size={14} /> Delete</button>
                  </div>
                </figure>
              );
            })}
          </div>
          <DuplicateDecisionFooter
            group={group}
            busy={busy}
            keepOnlyVersion={keepOnlyVersion}
            keepLikedVersions={keepLikedVersions}
            compareGroup={compareGroup}
            dismissGroup={dismissGroup}
            markOtherVersions={markOtherVersions}
            deleteEntireGroup={deleteEntireGroup}
          />
        </section>
        );
      }) : (
        <div className="notice-neutral">
          {loading ? "Loading shared-footage matches…" : status?.indexed < status?.total ? "No matches in the indexed videos yet. Analysis is continuing." : "No shared video clips found."}
        </div>
      )}
    </>
  );
}

function SimilarDuplicateSection({ title, description, empty, groups, loading, keepVersion, keepOnlyVersion, keepLikedVersions, deleteVersion, compareGroup, dismissGroup, markOtherVersions, deleteEntireGroup, busy, exitingGroupKeys, exitingItemIds }) {
  return (
    <>
      {groups.length ? groups.map((group, index) => {
        return (
        <section
          className={`duplicate-group ${exitingGroupKeys.has(duplicateGroupKey(group)) ? "exiting" : ""}`}
          key={`${group.kind}-${group.items.map((item) => item.id).join("-")}`}
        >
          <div className="section-title duplicate-group-title">
            <div>
              <h2>Match group {index + 1}</h2>
              <span>{group.confidence}% confidence{group.distance == null ? "" : ` · visual distance ${group.distance} / 64`}</span>
            </div>
          </div>
          <div className="compare-grid">
            {group.items.map((item, itemIndex) => {
              const recommended = item.id === group.recommendedId;
              return (
                <figure className={`${recommended ? "recommended-duplicate" : ""} ${exitingItemIds.has(item.id) ? "exiting" : ""}`} key={item.id}>
                  <span className="duplicate-image-shell">
                    <img src={`${item.thumbnailUrl}?size=600`} loading="lazy" />
                    {recommended && <strong>Best quality</strong>}
                  </span>
                  <figcaption>
                    {item.width || "?"} × {item.height || "?"} · {formatBytes(item.sizeBytes)}
                  </figcaption>
                  <DuplicateSourceInfo item={item} />
                  <span className={`review-decision ${item.disposition === "keep" ? "keep" : "undecided"}`}>
                    Version {itemIndex + 1} · {item.disposition === "keep" ? "Keeping" : "Undecided"}
                  </span>
                  <div className="duplicate-review-actions">
                    <button className="keep-only" disabled={busy} onClick={() => keepOnlyVersion(group, item)}>
                      <Check size={14} /> Keep only this
                    </button>
                    <button
                      className={item.disposition === "keep" ? "selected" : ""}
                      disabled={busy}
                      onClick={() => keepVersion(group, item)}
                    >
                      <Check size={14} /> {item.disposition === "keep" ? "Keeping too" : "Keep this too"}
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => deleteVersion(group, item)}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                </figure>
              );
            })}
          </div>
          <DuplicateDecisionFooter
            group={group}
            busy={busy}
            keepOnlyVersion={keepOnlyVersion}
            keepLikedVersions={keepLikedVersions}
            compareGroup={compareGroup}
            dismissGroup={dismissGroup}
            markOtherVersions={markOtherVersions}
            deleteEntireGroup={deleteEntireGroup}
          />
        </section>
        );
      }) : <div className="notice-neutral">{loading ? `Loading ${title.toLowerCase()}…` : empty}</div>}
    </>
  );
}

function DuplicateSourceInfo({ item }) {
  const [open, setOpen] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError("");
    if (metadata) return;
    try {
      setMetadata(await api(`/api/items/${item.id}/metadata`));
    } catch (requestError) {
      setError(requestError.message);
    }
  };
  const copyPath = async () => {
    if (!metadata?.path) return;
    try {
      await navigator.clipboard.writeText(metadata.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("The browser could not copy this path.");
    }
  };
  const folderName = metadata?.folderPath?.split("/").filter(Boolean).pop() || "Unknown folder";
  return (
    <div className="duplicate-source">
      <button
        className={open ? "selected" : ""}
        aria-expanded={open}
        onClick={toggle}
      >
        <Folder size={13} /> {open ? "Hide source" : "Source"}
      </button>
      {open && (
        <div className="duplicate-source-panel">
          {!metadata && !error && <span>Locating source…</span>}
          {error && <span className="duplicate-source-error">{error}</span>}
          {metadata && (
            <>
              <header>
                <span>
                  <small>Library</small>
                  <strong>{metadata.libraryName}</strong>
                </span>
                <i className={metadata.available ? "available" : "missing"}>
                  {metadata.available ? "Available" : "Unavailable"}
                </i>
              </header>
              <span className="duplicate-source-folder" title={metadata.folderPath}>
                <small>Folder</small>
                <strong>{folderName}</strong>
              </span>
              <code title={metadata.path}>{metadata.path}</code>
              <button onClick={copyPath}><Copy size={12} /> {copied ? "Copied" : "Copy path"}</button>
              {metadata.linkedLocations.length > 0 && (
                <details>
                  <summary>Also appears in {number.format(metadata.linkedLocations.length)} {metadata.linkedLocations.length === 1 ? "location" : "locations"}</summary>
                  <div>{metadata.linkedLocations.map((path) => <code key={path}>{path}</code>)}</div>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ComparisonViewer({ group, close, keepOnlyVersion, keepLikedVersions, keepVersion, deleteVersion }) {
  const [index, setIndex] = useState(() =>
    Math.max(0, group.items.findIndex((item) => item.id === group.recommendedId)),
  );
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(1);
  const [flipY, setFlipY] = useState(1);
  const item = group.items[index];
  const likedCount = group.items.filter((candidate) => candidate.disposition === "keep" || candidate.favorite).length;
  const mediaRef = useRef(null);
  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setFlipX(1);
    setFlipY(1);
  }, [item.id]);
  useEffect(() => {
    const keydown = (event) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft")
        setIndex((current) => (current - 1 + group.items.length) % group.items.length);
      if (event.key === "ArrowRight")
        setIndex((current) => (current + 1) % group.items.length);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, group.items.length]);
  const actualSize = () => {
    const media = mediaRef.current;
    if (!media) return;
    const sourceWidth = item.width || media.naturalWidth || media.videoWidth;
    const displayedWidth = media.getBoundingClientRect().width;
    setZoom(Math.max(1, Math.min(MAX_IMAGE_ZOOM, sourceWidth / Math.max(1, displayedWidth))));
  };
  return (
    <div className="comparison-viewer" role="dialog" aria-modal="true" aria-label="Compare media full size">
      <header>
        <button className="icon-button" onClick={close} aria-label="Close comparison"><X size={19} /></button>
        <div>
          <strong>Full-size comparison</strong>
          <span>{index + 1} of {group.items.length} · {item.width || "?"} × {item.height || "?"} · {formatBytes(item.sizeBytes)}</span>
        </div>
      </header>
      <div className="comparison-canvas">
        {item.mediaType === "video" ? (
          <video
            ref={mediaRef}
            src={item.contentUrl}
            controls
            autoPlay
            playsInline
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg) scale(${flipX},${flipY})` }}
          />
        ) : (
          <img
            ref={mediaRef}
            src={item.contentUrl}
            draggable={false}
            onDoubleClick={() => setZoom((current) => current > 1 ? 1 : 2.5)}
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg) scale(${flipX},${flipY})` }}
          />
        )}
      </div>
      <div className="comparison-tools">
        <button className={zoom === 1 ? "selected" : ""} onClick={() => setZoom(1)}>Fit</button>
        <button onClick={actualSize}>100%</button>
        <button onClick={() => setZoom((value) => Math.min(MAX_IMAGE_ZOOM, value * 1.5))}>Zoom in</button>
        <button onClick={() => setRotation((value) => value - 90)} title="Rotate left"><RotateCcw size={15} /></button>
        <button onClick={() => setRotation((value) => value + 90)} title="Rotate right"><RotateCw size={15} /></button>
        <button className={flipX === -1 ? "selected" : ""} onClick={() => setFlipX((value) => -value)} title="Flip horizontally"><FlipHorizontal2 size={15} /></button>
        <button className={flipY === -1 ? "selected" : ""} onClick={() => setFlipY((value) => -value)} title="Flip vertically"><FlipVertical2 size={15} /></button>
      </div>
      <div className="comparison-decisions" aria-label="Comparison decisions">
        <button className="primary" onClick={() => keepOnlyVersion(item)}><Check size={16} /> Keep only this</button>
        <button className={item.disposition === "keep" ? "selected" : ""} onClick={() => keepVersion(item)}>
          <Check size={16} /> {item.disposition === "keep" ? "Keeping too" : "Keep this too"}
        </button>
        {likedCount > 0 && likedCount < group.items.length && (
          <button onClick={keepLikedVersions}><Check size={16} /> Keep chosen ({likedCount})</button>
        )}
        <button className="danger" onClick={() => deleteVersion(item)}><Trash2 size={16} /> Delete this</button>
      </div>
      <div className="comparison-filmstrip">
        {group.items.map((candidate, candidateIndex) => (
          <button
            key={candidate.id}
            className={candidateIndex === index ? "selected" : ""}
            onClick={() => setIndex(candidateIndex)}
          >
            <img src={`${candidate.thumbnailUrl}?size=400`} />
            <span>{candidate.width || "?"} × {candidate.height || "?"}<small>{formatBytes(candidate.sizeBytes)}</small></span>
            {candidate.id === group.recommendedId && <strong>Recommended</strong>}
          </button>
        ))}
      </div>
    </div>
  );
}

function FoldersView({ route, navigate }) {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [folderSort, setFolderSort] = useState("name");
  const [sortOpen, setSortOpen] = useState(false);
  const sortMenuRef = useRef(null);
  const folderSortOptions = [
    { value: "name", label: "Name" },
    { value: "newest", label: "Newest media" },
    { value: "oldest", label: "Oldest media" },
    { value: "size", label: "Storage size" },
    { value: "items", label: "Item count" },
  ];
  const selectedFolderSort = folderSortOptions.find((option) => option.value === folderSort);
  useEffect(() => {
    setLoading(true);
    api(
      `/api/folders?libraryId=${route.libraryId}${route.parentId ? `&parentId=${route.parentId}` : ""}`,
    )
      .then((d) => setFolders(d.folders))
      .finally(() => setLoading(false));
  }, [route.libraryId, route.parentId]);
  useEffect(() => {
    if (!sortOpen) return undefined;
    const close = (event) => {
      if (!sortMenuRef.current?.contains(event.target)) setSortOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [sortOpen]);
  const open = (folder) =>
    folder.hasChildren
      ? navigate({
          ...route,
          parentId: folder.id,
          title: folder.name,
          crumbs: [...route.crumbs, folder.name],
          stack: [...route.stack, route],
        })
      : navigate({
          kind: "media",
          title: folder.name,
          params: { folderId: String(folder.id) },
          crumbs: [...route.crumbs, folder.name],
          parentRoute: route,
        });
  const back = () =>
    route.stack.length
      ? navigate(route.stack[route.stack.length - 1])
      : navigate({ kind: "home", crumbs: [], stack: [] });
  const breadcrumbs = route.crumbs.slice(0, -1).map((label, index) => ({
    label,
    onClick: () =>
      navigate(route.stack[index] || { kind: "home", crumbs: [], stack: [] }),
  }));
  const visibleFolders = folders
    .filter((folder) => folder.name.toLowerCase().includes(filterText.trim().toLowerCase()))
    .sort((left, right) => {
      if (folderSort === "size") return (right.totalBytes || 0) - (left.totalBytes || 0) || left.name.localeCompare(right.name);
      if (folderSort === "items") return (right.itemCount || 0) - (left.itemCount || 0) || left.name.localeCompare(right.name);
      if (folderSort === "newest") return (right.newestAt || 0) - (left.newestAt || 0) || left.name.localeCompare(right.name);
      if (folderSort === "oldest") return (left.oldestAt || Number.POSITIVE_INFINITY) - (right.oldestAt || Number.POSITIVE_INFINITY) || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name);
    });
  return (
    <div className="page">
      <PageTitle
        breadcrumbs={breadcrumbs}
        title={route.title}
        subtitle={`${folders.length} ${folders.length === 1 ? "folder" : "folders"}`}
        back={back}
      />
      {route.parentId && (
        <div className="folder-action-row">
          <button
            className="context-care"
            onClick={() => navigate({
              kind: "cleanup",
              title: `Care for ${route.title}`,
              scope: { label: route.title, params: { folderId: String(route.parentId) } },
              parentRoute: route,
              crumbs: [`Care for ${route.title}`],
            })}
          >
            <SlidersHorizontal size={15} /> Care for this {route.isLibraryRoot ? "collection" : "folder"}
          </button>
        </div>
      )}
      {(loading || folders.length > 0) && (
        <div className="folder-controls">
          <label className="live-filter folder-filter">
            <Search size={15} />
            <input value={filterText} onChange={(event) => setFilterText(event.target.value)} placeholder="Filter folders…" />
            {filterText && <button aria-label="Clear filter" onClick={() => setFilterText("")}><X size={14} /></button>}
          </label>
          <div className="folder-sort gallery-sort" ref={sortMenuRef}>
            <div className="sort-menu">
              <button
                className="sort-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={sortOpen}
                onClick={() => setSortOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} />
                <span className="sort-trigger-copy">
                  <small>Sort by</small>
                  <strong>{selectedFolderSort?.label}</strong>
                </span>
                <ChevronDown className="sort-chevron" size={14} />
              </button>
              {sortOpen && (
                <div className="sort-options" role="listbox" aria-label="Sort folders">
                  {folderSortOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={folderSort === option.value}
                      className={folderSort === option.value ? "selected" : ""}
                      onClick={() => {
                        setFolderSort(option.value);
                        setSortOpen(false);
                      }}
                    >
                      <span>{option.label}</span>
                      {folderSort === option.value && <Check size={14} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {loading ? (
        <SkeletonCards />
      ) : (
        <div className="collection-grid">
          {visibleFolders.map((folder) => (
            <CollectionCard
              key={folder.id}
              item={folder}
              onClick={() => open(folder)}
            />
          ))}
        </div>
      )}
      {route.parentId && (
        <MediaRail
          title={folders.length ? "Loose media" : "Media"}
          params={{ folderId: String(route.parentId), sort: "newest" }}
          navigate={navigate}
          parentRoute={route}
        />
      )}
    </div>
  );
}

function MediaRail({ title, params, navigate, parentRoute = null }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    api(`/api/items?${new URLSearchParams({ ...params, limit: "12" })}`).then(
      (d) => setItems(d.items),
    );
  }, []);
  if (!items.length) return null;
  return (
    <section className="rail">
      <div className="section-title">
        <h2>{title}</h2>
        <button
          onClick={() =>
            navigate({
              kind: "media",
              title,
              params,
              crumbs: [...(parentRoute?.crumbs || []), title],
              parentRoute,
            })
          }
        >
          View all <ChevronRight size={14} />
        </button>
      </div>
      <div className="rail-scroll">
        {items.map((item) => (
          <img
            key={item.id}
            src={`${item.thumbnailUrl}?size=400`}
            loading="lazy"
          />
        ))}
      </div>
    </section>
  );
}

const screenshotCategories = [
  ["", "To review", "Everything not already protected"],
  ["conversations", "Conversations", "Messages and chats"],
  ["orders", "Orders & receipts", "Purchases, deliveries, and invoices"],
  ["weather", "Weather", "Forecasts and advisories"],
  ["travel", "Travel & maps", "Directions, flights, and hotels"],
  ["recipes", "Recipes", "Ingredients, cooking, and baking"],
  ["social", "Social posts & memes", "Posts, comments, and shared graphics"],
  ["calendar", "Calendar & events", "Appointments, schedules, and reminders"],
  ["saved", "Already saved", "Favorites and screenshots marked to keep"],
];
const screenshotManualCategories = [
  ["conversations", "Conversations"],
  ["orders", "Orders & receipts"],
  ["weather", "Weather"],
  ["travel", "Travel & maps"],
  ["recipes", "Recipes"],
  ["social", "Social posts & memes"],
  ["calendar", "Calendar & events"],
  ["other", "Other screenshot"],
];

function ScreenshotOrganizer({ route, navigate, selectionEnabled, onToggleSelection }) {
  const [textQuery, setTextQuery] = useState("");
  const active = route.params.screenshotCategory || "";
  const chooseCategory = (category) => {
    const params = { ...route.params, sort: "newest" };
    delete params.q;
    if (category) params.screenshotCategory = category;
    else delete params.screenshotCategory;
    if (category === "saved") delete params.cleanup;
    else params.cleanup = "1";
    navigate({ ...route, params });
  };
  const searchScreenshotText = (event) => {
    event.preventDefault();
    const query = textQuery.trim();
    if (!query) return;
    const params = {
      ...route.params,
      q: `screenshots containing "${query.replaceAll('"', "")}"`,
      sort: "newest",
    };
    delete params.screenshotCategory;
    delete params.cleanup;
    navigate({ ...route, params });
  };
  return (
    <section className="screenshot-organizer" aria-label="Organize screenshots">
      <div className="screenshot-organizer-head">
        <div className="screenshot-organizer-copy">
          <strong>Find the screenshots that matter</strong>
          <span>Search words visible inside an image, or start with an overlapping category. Nothing here is assumed to be disposable.</span>
        </div>
        <button className={selectionEnabled ? "selected" : ""} type="button" onClick={onToggleSelection}>
          <Check size={16} /> {selectionEnabled ? "Done selecting" : "Select screenshots"}
        </button>
      </div>
      <form className="screenshot-text-search" onSubmit={searchScreenshotText}>
        <Search size={17} />
        <input
          value={textQuery}
          onChange={(event) => setTextQuery(event.target.value)}
          placeholder="Search text inside screenshots…"
          aria-label="Search text inside screenshots"
        />
        <button type="submit" disabled={!textQuery.trim()}>Search</button>
      </form>
      <div className="screenshot-category-strip" aria-label="Screenshot categories">
        {screenshotCategories.map(([value, label, description]) => (
          <button
            key={value || "review"}
            type="button"
            className={active === value && !route.params.q ? "selected" : ""}
            onClick={() => chooseCategory(value)}
          >
            <strong>{label}</strong>
            <small>{description}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function MediaView({
  route,
  navigate,
  operation,
  onSavedSearchChange,
  viewerSwipeDirection,
}) {
  const { confirmAction, promptAction } = useDialog();
  const [items, setItems] = useState([]),
    [cursor, setCursor] = useState(null),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [viewer, setViewer] = useState(null),
    [selectionEnabled, setSelectionEnabled] = useState(false),
    [selectedIds, setSelectedIds] = useState(() => new Set()),
    [dragRect, setDragRect] = useState(null),
    [unreadableStats, setUnreadableStats] = useState(null),
    [unreadableAction, setUnreadableAction] = useState(""),
    [unreadableMessage, setUnreadableMessage] = useState(""),
    [trashAction, setTrashAction] = useState(""),
    [trashMessage, setTrashMessage] = useState(""),
    [permanentAction, setPermanentAction] = useState(""),
    [permanentMessage, setPermanentMessage] = useState(""),
    [bulkActionBusy, setBulkActionBusy] = useState(""),
    [bulkMessage, setBulkMessage] = useState(""),
    [searchPlan, setSearchPlan] = useState(null),
    [galleryRevision, setGalleryRevision] = useState(0),
    [sortOpen, setSortOpen] = useState(false),
    [faceIndexStatus, setFaceIndexStatus] = useState(null),
    [personMergeOpen, setPersonMergeOpen] = useState(false),
    [personMergeQuery, setPersonMergeQuery] = useState(""),
    [personMergePeople, setPersonMergePeople] = useState([]),
    [personMergeTarget, setPersonMergeTarget] = useState(null),
    [personMergeBusy, setPersonMergeBusy] = useState(false);
  const [smartSearchAction, setSmartSearchAction] = useState("");
  const [layout, setLayout] = useStored("anthology.layout", "masonry");
  const [tileSize, setTileSize] = useStored("anthology.tileSize", 220);
  const [showInfo, setShowInfo] = useStored("anthology.showInfo", false);
  const sort = route.params.sort || "relevance";
  const sentinel = useRef(null),
    generation = useRef(0),
    loadingRef = useRef(false),
    galleryRef = useRef(null),
    sortMenuRef = useRef(null),
    selectionAnchor = useRef(null),
    dragState = useRef(null),
    suppressClick = useRef(false);
  const refreshedPurgeId = useRef("");
  const routeKey = JSON.stringify(route.params);
  const careScope = route.params.folderId || route.params.peopleKey;
  const renameReviewedPerson = async () => {
    const personKey = route.personKey || route.params.peopleKey;
    if (!personKey) return;
    const displayName = await promptAction({
      title: "Rename person",
      message: "This changes the name in Anthora without changing any original files.",
      value: route.title,
      confirmLabel: "Rename",
    });
    if (!displayName || displayName.trim() === route.title) return;
    setError("");
    try {
      const renamed = displayName.trim();
      await api("/api/people/alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: personKey,
          target: personKey,
          displayName: renamed,
        }),
      });
      navigate({
        ...route,
        title: renamed,
        personKey,
        crumbs: route.crumbs?.map((crumb, index) =>
          index === route.crumbs.length - 1 ? renamed : crumb
        ),
      });
    } catch (requestError) {
      setError(requestError.message);
    }
  };
  const openPersonMerge = async () => {
    if (personMergeOpen) {
      setPersonMergeOpen(false);
      setPersonMergeQuery("");
      setPersonMergeTarget(null);
      return;
    }
    setPersonMergeOpen(true);
    setPersonMergeQuery("");
    setPersonMergeTarget(null);
    if (personMergePeople.length) return;
    try {
      const data = await api("/api/people");
      setPersonMergePeople(data.people || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  };
  const mergeReviewedPerson = async () => {
    const sourceKey = route.personKey || route.params.peopleKey;
    if (!sourceKey || !personMergeTarget || personMergeTarget.key === sourceKey) return;
    if (!await confirmAction({
      title: `Add ${route.title} to ${personMergeTarget.name}?`,
      message: `These photos will become part of ${personMergeTarget.name}. The original files are not changed.`,
      confirmLabel: `Add to ${personMergeTarget.name}`,
    })) return;
    setPersonMergeBusy(true);
    setError("");
    try {
      await api("/api/people/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keys: [sourceKey, personMergeTarget.key],
          target: personMergeTarget.key,
          displayName: personMergeTarget.name,
        }),
      });
      const target = personMergeTarget;
      setPersonMergeOpen(false);
      setPersonMergeTarget(null);
      setPersonMergeQuery("");
      navigate({
        ...route,
        title: target.name,
        params: { ...route.params, peopleKey: target.key },
        personKey: target.key,
        crumbs: route.crumbs?.map((crumb, index) =>
          index === route.crumbs.length - 1 ? target.name : crumb
        ),
      });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPersonMergeBusy(false);
    }
  };
  const load = async ({
    reset = false,
    nextCursor = null,
    requestGeneration = generation.current,
  } = {}) => {
    if (!reset && loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    const { defaultSortApplied: _defaultSortApplied, ...requestParams } =
      route.params;
    const query = new URLSearchParams({
      ...requestParams,
      limit: route.params.type === "video" ? "24" : "120",
    });
    if (nextCursor) query.set("cursor", nextCursor);
    try {
      const data = await api(`/api/items?${query}`);
      if (generation.current !== requestGeneration) return;
      setItems((old) => {
        if (reset) return data.items;
        const loadedIds = new Set(old.map((item) => item.id));
        return [...old, ...data.items.filter((item) => !loadedIds.has(item.id))];
      });
      setCursor(data.nextCursor);
      setTotal(data.total);
      if (reset) setSearchPlan(data.searchPlan || null);
    } catch (requestError) {
      if (generation.current === requestGeneration)
        setError(requestError.message);
    } finally {
      if (generation.current === requestGeneration) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    const requestGeneration = ++generation.current;
    loadingRef.current = false;
    setItems([]);
    setCursor(null);
    setTotal(0);
    setSearchPlan(null);
    setError("");
    setBulkMessage("");
    load({ reset: true, requestGeneration });
    setSelectedIds(new Set());
    setSelectionEnabled(false);
    selectionAnchor.current = null;
    return () => { generation.current++; };
  }, [routeKey]);
  useEffect(() => {
    if (
      route.params.trash !== "1" ||
      operation?.kind !== "purgeTrash" ||
      !["completed", "completed_with_errors", "failed"].includes(operation.status) ||
      refreshedPurgeId.current === operation.id
    )
      return;
    refreshedPurgeId.current = operation.id;
    const requestGeneration = ++generation.current;
    loadingRef.current = false;
    setItems([]);
    setCursor(null);
    setTotal(0);
    load({ reset: true, requestGeneration });
  }, [operation?.id, operation?.kind, operation?.status, route.params.trash]);
  const refreshUnreadableStats = () =>
    api("/api/cleanup/stats").then(setUnreadableStats).catch(() => {});
  useEffect(() => {
    if (route.params.invalid === "1" || route.params.trash === "1") refreshUnreadableStats();
    else setUnreadableStats(null);
  }, [routeKey]);
  useEffect(() => {
    if (!route.params.faces) {
      setFaceIndexStatus(null);
      return;
    }
    let active = true;
    const refresh = () =>
      api("/api/ai/status")
        .then((status) => active && setFaceIndexStatus(status))
        .catch(() => active && setFaceIndexStatus({ error: true }));
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [route.params.faces]);
  useEffect(() => {
    const keydown = (event) => {
      if (event.key === "Escape" && (selectionEnabled || selectedIds.size)) {
        event.preventDefault();
        setSelectedIds(new Set());
        setSelectionEnabled(false);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "a" &&
        selectionEnabled
      ) {
        event.preventDefault();
        setSelectedIds(new Set(items.map((item) => item.id)));
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [items, selectedIds.size, selectionEnabled]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && cursor && !loadingRef.current)
          load({ nextCursor: cursor });
      },
      { rootMargin: "1000px" },
    );
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [cursor, routeKey]);
  const trashRemoved = async () => {
    if (!await confirmAction({
      title: "Delete all disliked media?",
      message: `${total.toLocaleString()} reviewed items will disappear now and remain recoverable for 30 days.`,
      confirmLabel: "Delete disliked",
      danger: true,
    })) return;
    setTrashAction("moving");
    setTrashMessage("");
    setError("");
    try {
      const result = await api("/api/curation/trash-removed", { method: "POST" });
      setItems([]);
      setCursor(null);
      setTotal(0);
      setTrashMessage(
        `${number.format(result.trashed)} ${result.trashed === 1 ? "item" : "items"} moved to Recently Deleted.`,
      );
      const requestGeneration = ++generation.current;
      loadingRef.current = false;
      await load({ reset: true, requestGeneration });
    } catch (requestError) {
      setError(requestError.message);
      setTrashMessage(`Anthora could not confirm the move. ${requestError.message}`);
    } finally {
      setTrashAction("");
    }
  };
  const emptyRecentlyDeleted = async () => {
    setPermanentAction("queuing");
    setPermanentMessage("");
    setError("");
    try {
      const result = await api("/api/curation/purge-trash/job", { method: "POST" });
      setPermanentMessage(
        `Permanent deletion started for ${number.format(result.totalItems)} items. You can continue browsing; progress will remain at the top.`,
      );
    } catch (requestError) {
      setError(requestError.message);
      setPermanentMessage(`Anthora could not start permanent deletion. ${requestError.message}`);
    } finally {
      setPermanentAction("");
    }
  };
  const runUnreadableAction = async (action) => {
    if (action === "recheck") {
      setUnreadableAction(action);
      setUnreadableMessage("");
      setError("");
      try {
        const result = await api("/api/cleanup/unreadable/recheck", { method: "POST" });
        setUnreadableMessage(
          result.retrying
            ? `${number.format(result.stale)} unavailable ${result.stale === 1 ? "item was" : "items were"} cleared from the active library. Anthora is checking ${number.format(result.retrying)} ${result.retrying === 1 ? "file" : "files"} again.`
            : `${number.format(result.stale)} unavailable ${result.stale === 1 ? "item was" : "items were"} cleared from the active library.`,
        );
        const requestGeneration = ++generation.current;
        loadingRef.current = false;
        setItems([]);
        setCursor(null);
        await load({ reset: true, requestGeneration });
        refreshUnreadableStats();
      } catch (requestError) {
        setError(requestError.message);
        setUnreadableMessage(`Anthora could not finish checking the files. ${requestError.message}`);
      } finally {
        setUnreadableAction("");
      }
      return;
    }
    const redownload = action === "redownload";
    const count = redownload
      ? unreadableStats?.recoverableItems || 0
      : unreadableStats?.unrecoverableItems || 0;
    if (!count) return;
    const prompt = redownload
      ? `Redownload ${number.format(count)} unreadable files from their known sources? Each replacement will be validated before the original moves to Trash.`
      : `Move ${number.format(count)} unreadable files with no recovery source to Recently Deleted? Liked and Favorite items remain protected.`;
    if (!await confirmAction({
      title: redownload ? "Redownload unreadable media?" : "Delete unreadable media?",
      message: prompt,
      confirmLabel: redownload ? "Redownload" : "Delete files",
      danger: !redownload,
    })) return;
    setUnreadableAction(action);
    setUnreadableMessage("");
    try {
      const result = await api(
        redownload
          ? "/api/cleanup/unreadable/redownload"
          : "/api/cleanup/unreadable/trash-unrecoverable",
        { method: "POST" },
      );
      setUnreadableMessage(
        redownload
          ? `${number.format(result.queued)} fresh copies queued.`
          : `${number.format(result.trashed)} files moved to Recently Deleted.`,
      );
      const requestGeneration = ++generation.current;
      loadingRef.current = false;
      setItems([]);
      setCursor(null);
      load({ reset: true, requestGeneration });
      refreshUnreadableStats();
    } catch (requestError) {
      setUnreadableMessage(requestError.message);
    } finally {
      setUnreadableAction("");
    }
  };
  const back = route.parentRoute ? () => navigate(route.parentRoute) : null;
  const changeSort = (nextSort) => {
    setSortOpen(false);
    const { defaultSortApplied: _, ...params } = route.params;
    navigate({
      ...route,
      params: { ...params, sort: nextSort },
    });
  };
  const saveSmartSearch = async () => {
    const name = await promptAction({
      title: "Save Smart Search",
      message: "This search will stay in the sidebar and update as your library changes.",
      value: route.title,
      confirmLabel: "Save to sidebar",
    });
    if (!name) return;
    setSmartSearchAction("saving");
    try {
      const result = await api("/api/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, params: route.params }),
      });
      onSavedSearchChange();
      navigate({
        ...route,
        title: result.savedSearch.name,
        params: result.savedSearch.params,
        savedSearchId: result.savedSearch.id,
        crumbs: ["Smart Searches", result.savedSearch.name],
      });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSmartSearchAction("");
    }
  };
  useEffect(() => {
    if (!sortOpen) return;
    const dismiss = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && sortMenuRef.current?.contains(event.target)) return;
      setSortOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [sortOpen]);
  const sortOptions = [
    ...(route.title !== "All Media" ? [{
      value: "relevance",
      label: route.params.trash === "1" ? "Recently deleted" : "Default",
    }] : []),
    { value: "newest", label: "Date · newest" },
    { value: "oldest", label: "Date · oldest" },
    { value: "largest", label: "File size · largest" },
    { value: "smallest", label: "File size · smallest" },
    { value: "resolution", label: "Resolution · highest" },
    { value: "aspectWide", label: "Aspect ratio · widest" },
    { value: "aspectTall", label: "Aspect ratio · tallest" },
    { value: "aspectSquare", label: "Aspect ratio · squarest" },
    { value: "longest", label: "Duration · longest" },
    { value: "name", label: "Name · A–Z" },
  ];
  const selectedSort = sortOptions.find((option) => option.value === sort) || sortOptions[0];
  const selectItem = (item, event) => {
    if (suppressClick.current) return;
    const additive = event.metaKey || event.ctrlKey || selectionEnabled;
    const currentIndex = items.findIndex(
      (candidate) => candidate.id === item.id,
    );
    const anchorIndex = items.findIndex(
      (candidate) => candidate.id === selectionAnchor.current,
    );
    setSelectedIds((current) => {
      if (event.shiftKey && anchorIndex >= 0 && currentIndex >= 0) {
        const next = additive ? new Set(current) : new Set();
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        items
          .slice(start, end + 1)
          .forEach((candidate) => next.add(candidate.id));
        return next;
      }
      const next = additive ? new Set(current) : new Set();
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    selectionAnchor.current = item.id;
    setSelectionEnabled(true);
  };
  const openOrSelect = (item, event) => {
    if (selectionEnabled || event.metaKey || event.ctrlKey || event.shiftKey) {
      selectItem(item, event);
    } else {
      setViewer(item);
    }
  };
  const beginBoxSelection = (event) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    dragState.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      additive: event.metaKey || event.ctrlKey,
      base: new Set(selectedIds),
      dragging: false,
    };
  };
  const updateBoxSelection = (drag, clientX, clientY) => {
    const box = {
      left: Math.min(drag.x, clientX),
      right: Math.max(drag.x, clientX),
      top: Math.min(drag.y, clientY),
      bottom: Math.max(drag.y, clientY),
    };
    const next = drag.additive ? new Set(drag.base) : new Set();
    galleryRef.current
      ?.querySelectorAll("[data-media-id]")
      .forEach((element) => {
        const card = element.getBoundingClientRect();
        if (
          card.left < box.right &&
          card.right > box.left &&
          card.top < box.bottom &&
          card.bottom > box.top
        ) {
          next.add(Number(element.dataset.mediaId));
        }
      });
    setSelectedIds((current) => {
      if (
        current.size === next.size &&
        [...next].every((itemId) => current.has(itemId))
      ) {
        return current;
      }
      return next;
    });
  };
  const moveBoxSelection = (event) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      !drag.dragging &&
      Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6
    )
      return;
    if (!drag.dragging) {
      drag.dragging = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setSelectionEnabled(true);
    }
    event.preventDefault();
    setDragRect({
      left: Math.min(drag.x, event.clientX),
      top: Math.min(drag.y, event.clientY),
      width: Math.abs(event.clientX - drag.x),
      height: Math.abs(event.clientY - drag.y),
    });
    updateBoxSelection(drag, event.clientX, event.clientY);
  };
  const endBoxSelection = (event) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (!drag.dragging) return setDragRect(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    updateBoxSelection(drag, event.clientX, event.clientY);
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    setSelectionEnabled(true);
    setDragRect(null);
  };
  const cancelBoxSelection = (event) => {
    const drag = dragState.current;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    dragState.current = null;
    if (drag?.dragging) setSelectedIds(new Set(drag.base));
    setDragRect(null);
  };
  const bulkAction = async (action) => {
    const ids = [...selectedIds];
    const selectedBytes = items
      .filter((item) => selectedIds.has(item.id))
      .reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
    if (!ids.length || bulkActionBusy) return;
    if (action === "trash" && !await confirmAction({
      title: `Delete ${ids.length.toLocaleString()} selected items?`,
      message: "They will disappear immediately and remain recoverable in Recently Deleted for 30 days.",
      confirmLabel: "Delete selected",
      danger: true,
    })) return;
    const previousItems = items;
    const previousTotal = total;
    const leavesCurrentView =
      action === "trash" ||
      (action === "review" && !route.params.disposition) ||
      (action === "keep" && route.params.cleanup === "1");
    if (action === "trash") {
      transitionUpdate(() => {
        setItems((current) => current.filter((item) => !selectedIds.has(item.id)));
        setTotal((current) => Math.max(0, current - ids.length));
        setViewer(null);
        setSelectedIds(new Set());
        setSelectionEnabled(false);
        selectionAnchor.current = null;
      });
    } else {
      transitionUpdate(() => {
        setItems((current) =>
          leavesCurrentView
            ? current.filter((item) => !selectedIds.has(item.id))
            : current.map((item) =>
                selectedIds.has(item.id)
                  ? {
                      ...item,
                      favorite:
                        action === "favorite"
                          ? true
                          : action === "unfavorite"
                            ? false
                            : item.favorite,
                      disposition:
                        action === "keep"
                          ? "keep"
                          : action === "review"
                            ? "remove"
                            : item.disposition,
                    }
                  : item,
              ),
        );
        if (leavesCurrentView)
          setTotal((current) => Math.max(0, current - ids.length));
        setSelectedIds(new Set());
        setSelectionEnabled(false);
        selectionAnchor.current = null;
      });
    }
    setBulkActionBusy(action);
    setBulkMessage("");
    setError("");
    try {
      const result = await api("/api/items/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
      });
      if (action === "trash") {
        setBulkMessage(
          `${number.format(result.updated)} ${result.updated === 1 ? "item" : "items"} cleared · ${formatBytes(selectedBytes)} moved out of your active library.`,
        );
        const requestGeneration = ++generation.current;
        loadingRef.current = false;
        load({ reset: true, requestGeneration });
      } else {
        setBulkMessage(
          action === "keep"
            ? `${number.format(result.updated)} liked.`
            : action === "review"
              ? `${number.format(result.updated)} disliked for later review.`
              : `${number.format(result.updated)} favorites updated.`,
        );
      }
    } catch (requestError) {
      setItems(previousItems);
      setTotal(previousTotal);
      setSelectedIds(new Set(ids));
      setSelectionEnabled(true);
      setError(requestError.message);
    } finally {
      setBulkActionBusy("");
    }
  };
  const parentStack = route.parentRoute?.stack || [];
  const breadcrumbs =
    route.crumbs
      ?.slice(0, -1)
      .map((label, index) => ({
        label,
        onClick: () =>
          navigate(
            index < parentStack.length ? parentStack[index] : route.parentRoute,
          ),
      }))
      .filter((crumb) => crumb.onClick) || [];
  const deletionMode = route.params.deletionMode;
  const deletionTitle = deletionMode === "deleted"
    ? "Recently Deleted"
    : deletionMode === "returned"
      ? "Returned Files"
      : route.title;
  const deletionSubtitle = deletionMode === "deleted"
    ? `${number.format(total)} items · Recoverable for 30 days unless erased sooner.`
    : deletionMode === "returned"
      ? `${number.format(total)} items · Files Anthora recognizes from an earlier permanent deletion.`
      : `${number.format(total)} items`;
  const sourcePersonKey = route.personKey || route.params.peopleKey;
  const isScreenshotView = route.params.ai === "downloadedClutter";
  const bookPhotos = selectedBookPhotos(items, selectedIds);
  const normalizedPersonMergeQuery = personMergeQuery.trim().toLocaleLowerCase();
  const personMergeSuggestions = normalizedPersonMergeQuery
    ? personMergePeople
      .filter((person) =>
        person.key !== sourcePersonKey &&
        person.name.toLocaleLowerCase().includes(normalizedPersonMergeQuery),
      )
      .sort((left, right) => {
        const leftStarts = left.name.toLocaleLowerCase().startsWith(normalizedPersonMergeQuery);
        const rightStarts = right.name.toLocaleLowerCase().startsWith(normalizedPersonMergeQuery);
        return Number(rightStarts) - Number(leftStarts) || right.itemCount - left.itemCount;
      })
      .slice(0, 7)
    : [];
  return (
    <div className="page media-page">
      <PageTitle
        breadcrumbs={route.parentRoute ? breadcrumbs : null}
        back={back}
        title={deletionTitle}
        subtitle={deletionSubtitle}
        action={route.params.peopleKey && !deletionMode ? (
          <div className="person-page-actions">
            <button className="page-heading-action" type="button" onClick={renameReviewedPerson}>
              <Pencil size={14} /> Rename
            </button>
            <button className={`page-heading-action ${personMergeOpen ? "selected" : ""}`} type="button" onClick={openPersonMerge}>
              <Users size={15} /> Add to another person
            </button>
          </div>
        ) : null}
      />
      {personMergeOpen && (
        <section className="person-detail-merge" aria-label="Add this person to another person">
          <div>
            <strong>Add {route.title} to an existing person</strong>
            <span>Search by name, check the face, then confirm.</span>
          </div>
          {personMergeTarget ? (
            <div className="person-detail-target">
              <span className="people-merge-avatar">
                {personMergeTarget.coverUrl ? <img src={personMergeTarget.coverUrl} alt="" style={personFaceCropStyle(personMergeTarget)} /> : <Users size={18} />}
              </span>
              <span><small>Selected person</small><strong>{personMergeTarget.name}</strong><em>{number.format(personMergeTarget.itemCount)} photos</em></span>
              <button type="button" aria-label="Choose a different person" onClick={() => setPersonMergeTarget(null)}>Change</button>
            </div>
          ) : (
            <div className="person-detail-search-wrap">
              <label className="person-detail-search">
                <Search size={17} />
                <input
                  autoFocus
                  type="search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-controls="person-detail-suggestions"
                  aria-expanded={Boolean(normalizedPersonMergeQuery)}
                  value={personMergeQuery}
                  onChange={(event) => setPersonMergeQuery(event.target.value)}
                  placeholder="Search existing people…"
                  autoComplete="off"
                />
              </label>
              {normalizedPersonMergeQuery && (
                <div className="person-detail-suggestions" id="person-detail-suggestions" role="listbox">
                  {personMergeSuggestions.length ? personMergeSuggestions.map((person) => (
                    <button key={person.key} type="button" role="option" aria-selected="false" onClick={() => setPersonMergeTarget(person)}>
                      <span className="people-merge-avatar">{person.coverUrl ? <img src={person.coverUrl} alt="" style={personFaceCropStyle(person)} /> : <Users size={18} />}</span>
                      <span><strong>{person.name}</strong><small>{number.format(person.itemCount)} photos</small></span>
                      <span>Choose</span>
                    </button>
                  )) : <p>No existing people match “{personMergeQuery.trim()}”.</p>}
                </div>
              )}
            </div>
          )}
          <button className="person-detail-submit" type="button" disabled={!personMergeTarget || personMergeBusy} onClick={mergeReviewedPerson}>
            {personMergeBusy ? "Adding…" : personMergeTarget ? `Add to ${personMergeTarget.name}` : "Choose a person"}
          </button>
        </section>
      )}
      {isScreenshotView && (
        <ScreenshotOrganizer
          route={route}
          navigate={navigate}
          selectionEnabled={selectionEnabled}
          onToggleSelection={() => {
            if (selectionEnabled) {
              setSelectedIds(new Set());
              selectionAnchor.current = null;
            }
            setSelectionEnabled(!selectionEnabled);
          }}
        />
      )}
      {deletionMode && (
        <button
          className="deletion-view-switch"
          onClick={() => navigate(deletionMode === "deleted"
            ? { ...route, title: "Returned Files", params: { reentry: "1", deletionMode: "returned" } }
            : { ...route, title: "Recently Deleted", params: { trash: "1", deletionMode: "deleted" } })}
        >
          {deletionMode === "deleted" ? "View returned files" : "View recently deleted"}
          <ChevronRight size={14} />
        </button>
      )}
      {route.params.q && searchPlan && <SearchInterpretation plan={searchPlan} />}
      {careScope && !route.params.cleanup && (
        <button
          className="context-care"
          onClick={() => navigate({
            kind: "cleanup",
            title: `Care for ${route.title}`,
            scope: {
              label: route.title,
              params: route.params.folderId
                ? { folderId: route.params.folderId }
                : { peopleKey: route.params.peopleKey },
            },
            parentRoute: route,
            crumbs: [`Care for ${route.title}`],
          })}
        >
          <SlidersHorizontal size={15} /> Care for this collection
        </button>
      )}
      <div className="gallery-controls">
        <div className="gallery-sort" ref={sortMenuRef}>
          <div className="sort-menu">
            <button
              className="sort-trigger"
              type="button"
              aria-haspopup="listbox"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((open) => !open)}
            >
              <SlidersHorizontal size={14} />
              <span className="sort-trigger-copy">
                <small>Sort by</small>
                <strong>{selectedSort?.label}</strong>
              </span>
              <ChevronDown className="sort-chevron" size={14} />
            </button>
            {sortOpen && (
              <div className="sort-options" role="listbox" aria-label="Sort media">
                {sortOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === sort}
                    className={option.value === sort ? "selected" : ""}
                    onClick={() => changeSort(option.value)}
                  >
                    {option.label}
                    {option.value === sort && <Check size={13} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {(route.crumbs?.[0] === "Search" || route.savedSearchId) && (
          <button
            className={route.savedSearchId ? "selected smart-search-save" : "smart-search-save"}
            disabled={Boolean(route.savedSearchId) || smartSearchAction === "saving"}
            onClick={saveSmartSearch}
          >
            <Bookmark size={13} />
            {route.savedSearchId ? "Saved" : smartSearchAction ? "Saving…" : "Save to sidebar"}
          </button>
        )}
        <RotaryControl label="Tile size" value={tileSize} min={140} max={380} step={20} onChange={setTileSize} />
        <div className="layout-switch segmented" role="group" aria-label="Gallery layout">
          <button
            aria-pressed={layout === "masonry"}
            className={layout === "masonry" ? "selected" : ""}
            onClick={() => setLayout("masonry")}
          >
            Masonry
          </button>
          <button
            aria-pressed={layout === "grid"}
            className={layout === "grid" ? "selected" : ""}
            onClick={() => setLayout("grid")}
          >
            Grid
          </button>
        </div>
        <button
          className={showInfo ? "selected" : ""}
          onClick={() => setShowInfo(!showInfo)}
        >
          Info
        </button>
        {!isScreenshotView && (
          <button
            className={selectionEnabled ? "selected" : ""}
            onClick={() => {
              if (selectionEnabled) {
                setSelectedIds(new Set());
                selectionAnchor.current = null;
              }
              setSelectionEnabled(!selectionEnabled);
            }}
          >
            Select
          </button>
        )}
        {route.params.trash === "1" && total > 0 && !permanentAction && !careScope && (
          <button className="empty-deleted-action" onClick={() => setPermanentAction("confirm")}>
            <Trash2 size={14} /> Empty
          </button>
        )}
      </div>
      {isScreenshotView && selectionEnabled && (
        <div className="screenshot-batch-bar" role="toolbar" aria-label="Screenshot batch actions">
          <strong>{number.format(selectedIds.size)} selected</strong>

          <button type="button" onClick={() => setSelectedIds(new Set(items.map((item) => item.id)))}>
            Select loaded
          </button>
          <button type="button" disabled={!selectedIds.size || Boolean(bulkActionBusy)} onClick={() => bulkAction("keep")}>
            <Check size={16} /> Keep
          </button>
          <button className="danger" type="button" disabled={!selectedIds.size || Boolean(bulkActionBusy)} onClick={() => bulkAction("trash")}>
            <Trash2 size={16} /> {bulkActionBusy === "trash" ? "Deleting…" : "Delete selected"}
          </button>
          <button type="button" onClick={() => {
            setSelectedIds(new Set());
            setSelectionEnabled(false);
          }}>Done</button>
        </div>
      )}
      {route.params.faces && faceIndexStatus && (
        <div className="video-index-progress face-index-progress" role="status" aria-live="polite">
          {faceIndexStatus.error ? (
            <strong>Face-index status is temporarily unavailable. Results may be incomplete.</strong>
          ) : (
            <>
              <div>
                <strong>{faceIndexStatus.facesRemaining ? "Face analysis in progress" : "Face analysis is current"}</strong>
                <span>{number.format(faceIndexStatus.facesAnalyzed)} of {number.format(faceIndexStatus.facesTotal)} images</span>
              </div>
              <progress max={faceIndexStatus.facesTotal || 1} value={faceIndexStatus.facesAnalyzed || 0} />
              <small>
                {faceIndexStatus.facesRemaining
                  ? `${number.format(faceIndexStatus.facesRemaining)} images remain. New results appear automatically.`
                  : "Every current image has been checked."}
                {" "}Date · newest uses the media date, not the time Anthora analyzed it.
              </small>
            </>
          )}
        </div>
      )}
      {route.params.disposition === "remove" && total > 0 && !careScope && (
        <>
          <button className="bulk-action" disabled={Boolean(trashAction)} onClick={trashRemoved}>
            <Trash2 size={15} /> {trashAction ? "Deleting…" : "Delete all disliked"}
          </button>
          {trashMessage && <div className="gallery-action-status" role="status" aria-live="polite">{trashMessage}</div>}
        </>
      )}
      {route.params.disposition === "remove" && total === 0 && trashMessage && (
        <div className="gallery-action-status success" role="status" aria-live="polite">{trashMessage}</div>
      )}
      {route.params.trash === "1" && total > 0 && permanentAction === "confirm" && !careScope && (
        <section className="permanent-delete-confirm" aria-label="Confirm permanent deletion">
          <div>
            <strong>Permanently delete {number.format(total)} items?</strong>
            <small>This cannot be undone. Anthora will remember their fingerprints to prevent accidental re-imports.</small>
          </div>
          <button onClick={() => setPermanentAction("")}>Cancel</button>
          <button className="danger" autoFocus onClick={emptyRecentlyDeleted}>
            <Trash2 size={14} /> Delete permanently
          </button>
        </section>
      )}
      {route.params.trash === "1" && permanentMessage && (
        <div className={`gallery-action-status ${total === 0 ? "success" : ""}`} role="status" aria-live="polite">{permanentMessage}</div>
      )}
      {route.params.invalid === "1" && unreadableStats && !careScope && (
        <section className="unreadable-actions" aria-label="Unreadable media actions">
          <button
            onClick={() => runUnreadableAction("recheck")}
            disabled={!unreadableStats.invalidItems || Boolean(unreadableAction)}
          >
            <RefreshCw size={15} /> Check files again
            <small>{number.format(unreadableStats.invalidItems)}</small>
          </button>
          <button
            onClick={() => runUnreadableAction("redownload")}
            disabled={!unreadableStats.recoverableItems || Boolean(unreadableAction)}
          >
            <RefreshCw size={15} /> Redownload all available
            <small>{number.format(unreadableStats.recoverableItems)}</small>
          </button>
          <button
            className="danger"
            onClick={() => runUnreadableAction("trash")}
            disabled={!unreadableStats.unrecoverableItems || Boolean(unreadableAction)}
          >
            <Trash2 size={15} /> Move all without a source to Recently Deleted
            <small>{number.format(unreadableStats.unrecoverableItems)}</small>
          </button>
          {unreadableStats.protectedUnreadableItems > 0 && (
            <p>{number.format(unreadableStats.protectedUnreadableItems)} Liked or Favorite items are protected.</p>
          )}
          {unreadableMessage && <p>{unreadableMessage}</p>}
        </section>
      )}
      <div
        ref={galleryRef}
        className={`selection-surface ${selectionEnabled ? "selection-enabled" : ""}`}
        onPointerDownCapture={beginBoxSelection}
        onPointerMove={moveBoxSelection}
        onPointerUp={endBoxSelection}
        onPointerCancel={cancelBoxSelection}
        onDragStart={(event) => event.preventDefault()}
      >
        {items.length > 0 &&
          (layout === "masonry" ? (
            <MediaSelectionContext.Provider
              value={{ selectedIds, selectionEnabled, showInfo, openOrSelect }}
            >
              <Masonry
                key={`${routeKey}:${galleryRevision}:${tileSize}`}
                items={items}
                itemKey={(item) => item.id}
                columnWidth={tileSize}
                columnGutter={12}
                rowGutter={12}
                overscanBy={4}
                render={MasonryMediaCard}
              />
            </MediaSelectionContext.Provider>
          ) : (
            <div className="uniform-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${tileSize}px), 1fr))` }}>
              {items.map((item) => (
                <MediaCard
                  key={item.id}
                  item={item}
                  width={220}
                  showInfo={showInfo}
                  selected={selectedIds.has(item.id)}
                  selectionEnabled={selectionEnabled}
                  open={(event) => openOrSelect(item, event)}
                />
              ))}
            </div>
          ))}
        {dragRect && <span className="selection-rectangle" style={dragRect} />}
      </div>
      {selectedIds.size > 0 && !isScreenshotView && (
        <div
          className="bulk-selection-bar"
          role="toolbar"
          aria-label="Selected media actions"
        >
          <strong>{number.format(selectedIds.size)} selected</strong>
          <button
            title={selectedIds.size === bookPhotos.length ? "Choose up to 200 photos" : `${bookPhotos.length} selected photos; videos cannot be added to a photo book`}
            disabled={!bookPhotos.length || bookPhotos.length > 200}
            onClick={() => navigate({kind: "books", title: "Books", crumbs: ["Books"], bookContext: {label: "Selected photos"}, bookPhotos})}
          >
            Make a book ({bookPhotos.length})
          </button>
          <button
            onClick={() =>
              setSelectedIds(new Set(items.map((item) => item.id)))
            }
          >
            Select loaded
          </button>
          <button
            disabled={Boolean(bulkActionBusy)}
            title={route.params.cleanup === "1" ? "Keep selected media and remove it from this review queue" : "Like selected media"}
            onClick={() => bulkAction("keep")}
          >
            <ThumbsUp size={16} /> {route.params.cleanup === "1" ? "Keep" : "Like"}
          </button>
          <button
            disabled={Boolean(bulkActionBusy)}
            title="Dislike: save for a later delete decision"
            onClick={() => bulkAction("review")}
          >
            <ThumbsDown size={16} /> Dislike
          </button>
          <button
            disabled={Boolean(bulkActionBusy)}
            title="Add to Favorites"
            onClick={() => bulkAction("favorite")}
          >
            <Heart size={16} /> Favorite
          </button>
          <button className="danger" disabled={Boolean(bulkActionBusy)} onClick={() => bulkAction("trash")}>
            <Trash2 size={16} /> {bulkActionBusy === "trash" ? "Deleting…" : "Delete"}
          </button>
          <button
            className="clear-selection"
            title="Clear selection"
            aria-label="Clear selection"
            onClick={() => {
              setSelectedIds(new Set());
              setSelectionEnabled(false);
            }}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {bulkMessage && (
        <div className="gallery-action-status success" role="status" aria-live="polite">
          {bulkMessage}
        </div>
      )}
      {loading && items.length === 0 && (
        <div className="gallery-skeleton">
          {Array.from(
            { length: route.params.type === "video" ? 8 : 12 },
            (_, index) => (
              <div key={index} />
            ),
          )}
        </div>
      )}
      {!loading && !error && items.length === 0 && route.params.cleanup === "1" && (
        <section className="care-clean-state">
          <span><Check size={28} /></span>
          <div>
            <h2>This review is clear</h2>
            <p>
              {route.params.ai === "lowQuality"
                ? "You have worked through every current low-quality candidate. New items will appear only if a later scan finds something worth checking."
                : "You have reviewed every current item in this queue. New candidates may appear after a future source scan."}
            </p>
          </div>
        </section>
      )}
      {!loading && !error && items.length === 0 && route.params.trash === "1" && (
        <section className="care-clean-state">
          <span><Check size={28} /></span>
          <div>
            <h2>Recently Deleted is empty</h2>
            <p>
              {unreadableStats?.finalizedItems
                ? "You finished clearing this area. Anthora remembers permanently deleted files so it can recognize them if they return later."
                : "There are no files waiting to be restored or permanently erased."}
            </p>
          </div>
        </section>
      )}
      {error && (
        <div className="notice gallery-notice">
          {error}
          <button
            onClick={() =>
              load({
                reset: items.length === 0,
                nextCursor: items.length ? cursor : null,
              })
            }
          >
            Try again
          </button>
        </div>
      )}
      <div ref={sentinel} className="load-more">
        {loading && items.length
          ? "Loading more…"
          : cursor
            ? ""
            : items.length
              ? "End of collection"
              : loading || error
                ? ""
                : route.params.cleanup === "1" ? "" : "Nothing here yet"}
      </div>
      {viewer && (
        <Viewer
          item={viewer}
          items={items}
          folderId={route.params.folderId}
          peopleKey={route.params.peopleKey}
          screenshotMode={isScreenshotView}
          close={() => setViewer(null)}
          navigate={setViewer}
          swipeDirection={viewerSwipeDirection}
          remove={(removedItem) => {
            const previousItems = items;
            const previousTotal = total;
            const removedIndex = items.findIndex((candidate) => candidate.id === removedItem.id);
            const nextViewer = items[removedIndex + 1] || items[removedIndex - 1] || null;
            transitionUpdate(() => {
              setItems((current) => current.filter((candidate) => candidate.id !== removedItem.id));
              setTotal((current) => Math.max(0, current - 1));
              setViewer(nextViewer);
            });
            return () => {
              setItems(previousItems);
              setTotal(previousTotal);
              setViewer(removedItem);
            };
          }}
          update={(next) => {
            const previousItems = items;
            const previousTotal = total;
            const previousViewer = viewer;
            const screenshotCategoryChanged =
              previousViewer?.screenshotCategory !== next.screenshotCategory;
            const leavesScreenshotCategory = Boolean(
              screenshotCategoryChanged &&
              route.params.screenshotCategory &&
              route.params.screenshotCategory !== "saved" &&
              route.params.screenshotCategory !== next.screenshotCategory
            );
            const leavesCurrentView =
              (route.params.cleanup === "1" && next.disposition === "keep") ||
              (!route.params.disposition && next.disposition === "remove") ||
              leavesScreenshotCategory;
            if (leavesCurrentView) {
              const currentIndex = items.findIndex((candidate) => candidate.id === next.id);
              const nextViewer = items[currentIndex + 1] || items[currentIndex - 1] || null;
              transitionUpdate(() => {
                setItems((current) => current.filter((candidate) => candidate.id !== next.id));
                setTotal((current) => Math.max(0, current - 1));
                setViewer(nextViewer);
              });
            } else {
              setViewer(next);
              setItems((xs) => xs.map((x) => (x.id === next.id ? next : x)));
            }
            return () => {
              setItems(previousItems);
              setTotal(previousTotal);
              setViewer(previousViewer);
            };
          }}
        />
      )}
    </div>
  );
}

function SearchInterpretation({ plan }) {
  const details = [
    ...plan.filters,
    plan.semanticQuery &&
    plan.semanticQuery.toLowerCase() !== plan.original.toLowerCase()
      ? `Meaning: ${plan.semanticQuery}`
      : "",
  ].filter(Boolean);
  return (
    <section className="search-interpretation" aria-label="How Anthora interpreted this search">
      <Sparkles size={16} />
      <div>
        <strong>Understood as</strong>
        <span>
          {details.length
            ? details.map((detail) => <i key={detail}>{detail}</i>)
            : <i>{plan.semanticAvailable === false ? "Detected subjects and metadata" : "Semantic meaning · best matches first"}</i>}
        </span>
      </div>
      <small>{plan.semanticAvailable === false
        ? "Detected subjects, OCR, people, metadata, and your choices are ranked together."
        : "Semantic similarity, OCR, people, metadata, and your choices are ranked together."}</small>
    </section>
  );
}

function MasonryMediaCard({ data, width }) {
  const selection = useContext(MediaSelectionContext);
  return (
    <MediaCard
      item={data}
      width={width}
      showInfo={selection.showInfo}
      selected={selection.selectedIds.has(data.id)}
      selectionEnabled={selection.selectionEnabled}
      preserveAspect
      open={(event) => selection.openOrSelect(data, event)}
    />
  );
}

function MediaCard({
  item,
  width,
  open,
  showInfo = false,
  selected = false,
  selectionEnabled = false,
  preserveAspect = false,
}) {
  const ratio = item.width && item.height ? item.height / item.width : 1;
  const [thumbnailAttempt, setThumbnailAttempt] = useState(0);
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false);
  const [thumbnailNearViewport, setThumbnailNearViewport] = useState(false);
  const [thumbnailRequestReady, setThumbnailRequestReady] = useState(false);
  const cardRef = useRef(null);
  const thumbnailReleaseRef = useRef(null);
  useEffect(() => {
    setThumbnailAttempt(0);
    setThumbnailLoaded(false);
    setThumbnailNearViewport(false);
    setThumbnailRequestReady(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        setThumbnailNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "900px" },
    );
    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [item.id]);
  useEffect(() => {
    setThumbnailLoaded(false);
    setThumbnailRequestReady(false);
  }, [thumbnailAttempt]);
  const thumbnailSize = item.mediaType === "video" ? 400 : 600;
  const thumbnailURL = `${item.thumbnailUrl}?size=${thumbnailSize}${
    thumbnailAttempt ? `&attempt=${thumbnailAttempt}` : ""
  }`;
  const height =
    preserveAspect
      ? Math.max(1, width * ratio)
      : item.mediaType === "video"
      ? Math.max(120, width * ratio)
      : Math.max(150, Math.min(width * ratio, width * 1.5));
  const thumbnailFailed = Boolean(item.analysisError) || thumbnailAttempt >= 3;
  useEffect(() => {
    if (!thumbnailNearViewport || thumbnailLoaded || thumbnailFailed) return;
    return scheduleThumbnail((release) => {
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        release();
      };
      thumbnailReleaseRef.current = releaseOnce;
      setThumbnailRequestReady(true);
      // Never let one slow network file block every card behind it. The image
      // request may continue in the browser, but its scheduler slot is freed
      // quickly so cached previews and newly visible cards can proceed.
      setTimeout(releaseOnce, 12_000);
    });
  }, [item.id, thumbnailAttempt, thumbnailLoaded, thumbnailFailed, thumbnailNearViewport]);
  const finishThumbnailRequest = () => {
    thumbnailReleaseRef.current?.();
    thumbnailReleaseRef.current = null;
  };
  return (
    <button
      ref={cardRef}
      data-media-id={item.id}
      aria-pressed={selected}
      className={`media-card ${preserveAspect ? "preserve-aspect" : ""} ${item.mediaType === "video" ? "video-card" : ""} ${showInfo ? "show-info" : ""} ${selected ? "selected" : ""}`}
      style={{
        height,
        "--media-aspect": `${item.width || 1}/${item.height || 1}`,
      }}
      onClick={open}
    >
      {selectionEnabled && (
        <span className="selection-mark">
          {selected && <Check size={15} strokeWidth={3} />}
        </span>
      )}
      {thumbnailFailed ? (
        <span className="media-placeholder">
          {item.analysisError ? <FileWarning size={25} /> : <ImageIcon size={25} />}
          <small>{item.analysisError ? "Unreadable file" : "Preview unavailable"}</small>
        </span>
      ) : thumbnailNearViewport && thumbnailRequestReady ? (
        <>
          {!thumbnailLoaded && (
            <span className="media-loading" aria-hidden="true" />
          )}
          <img
            className={thumbnailLoaded ? "thumbnail-loaded" : "thumbnail-loading"}
            src={thumbnailURL}
            loading="eager"
            draggable={false}
            onLoad={() => {
              finishThumbnailRequest();
              setThumbnailLoaded(true);
            }}
            onError={() => {
              finishThumbnailRequest();
              setThumbnailLoaded(false);
              const retryDelay = Math.min(30_000, 1_500 * 2 ** Math.min(thumbnailAttempt, 4));
              setTimeout(() => setThumbnailAttempt((value) => value + 1), retryDelay);
            }}
          />
        </>
      ) : null}
      {showInfo && <span className="media-actions">
        {item.favorite && <Heart size={15} fill="currentColor" />}
        {item.disposition === "keep" && <ThumbsUp size={15} />}{" "}
        {item.disposition === "remove" && <ThumbsDown size={15} />}
        <span>{item.mediaType}</span>
      </span>}
      {showInfo && (
        <span className="media-info">
          {item.name}
          <small>
            {item.width} × {item.height}
          </small>
        </span>
      )}
    </button>
  );
}

function Viewer({
  item,
  items,
  folderId,
  peopleKey,
  screenshotMode,
  close,
  navigate,
  update,
  remove,
  swipeDirection,
}) {
  const { confirmAction } = useDialog();
  const [faces, setFaces] = useState([]);
  const [people, setPeople] = useState([]);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState("");
  const [pathCopied, setPathCopied] = useState(false);
  const [mediaOnly, setMediaOnly] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [screenshotCategoryOpen, setScreenshotCategoryOpen] = useState(false);
  const [screenshotCategoryBusy, setScreenshotCategoryBusy] = useState("");
  const [personPhotoSet, setPersonPhotoSet] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageLoadError, setImageLoadError] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(1);
  const [flipY, setFlipY] = useState(1);
  const [imageZoom, setImageZoom] = useState({
    active: false,
    pinching: false,
    preset: "fit",
    scale: 1,
    translateX: 0,
    translateY: 0,
  });
  const imageZoomRef = useRef(imageZoom);
  const imagePointersRef = useRef(new Map());
  const pinchStartRef = useRef(null);
  const panStartRef = useRef(null);
  const suppressImageClickRef = useRef(false);
  const suppressImageClickTimerRef = useRef(null);
  const imageRef = useRef(null);
  const videoRef = useRef(null);
  const viewerRootRef = useRef(null);
  const viewerSwipeRef = useRef(null);
  const viewerSwipeTimerRef = useRef(null);
  const viewerSwipeFrameRef = useRef(null);
  const viewerSwipeSequenceRef = useRef(0);
  const viewerSwipePreloadsRef = useRef([]);
  const [viewerSwipe, setViewerSwipe] = useState({
    dragging: false,
    settling: false,
    target: null,
    targetOrigin: 1,
    targetSpan: 0,
  });
  const itemIndex = items.findIndex((candidate) => candidate.id === item.id);
  const previous = itemIndex > 0 ? items[itemIndex - 1] : null;
  const next =
    itemIndex >= 0 && itemIndex < items.length - 1
      ? items[itemIndex + 1]
      : null;
  useEffect(() => {
    const preloads = [];
    for (const candidate of [previous, next]) {
      if (!candidate) continue;
      const preview = new Image();
      preview.src = `${candidate.thumbnailUrl}?size=1200`;
      preloads.push(preview);
    }
    viewerSwipePreloadsRef.current = preloads;
    return () => { viewerSwipePreloadsRef.current = []; };
  }, [previous?.id, next?.id]);
  useEffect(() => {
    const fitted = {
      active: false,
      pinching: false,
      preset: "fit",
      scale: 1,
      translateX: 0,
      translateY: 0,
    };
    imageZoomRef.current = fitted;
    imagePointersRef.current.clear();
    pinchStartRef.current = null;
    panStartRef.current = null;
    suppressImageClickRef.current = false;
    window.clearTimeout(suppressImageClickTimerRef.current);
    window.clearTimeout(viewerSwipeTimerRef.current);
    window.cancelAnimationFrame(viewerSwipeFrameRef.current);
    viewerSwipeSequenceRef.current += 1;
    viewerSwipeRef.current = null;
    const viewerRoot = viewerRootRef.current;
    viewerRoot?.style.removeProperty("--viewer-swipe-x");
    viewerRoot?.style.removeProperty("--viewer-swipe-y");
    viewerRoot?.style.removeProperty("--viewer-swipe-duration");
    setViewerSwipe({ dragging: false, settling: false, target: null, targetOrigin: 1, targetSpan: 0 });
    setImageLoaded(false);
    setImageLoadError(false);
    setMetadataOpen(false);
    setMetadata(null);
    setMetadataError("");
    setPathCopied(false);
    setToolsOpen(false);
    setPeopleOpen(false);
    setScreenshotCategoryOpen(false);
    setScreenshotCategoryBusy("");
    setPersonPhotoSet(false);
    setRotation(0);
    setFlipX(1);
    setFlipY(1);
    setImageZoom(fitted);
  }, [item.id]);
  useEffect(() => () => {
    window.clearTimeout(viewerSwipeTimerRef.current);
    window.cancelAnimationFrame(viewerSwipeFrameRef.current);
  }, []);
  const toggleMetadata = async () => {
    if (metadataOpen) {
      setMetadataOpen(false);
      return;
    }
    setMetadataOpen(true);
    setMetadataError("");
    if (metadata) return;
    try {
      setMetadata(await api(`/api/items/${item.id}/metadata`));
    } catch (requestError) {
      setMetadataError(requestError.message);
    }
  };
  const copySourcePath = async () => {
    if (!metadata?.path) return;
    try {
      await navigator.clipboard.writeText(metadata.path);
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1800);
    } catch {
      setMetadataError("The browser could not copy this path.");
    }
  };
  const chooseScreenshotCategory = async (category) => {
    if (!screenshotMode || screenshotCategoryBusy) return;
    setScreenshotCategoryBusy(category);
    setActionError("");
    try {
      const result = await api(`/api/items/${item.id}/screenshot-category`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
      update({ ...item, screenshotCategory: result.category });
      setScreenshotCategoryOpen(false);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setScreenshotCategoryBusy("");
    }
  };
  useEffect(() => {
    if (item.mediaType !== "image") return;
    Promise.all([api(`/api/items/${item.id}/faces`), api("/api/people")])
      .then(([faceData, peopleData]) => {
        setFaces(faceData.faces);
        setPeople(peopleData.people);
      })
      .catch(() => {});
  }, [item.id, item.mediaType]);
  useEffect(() => {
    const keydown = (event) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft" && previous) {
        event.preventDefault();
        navigate(previous);
      }
      if (event.key === "ArrowRight" && next) {
        event.preventDefault();
        navigate(next);
      }
      if (
        item.mediaType === "video" &&
        (event.key === "," || event.key === ".")
      ) {
        const video = videoRef.current;
        if (!video || !Number.isFinite(video.duration)) return;
        event.preventDefault();
        video.pause();
        const frameDuration = 1 / (item.frameRate || 30);
        const direction = event.key === "." ? 1 : -1;
        video.currentTime = Math.max(
          0,
          Math.min(video.duration, video.currentTime + direction * frameDuration),
        );
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, navigate, previous, next, item.mediaType, item.frameRate]);
  const favorite = async () => {
    const next = !item.favorite;
    setActionError("");
    const rollback = update({ ...item, favorite: next });
    try {
      await api(`/api/items/${item.id}/favorite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: next }),
      });
    } catch (requestError) {
      rollback?.();
      setActionError(requestError.message);
    }
  };
  const disposition = async (value) => {
    setActionError("");
    const rollback = update({ ...item, disposition: value });
    try {
      await api(`/api/items/${item.id}/disposition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
    } catch (requestError) {
      rollback?.();
      setActionError(requestError.message);
    }
  };
  const restore = async () => {
    await api(`/api/items/${item.id}/restore`, { method: "POST" });
    update({ ...item, disposition: null, trashedAt: null });
  };
  const deleteNow = async () => {
    if (!await confirmAction({
      title: "Delete permanently?",
      message: "This file is already in Recently Deleted. Permanent deletion cannot be undone.",
      confirmLabel: "Delete permanently",
      danger: true,
    })) return;
    await api(`/api/items/${item.id}/delete-now`, { method: "POST" });
    close();
  };
  const deleteItem = async () => {
    if (!await confirmAction({
      title: "Delete this item?",
      message: "It will disappear immediately and remain recoverable in Recently Deleted for 30 days.",
      confirmLabel: "Delete",
      danger: true,
    })) return;
    const rollback = remove?.(item);
    try {
      await api("/api/items/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.id], action: "trash" }),
      });
    } catch (requestError) {
      rollback?.();
      setActionError(requestError.message);
    }
  };
  const redownload = async () => {
    if (!await confirmAction({
      title: "Redownload a fresh copy?",
      message: "The replacement is installed only after Anthora validates it. The unreadable original then moves to Recently Deleted.",
      confirmLabel: "Redownload",
    })) return;
    setRecoveryMessage("Requesting a fresh copy…");
    try {
      const result = await api(`/api/items/${item.id}/redownload`, {
        method: "POST",
      });
      setRecoveryMessage("Fresh copy queued. Anthora will validate and reindex it in the background.");
      update({ ...item, recoveryStatus: result.status });
    } catch (requestError) {
      setRecoveryMessage(requestError.message);
    }
  };
  const decideReentry = async (decision) => {
    await api(`/api/items/${item.id}/reentry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    close();
  };
  const useAsCover = async () => {
    await api(`/api/folders/${folderId}/cover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id }),
    });
  };
  const setAsPersonPhoto = async () => {
    setActionError("");
    try {
      await api("/api/people/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personKey: peopleKey, mediaId: item.id }),
      });
      setPersonPhotoSet(true);
      setRecoveryMessage("Person photo updated.");
    } catch (requestError) {
      setActionError(requestError.message);
    }
  };
  const assignFace = async (faceIndex, personKey) => {
    await api(`/api/items/${item.id}/faces/${faceIndex}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personKey: personKey || null }),
    });
    setFaces((current) =>
      current.map((face) =>
        face.index === faceIndex
          ? {
              ...face,
              personKey: personKey || null,
              source: personKey ? "user" : null,
            }
          : face,
      ),
    );
  };
  const changeImageZoom = (update) => {
    setImageZoom((current) => {
      const next = typeof update === "function" ? update(current) : update;
      imageZoomRef.current = next;
      return next;
    });
  };
  const clampImageTranslation = (scale, x, y, width, height) => {
    if (scale <= 1.001) return { x: 0, y: 0 };
    const maxX = Math.max(0, (width * scale - window.innerWidth) / 2);
    const maxY = Math.max(0, (height * scale - window.innerHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };
  const suppressImageClick = () => {
    suppressImageClickRef.current = true;
    window.clearTimeout(suppressImageClickTimerRef.current);
    suppressImageClickTimerRef.current = window.setTimeout(() => {
      suppressImageClickRef.current = false;
    }, 400);
  };
  const fitImage = () => {
    changeImageZoom((current) => ({
      ...current,
      active: false,
      pinching: false,
      preset: "fit",
      scale: 1,
      translateX: 0,
      translateY: 0,
    }));
  };
  const showImageAtActualSize = () => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.offsetWidth) return;
    const scale = Math.max(1, image.naturalWidth / image.offsetWidth);
    changeImageZoom((current) => ({
      ...current,
      active: scale > 1.001,
      pinching: false,
      preset: "actual",
      scale,
      translateX: 0,
      translateY: 0,
    }));
  };
  const toggleImageZoom = (event) => {
    if (suppressImageClickRef.current) return;
    if (imageZoomRef.current.active) {
      // Keep the focal point stable until scale reaches 1. Changing the
      // transform origin during zoom-out makes Safari jump for one frame.
      fitImage();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const clientX = Number.isFinite(event.clientX)
      ? event.clientX
      : bounds.left + bounds.width / 2;
    const clientY = Number.isFinite(event.clientY)
      ? event.clientY
      : bounds.top + bounds.height / 2;
    const scale = 2.5;
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const translation = clampImageTranslation(
      scale,
      (clientX - centerX) * (1 - scale),
      (clientY - centerY) * (1 - scale),
      event.currentTarget.offsetWidth,
      event.currentTarget.offsetHeight,
    );
    changeImageZoom({
      active: true,
      pinching: false,
      preset: "custom",
      scale,
      translateX: translation.x,
      translateY: translation.y,
    });
  };
  const imagePointerDown = (event) => {
    if (event.pointerType !== "touch") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    imagePointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const current = imageZoomRef.current;
    if (imagePointersRef.current.size === 1 && current.scale > 1.001) {
      panStartRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        translateX: current.translateX,
        translateY: current.translateY,
        width: event.currentTarget.offsetWidth,
        height: event.currentTarget.offsetHeight,
        moved: false,
      };
      changeImageZoom((zoom) => ({ ...zoom, pinching: true }));
    }
    if (imagePointersRef.current.size !== 2) return;
    panStartRef.current = null;
    const [first, second] = [...imagePointersRef.current.values()];
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const bounds = event.currentTarget.getBoundingClientRect();
    const midpointX = (first.x + second.x) / 2;
    const midpointY = (first.y + second.y) / 2;
    const centerX = bounds.left + bounds.width / 2 - current.translateX;
    const centerY = bounds.top + bounds.height / 2 - current.translateY;
    pinchStartRef.current = {
      distance: Math.max(distance, 1),
      scale: current.scale,
      centerX,
      centerY,
      contentX:
        (midpointX - centerX - current.translateX) / current.scale,
      contentY:
        (midpointY - centerY - current.translateY) / current.scale,
      width: event.currentTarget.offsetWidth,
      height: event.currentTarget.offsetHeight,
    };
    changeImageZoom((zoom) => ({ ...zoom, pinching: true }));
  };
  const imagePointerMove = (event) => {
    if (
      event.pointerType !== "touch" ||
      !imagePointersRef.current.has(event.pointerId)
    )
      return;
    imagePointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const start = pinchStartRef.current;
    if (start && imagePointersRef.current.size >= 2) {
      event.preventDefault();
      const [first, second] = [...imagePointersRef.current.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const midpointX = (first.x + second.x) / 2;
      const midpointY = (first.y + second.y) / 2;
      const scale = Math.min(
        Math.max(MAX_IMAGE_ZOOM, start.scale),
        Math.max(1, start.scale * (distance / start.distance)),
      );
      const translation = clampImageTranslation(
        scale,
        midpointX - start.centerX - start.contentX * scale,
        midpointY - start.centerY - start.contentY * scale,
        start.width,
        start.height,
      );
      changeImageZoom((zoom) => ({
        ...zoom,
        active: scale > 1.001,
        pinching: true,
        preset: scale <= 1.001 ? "fit" : "custom",
        scale,
        translateX: translation.x,
        translateY: translation.y,
      }));
      return;
    }
    const pan = panStartRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - pan.x;
    const deltaY = event.clientY - pan.y;
    pan.moved ||= Math.hypot(deltaX, deltaY) > 3;
    const current = imageZoomRef.current;
    const translation = clampImageTranslation(
      current.scale,
      pan.translateX + deltaX,
      pan.translateY + deltaY,
      pan.width,
      pan.height,
    );
    changeImageZoom((zoom) => ({
      ...zoom,
      translateX: translation.x,
      translateY: translation.y,
    }));
  };
  const imagePointerEnd = (event) => {
    if (event.pointerType !== "touch") return;
    imagePointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (pinchStartRef.current && imagePointersRef.current.size < 2) {
      const current = imageZoomRef.current;
      const scale = current.scale < 1.08 ? 1 : current.scale;
      const translation = clampImageTranslation(
        scale,
        current.translateX,
        current.translateY,
        event.currentTarget.offsetWidth,
        event.currentTarget.offsetHeight,
      );
      const remaining = [...imagePointersRef.current.entries()][0];
      const final = {
        ...current,
        active: scale > 1.001,
        pinching: Boolean(remaining) && scale > 1.001,
        preset: scale <= 1.001 ? "fit" : current.preset,
        scale,
        translateX: translation.x,
        translateY: translation.y,
      };
      changeImageZoom(final);
      pinchStartRef.current = null;
      suppressImageClick();
      if (remaining && scale > 1.001) {
        const [pointerId, point] = remaining;
        panStartRef.current = {
          pointerId,
          x: point.x,
          y: point.y,
          translateX: final.translateX,
          translateY: final.translateY,
          width: event.currentTarget.offsetWidth,
          height: event.currentTarget.offsetHeight,
          moved: true,
        };
      }
      return;
    }
    const pan = panStartRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panStartRef.current = null;
    changeImageZoom((zoom) => ({ ...zoom, pinching: false }));
    if (pan.moved) suppressImageClick();
  };
  const imageZoomKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleImageZoom(event);
  };
  const viewerTouchStart = (event) => {
    if (viewerSwipe.settling || event.touches.length !== 1 || imageZoomRef.current.scale > 1.001) {
      viewerSwipeRef.current = null;
      return;
    }
    if (event.target.closest("button, input, select, .video-controls, .viewer-metadata, .face-editor, .screenshot-category-editor")) {
      viewerSwipeRef.current = null;
      return;
    }
    const touch = event.touches[0];
    const viewerBounds = viewerRootRef.current?.getBoundingClientRect();
    const axis = swipeDirection === "vertical" ? "vertical" : "horizontal";
    const sequence = ++viewerSwipeSequenceRef.current;
    viewerSwipeRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: performance.now(),
      axis,
      span: axis === "vertical"
        ? (viewerBounds?.height || window.innerHeight)
        : (viewerBounds?.width || window.innerWidth),
      locked: false,
      cancelled: false,
      lastPrimary: 0,
      lastTime: performance.now(),
      velocity: 0,
      target: null,
      sequence,
    };
  };
  const applyViewerSwipeOffset = (primary, axis) => {
    const viewerRoot = viewerRootRef.current;
    if (!viewerRoot) return;
    viewerRoot.style.setProperty("--viewer-swipe-x", `${axis === "horizontal" ? primary : 0}px`);
    viewerRoot.style.setProperty("--viewer-swipe-y", `${axis === "vertical" ? primary : 0}px`);
  };
  const viewerTouchMove = (event) => {
    const start = viewerSwipeRef.current;
    if (!start || start.cancelled || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const primary = start.axis === "vertical" ? deltaY : deltaX;
    const cross = start.axis === "vertical" ? deltaX : deltaY;
    if (!start.locked) {
      if (Math.abs(primary) < 6 && Math.abs(cross) < 6) return;
      if (Math.abs(cross) > Math.abs(primary) * 1.15) {
        start.cancelled = true;
        return;
      }
      if (Math.abs(primary) < Math.abs(cross) * 1.08) return;
      start.locked = true;
    }
    event.preventDefault();
    const target = primary < 0 ? next : previous;
    const resisted = target ? primary : primary * 0.18;
    const now = performance.now();
    const elapsed = Math.max(1, now - start.lastTime);
    const instantVelocity = (primary - start.lastPrimary) / elapsed;
    start.velocity = start.velocity * 0.58 + instantVelocity * 0.42;
    start.lastPrimary = primary;
    start.lastTime = now;
    start.target = target;
    if (viewerSwipe.target?.id !== target?.id || !viewerSwipe.dragging) {
      setViewerSwipe({
        dragging: true,
        settling: false,
        target,
        targetOrigin: primary < 0 ? 1 : -1,
        targetSpan: start.span,
      });
    }
    window.cancelAnimationFrame(viewerSwipeFrameRef.current);
    viewerSwipeFrameRef.current = window.requestAnimationFrame(() => {
      applyViewerSwipeOffset(resisted, start.axis);
    });
  };
  const viewerTouchEnd = (event) => {
    const start = viewerSwipeRef.current;
    viewerSwipeRef.current = null;
    window.cancelAnimationFrame(viewerSwipeFrameRef.current);
    if (!start || !start.locked || start.cancelled || event.changedTouches.length !== 1) {
      applyViewerSwipeOffset(0, start?.axis || swipeDirection);
      setViewerSwipe({ dragging: false, settling: false, target: null, targetOrigin: 1, targetSpan: 0 });
      return;
    }
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const primary = start.axis === "vertical" ? deltaY : deltaX;
    const cross = start.axis === "vertical" ? deltaX : deltaY;
    const target = primary < 0 ? next : previous;
    const committed = Boolean(
      target &&
      Math.abs(primary) > Math.abs(cross) * 1.08 &&
      (Math.abs(primary) >= 68 || (Math.abs(primary) >= 28 && Math.abs(start.velocity) > 0.38))
    );
    // The outgoing item and incoming underlay must stop on the exact same
    // viewport boundary. Overshooting here makes the new item appear to slide
    // past center and then snap backward when React promotes it to current.
    const destination = committed ? Math.sign(primary) * start.span : 0;
    const remaining = Math.abs(destination - primary);
    const settleDuration = Math.round(Math.max(
      150,
      Math.min(280, remaining / Math.max(Math.abs(start.velocity), 0.95)),
    ));
    viewerRootRef.current?.style.setProperty("--viewer-swipe-duration", `${settleDuration}ms`);
    setViewerSwipe({
      dragging: false,
      settling: true,
      target: target || start.target,
      targetOrigin: primary < 0 ? 1 : -1,
      targetSpan: start.span,
    });
    viewerSwipeFrameRef.current = window.requestAnimationFrame(() => {
      if (start.sequence !== viewerSwipeSequenceRef.current) return;
      viewerSwipeFrameRef.current = window.requestAnimationFrame(() => {
        if (start.sequence !== viewerSwipeSequenceRef.current) return;
        applyViewerSwipeOffset(destination, start.axis);
        // Start the handoff clock with the transition, not with touchend. Two
        // queued animation frames can otherwise make navigation fire early.
        viewerSwipeTimerRef.current = window.setTimeout(() => {
          if (start.sequence !== viewerSwipeSequenceRef.current) return;
          if (committed) {
            // Promote the incoming underlay to the current item in one paint.
            // Leaving the completed transform active makes the new item inherit
            // an off-screen position and animate to center a second time.
            viewerRootRef.current?.style.setProperty("--viewer-swipe-duration", "0ms");
            applyViewerSwipeOffset(0, start.axis);
            flushSync(() => {
              setViewerSwipe({ dragging: false, settling: false, target: null, targetOrigin: 1, targetSpan: 0 });
              navigate(target);
            });
          } else {
            setViewerSwipe({ dragging: false, settling: false, target: null, targetOrigin: 1, targetSpan: 0 });
          }
        }, settleDuration + 8);
      });
    });
  };
  const cancelViewerSwipe = () => {
    viewerSwipeSequenceRef.current += 1;
    viewerSwipeRef.current = null;
    window.cancelAnimationFrame(viewerSwipeFrameRef.current);
    viewerRootRef.current?.style.setProperty("--viewer-swipe-duration", "220ms");
    setViewerSwipe((current) => ({ ...current, dragging: false, settling: true }));
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        applyViewerSwipeOffset(0, swipeAxis);
        viewerSwipeTimerRef.current = window.setTimeout(() => {
          setViewerSwipe({ dragging: false, settling: false, target: null, targetOrigin: 1, targetSpan: 0 });
        }, 228);
      });
    });
  };
  const swipeAxis = swipeDirection === "vertical" ? "vertical" : "horizontal";
  const browserCanDisplaySource = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(item.name || "");
  const viewerDisplayUrl = browserCanDisplaySource && !imageLoadError
    ? item.contentUrl
    : `${item.thumbnailUrl}?size=1600`;
  const viewerImageFrameStyle = (candidate) => ({
    width: mediaOnly
      ? `min(100vw, ${100 * ((candidate.width || 1) / (candidate.height || 1))}dvh)`
      : `min(94vw, ${90 * ((candidate.width || 1) / (candidate.height || 1))}vh)`,
    aspectRatio: `${candidate.width || 1}/${candidate.height || 1}`,
  });
  return (
    <div
      ref={viewerRootRef}
      className={`viewer viewer-${item.mediaType} ${mediaOnly ? "viewer-media-only" : ""} ${viewerSwipe.dragging ? "viewer-swipe-dragging" : ""} ${viewerSwipe.settling ? "viewer-swipe-settling" : ""} ${faces.length ? "viewer-has-faces" : ""} ${peopleOpen ? "viewer-people-open" : ""}`}
      data-swipe-direction={swipeAxis}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
      onClickCapture={(event) => {
        if (!mediaOnly) return;
        event.stopPropagation();
        setMediaOnly(false);
      }}
      onTouchStart={viewerTouchStart}
      onTouchMove={viewerTouchMove}
      onTouchEnd={viewerTouchEnd}
      onTouchCancel={cancelViewerSwipe}
    >
      <div className="viewer-top">
        <div className="viewer-title">
          <span>{item.name}</span>
          <small>
            {item.reentryPending
              ? "Previously deleted · Review required"
              : `${item.width} × ${item.height}`}
          </small>
        </div>
        <div className="viewer-actions">
          {folderId && (
            <button title="Use as folder cover" onClick={useAsCover}>
              <ImageIcon size={20} />
            </button>
          )}
          {peopleKey && item.mediaType === "image" && (
            <button
              className={personPhotoSet ? "selected" : ""}
              title={personPhotoSet ? "Person photo" : "Set as person photo"}
              aria-label={personPhotoSet ? "This is the person photo" : "Set as person photo"}
              onClick={setAsPersonPhoto}
            >
              <UserRound size={20} />
            </button>
          )}
          {screenshotMode && (
            <button
              className={screenshotCategoryOpen ? "selected" : ""}
              title="Change screenshot category"
              aria-label="Change screenshot category"
              aria-expanded={screenshotCategoryOpen}
              onClick={() => {
                setMetadataOpen(false);
                setToolsOpen(false);
                setPeopleOpen(false);
                setScreenshotCategoryOpen((open) => !open);
              }}
            >
              <Folder size={20} />
            </button>
          )}
          {item.reentryPending ? (
            <>
              <button
                title="Add anyway"
                aria-label="Add previously deleted media anyway"
                onClick={() => decideReentry("approve")}
              >
                <Check size={20} />
              </button>
              <button
                title="Remove again"
                aria-label="Remove previously deleted media again"
                onClick={() => decideReentry("remove")}
              >
                <Trash2 size={20} />
              </button>
            </>
          ) : item.trashedAt ? (
            <>
              <button title="Restore" onClick={restore}>
                <Undo2 size={20} />
              </button>
              <button title="Delete permanently" onClick={deleteNow}>
                <Trash2 size={20} />
              </button>
            </>
          ) : (
            <>
              <button
                className={item.disposition === "keep" ? "selected" : ""}
                title="Like: mark as an intentional keeper"
                aria-label="Like media"
                onClick={() =>
                  disposition(item.disposition === "keep" ? null : "keep")
                }
              >
                <ThumbsUp size={20} />
              </button>
              <button
                className={item.disposition === "remove" ? "selected" : ""}
                title="Dislike: save for a later delete decision"
                aria-label="Dislike media"
                onClick={() =>
                  disposition(item.disposition === "remove" ? null : "remove")
                }
              >
                <ThumbsDown size={20} />
              </button>
              <button
                title="Delete: move directly to Recently Deleted"
                aria-label="Delete media"
                onClick={deleteItem}
              >
                <Trash2 size={20} />
              </button>
            </>
          )}
          <button
            title="Favorite: add to Favorites"
            aria-label="Toggle favorite"
            onClick={favorite}
          >
            <Heart size={20} fill={item.favorite ? "currentColor" : "none"} />
          </button>
          <button
            className={metadataOpen ? "selected" : ""}
            title="File information"
            aria-label="Show file information"
            aria-expanded={metadataOpen}
            onClick={toggleMetadata}
          >
            <Info size={20} />
          </button>
          {!item.analysisError && (
            <button
              className={toolsOpen ? "selected" : ""}
              title="Adjust view"
              aria-label="Adjust view"
              aria-expanded={toolsOpen}
              onClick={() => {
                setMetadataOpen(false);
                setToolsOpen((open) => !open);
              }}
            >
              <SlidersHorizontal size={20} />
            </button>
          )}
          <button
            title="Show media only"
            aria-label="Show media only"
            onClick={() => {
              setMetadataOpen(false);
              setToolsOpen(false);
              setPeopleOpen(false);
              setMediaOnly(true);
            }}
          >
            <Maximize2 size={20} />
          </button>
          <button title="Close" aria-label="Close viewer" onClick={close}>
            <X size={20} />
          </button>
        </div>
      </div>
      {metadataOpen && (
        <aside className="viewer-metadata" aria-label="File information">
          <header>
            <span>
              <small>File details</small>
              <strong>Source location</strong>
            </span>
            <button aria-label="Close file information" onClick={() => setMetadataOpen(false)}>
              <X size={16} />
            </button>
          </header>
          {!metadata && !metadataError && <div className="viewer-metadata-loading">Locating file…</div>}
          {metadataError && <div className="viewer-metadata-error">{metadataError}</div>}
          {metadata && (
            <>
              <div className="viewer-source-path">
                <span>
                  {metadata.libraryName}
                  <i className={metadata.available ? "available" : "missing"}>
                    {metadata.available ? "Available" : "Unavailable"}
                  </i>
                </span>
                <code title={metadata.path}>{metadata.path}</code>
                <button onClick={copySourcePath}>{pathCopied ? "Copied" : "Copy path"}</button>
              </div>
              <dl className="viewer-metadata-grid">
                <div><dt>Type</dt><dd>{item.mediaType}</dd></div>
                <div><dt>Size</dt><dd>{formatBytes(item.sizeBytes)}</dd></div>
                <div><dt>Dimensions</dt><dd>{item.width || "?"} × {item.height || "?"}</dd></div>
                <div><dt>Folder</dt><dd title={metadata.folderPath}>{metadata.folderPath.split("/").pop()}</dd></div>
              </dl>
              {metadata.linkedLocations.length > 0 && (
                <details className="viewer-linked-locations">
                  <summary>Also appears in {number.format(metadata.linkedLocations.length)} {metadata.linkedLocations.length === 1 ? "location" : "locations"}</summary>
                  <div>
                    {metadata.linkedLocations.map((path) => <code key={path}>{path}</code>)}
                  </div>
                </details>
              )}
            </>
          )}
        </aside>
      )}
      {screenshotCategoryOpen && (
        <aside className="screenshot-category-editor" aria-label="Screenshot category">
          <header>
            <span><small>Screenshot category</small><strong>Where does this belong?</strong></span>
            <button aria-label="Close screenshot categories" onClick={() => setScreenshotCategoryOpen(false)}><X size={17} /></button>
          </header>
          <div>
            {screenshotManualCategories.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={item.screenshotCategory === value ? "selected" : ""}
                disabled={Boolean(screenshotCategoryBusy)}
                onClick={() => chooseScreenshotCategory(value)}
              >
                <span>{label}</span>
                {item.screenshotCategory === value && <Check size={17} />}
              </button>
            ))}
          </div>
          <p>Manual choices override automatic text matching.</p>
        </aside>
      )}
      <button
        className="viewer-nav viewer-previous"
        aria-label="Previous media"
        disabled={!previous}
        onClick={() => previous && navigate(previous)}
      >
        <ChevronLeft />
      </button>
      {viewerSwipe.target && (
        <div
          className={`viewer-swipe-underlay ${swipeAxis}`}
          aria-hidden="true"
          style={{
            "--viewer-target-origin-x": swipeAxis === "horizontal"
              ? `${viewerSwipe.targetOrigin * viewerSwipe.targetSpan}px`
              : "0px",
            "--viewer-target-origin-y": swipeAxis === "vertical"
              ? `${viewerSwipe.targetOrigin * viewerSwipe.targetSpan}px`
              : "0px",
          }}
        >
          <div
            className="viewer-image-shell viewer-swipe-target-shell"
            style={viewerImageFrameStyle(viewerSwipe.target)}
          >
            <img
              className="viewer-swipe-target-preview"
              src={`${viewerSwipe.target.thumbnailUrl}?size=1200`}
              alt=""
            />
          </div>
        </div>
      )}
      {item.analysisError ? (
        <section className="recovery-panel viewer-swipe-media" aria-label="Unreadable media recovery">
          <FileWarning size={34} />
          <div className="eyebrow">File status</div>
          <h2>Unreadable media</h2>
          <p>
            {item.downloadUrlAvailable
              ? "A recovery source is available."
              : "No recovery source was found."}
          </p>
          <small>{item.analysisError}</small>
          {item.recoveryStatus && (
            <div className={`recovery-status ${item.recoveryStatus}`}>
              Recovery {item.recoveryStatus}
              {item.recoveryError && <small>{item.recoveryError}</small>}
            </div>
          )}
          {recoveryMessage && <div className="recovery-message">{recoveryMessage}</div>}
          {actionError && <div className="recovery-message error" role="alert">{actionError}</div>}
          <div className="recovery-actions">
            {item.downloadUrlAvailable && (
              <button onClick={redownload} disabled={["queued", "running"].includes(item.recoveryStatus)}>
                <RefreshCw size={16} /> Redownload fresh copy
              </button>
            )}
            {item.sourceUrl && (
              <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={16} /> Open source
              </a>
            )}
            <button className="danger" onClick={deleteItem}>
              <Trash2 size={16} /> Delete
            </button>
          </div>
          {!item.downloadUrlAvailable && (
            <p className="recovery-source-note">
              No verified source is attached, so Anthora will not guess where to download this file.
            </p>
          )}
        </section>
      ) : item.mediaType === "video" ? (
        <div className="viewer-swipe-media">
          <VideoPlayer
            item={item}
            videoRef={videoRef}
            transform={`rotate(${rotation}deg) scale(${flipX},${flipY})`}
          />
        </div>
      ) : (
        <div
          key={`image-${item.id}`}
          className="viewer-image-shell viewer-swipe-media"
          style={viewerImageFrameStyle(item)}
        >
          <img
            key={`preview-${item.id}`}
            className="viewer-image-preview"
            src={`${item.thumbnailUrl}?size=1200`}
            draggable={false}
            aria-hidden="true"
          />
          <img
            key={`full-${item.id}`}
            ref={imageRef}
            className={`viewer-image ${imageLoaded ? "full-image-loaded" : "full-image-loading"} ${imageZoom.active ? "zoomed" : ""} ${imageZoom.pinching ? "pinching" : ""}`}
            src={viewerDisplayUrl}
            draggable={false}
            role="button"
            tabIndex={0}
            aria-label={imageZoom.active ? "Zoom out" : "Zoom into image"}
            style={{
              "--zoom-scale": imageZoom.scale,
              "--zoom-translate-x": `${imageZoom.translateX}px`,
              "--zoom-translate-y": `${imageZoom.translateY}px`,
              "--media-transform": `rotate(${rotation}deg) scale(${flipX},${flipY})`,
            }}
            onLoad={() => setImageLoaded(true)}
            onError={() => {
              if (!imageLoadError && browserCanDisplaySource) setImageLoadError(true);
            }}
            onClick={toggleImageZoom}
            onKeyDown={imageZoomKeyDown}
            onPointerDown={imagePointerDown}
            onPointerMove={imagePointerMove}
            onPointerUp={imagePointerEnd}
            onPointerCancel={imagePointerEnd}
          />
        </div>
      )}
      {!item.analysisError && toolsOpen && (
        <div className="viewer-tool-dock" aria-label="Media view tools">
          {item.mediaType === "image" && (
            <div className="viewer-zoom-presets" role="group" aria-label="Image zoom">
              <button className={imageZoom.preset === "fit" ? "selected" : ""} title="Fit the whole image in the viewer" onClick={fitImage}>Fit</button>
              <button className={imageZoom.preset === "actual" ? "selected" : ""} title="Show one source pixel per screen pixel" onClick={showImageAtActualSize}>100%</button>
            </div>
          )}
          <div className="viewer-transform-tools" role="group" aria-label="Rotate or flip media">
            <button title="Rotate left" onClick={() => setRotation((value) => value - 90)}><RotateCcw size={15} /></button>
            <button title="Rotate right" onClick={() => setRotation((value) => value + 90)}><RotateCw size={15} /></button>
            <button className={flipX === -1 ? "selected" : ""} title="Flip horizontally" onClick={() => setFlipX((value) => -value)}><FlipHorizontal2 size={15} /></button>
            <button className={flipY === -1 ? "selected" : ""} title="Flip vertically" onClick={() => setFlipY((value) => -value)}><FlipVertical2 size={15} /></button>
          </div>
          {faces.length > 0 && (
            <button
              className={`viewer-people-toggle ${peopleOpen ? "selected" : ""}`}
              title="People in this image"
              aria-label={`People in this image, ${faces.length} ${faces.length === 1 ? "face" : "faces"}`}
              aria-expanded={peopleOpen}
              onClick={() => setPeopleOpen((open) => !open)}
            >
              <Users size={16} /><span>{faces.length}</span>
            </button>
          )}
        </div>
      )}
      {actionError && !item.analysisError && (
        <div className="viewer-action-error" role="alert">{actionError}</div>
      )}
      <button
        className="viewer-nav viewer-next"
        aria-label="Next media"
        disabled={!next}
        onClick={() => next && navigate(next)}
      >
        <ChevronRight />
      </button>
      {faces.length > 0 && peopleOpen && (
        <aside className="face-editor">
          <header>
            <div><strong>People</strong><small>{faces.length} {faces.length === 1 ? "face" : "faces"} in this image</small></div>
            <button aria-label="Close People" onClick={() => setPeopleOpen(false)}><X size={16} /></button>
          </header>
          {faces.map((face) => (
            <label key={face.index}>
              <span>Face {face.index + 1}</span>
              <select
                value={face.personKey || ""}
                onChange={(event) => assignFace(face.index, event.target.value)}
              >
                <option value="">Unassigned</option>
                {people.map((person) => (
                  <option key={person.key} value={person.key}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </aside>
      )}
      {mediaOnly && (
        <button className="viewer-media-only-exit" aria-label="Show viewer controls" title="Show controls">
          <Minimize2 size={18} />
        </button>
      )}
    </div>
  );
}

function VideoPlayer({ item, videoRef, transform }) {
  const timelineRef = useRef(null);
  const resumeAfterScrubRef = useRef(false);
  const [duration, setDuration] = useState(item.durationSeconds || 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [preview, setPreview] = useState({
    visible: false,
    scrubbing: false,
    time: 0,
    left: 0,
  });
  const quality =
    item.width >= 3800 ? "4K source"
      : item.width >= 2500 ? "2.5K source"
        : item.height >= 1080 ? "Full HD source"
          : item.height >= 720 ? "HD source"
            : "Source";
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updateTime = () => setCurrentTime(video.currentTime || 0);
    const updateMetadata = () => setDuration(video.duration || item.durationSeconds || 0);
    const updatePlaying = () => setPlaying(!video.paused);
    const updateDisplay = () => {
      const bounds = video.getBoundingClientRect();
      setDisplaySize({
        width: Math.round(bounds.width * (window.devicePixelRatio || 1)),
        height: Math.round(bounds.height * (window.devicePixelRatio || 1)),
      });
    };
    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("loadedmetadata", updateMetadata);
    video.addEventListener("play", updatePlaying);
    video.addEventListener("pause", updatePlaying);
    const observer = new ResizeObserver(updateDisplay);
    observer.observe(video);
    updateDisplay();
    return () => {
      video.removeEventListener("timeupdate", updateTime);
      video.removeEventListener("loadedmetadata", updateMetadata);
      video.removeEventListener("play", updatePlaying);
      video.removeEventListener("pause", updatePlaying);
      observer.disconnect();
    };
  }, [item.id, item.durationSeconds, videoRef]);
  const timeAtPointer = (event) => {
    const bounds = timelineRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    return { time: ratio * duration, left: ratio * 100 };
  };
  const showPreview = (event, scrubbing = preview.scrubbing) => {
    if (!duration) return;
    const position = timeAtPointer(event);
    setPreview((current) => ({ ...current, ...position, visible: true, scrubbing }));
  };
  const startScrub = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resumeAfterScrubRef.current = Boolean(videoRef.current && !videoRef.current.paused);
    videoRef.current?.pause();
    showPreview(event, true);
  };
  const endScrub = (event) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const position = duration ? timeAtPointer(event) : null;
    if (position && videoRef.current) {
      const video = videoRef.current;
      const resume = resumeAfterScrubRef.current;
      video.currentTime = position.time;
      setCurrentTime(position.time);
      if (resume) {
        const resumePlayback = () => video.play().catch(() => {});
        video.addEventListener("seeked", resumePlayback, { once: true });
      }
    }
    resumeAfterScrubRef.current = false;
    showPreview(event, false);
    window.setTimeout(
      () => setPreview((current) => ({ ...current, visible: false })),
      350,
    );
  };
  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  };
  const displayedTime = preview.scrubbing ? preview.time : currentTime;
  const frameStep = Math.max(0.5, duration / 120);
  const previewFrameTime = Math.round(preview.time / frameStep) * frameStep;
  return (
    <div
      className={`viewer-video-shell custom-video-player ${preview.scrubbing ? "is-scrubbing" : ""}`}
      style={{
        width: `min(94vw, ${90 * ((item.width || 16) / (item.height || 9))}vh)`,
        aspectRatio: `${item.width || 16}/${item.height || 9}`,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        preload="auto"
        poster={`${item.thumbnailUrl}?size=600`}
        src={item.contentUrl}
        style={{ transform }}
        onClick={togglePlayback}
      />
      {preview.visible && (
        <div
          className="video-scrub-preview"
          style={{ left: `${Math.min(88, Math.max(12, preview.left))}%` }}
        >
          <img
            src={`/api/items/${item.id}/frame?time=${previewFrameTime.toFixed(2)}&size=360`}
            aria-hidden="true"
          />
          <span>{formatDuration(preview.time)}</span>
        </div>
      )}
      <div className="video-quality-badge">
        {quality} · {item.width || "?"} × {item.height || "?"}
        {displaySize.width > 0 && ` · Display ${displaySize.width} × ${displaySize.height}`}
      </div>
      <div className="video-controls">
        <button onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span>{formatDuration(displayedTime)}</span>
        <div
          ref={timelineRef}
          className="video-timeline"
          onPointerEnter={showPreview}
          onPointerMove={(event) => showPreview(event)}
          onPointerLeave={() => {
            if (!preview.scrubbing)
              setPreview((current) => ({ ...current, visible: false }));
          }}
          onPointerDown={startScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
        >
          <i style={{ width: `${duration ? (displayedTime / duration) * 100 : 0}%` }} />
          <b style={{ left: `${duration ? (displayedTime / duration) * 100 : 0}%` }} />
        </div>
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}

function SearchPanel({ close, navigate, filters, setFilters }) {
  const {
    query = "",
    type = "",
    favorite = false,
    aiFilter = "",
    aspect = "",
    resolution = "",
    faces = "",
    people = "",
    presentation = "",
    sort = "relevance",
  } = filters;
  const change = (patch) => setFilters((current) => ({ ...current, ...patch }));
  const [status, setStatus] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  useEffect(() => {
    api("/api/ai/status")
      .then(setStatus)
      .catch(() => {});
    api("/api/ai/suggestions")
      .then((data) => setSuggestions(data.suggestions.slice(0, 10)))
      .catch(() => {});
  }, []);
  const analyze = async () => {
    setAnalyzing(true);
    try {
      setStatus(
        await api("/api/ai/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 10 }),
        }),
      );
    } finally {
      setAnalyzing(false);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    const params = { q: query, type, sort };
    if (favorite) params.favorite = "1";
    if (aiFilter) params.ai = aiFilter;
    if (aspect) params.aspect = aspect;
    if (resolution) params.resolution = resolution;
    if (faces) params.faces = faces;
    if (people) params.people = people;
    if (presentation) params.presentation = presentation;
    navigate({
      kind: "media",
      title: searchTitle(filters),
      params,
      crumbs: ["Search"],
    });
    close();
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <form className="search-panel" onSubmit={submit}>
        <div className="search-line">
          <Search />
          <input
            autoFocus
            value={query}
            onChange={(e) => change({ query: e.target.value })}
            placeholder="A person, place, event, topic, or concept…"
          />
          <button type="button" onClick={close}>
            <X />
          </button>
        </div>
        <div className="natural-search-callout">
          <Sparkles size={14} />
          <span>
            {status?.semanticAvailable
              ? "Search naturally by subject, visible text, people, dates, favorites, and media type."
              : "Search filenames, visible text, people, dates, favorites, file types, and detected subjects."}
          </span>
        </div>
        <div className="filter-row">
          <button
            type="button"
            className={type === "" ? "selected" : ""}
            onClick={() => change({ type: "" })}
          >
            All media
          </button>
          <button
            type="button"
            className={type === "image" ? "selected" : ""}
            onClick={() => change({ type: "image" })}
          >
            Images
          </button>
          <button
            type="button"
            className={type === "video" ? "selected" : ""}
            onClick={() => change({ type: "video" })}
          >
            Videos
          </button>
          <button
            type="button"
            className={favorite ? "selected" : ""}
            onClick={() => change({ favorite: !favorite })}
          >
            Favorites
          </button>
          <button
            type="button"
            className={aiFilter === "textHeavy" ? "selected" : ""}
            onClick={() =>
              change({
                aiFilter: aiFilter === "textHeavy" ? "" : "textHeavy",
              })
            }
          >
            Text-heavy images
          </button>
          <button
            type="button"
            className={aiFilter === "screenshot" ? "selected" : ""}
            onClick={() =>
              change({
                aiFilter: aiFilter === "screenshot" ? "" : "screenshot",
              })
            }
          >
            Screenshots
          </button>
          <button
            type="button"
            className="clear-filters"
            onClick={() => setFilters(defaultSearchFilters)}
          >
            Clear
          </button>
        </div>
        <div className="advanced-filters">
          <select
            value={aspect}
            onChange={(e) => change({ aspect: e.target.value })}
          >
            <option value="">Any shape</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
            <option value="square">Square</option>
          </select>
          <select
            value={resolution}
            onChange={(e) => change({ resolution: e.target.value })}
          >
            <option value="">Any resolution</option>
            <option value="large">8 MP and up</option>
            <option value="medium">2-8 MP</option>
            <option value="small">Under 2 MP</option>
          </select>
          <select
            value={faces}
            onChange={(e) => change({ faces: e.target.value })}
          >
            <option value="">Any faces</option>
            <option value="1">Has faces</option>
            <option value="many">Multiple faces</option>
            <option value="0">No faces</option>
          </select>
          <select
            value={people}
            onChange={(e) => change({ people: e.target.value })}
          >
            <option value="">Any people</option>
            <option value="1">People detected</option>
            <option value="0">No people detected</option>
          </select>
          {status?.semanticAvailable && (
            <select
              value={presentation}
              onChange={(e) => change({ presentation: e.target.value })}
            >
              <option value="">Any visual presentation</option>
              <option value="feminine">Feminine-presenting · strong matches</option>
              <option value="masculine">Masculine-presenting · strong matches</option>
            </select>
          )}
          <label className="sort-filter">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(e) => change({ sort: e.target.value })}
            >
              <option value="relevance">Best match / newest</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="largest">Largest files</option>
              <option value="smallest">Smallest files</option>
              <option value="resolution">Highest resolution</option>
              <option value="aspectWide">Widest aspect ratio</option>
              <option value="aspectTall">Tallest aspect ratio</option>
              <option value="aspectSquare">Closest to square</option>
              <option value="longest">Longest videos</option>
              <option value="name">Name A-Z</option>
            </select>
          </label>
        </div>
        {status?.semanticAvailable && <div className="search-preset-groups">
          {[
            ["Subjects", subjectPresets],
            ["Appearance", appearancePresets],
            ["Composition & color", visualPresets],
          ].map(([title, presets]) => (
            <section className="subject-presets" key={title}>
              <span>{title}</span>
              <div>
                {presets.map(([label, value]) => (
                  <button
                    type="button"
                    key={label}
                    className={query === value ? "selected" : ""}
                    onClick={() => change({ query: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
          ))}
          <p className="appearance-note">
            Appearance matches are visual estimates affected by lighting, styling, and model confidence. They remain search filters, never identity labels.
          </p>
        </div>}
        {suggestions.length > 0 && (
          <div className="suggestion-row">
            {suggestions.map((item) => (
              <button
                type="button"
                key={item.name}
                onClick={() => change({ query: item.name })}
              >
                {item.name.replaceAll("_", " ")}
                <small>{item.item_count}</small>
              </button>
            ))}
          </div>
        )}
        {status && (
          <div className="ai-status">
            <span>
              <Sparkles size={15} />
              {status.semanticAvailable && <><strong>{status.semanticAnalyzed.toLocaleString()}</strong> semantic · </>}
              <strong>{(status.ocrSearchAnalyzed || 0).toLocaleString()}</strong> searchable text
              · {status.total.toLocaleString()} total
            </span>
            {status.remaining > 0 && (
              <button type="button" disabled={analyzing} onClick={analyze}>
                {analyzing ? "Analyzing…" : "Analyze next 10"}
              </button>
            )}
          </div>
        )}
        <div className="search-hint">
          <span>
            {presentation
              ? "Visual-presentation results are estimates, not identity labels"
              : `AI filters improve as ${brand.appName} finishes analysis`}
          </span>
          <button type="submit">Search</button>
        </div>
      </form>
    </div>
  );
}

function SettingsPage({
  appearance,
  setAppearance,
  homeRows,
  setHomeRows,
  defaultMediaSort,
  setDefaultMediaSort,
  defaultPeopleSort,
  setDefaultPeopleSort,
  viewerSwipeDirection,
  setViewerSwipeDirection,
}) {
  const license = useLicense();
  return (
    <section className="page settings-page">
      <header className="page-heading">
        <h1>Settings</h1>
        <p>Choose how Anthora looks and how your library opens.</p>
      </header>
      <div className="settings-list">
        <div className="settings-row"><div className="settings-copy"><strong>Anthora</strong><small>Free, including Books, PDF export, and cleanup tools.</small></div></div>
        <div className="settings-row">
          <div className="settings-copy">
            <strong>Appearance</strong>
            <small>Follow your Mac or choose a fixed appearance.</small>
          </div>
          <div className="segmented">
            {[
              ["system", Columns3, "System"],
              ["light", Sun, "Light"],
              ["dark", Moon, "Dark"],
            ].map(([value, Icon, label]) => (
              <button
                key={value}
                className={appearance === value ? "selected" : ""}
                aria-pressed={appearance === value}
                onClick={() => setAppearance(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="settings-row toggle-line">
          <span className="settings-copy">
            <strong>Home highlights</strong>
            <small>Show recent and favorite media below collections</small>
          </span>
          <input
            type="checkbox"
            checked={homeRows}
            onChange={(e) => setHomeRows(e.target.checked)}
          />
        </label>
        <label className="settings-row">
          <span className="settings-copy">
            <strong>All Media default sort</strong>
            <small>Choose the order used when All Media opens.</small>
          </span>
          <select
            className="settings-select"
            value={defaultMediaSort}
            onChange={(event) => setDefaultMediaSort(event.target.value)}
          >
            {defaultMediaSortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span className="settings-copy">
            <strong>People default sort</strong>
            <small>Choose the order used when People opens.</small>
          </span>
          <select
            className="settings-select"
            value={defaultPeopleSort}
            onChange={(event) => setDefaultPeopleSort(event.target.value)}
          >
            {peopleSortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span className="settings-copy">
            <strong>Viewer swipe direction</strong>
            <small>Vertical uses an up-and-down, full-screen browsing motion.</small>
          </span>
          <select className="settings-select" value={viewerSwipeDirection} onChange={(event) => setViewerSwipeDirection(event.target.value)}>
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        </label>
        <div className="settings-row settings-support">
          <span className="settings-copy">
            <strong>Feedback</strong>
            <small>No media, filenames, or library content are attached.</small>
          </span>
          <a
            href="https://github.com/barryanders/Anthora/issues"
            target="_blank"
            rel="noreferrer"
          >
            Report a problem <ExternalLink size={14} />
          </a>
        </div>
      </div>
    </section>
  );
}

function SkeletonCards() {
  return (
    <div className="collection-grid">
      {Array.from({ length: 8 }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <AppErrorBoundary>
    <DialogProvider>
      <App />
    </DialogProvider>
  </AppErrorBoundary>,
);
