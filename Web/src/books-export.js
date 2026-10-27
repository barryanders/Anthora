import { jsPDF } from "jspdf";
import "./books-fonts.css";
import { loadBookFonts, fontDeclaration } from "./books-typography.js";
import {
  bookStyle,
  boxes,
  imagePlacement,
  ornaments,
  bookFormat,
} from "./books-model";
import { preparedText } from "./books-render";

async function requireBookExport(signal) {
  const response = await fetch("/api/books/export-check", { method: "POST", signal });
  const result = await response.json();
  if (!response.ok) {
    if (result.code === "license_required") window.dispatchEvent(new CustomEvent("anthora-license-required"));
    throw new Error(result.error || "Could not check Books access. Try again.");
  }
}

function cancelled(signal) {
  if (signal?.aborted)
    throw new DOMException("Export cancelled.", "AbortError");
}
function loadImage(src, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      img.onload = null;
      img.onerror = null;
    };
    const abort = () => {
      cleanup();
      img.src = "";
      reject(new DOMException("Export cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "A photo took too long to load. Check that its drive is connected.",
        ),
      );
    }, 30000);
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(
        new Error(
          "A photo is unavailable. Reconnect its drive or replace it before exporting.",
        ),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    img.src = src;
  });
}
export function exportDimensions(book, options = {}) {
  const f = bookFormat(book),
    dpi = options.quality === "share" ? 150 : 300,
    bleed = options.bleed ? 0.125 : 0;
  return {
    width: f.width,
    height: f.height,
    dpi,
    bleed,
    points: [(f.width + 2 * bleed) * 72, (f.height + 2 * bleed) * 72],
    pixels: [
      Math.round((f.width + 2 * bleed) * dpi),
      Math.round((f.height + 2 * bleed) * dpi),
    ],
    orientation: f.width > f.height ? "landscape" : "portrait",
  };
}
export async function buildBookPDF(book, progress = () => {}, options = {}) {
  cancelled(options.signal);
  await requireBookExport(options.signal);
  if (!book.title.trim())
    throw new Error("Give your book a title before exporting.");
  const d = exportDimensions(book, options),
    lowResolution = new Set();
  const pdf = new jsPDF({
    unit: "pt",
    format: d.points,
    orientation: d.orientation,
    compress: true,
  });
  pdf.setProperties({
    title: book.title,
    creator: "Anthora",
    subject: `${d.width} × ${d.height} inch photo book`,
  });
  await loadBookFonts();
  await document.fonts?.ready;
  const width = d.width * d.dpi,
    height = d.height * d.dpi,
    bleed = d.bleed * d.dpi;
  for (let n = 0; n < book.pages.length; n++) {
    const style = bookStyle(book, n);
    cancelled(options.signal);
    progress(`Preparing page ${n + 1} of ${book.pages.length}…`);
    const p = book.pages[n],
      canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = d.pixels;
    const ctx = canvas.getContext("2d");
    try {
      ctx.fillStyle = style.color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(bleed, bleed);
      ctx.strokeStyle = style.accent;
      ctx.fillStyle = style.accent;
      for (const o of ornaments(
        book.template,
        n === 0 && ["classic", "inset"].includes(book.coverStyle || "classic"),
      )) {
        const x = (o.x * width) / 100,
          y = (o.y * height) / 100,
          w = (o.w * width) / 100,
          h = (o.h * height) / 100;
        if (o.outline) {
          ctx.lineWidth = width / 800;
          ctx.strokeRect(x, y, w, h);
        } else if (o.round) {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (o.heart) {
          ctx.font = `${width * 0.04}px Georgia`;
          ctx.textAlign = "center";
          ctx.fillText("♥", x + w / 2, y + h);
        }
      }
      const areas = boxes(
        p.layout,
        book.template,
        n === 0,
        Boolean(p.heading),
        book.coverStyle,
      );
      for (let j = 0; j < p.photos.length; j++) {
        cancelled(options.signal);
        const photo = p.photos[j];
        if (!photo)
          throw new Error(
            `Page ${n + 1} has an empty photo space. Fill it or remove the page.`,
          );
        const size =
          options.quality === "share"
            ? 1600
            : Math.min(4800, Math.ceil(Math.max(width, height)));
        const image = await loadImage(
          `/api/items/${Number(photo.id)}/${options.quality === "share" ? "thumbnail" : "book-preview"}?size=${size}`,
          options.signal,
        );
        const [ax, ay, aw, ah] = areas[j];
        let x = (ax * width) / 100,
          y = (ay * height) / 100,
          w = (aw * width) / 100,
          h = (ah * height) / 100;
        // Only edge-touching photos extend into bleed; interior margins stay at trim size.
        if (ax === 0) {
          x -= bleed;
          w += bleed;
        }
        if (ay === 0) {
          y -= bleed;
          h += bleed;
        }
        if (ax + aw === 100) w += bleed;
        if (ay + ah === 100) h += bleed;
        const placement = imagePlacement(
          photo,
          image.naturalWidth,
          image.naturalHeight,
          x,
          y,
          w,
          h,
        );
        const effectiveDpi =
          Math.min(
            image.naturalWidth / placement[2],
            image.naturalHeight / placement[3],
          ) * d.dpi;
        if (options.quality !== "share" && effectiveDpi < 200)
          lowResolution.add(n + 1);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(image, ...placement);
        ctx.restore();
      }
      if (n === 0 && book.coverStyle === "full") {
        const gradient = ctx.createLinearGradient(
          0,
          height * 0.35,
          0,
          height + bleed,
        );
        gradient.addColorStop(0, "rgba(0,0,0,0)");
        gradient.addColorStop(0.65, "rgba(0,0,0,.65)");
        gradient.addColorStop(1, "rgba(0,0,0,.85)");
        ctx.fillStyle = gradient;
        ctx.fillRect(
          -bleed,
          height * 0.35,
          width + 2 * bleed,
          height * 0.65 + bleed,
        );
      }
      for (const b of preparedText(book, n, width)) {
        ctx.font = fontDeclaration(b);
        ctx.fillStyle = b.ink;
        ctx.textAlign = b.align || "left";
        ctx.textBaseline = "top";
        const x =
          b.align === "center"
            ? b.x + b.w / 2
            : b.align === "right"
              ? b.x + b.w
              : b.x;
        ctx.save();
        ctx.translate(x, b.y);
        ctx.scale(b.widthScale || 1, 1);
        b.lines.forEach((line, i) => ctx.fillText(line, 0, i * b.lineHeight));
        ctx.restore();
      }
      if (n) pdf.addPage(d.points, d.orientation);
      const context = pdf.internal.getCurrentPageInfo().pageContext;
      context.trimBox = {
        bottomLeftX: d.bleed * 72,
        bottomLeftY: d.bleed * 72,
        topRightX: (d.width + d.bleed) * 72,
        topRightY: (d.height + d.bleed) * 72,
      };
      context.bleedBox = {
        bottomLeftX: 0,
        bottomLeftY: 0,
        topRightX: d.points[0],
        topRightY: d.points[1],
      };
      pdf.addImage(
        canvas.toDataURL(
          "image/jpeg",
          options.quality === "share" ? 0.86 : 0.96,
        ),
        "JPEG",
        0,
        0,
        ...d.points,
      );
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
    // Yield between pages so progress and cancellation stay responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  cancelled(options.signal);
  const warnings = lowResolution.size
    ? [
        `Photos on ${lowResolution.size === 1 ? "page" : "pages"} ${[...lowResolution].join(", ")} may look soft in print (below 200 dpi at this size).`,
      ]
    : [];
  return { pdf, warnings };
}
export async function saveBookPDF(book, pdf) {
  await requireBookExport();
  const name =
    (book.title.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 70) ||
      "Anthora book") + ".pdf";
  const blob = pdf.output("blob");
  if (window.anthoraNative?.saveBookPDF) {
    if (blob.size > 70_000_000)
      throw new Error(
        "This PDF is too large for the Mac save panel. Choose Smaller file or split the book into shorter volumes.",
      );
    const result = await window.anthoraNative.saveBookPDF(
      name,
      pdf.output("datauristring").split(",")[1],
    );
    return result.cancelled ? "Export cancelled." : "PDF saved.";
  }
  pdf.save(name);
  return "PDF download started.";
}
export async function exportBook(book, progress, options = {}) {
  const result = await buildBookPDF(book, progress, options);
  if (result.warnings.length && options.reviewWarnings) return result;
  return {
    message: await saveBookPDF(book, result.pdf),
    warnings: result.warnings,
  };
}
