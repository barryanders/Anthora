import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./books-fonts.css";
import { loadBookFonts } from "./books-typography.js";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  LoaderCircle,
  Plus,
  Search,
  Undo2,
  Redo2,
  X,
  Trash2,
  Images,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  templates,
  formats,
  coverStyles,
  bookFormat,
  bookStyle,
  bookColors,
  layouts,
  ornaments,
  capacity,
  page,
  newBook,
  autoFill,
  changeLayout,
  photoURL,
  boxes,
  cropPercent,
  duplicatePage,
  duplicateBook,
  reorderPages,
} from "./books-model";
import "./books.css";
import BookPrinting from "./BookPrinting";
import { exportedBookKey } from "./book-printing";
import { preparedText } from "./books-render";
import { samplePhoto } from "./books-samples";
const noop = () => {};
async function api(url, body) {
  const response = await fetch(
    url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const result = await response.json();
  if (!response.ok) {
    if (result.code === "license_required") window.dispatchEvent(new CustomEvent("anthora-license-required"));
    throw new Error(result.error || "Something went wrong. Please try again.");
  }
  return result;
}
function Photo({ photo, decorative = false }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photo?.id]);
  if (!photo || failed)
    return (
      <span className="bk-photo-empty">
        {failed ? <AlertCircle size={22} /> : <ImagePlus size={26} />}
        <span>{failed ? "Photo unavailable" : "Add a photo"}</span>
      </span>
    );
  return (
    <img
      src={photoURL(photo)}
      alt={decorative ? "" : photo.name}
      draggable={false}
      style={{
        objectFit: photo.fit === "fill" ? "cover" : "contain",
        objectPosition:
          photo.fit === "fill"
            ? `${cropPercent(photo.cropX)}% ${cropPercent(photo.cropY)}%`
            : "50% 50%",
      }}
      onError={() => setFailed(true)}
    />
  );
}
export function Sheet({
  book,
  index,
  mini = false,
  demo = false,
  samplePhotos = false,
  slot,
  onSlot,
  onDrop,
}) {
  const [, fontsChanged] = useState(false);
  useEffect(() => {
    let active = true;
    loadBookFonts().then(() => { if (active) fontsChanged(true); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const p = book.pages[index],
    style = bookStyle(book, index),
    format = bookFormat(book),
    text = preparedText(book, index);
  return (
    <div
      data-format={book.format || "square"}
      data-cover-style={index === 0 ? book.coverStyle || "classic" : undefined}
      className={`bk-sheet ${mini ? "bk-mini" : ""} ${index === 0 ? "bk-cover" : ""} ${index === 0 && book.title.length > 45 ? "bk-long-title" : ""}`}
      style={{
        aspectRatio: `${format.width} / ${format.height}`,
        background: style.color,
        color: style.ink,
        "--bk-book-font": style.font,
      }}
    >
      {ornaments(
        book.template,
        index === 0 &&
          ["classic", "inset"].includes(book.coverStyle || "classic"),
      ).map((o, i) => (
        <span
          key={`ornament-${i}`}
          aria-hidden="true"
          className="bk-ornament"
          style={{
            left: `${o.x}%`,
            top: `${o.y}%`,
            width: `${o.w}%`,
            height: `${o.h}%`,
            border: o.outline ? `1px solid ${style.accent}` : undefined,
            borderRadius: o.round ? "50%" : undefined,
            background: o.round ? style.accent : undefined,
            color: style.accent,
          }}
        >
          {o.heart ? "♥" : null}
        </span>
      ))}
      {boxes(
        p.layout,
        book.template,
        index === 0,
        Boolean(p.heading),
        book.coverStyle,
      ).map(([x, y, w, h], i) => {
        const sample =
          demo && samplePhotos
            ? samplePhoto(
                book.template,
                index,
                i,
                w * format.width,
                h * format.height,
              )
            : null;
        const contents = demo ? (
          sample ? (
            <span
              className="bk-sample-photo"
              role={mini ? undefined : "img"}
              aria-label={
                mini ? undefined : `Sample photo: ${sample.description}`
              }
              aria-hidden={mini || undefined}
              style={{
                backgroundImage: `url("${sample.url}")`,
                backgroundPosition: sample.position,
                width: sample.width,
                height: sample.height,
              }}
            />
          ) : (
            <span
              className={`bk-demo-art bk-demo-art-${i % 3}`}
              style={{ "--art-color": style.accent }}
            >
              <i />
              <b />
            </span>
          )
        ) : (
          <Photo photo={p.photos[i]} decorative={mini} />
        );
        const position = {
          left: `${x}%`,
          top: `${y}%`,
          width: `${w}%`,
          height: `${h}%`,
        };
        return mini || !onSlot ? (
          <div className="bk-photo-slot" style={position} key={i}>
            {contents}
          </div>
        ) : (
          <button
            key={i}
            className={`bk-photo-slot ${slot === i ? "is-target" : ""}`}
            style={position}
            onClick={() => onSlot(i)}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(i, Number(e.dataTransfer.getData("text/anthora-photo")));
            }}
            aria-label={`Photo space ${i + 1}${p.photos[i] ? `: ${p.photos[i].name}` : ": empty"}`}
          >
            <span className="bk-photo-content">{contents}</span>
            <span className="bk-slot-action">
              <ImagePlus size={16} /> {p.photos[i] ? "Replace" : "Choose photo"}
            </span>
          </button>
        );
      })}
      {index === 0 && book.coverStyle === "full" && (
        <span className="bk-cover-scrim" />
      )}
      {text.map((block, i) => (
        <div
          key={i}
          className="bk-typeset"
          style={{
            left: `${block.box[0]}%`,
            top: `${block.box[1]}%`,
            width: `${block.box[2] / (block.widthScale || 1)}%`,
            transform: block.widthScale ? `scaleX(${block.widthScale})` : undefined,
            transformOrigin: "left top",
            color: block.ink,
            fontFamily: block.font,
            fontWeight: block.weight || 400,
            fontStyle: block.italic ? "italic" : "normal",
            fontSize: `${block.size / 10}cqw`,
            lineHeight: block.leading || 1.25,
            textAlign: block.align || "left",
          }}
        >
          {block.lines.join("\n")}
        </div>
      ))}
      {index > 0 && p.layout === "story" && !p.text && !mini && !demo && (
        <span className="bk-story-placeholder">
          Write your story in the page panel.
        </span>
      )}
    </div>
  );
}
function LayoutIcon({ layout }) {
  return (
    <span className="bk-layout-icon">
      {layout === "story" && <span className="bk-text-layout">Aa</span>}
      {layouts[layout].areas.map(([x, y, w, h], i) => (
        <i
          key={i}
          style={{
            position: "absolute",
            left: `${x}%`,
            top: `${y}%`,
            width: `${w}%`,
            height: `${h}%`,
          }}
        />
      ))}
    </span>
  );
}
function SampleToggle({ checked, onChange }) {
  return (
    <button
      type="button"
      className="bk-sample-toggle"
      role="switch"
      aria-checked={checked}
      aria-label="Show sample photos"
      onClick={() => onChange(!checked)}
    >
      <span>Sample photos</span>
      <span className="bk-switch-track" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}
function ColorPicker({ value, onChange, defaultColor }) {
  return (
    <div className="bk-color-picker">
      <div className="bk-color-swatches" role="group" aria-label="Book colors">
        {bookColors.map((color) => (
          <button
            type="button"
            key={color.value}
            aria-label={`${color.name} book color`}
            aria-pressed={value?.toLowerCase() === color.value}
            title={color.name}
            onClick={() => onChange(color.value)}
            style={{ background: color.value }}
          >
            {value?.toLowerCase() === color.value && (
              <Check
                size={16}
                style={{
                  color: bookStyle({ template: "album", color: color.value })
                    .ink,
                }}
              />
            )}
          </button>
        ))}
      </div>
      <div className="bk-custom-color">
        <label>
          Custom color{" "}
          <input
            type="color"
            aria-label="Custom book color"
            value={value || defaultColor}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <button
          className="bk-text-button"
          type="button"
          onClick={() => onChange(defaultColor)}
        >
          Design color
        </button>
      </div>
    </div>
  );
}
function FormatPicker({ value, onChange, compact = false }) {
  return (
    <div
      className={`bk-format-picker ${compact ? "is-compact" : ""}`}
      role="group"
      aria-label="Book size"
    >
      {Object.entries(formats).map(([key, f]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          aria-label={`${f.name}, ${f.detail}`}
          onClick={() => onChange(key)}
        >
          <span
            className="bk-format-shape"
            style={{
              aspectRatio: `${f.width} / ${f.height}`,
              width: `${Math.min(28, (25 * f.width) / f.height)}px`,
            }}
          />
          <span>
            <strong>{f.name}</strong>
            <small>{f.detail}</small>
          </span>
          {value === key && <Check size={13} />}
        </button>
      ))}
    </div>
  );
}
export default function Books({
  initialPhotos = [],
  initialContext = null,
  canCreate = false,
  onUpgrade = noop,
  onDirty = noop,
  confirmAction,
}) {
  const [saved, setSaved] = useState([]),
    [loadingBooks, setLoadingBooks] = useState(true),
    [book, setBook] = useState(null),
    [step, setStep] = useState("home"),
    [template, setTemplate] = useState("album"),
    [title, setTitle] = useState(""),
    [active, setActive] = useState(0),
    [pool, setPool] = useState(
      initialPhotos.filter((p) => p.mediaType === "image"),
    ),
    [results, setResults] = useState(
      initialPhotos.filter((p) => p.mediaType === "image").map((p) => p.id),
    ),
    [chosen, setChosen] = useState(
      new Set(
        initialPhotos.filter((p) => p.mediaType === "image").map((p) => p.id),
      ),
    ),
    [slot, setSlot] = useState(null),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState(null),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [history, setHistory] = useState([]),
    [future, setFuture] = useState([]),
    [drawer, setDrawer] = useState(false),
    [review, setReview] = useState(false),
    [loadAttempted, setLoadAttempted] = useState(false);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step]);
  const [showSamplePhotos, setShowSamplePhotos] = useState(() => {
    try {
      return localStorage.getItem("anthora.books.samplePhotos") !== "false";
    } catch {
      return true;
    }
  });
  function changeSamplePhotos(value) {
    setShowSamplePhotos(value);
    try {
      localStorage.setItem("anthora.books.samplePhotos", String(value));
    } catch {
      /* The preference remains usable for this session. */
    }
  }
  const [formatFilter, setFormatFilter] = useState("All shapes");
  const [selectedColor, setSelectedColor] = useState("#ffffff");
  const [selectedFormat, setSelectedFormat] = useState("square");
  const [exportQuality, setExportQuality] = useState("print");
  const [bleed, setBleed] = useState(false);
  const [savedExport, setSavedExport] = useState(null);
  const [pendingPDF, setPendingPDF] = useState(null);
  const [cancelExport, setCancelExport] = useState(null);
  const [category, setCategory] = useState("All designs");
  const [designIndex, setDesignIndex] = useState(0);
  const [photoOrder, setPhotoOrder] = useState("date");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [dragPage, setDragPage] = useState(null);
  const [dropPage, setDropPage] = useState(null);
  const cropGesture = useRef(false);
  const filmstrip = useRef(null);
  const requestId = useRef(0),
    fileInput = useRef(null),
    bookRef = useRef(book);
  bookRef.current = book;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    let alive = true;
    api("/api/books")
      .then((d) => {
        if (alive) setSaved(d.books);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoadingBooks(false);
      });
    return () => {
      alive = false;
      requestId.current++;
    };
  }, []);
  useEffect(() => {
    const warn = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (step === "photos" && !loadAttempted && !pool.length) load();
  }, [step]);
  useEffect(() => {
    if (review) {
      fileInput.current?.focus();
      const key = (e) => {
        if (e.key === "Escape" && !busy) setReview(false);
      };
      window.addEventListener("keydown", key);
      return () => window.removeEventListener("keydown", key);
    }
  }, [review, busy]);
  useEffect(() => {
    if (!review) return;
    const overflow = document.body.style.overflow;
    const focus = document.activeElement;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (focus?.isConnected) focus.focus();
    };
  }, [review]);
  function update(next, remember = true) {
    if (remember && book) setHistory((h) => [...h.slice(-39), book]);
    setFuture([]);
    setBook(next);
    setDirty(true);
    setMessage("");
    setError("");
  }
  function patchPage(patch, remember = true) {
    update(
      {
        ...book,
        pages: book.pages.map((p, i) =>
          i === active ? { ...p, ...patch } : p,
        ),
      },
      remember,
    );
  }
  useEffect(() => {
    const end = () => {
      cropGesture.current = false;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);
  function beginCrop() {
    cropGesture.current = true;
    setHistory((h) => [...h.slice(-39), book]);
  }
  function adjustCrop(axis, value) {
    patchPage(
      {
        photos: current.photos.map((p, i) =>
          i === slot ? { ...p, [axis]: Number(value) } : p,
        ),
      },
      !cropGesture.current,
    );
  }

  function changePage(i) {
    setActive(i);
    setSlot(null);
  }
  function undo() {
    if (!history.length) return;
    setFuture((f) => [book, ...f]);
    const previous = history.at(-1);
    setHistory((h) => h.slice(0, -1));
    setBook(previous);
    setActive((i) => Math.min(i, previous.pages.length - 1));
    setSlot(null);
    setDirty(true);
  }
  function redo() {
    if (!future.length) return;
    setHistory((h) => [...h, book]);
    const next = future[0];
    setFuture((f) => f.slice(1));
    setBook(next);
    setActive((i) => Math.min(i, next.pages.length - 1));
    setSlot(null);
    setDirty(true);
  }
  async function load(more = false, search = query) {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    setLoadAttempted(true);
    try {
      const params = new URLSearchParams({
        type: "image",
        limit: "60",
        q: search,
      });
      if (more && cursor) params.set("cursor", cursor);
      const d = await api("/api/items?" + params);
      if (id !== requestId.current) return;
      setPool((old) => [
        ...new Map([...old, ...d.items].map((p) => [p.id, p])).values(),
      ]);
      setResults((old) =>
        more
          ? [...new Set([...old, ...d.items.map((p) => p.id)])]
          : d.items.map((p) => p.id),
      );
      setCursor(d.nextCursor);
    } catch (e) {
      if (id === requestId.current) setError(e.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }
  async function save() {
    if (!canCreate) { onUpgrade(); return false; }
    const snapshot = book;
    setBusy(true);
    setError("");
    try {
      await api("/api/books", snapshot);
      setSaved((old) => [snapshot, ...old.filter((b) => b.id !== snapshot.id)]);
      if (bookRef.current === snapshot) {
        setDirty(false);
        setMessage("All changes saved");
      }
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function copySavedBook(original) {
    if (!canCreate) { onUpgrade(); return false; }
    setBusy(true);
    setError("");
    try {
      const copy = duplicateBook(original);
      await api("/api/books", copy);
      setSaved((old) => [copy, ...old]);
      setMessage("Copy saved. Open it to make a different version.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function removeSavedBook(original) {
    if (
      !(await confirmAction({
        title: "Remove saved book?",
        message: `Remove “${original.title}” from your saved books? Your photos stay in your library.`,
        confirmLabel: "Remove book",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/books/${original.id}/remove`, {});
      setSaved((old) => old.filter((b) => b.id !== original.id));
      setMessage("Book removed.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function leave() {
    if (
      dirty &&
      !(await confirmAction({
        title: "Leave this book?",
        message: "Your unsaved changes will be lost.",
        confirmLabel: "Leave book",
      }))
    )
      return;
    setBook(null);
    setStep("home");
    setDirty(false);
    setHistory([]);
    setFuture([]);
    setMessage("");
    setError("");
    setReview(false);
  }
  function openBook(b) {
    setBook(b);
    setStep("editor");
    setActive(0);
    setSlot(null);
    setHistory([]);
    setFuture([]);
    setDirty(false);
    setMessage("");
    setError("");
    const photos = b.pages.flatMap((p) => p.photos).filter(Boolean);
    setPool((old) => [
      ...new Map([...old, ...photos].map((p) => [p.id, p])).values(),
    ]);
    setResults([...new Set(photos.map((p) => p.id))]);
    setChosen(new Set(photos.map((p) => p.id)));
    setQuery("");
    setCursor(null);
    load(false, "");
  }
  function create(manual = false) {
    if (chosen.size > 200) {
      setError("Choose up to 200 photos for one book.");
      return;
    }
    const b = newBook(
      template,
      manual
        ? []
        : [...chosen]
            .map((id) => pool.find((p) => p.id === id))
            .filter(Boolean),
      photoOrder,
    );
    b.format = selectedFormat;
    b.color = selectedColor;
    b.title = title.trim() || templates[template].title;
    update(b, false);
    setHistory([]);
    setStep("editor");
    setActive(0);
    setDrawer(false);
    setSlot(null);
  }
  function toggle(id) {
    setChosen((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else if (next.size < 200) next.add(id);
      else setError("You can select up to 200 photos.");
      return next;
    });
  }
  function place(target, id) {
    const photo = pool.find((p) => p.id === id);
    if (!photo || target === null || busy) return;
    patchPage({
      photos: current.photos.map((p, i) =>
        i === target ? { ...photo, fit: "fit" } : p,
      ),
    });
    setSlot(null);
    setMessage("Photo placed. You can undo this change.");
  }
  function move(delta) {
    update(reorderPages(book, active, active + delta));
    changePage(active + delta);
  }
  function dropAt(event, target) {
    event.preventDefault();
    const from = book.pages.findIndex(
      (p) => p.id === event.dataTransfer.getData("text/anthora-page"),
    );
    if (from >= 0 && from !== target) {
      update(reorderPages(book, from, target));
      changePage(target);
    }
    setDragPage(null);
    setDropPage(null);
  }
  async function refill() {
    if (!chosen.size) {
      setError("Select photos in the photo picker first.");
      setStep("photos");
      return;
    }
    if (
      !(await confirmAction({
        title: "Make a new arrangement?",
        message:
          "Pages and captions will be replaced. You can undo this change.",
        confirmLabel: "Arrange photos",
      }))
    )
      return;
    update({
      ...book,
      pages: autoFill(
        [...chosen].map((id) => pool.find((p) => p.id === id)).filter(Boolean),
        book.template,
        photoOrder,
      ),
    });
    setActive(0);
    setSlot(null);
    setStep("editor");
  }
  useEffect(() => {
    const nav = filmstrip.current,
      item = nav?.querySelector('[aria-current="page"]');
    if (item)
      nav.scrollTo({
        left:
          item.offsetLeft -
          nav.offsetLeft -
          nav.clientWidth / 2 +
          item.offsetWidth / 2,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }, [active]);
  const current = book?.pages[active],
    used = new Set(
      book?.pages
        .flatMap((p) => p.photos)
        .filter(Boolean)
        .map((p) => p.id) || [],
    ),
    empty =
      book?.pages.reduce((n, p) => n + p.photos.filter((v) => !v).length, 0) ||
      0;
  const previews = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(templates).map((key) => {
          const b = newBook(key);
          const words = {
            coast:
              "We left on Friday with no plans beyond the sea. There was coffee on the balcony, a road that followed the coast, and a little place we went back to twice.\n\nThese are the parts we want to remember.",
            vows: "I love the life we have made together: the ordinary mornings, the long conversations, the way you make a room feel like home.\n\nToday, in front of our favorite people, we begin the next part.",
            journal:
              "The walk took twice as long because every stone needed inspecting. We brought three home, along with a leaf and a story about a dragon.\n\nI hope we always make time for days like this.",
            monograph:
              "Photographs made slowly, with attention to the space between things. Light on stone. The shape of a shadow. A place seen again, a little differently.\n\nA selection from the ongoing series.",
          };
          b.pages = b.pages.map((p) =>
            p.layout === "story" ? { ...p, text: words[key] || "" } : p,
          );
          return [key, b];
        }),
      ),
    [],
  );
  const design = templates[template],
    preview = {
      ...previews[template],
      format: selectedFormat,
      color: selectedColor,
    };
  const arrangedCount = useMemo(
    () =>
      chosen.size
        ? autoFill(
            [...chosen]
              .map((id) => pool.find((p) => p.id === id))
              .filter(Boolean),
            template,
            photoOrder,
          ).length
        : 0,
    [chosen, pool, template, photoOrder],
  );
  function picker(selectMode) {
    const visible = [...new Set(results)].filter(
      (id) => !unusedOnly || !book || !used.has(id),
    );
    return (
      <div className="bk-picker">
        <form
          className="bk-search"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <Search size={17} />
          <input
            aria-label="Search book photos"
            value={query}
            placeholder="Search your photos"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(null);
            }}
          />
          <button type="submit" disabled={loading} aria-label="Search photos">
            {loading ? (
              <LoaderCircle className="bk-spin" size={17} />
            ) : (
              <ArrowRight size={17} />
            )}
          </button>
        </form>
        <div className="bk-picker-meta">
          <span>
            {selectMode
              ? `${chosen.size} selected`
              : slot === null
                ? "Click a space on the page first"
                : `Choose a photo for space ${slot + 1}`}
          </span>
          {selectMode && (
            <button
              className="bk-text-button"
              disabled={!chosen.size}
              onClick={() => setChosen(new Set())}
            >
              Clear selection
            </button>
          )}
          {selectMode && (
            <button
              className="bk-text-button"
              onClick={() => setChosen(new Set(visible.slice(0, 200)))}
            >
              Select shown
            </button>
          )}
        </div>
        {book && (
          <div
            className="bk-segmented bk-photo-filters"
            aria-label="Photo filter"
          >
            <button
              aria-pressed={!unusedOnly}
              onClick={() => setUnusedOnly(false)}
            >
              All photos
            </button>
            <button
              aria-pressed={unusedOnly}
              onClick={() => setUnusedOnly(true)}
            >
              Unused only
            </button>
          </div>
        )}
        {loading && !visible.length ? (
          <div className="bk-skeletons">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
        ) : visible.length ? (
          <div className="bk-picker-scroll">
            <div className="bk-picker-grid">
              {visible
                .map((id) => pool.find((p) => p.id === id))
                .filter(Boolean)
                .map((p) => (
                  <button
                    key={p.id}
                    className={`${selectMode && chosen.has(p.id) ? "is-selected" : ""} ${used.has(p.id) ? "is-used" : ""}`}
                    aria-label={`${selectMode ? "Select" : "Place"} ${p.name}`}
                    aria-pressed={selectMode ? chosen.has(p.id) : undefined}
                    disabled={!selectMode && slot === null}
                    onClick={() =>
                      selectMode ? toggle(p.id) : place(slot, p.id)
                    }
                    draggable={!selectMode}
                    onDragStart={(e) =>
                      e.dataTransfer.setData("text/anthora-photo", String(p.id))
                    }
                  >
                    <Photo photo={{ ...p, fit: "fill" }} decorative />
                    <span className="bk-picker-mark">
                      {selectMode ? (
                        <Check size={13} />
                      ) : (
                        <span>{used.has(p.id) ? "In book" : "+"}</span>
                      )}
                    </span>
                    <span className="bk-photo-name">{p.name}</span>
                  </button>
                ))}
            </div>
          </div>
        ) : null}
        {!loading && !visible.length && (
          <div className="bk-empty">
            <Images size={30} />
            <h3>
              {unusedOnly && book && results.length
                ? "All these photos are in your book"
                : loadAttempted
                  ? "No photos found"
                  : "Your photos belong here"}
            </h3>
            <p>
              {unusedOnly && book && results.length
                ? "Show all photos to reuse one, or browse more of your library."
                : loadAttempted
                  ? "Try a different search or add a photo folder to your library."
                  : "Browse photos already in your Anthora library."}
            </p>
            <button className="bk-secondary" onClick={() => load()}>
              Browse library
            </button>
          </div>
        )}
        {cursor && (
          <button
            className="bk-secondary bk-more"
            disabled={loading}
            onClick={() => load(true)}
          >
            {loading ? "Loading…" : "Load more photos"}
          </button>
        )}
      </div>
    );
  }
  return (
    <section className={`bk-workspace bk-view-${step}`} aria-label="Book maker">
      <header className="bk-topbar">
        <div className="bk-topbar-left">
          {step !== "home" ? (
            <button
              className="bk-icon"
              aria-label="Back to books"
              disabled={busy}
              onClick={
                step === "photos"
                  ? () => setStep(book ? "editor" : "design")
                  : leave
              }
            >
              <ArrowLeft size={19} />
            </button>
          ) : (
            <BookOpen size={22} />
          )}
          <span>{step === "editor" ? book.title : "Books"}</span>
          {step === "editor" && (
            <small>{dirty ? "Unsaved changes" : "Saved in this library"}</small>
          )}
        </div>
        {step === "editor" && (
          <div className="bk-topbar-actions">
            <button
              className="bk-icon"
              aria-label="Undo"
              title="Undo"
              disabled={!history.length || busy}
              onClick={undo}
            >
              <Undo2 size={18} />
            </button>
            <button
              className="bk-icon"
              aria-label="Redo"
              title="Redo"
              disabled={!future.length || busy}
              onClick={redo}
            >
              <Redo2 size={18} />
            </button>
            <span className="bk-divider" />
            <button
              className="bk-secondary"
              disabled={busy || !dirty}
              onClick={save}
            >
              {"Save book"}
            </button>
            <button
              className="bk-primary"
              disabled={busy}
              onClick={() => {
                setPendingPDF(null);
                setReview(true);
              }}
            >
              Preview & export <ArrowRight size={16} />
            </button>
          </div>
        )}
      </header>
      {step === "editor" && !canCreate && (
        <div className="bk-preview-notice" role="status">
          <span><strong>Free book preview.</strong> Edit every page with your own photos. Saving and PDF export are included.</span>
          <button onClick={onUpgrade}>Continue</button>
        </div>
      )}
      {(message || error) && (
        <div
          role={error ? "alert" : "status"}
          className={`bk-notice ${error ? "bk-error" : ""}`}
        >
          {error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
          <span>{error || message}</span>
          <button
            aria-label="Dismiss message"
            className="bk-icon"
            onClick={() => {
              setError("");
              setMessage("");
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {step === "home" && (
        <div className="bk-home bk-enter">
          <div className="bk-intro">
            <h1>Make a photo book</h1>
            <p>Choose a design. Add your photos. Make it yours.</p>
          </div>
          {initialPhotos.length > 0 && (
            <div className="bk-source-summary">
              <Images size={20} />
              <div>
                <strong>
                  {initialPhotos.length} photos ready
                  {initialContext?.label ? ` from ${initialContext.label}` : ""}
                </strong>
                <p>
                  {initialContext?.limited
                    ? "Using the first 200 matching photos. Narrow the original search or use a selection for a different set."
                    : "Choose a design below. Your photos are already selected."}
                </p>
              </div>
            </div>
          )}
          <div className="bk-design-toolbar calm-book-filters">
            <select aria-label="Book occasion" value={category} onChange={e=>setCategory(e.target.value)}>
              {[
                "All designs",
                ...new Set(Object.values(templates).map((t) => t.category)),
              ].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <details className="book-options quiet-details"><summary>Options{formatFilter !== "All shapes" ? ` · ${formatFilter}` : ""}</summary>
            <label>Shape <select aria-label="Book shape" value={formatFilter} onChange={e=>setFormatFilter(e.target.value)}>
              {["All shapes", "Portrait", "Landscape", "Square"].map(shape=><option key={shape}>{shape}</option>)}
            </select></label>
            <SampleToggle
              checked={showSamplePhotos}
              onChange={changeSamplePhotos}
            />
          <p className="bk-sample-note">
            {showSamplePhotos
              ? "AI-generated sample photos. Your book will use your own photos."
              : "Layout previews. Turn on sample photos to see finished examples."}
          </p>
            </details>
          </div>
          <div className="bk-template-grid">
            {Object.entries(templates)
              .filter(
                ([, t]) =>
                  (category === "All designs" || t.category === category) &&
                  (formatFilter === "All shapes" ||
                    formats[t.format].group === formatFilter),
              )
              .map(([key, t]) => (
                <button
                  className={`bk-template-card bk-template-${key}`}
                  key={key}
                  onClick={() => {
                    setTemplate(key);
                    setSelectedFormat(t.format);
                    setSelectedColor(t.defaultColor || t.color);
                    setTitle("");
                    setDesignIndex(0);
                    setStep("design");
                    setError("");
                  }}
                  aria-label={`Explore ${t.name}`}
                >
                  <div className="bk-template-scene">
                    <div
                      className="bk-design-stack"
                      data-shape={formats[t.format].group}
                      style={{
                        "--bk-aspect":
                          formats[t.format].width / formats[t.format].height,
                      }}
                    >
                      <div className="bk-stack-page">
                        <Sheet
                          book={previews[key]}
                          index={1}
                          mini
                          demo
                          samplePhotos={showSamplePhotos}
                        />
                      </div>
                      <div className="bk-stack-cover">
                        <Sheet
                          book={previews[key]}
                          index={0}
                          mini
                          demo
                          samplePhotos={showSamplePhotos}
                        />
                      </div>
                    </div>
                    <span className="bk-template-badge">
                      {formats[t.format].name} · {formats[t.format].detail}
                    </span>
                  </div>
                  <div className="bk-template-info">
                    <div>
                      <h2>{t.name}</h2>
                      <p>{t.description}</p>
                    </div>
                    <span className="bk-circle-arrow">
                      <ArrowRight size={21} />
                    </span>
                  </div>
                </button>
              ))}
          </div>
          {!Object.values(templates).some(
            (t) =>
              (category === "All designs" || t.category === category) &&
              (formatFilter === "All shapes" ||
                formats[t.format].group === formatFilter),
          ) && (
            <div className="bk-empty">
              <h3>Try another shape</h3>
              <p>Every design can be resized after you choose it.</p>
              <button
                className="bk-secondary"
                onClick={() => setFormatFilter("All shapes")}
              >
                Show every shape
              </button>
            </div>
          )}
          <section className="bk-library">
            <div className="bk-section-title">
              <h2>Your books</h2>
              <span>
                {saved.length
                  ? `${saved.length} saved`
                  : "A place for works in progress"}
              </span>
            </div>
            {loadingBooks ? (
              <p>Loading your books…</p>
            ) : saved.length ? (
              <div className="bk-saved-grid">
                {saved.map((b) => (
                  <div className="bk-saved-item" key={b.id}>
                    <button
                      disabled={busy}
                      className="bk-saved-card"
                      onClick={() => openBook(b)}
                    >
                      <Sheet book={b} index={0} mini />
                      <strong>{b.title}</strong>
                      <span>
                        {templates[b.template].name} · {b.pages.length} pages
                      </span>
                    </button>
                    <div className="bk-saved-actions">
                      <button
                        disabled={busy}
                        aria-label={`Duplicate book: ${b.title}`}
                        title="Make a copy"
                        onClick={() => copySavedBook(b)}
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        disabled={busy}
                        aria-label={`Remove book: ${b.title}`}
                        title="Remove saved book"
                        onClick={() => removeSavedBook(b)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="bk-library-empty">
                Choose a template above to make your first book. Saved books
                will stay here.
              </p>
            )}
          </section>
        </div>
      )}
      {step === "design" && (
        <div className="bk-design-detail bk-enter">
          <div className="bk-design-description">
            <h1>{design.name}</h1>
            <p>{design.description}</p>
            <details className="quiet-details book-customize"><summary>Size & cover color</summary>
            <div className="bk-label bk-format-label">Book size</div>
            <FormatPicker value={selectedFormat} onChange={setSelectedFormat} />
            <div className="bk-label bk-format-label">Cover color</div>
            <ColorPicker
              value={selectedColor}
              onChange={setSelectedColor}
              defaultColor={design.defaultColor || design.color}
            />
            </details>
            <button
              className="bk-primary bk-wide"
              onClick={() => setStep("photos")}
            >
              {canCreate ? "Use this design" : "Try with my photos"} <ArrowRight size={17} />
            </button>
            <p className="bk-reassurance">
              {canCreate ? "The book grows to fit your photos. Every heading and page is editable." : "Try this design with your photos. Saving and PDF export are free."}
            </p>
            <details className="bk-chapter-list quiet-details"><summary>All pages</summary>
              {design.sequence.map((p, i) => (
                <button
                  key={i}
                  onClick={() => setDesignIndex(i)}
                  aria-current={designIndex === i ? "page" : undefined}
                >
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  {i === 0 ? "Cover" : p.heading || layouts[p.layout].name}
                  <ChevronRight size={13} />
                </button>
              ))}
            </details>
          </div>
          <div className="bk-design-preview">
            <div className="bk-preview-tools">
              <button
                className="bk-text-button"
                disabled={designIndex === 0}
                onClick={() => setDesignIndex(0)}
              >
                View cover
              </button>
              <SampleToggle
                checked={showSamplePhotos}
                onChange={changeSamplePhotos}
              />
            </div>
            <div
              className="bk-design-spread"
              key={`${template}-${designIndex}`}
              style={{ background: design.scene }}
            >
              {[designIndex, designIndex + 1]
                .filter((i) => i < preview.pages.length)
                .map((i) => (
                  <div key={i}>
                    <Sheet
                      book={preview}
                      index={i}
                      demo
                      samplePhotos={showSamplePhotos}
                    />
                    <small>{i === 0 ? "Cover" : `Page ${i + 1}`}</small>
                  </div>
                ))}
            </div>
            <div className="bk-spread-nav">
              <button
                className="bk-icon"
                aria-label="Previous design pages"
                disabled={designIndex === 0}
                onClick={() => setDesignIndex(Math.max(0, designIndex - 2))}
              >
                <ChevronLeft size={20} />
              </button>
              <span>
                {designIndex + 1}–
                {Math.min(designIndex + 2, preview.pages.length)} of{" "}
                {preview.pages.length}
              </span>
              <button
                className="bk-icon"
                aria-label="Next design pages"
                disabled={designIndex + 2 >= preview.pages.length}
                onClick={() => setDesignIndex(designIndex + 2)}
              >
                <ChevronRight size={20} />
              </button>
            </div>
            <p className="bk-canvas-hint">
              {showSamplePhotos
                ? "AI-generated sample photos show how the finished pages can look. These photos aren't added to your book."
                : "Layout preview. Your finished book uses your selected photos once each."}
            </p>
          </div>
        </div>
      )}
      {step === "photos" && (
        <div className="bk-select-step bk-enter">
          <div className="bk-selection-intro">
            <h1>{book ? "Choose your photos" : design.name}</h1>
            <p>
              {initialPhotos.length
                ? "Your photos are selected. Keep them all or choose a smaller set."
                : "Choose your photos and we'll fill the whole book for you."}
            </p>
            <label className="bk-label">
              Book title
              <input
                maxLength={80}
                placeholder={design.title}
                value={book ? book.title : title}
                onChange={(e) =>
                  book
                    ? update({ ...book, title: e.target.value })
                    : setTitle(e.target.value)
                }
              />
            </label>
            <label className="bk-label bk-order-label">
              Arrange photos
              <select
                value={photoOrder}
                onChange={(e) => setPhotoOrder(e.target.value)}
              >
                <option value="date">Oldest to newest</option>
                <option value="selection">Selection order</option>
              </select>
            </label>
            <div className="bk-selection-summary">
              <span className="bk-selection-count">{chosen.size}</span>
              <span>
                photos selected
                <br />
                <small>
                  {arrangedCount
                    ? `${arrangedCount} pages, ready to review`
                    : "Up to 200 photos"}
                </small>
              </span>
            </div>
            <button
              className="bk-primary bk-wide"
              disabled={!chosen.size || busy}
              onClick={() => (book ? refill() : create())}
            >
              {book ? "Arrange selected photos" : "Make my book"}{" "}
              <ArrowRight size={17} />
            </button>
            {!book && (
              <button
                className="bk-text-button bk-manual"
                onClick={() => create(true)}
              >
                Fill the premade pages myself
              </button>
            )}
            <p className="bk-reassurance">
              <Check size={14} /> You can change every page afterward.
            </p>
          </div>
          <div className="bk-selection-picker">{picker(true)}</div>
        </div>
      )}
      {step === "editor" && book && (
        <fieldset
          className="bk-edit-controls"
          disabled={busy}
          style={{
            "--bk-aspect": bookFormat(book).width / bookFormat(book).height,
          }}
        >
          <div className="bk-editor-bar">
            <button
              className={`bk-secondary ${drawer ? "is-active" : ""}`}
              onClick={() => {
                setDrawer(!drawer);
                if (!loadAttempted && !pool.length) load();
              }}
            >
              <Images size={16} /> Photos
            </button>
            <span>
              {templates[book.template].name} <span className="bk-dot">·</span>{" "}
              {book.pages.length} pages · {bookFormat(book).detail}
            </span>
            <button
              className="bk-text-button"
              onClick={() => {
                setTemplate(book.template);
                setStep("photos");
              }}
            >
              Auto-fill again
            </button>
          </div>
          <div className={`bk-editor ${drawer ? "bk-drawer-open" : ""}`}>
            {drawer && (
              <aside className="bk-photo-drawer bk-enter">
                <div className="bk-panel-heading">
                  <h2>Photos</h2>
                  <button
                    className="bk-icon"
                    aria-label="Close photos"
                    onClick={() => setDrawer(false)}
                  >
                    <X size={18} />
                  </button>
                </div>
                {picker(false)}
              </aside>
            )}
            <div className="bk-canvas-area">
              <div className="bk-canvas-heading">
                <span>{active === 0 ? "Cover" : `Page ${active + 1}`}</span>
                <div>
                  <button
                    className="bk-icon"
                    aria-label="Previous page"
                    disabled={active === 0}
                    onClick={() => changePage(active - 1)}
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <button
                    className="bk-icon"
                    aria-label="Next page"
                    disabled={active === book.pages.length - 1}
                    onClick={() => changePage(active + 1)}
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
              <div className="bk-page-arrival" key={current.id}>
                <Sheet
                  book={book}
                  index={active}
                  slot={slot}
                  onSlot={(i) => {
                    setSlot(i);
                    setDrawer(true);
                    if (!loadAttempted && !pool.length) load();
                  }}
                  onDrop={place}
                />
              </div>
              <p className="bk-canvas-hint">
                {slot !== null
                  ? "Choose a photo in the panel, or drag one into this space."
                  : "Click a photo to replace it. Your originals stay untouched."}
              </p>
            </div>
            <aside className="bk-inspector">
              <h2 className="bk-section-heading">
                {active === 0 ? "Cover design" : "Page design"}
              </h2>
              {active > 0 && (
                <label className="bk-label">
                  Page heading
                  <input
                    maxLength={60}
                    value={current.heading || ""}
                    placeholder="Optional section heading"
                    onChange={(e) => patchPage({ heading: e.target.value })}
                  />
                </label>
              )}
              <label className="bk-label">
                {active === 0 ? "Book title" : "Caption"}
                <input
                  maxLength={active === 0 ? 80 : 120}
                  placeholder={
                    active === 0
                      ? "Give your book a name"
                      : "Add a date, a place, a little detail…"
                  }
                  value={active === 0 ? book.title : current.caption}
                  onChange={(e) =>
                    active === 0
                      ? update({ ...book, title: e.target.value })
                      : patchPage({ caption: e.target.value })
                  }
                />
              </label>
              {active === 0 && (
                <div className="bk-label">
                  Book style
                  <select
                    aria-label="Book style"
                    value={book.template}
                    onChange={(e) =>
                      update({
                        ...book,
                        template: e.target.value,
                        color:
                          templates[e.target.value].defaultColor ||
                          templates[e.target.value].color,
                      })
                    }
                  >
                    {Object.entries(templates).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {active === 0 && (
                <>
                  <div className="bk-label">
                    Book size
                    <FormatPicker
                      compact
                      value={book.format || "square"}
                      onChange={(format) => {
                        update({ ...book, format });
                        setMessage(
                          "Book resized. Check your photo crops before exporting.",
                        );
                      }}
                    />
                  </div>
                  <div className="bk-label">
                    Cover color
                    <ColorPicker
                      value={book.color || templates[book.template].color}
                      onChange={(color) => update({ ...book, color })}
                      defaultColor={
                        templates[book.template].defaultColor ||
                        templates[book.template].color
                      }
                    />
                  </div>
                  <label className="bk-label">
                    Cover composition
                    <select
                      value={book.coverStyle || "classic"}
                      onChange={(e) =>
                        update({ ...book, coverStyle: e.target.value })
                      }
                    >
                      {Object.entries(coverStyles).map(([key, value]) => (
                        <option key={key} value={key}>
                          {value.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {active > 0 && current.layout === "story" && (
                <label className="bk-label">
                  Your words
                  <textarea
                    rows={9}
                    maxLength={1500}
                    value={current.text || ""}
                    placeholder="A memory, your vows, or a note to someone you love…"
                    onChange={(e) => patchPage({ text: e.target.value })}
                  />
                  <small>
                    {(current.text || "").length} / 1,500 characters
                  </small>
                </label>
              )}
              <div className="bk-label">
                Layout
                <div className="bk-layout-options">
                  {Object.keys(capacity).map((layout) => (
                    <button
                      aria-label={`${layouts[layout].name} layout`}
                      aria-pressed={current.layout === layout}
                      className={current.layout === layout ? "is-selected" : ""}
                      key={layout}
                      onClick={() => {
                        try {
                          patchPage(changeLayout(current, layout));
                          setSlot(null);
                        } catch (e) {
                          setError(e.message);
                        }
                      }}
                    >
                      <LayoutIcon layout={layout} />
                      <span>{layouts[layout].name}</span>
                    </button>
                  ))}
                </div>
              </div>
              {slot !== null && current.photos[slot] && (
                <div className="bk-crop-options">
                  <span className="bk-label">Selected photo</span>
                  <div className="bk-segmented">
                    {["fit", "fill"].map((fit) => (
                      <button
                        key={fit}
                        aria-pressed={
                          (current.photos[slot].fit || "fit") === fit
                        }
                        onClick={() =>
                          patchPage({
                            photos: current.photos.map((p, i) =>
                              i === slot ? { ...p, fit } : p,
                            ),
                          })
                        }
                      >
                        {fit === "fit" ? "Fit photo" : "Fill frame"}
                      </button>
                    ))}
                  </div>
                  {current.photos[slot].fit === "fill" && (
                    <div className="bk-crop-position">
                      {[
                        ["cropX", "Horizontal position"],
                        ["cropY", "Vertical position"],
                      ].map(([axis, label]) => (
                        <label key={axis}>
                          <span>
                            {label}
                            <output>
                              {cropPercent(current.photos[slot][axis])}%
                            </output>
                          </span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            aria-label={label}
                            value={cropPercent(current.photos[slot][axis])}
                            onPointerDown={beginCrop}
                            onChange={(e) => adjustCrop(axis, e.target.value)}
                          />
                        </label>
                      ))}
                      <button
                        className="bk-text-button"
                        onClick={() =>
                          patchPage({
                            photos: current.photos.map((p, i) =>
                              i === slot ? { ...p, cropX: 50, cropY: 50 } : p,
                            ),
                          })
                        }
                      >
                        Center photo
                      </button>
                    </div>
                  )}
                  <button
                    className="bk-text-button"
                    onClick={() =>
                      patchPage({
                        photos: current.photos.map((p, i) =>
                          i === slot ? null : p,
                        ),
                      })
                    }
                  >
                    Remove photo
                  </button>
                </div>
              )}
              <div className="bk-inspector-bottom">
                <button
                  className="bk-text-button"
                  disabled={book.pages.length >= 200}
                  onClick={() => {
                    update(duplicatePage(book, active));
                    changePage(active + 1);
                  }}
                >
                  <Copy size={14} /> Duplicate page
                </button>
                <div className="bk-label">
                  Move page
                  <div className="bk-move-buttons">
                    <button
                      className="bk-secondary"
                      disabled={active === 0}
                      onClick={() => move(-1)}
                    >
                      <ChevronLeft size={15} /> Earlier
                    </button>
                    <button
                      className="bk-secondary"
                      disabled={active === book.pages.length - 1}
                      onClick={() => move(1)}
                    >
                      Later <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
                <button
                  className="bk-text-button bk-delete"
                  disabled={book.pages.length === 1}
                  onClick={() => {
                    update({
                      ...book,
                      pages: book.pages.filter((_, i) => i !== active),
                    });
                    changePage(Math.max(0, active - 1));
                  }}
                >
                  <Trash2 size={14} /> Remove page
                </button>
              </div>
            </aside>
          </div>
          <nav className="bk-filmstrip" ref={filmstrip} aria-label="Book pages">
            {book.pages.map((p, i) => (
              <button
                key={p.id}
                className={`${active === i ? "is-current" : ""} ${dragPage === p.id ? "is-dragging" : ""} ${dropPage === p.id ? "is-drop-target" : ""}`}
                draggable
                title="Drag to reorder this page"
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/anthora-page", p.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragPage(p.id);
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("text/anthora-page")) {
                    e.preventDefault();
                    setDropPage(p.id);
                  }
                }}
                onDrop={(e) => dropAt(e, i)}
                onDragEnd={() => {
                  setDragPage(null);
                  setDropPage(null);
                }}
                aria-label={i === 0 ? "Cover" : `Page ${i + 1}`}
                aria-current={active === i ? "page" : undefined}
                onClick={() => changePage(i)}
              >
                <Sheet book={book} index={i} mini />
                <span>{i === 0 ? "Cover" : i + 1}</span>
                {p.photos.some((v) => !v) && (
                  <i className="bk-empty-dot" title="Has empty photo spaces" />
                )}
              </button>
            ))}
            <button
              className="bk-add-page"
              disabled={book.pages.length >= 200}
              onClick={() => {
                update({ ...book, pages: [...book.pages, page()] });
                changePage(book.pages.length);
              }}
            >
              <span>
                <Plus size={22} />
              </span>
              Add page
            </button>
          </nav>
        </fieldset>
      )}
      {review && book && (
        <div
          className="bk-review-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setReview(false);
          }}
        >
          <section
            className="bk-review"
            style={{
              "--bk-aspect": bookFormat(book).width / bookFormat(book).height,
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Preview and export book"
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                const controls = [...e.currentTarget.querySelectorAll(
                  "button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href]",
                )].filter(element => element.getClientRects().length && !element.closest("fieldset:disabled"));
                if (controls.length) {
                  e.preventDefault();
                  const position = controls.indexOf(document.activeElement);
                  const next = position < 0 ? (e.shiftKey ? controls.length - 1 : 0)
                    : (position + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
                  controls[next].focus();
                }
              }
            }}
          >
            <header>
              <div>
                <h2>{book.title || "Your book"}</h2>
              </div>
              <button
                ref={fileInput}
                className="bk-icon"
                aria-label="Close preview"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                <X size={21} />
              </button>
            </header>
            <div className="bk-review-body">
              <div className="bk-review-paper" key={current.id}>
                <Sheet book={book} index={active} />
              </div>
              <div className="bk-review-navigation">
                <button
                  className="bk-icon"
                  aria-label="Previous preview page"
                  disabled={active === 0 || busy}
                  onClick={() => changePage(active - 1)}
                >
                  <ChevronLeft size={20} />
                </button>
                <span>
                  {active + 1} / {book.pages.length}
                </span>
                <button
                  className="bk-icon"
                  aria-label="Next preview page"
                  disabled={active === book.pages.length - 1 || busy}
                  onClick={() => changePage(active + 1)}
                >
                  <ChevronRight size={20} />
                </button>
              </div>
            </div>
            <footer>
              {empty ? (
                <div className="bk-review-warning">
                  <AlertCircle size={17} />
                  <span>
                    {empty} empty photo {empty === 1 ? "space" : "spaces"} to
                    fill.
                  </span>
                  <button
                    className="bk-text-button"
                    onClick={() => {
                      changePage(
                        book.pages.findIndex((p) => p.photos.some((v) => !v)),
                      );
                      setReview(false);
                    }}
                  >
                    Go to page
                  </button>
                </div>
              ) : (
                <p>
                  <CheckCircle2 size={16} /> Every photo space is filled.
                </p>
              )}
              <fieldset className="bk-export-options" disabled={busy}>
                <label className="bk-label">
                  PDF quality
                  <select
                    value={exportQuality}
                    onChange={(e) => {
                      setPendingPDF(null);
                      setError("");
                      setExportQuality(e.target.value);
                    }}
                  >
                    <option value="print">High quality · 300 dpi</option>
                    <option value="share">Smaller file · 150 dpi</option>
                  </select>
                </label>
                <label className="bk-bleed-option">
                  <input
                    type="checkbox"
                    checked={bleed}
                    onChange={(e) => {
                      setPendingPDF(null);
                      setError("");
                      setBleed(e.target.checked);
                    }}
                  />{" "}
                  Add ⅛-inch bleed for trimming
                </label>
              </fieldset>
              <div className="bk-export-row">
                <div>
                  <strong>Save a PDF</strong>
                  <small>
                    {bookFormat(book).detail} trim · {book.pages.length} single
                    pages
                    <br />
                    {bleed
                      ? "Includes ⅛-inch bleed and PDF trim boxes."
                      : "Exports at your chosen book size."}
                    <br />
                    Confirm size and cover requirements with your printer. A
                    wraparound cover is not included.
                  </small>
                </div>
                <button
                  className="bk-primary"
                  disabled={busy || empty > 0 || !book.title.trim()}
                  onClick={async () => {
                    if (!canCreate) { setReview(false); onUpgrade(); return; }
                    setBusy(true);
                    setError("");
                    try {
                      const { exportBook, saveBookPDF } = await import(
                        "./books-export"
                      );
                      if (pendingPDF) {
                        const savedMessage = await saveBookPDF(book, pendingPDF.pdf);
                        setMessage(savedMessage);
                        if (savedMessage.startsWith("PDF ")) setSavedExport(exportedBookKey(book, exportQuality, bleed));
                        setPendingPDF(null);
                        return;
                      }
                      const controller = new AbortController();
                      setCancelExport(() => () => controller.abort());
                      const result = await exportBook(book, setMessage, {
                        quality: exportQuality,
                        bleed,
                        reviewWarnings: true,
                        signal: controller.signal,
                      });
                      if (result.pdf) {
                        setPendingPDF(result);
                        setError(
                          result.warnings.join(" ") +
                            " You can save anyway, choose a smaller book size, or replace those photos.",
                        );
                      } else {
                        const savedMessage = result.message || result;
                        setMessage(savedMessage);
                        if (typeof savedMessage === "string" && savedMessage.startsWith("PDF ")) setSavedExport(exportedBookKey(book, exportQuality, bleed));
                      }
                    } catch (e) {
                      if (e.name === "AbortError")
                        setMessage("Export cancelled.");
                      else setError(e.message);
                    } finally {
                      setCancelExport(null);
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? (
                    <LoaderCircle className="bk-spin" size={17} />
                  ) : (
                    <Download size={17} />
                  )}{" "}
                  {busy
                    ? "Preparing PDF…"
                    : !canCreate
                      ? "Export PDF"
                      : pendingPDF
                        ? "Save anyway"
                        : "Save PDF"}
                </button>
              </div>
              <BookPrinting book={book} saved={savedExport === exportedBookKey(book, exportQuality, bleed)} busy={busy}/>
              {busy && cancelExport && (
                <button className="bk-secondary" onClick={cancelExport}>
                  Cancel export
                </button>
              )}
              <p
                role="status"
                className={error ? "bk-error-text" : "bk-export-status"}
              >
                {error || message}
              </p>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
