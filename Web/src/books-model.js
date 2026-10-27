// Each design is a complete page sequence. It adapts to the selected photo count.
import { designedCovers, interiorFrames, artDirections } from "./books-typography.js";

const sequence = (entries) =>
  entries.map(([layout, heading = "", text = ""]) => ({
    layout,
    heading,
    text,
  }));
export const templates = {
  album: {
    name: "Everyday",
    category: "Everyday",
    description:
      "A clean, generous album for the photos you keep coming back to.",
    color: "#f7f5ef",
    ink: "#303034",
    accent: "#999186",
    scene: "#e6e5e2",
    title: "Life lately",
    eyebrow: "A PHOTO ALBUM",
    motif: "line",
    font: "Georgia",
    sequence: sequence([
      ["single"],
      ["single", "The little things"],
      ["pair"],
      ["grid", "Together"],
      ["feature"],
      ["single", "One to keep"],
    ]),
  },
  travel: {
    name: "Travel Journal",
    category: "Travel",
    description:
      "From the first stop to the journey home. Landscapes, details, and days out.",
    color: "#f1eee5",
    ink: "#49413b",
    accent: "#a57b51",
    scene: "#dfd8cf",
    title: "Somewhere new",
    eyebrow: "A TRAVEL JOURNAL",
    motif: "frame",
    font: "Georgia",
    sequence: sequence([
      ["single"],
      ["wide", "Here we are"],
      ["triptych", "Along the way"],
      ["feature", "A closer look"],
      ["pair", "Out exploring"],
      ["grid", "The details"],
      ["wide", "Until next time"],
    ]),
  },
  wedding: {
    name: "The Wedding",
    category: "Love & weddings",
    description: "An ivory keepsake, from getting ready to the last dance.",
    color: "#fcf9f2",
    ink: "#554b40",
    accent: "#b59a70",
    scene: "#e8dfd1",
    title: "Our wedding",
    eyebrow: "THE WEDDING ALBUM",
    motif: "frame",
    font: "Georgia",
    sequence: sequence([
      ["portrait"],
      ["pair", "Getting ready"],
      ["portrait", "The first look"],
      ["wide", "The ceremony"],
      ["feature", "Just married"],
      ["grid", "Our people"],
      ["triptych", "The little details"],
      ["pair", "The celebration"],
      ["single", "Always"],
    ]),
  },
  valentine: {
    name: "You & Me",
    category: "Love & weddings",
    description:
      "A Valentine's gift with room for your favorite days and a few words of your own.",
    color: "#fff1ef",
    ink: "#752f40",
    accent: "#c86678",
    scene: "#eed4d8",
    title: "You & me",
    eyebrow: "OUR STORY SO FAR",
    motif: "heart",
    font: "Georgia",
    sequence: sequence([
      ["portrait"],
      ["pair", "How it started"],
      ["feature", "My favorite days"],
      ["triptych", "Little things I love"],
      ["single", "A note for you"],
      ["pair", "More of this, please"],
      ["portrait", "With love"],
    ]),
  },
  baby: {
    name: "Hello, Little One",
    category: "Family",
    description:
      "A first-year album for tiny details, big changes, and everyone who was there.",
    color: "#f8f0e5",
    ink: "#68534b",
    accent: "#c39466",
    scene: "#e9dccb",
    title: "Hello, little one",
    eyebrow: "THE FIRST YEAR",
    motif: "dots",
    font: "Georgia",
    sequence: sequence([
      ["portrait"],
      ["single", "Hello, world"],
      ["triptych", "Tiny details"],
      ["pair", "Coming home"],
      ["feature", "First discoveries"],
      ["grid", "Growing every day"],
      ["single", "One whole year"],
    ]),
  },
  yearbook: {
    name: "Our Year",
    category: "Family",
    description:
      "A family yearbook with space for the seasons and everything in between.",
    color: "#f4f2eb",
    ink: "#334854",
    accent: "#819daa",
    scene: "#dbe2e5",
    title: "Our year together",
    eyebrow: "A FAMILY YEARBOOK",
    motif: "line",
    font: "system-ui",
    sequence: sequence([
      ["single"],
      ["grid", "Winter"],
      ["feature", "Spring"],
      ["wide", "Summer"],
      ["mosaic", "Autumn"],
      ["pair", "Days together"],
      ["grid", "The everyday"],
      ["single", "Looking back"],
    ]),
  },
  birthday: {
    name: "A Birthday to Keep",
    category: "Celebrations",
    description:
      "The people, the cake, and the photos you'll want to pull out next year.",
    color: "#fff5e5",
    ink: "#634028",
    accent: "#c78942",
    scene: "#eedfc8",
    title: "Happy birthday",
    eyebrow: "A DAY TO CELEBRATE",
    motif: "dots",
    font: "system-ui",
    sequence: sequence([
      ["single"],
      ["feature", "The birthday star"],
      ["triptych", "Before the party"],
      ["grid", "Everyone's here"],
      ["pair", "Make a wish"],
      ["mosaic", "The celebration"],
      ["single", "A very good day"],
    ]),
  },
  portfolio: {
    name: "The Edit",
    category: "Everyday",
    description:
      "A dark, minimal collection for photography, projects, and your strongest work.",
    color: "#24252a",
    ink: "#f2eee6",
    accent: "#b9b5aa",
    scene: "#c7c8cc",
    title: "Selected works",
    eyebrow: "A PHOTOGRAPHIC COLLECTION",
    motif: "line",
    font: "system-ui",
    sequence: sequence([
      ["single"],
      ["wide"],
      ["portrait"],
      ["pair"],
      ["feature"],
      ["triptych"],
      ["single"],
    ]),
  },
};
// Physical trim sizes. Missing format means the original eight-inch square.
export const formats = {
  square: {
    name: "Square",
    width: 8,
    height: 8,
    group: "Square",
    detail: "8 × 8 in",
  },
  portrait: {
    name: "Portrait",
    width: 8,
    height: 10,
    group: "Portrait",
    detail: "8 × 10 in",
  },
  landscape: {
    name: "Landscape",
    width: 10,
    height: 8,
    group: "Landscape",
    detail: "10 × 8 in",
  },
  panorama: {
    name: "Panoramic",
    width: 12,
    height: 6,
    group: "Landscape",
    detail: "12 × 6 in",
  },
  pocket: {
    name: "Pocket",
    width: 6,
    height: 8,
    group: "Portrait",
    detail: "6 × 8 in",
  },
  magazine: {
    name: "Magazine",
    width: 8.5,
    height: 11,
    group: "Portrait",
    detail: "8½ × 11 in",
  },
};
export const coverStyles = {
  classic: {
    name: "Classic",
    area: [12, 17, 76, 56],
    title: [8, 80, 84, 14],
    eyebrow: [8, 7, 84, 5],
    align: "center",
  },
  editorial: {
    name: "Editorial",
    area: [8, 40, 84, 52],
    title: [8, 14, 84, 20],
    eyebrow: [8, 6, 84, 5],
    align: "left",
  },
  band: {
    name: "Split cover",
    area: [0, 0, 56, 100],
    title: [62, 28, 32, 55],
    eyebrow: [62, 12, 32, 10],
    align: "left",
  },
  full: {
    name: "Full photograph",
    area: [0, 0, 100, 100],
    title: [8, 72, 84, 20],
    eyebrow: [8, 63, 84, 6],
    align: "left",
  },
  inset: {
    name: "Gallery frame",
    area: [18, 21, 64, 53],
    title: [8, 81, 84, 13],
    eyebrow: [8, 9, 84, 5],
    align: "center",
  },
};
Object.entries({
  album: ["square", "classic"],
  travel: ["landscape", "editorial"],
  wedding: ["portrait", "inset"],
  valentine: ["pocket", "band"],
  baby: ["portrait", "classic"],
  yearbook: ["magazine", "editorial"],
  birthday: ["landscape", "full"],
  portfolio: ["panorama", "band"],
}).forEach(([key, [format, coverStyle]]) =>
  Object.assign(templates[key], { format, coverStyle }),
);
Object.assign(templates, {
  coast: {
    name: "The Long Weekend",
    category: "Travel",
    description:
      "A wide travel book with sweeping photographs, small details, and room for the story.",
    color: "#faf7ee",
    ink: "#214254",
    accent: "#32748b",
    scene: "#d7e7ec",
    title: "The long weekend",
    eyebrow: "NOTES FROM THE COAST",
    motif: "line",
    font: "Georgia",
    format: "panorama",
    coverStyle: "full",
    sequence: sequence([
      ["single"],
      ["wide", "The view from here"],
      ["story", "A few days away"],
      ["offset", "Around the next corner"],
      ["hero", "A day by the water"],
      ["triptych", "Places to remember"],
      ["single", "One last look"],
    ]),
  },
  vows: {
    name: "After the Vows",
    category: "Love & weddings",
    description:
      "A modern wedding magazine. Big type, quiet margins, and space for your vows and photographs.",
    color: "#f6f2ed",
    ink: "#342b2c",
    accent: "#a37970",
    scene: "#e5d9d5",
    title: "After the vows",
    eyebrow: "OUR WEDDING DAY",
    motif: "line",
    font: "Georgia",
    format: "magazine",
    coverStyle: "editorial",
    sequence: sequence([
      ["single"],
      ["story", "Our vows"],
      ["columns", "The morning"],
      ["single", "The ceremony"],
      ["offset", "Just us"],
      ["hero", "Everyone we love"],
      ["contact", "The evening"],
      ["portrait", "Married"],
    ]),
  },
  journal: {
    name: "Little Family Stories",
    category: "Family",
    description:
      "A pocket journal for photographs, funny things they said, and the details you might forget.",
    color: "#f2ede3",
    ink: "#654031",
    accent: "#aa6646",
    scene: "#e4d5c7",
    title: "Little family stories",
    eyebrow: "PHOTOS & NOTES",
    motif: "line",
    font: "Georgia",
    format: "pocket",
    coverStyle: "inset",
    sequence: sequence([
      ["single"],
      ["story", "Remember when"],
      ["stacked", "Days at home"],
      ["offset", "Out together"],
      ["columns", "Small discoveries"],
      ["story", "Things they said"],
      ["pair", "Just like this"],
      ["single", "To be continued"],
    ]),
  },
  monograph: {
    name: "Monograph",
    category: "Everyday",
    description:
      "A gallery-style volume for a photography series. A bold cover, considered pairings, and a contact sheet to close.",
    color: "#fbfbf9",
    ink: "#202529",
    accent: "#747b81",
    scene: "#dfe2e4",
    title: "A study in light",
    eyebrow: "PHOTOGRAPHY / VOLUME 01",
    motif: "line",
    font: "system-ui",
    format: "portrait",
    coverStyle: "band",
    sequence: sequence([
      ["single"],
      ["story", "About this collection"],
      ["portrait"],
      ["offset"],
      ["single"],
      ["columns"],
      ["hero"],
      ["contact", "The collection"],
    ]),
  },
});
export const bookColors = [
  { name: "Navy", value: "#193b53" },
  { name: "Burgundy", value: "#702b42" },
  { name: "Charcoal", value: "#24252a" },
  { name: "Terracotta", value: "#b74932" },
  { name: "Forest", value: "#27564c" },
  { name: "Ochre", value: "#d5a254" },
  { name: "Blush", value: "#efc4c9" },
  { name: "White", value: "#ffffff" },
];
Object.entries({
  album: "#ffffff",
  travel: "#193b53",
  wedding: "#efe5d4",
  valentine: "#702b42",
  baby: "#e6bd95",
  yearbook: "#263e63",
  birthday: "#b74932",
  portfolio: "#24252a",
  coast: "#286677",
  vows: "#702b42",
  journal: "#d5a254",
  monograph: "#24252a",
}).forEach(([key, color]) => (templates[key].defaultColor = color));
for (const [key, direction] of Object.entries(artDirections)) {
  Object.assign(templates[key], {
    format: direction.format, coverStyle: direction.coverStyle,
    defaultColor: direction.color, color: direction.color,
    ink: readableInk(direction.color), motif: "none",
  });
}
templates.yearbook.sequence[0].layout = "pair";
export function readableInk(color) {
  const rgb = color
    .match(/[a-f0-9]{2}/gi)
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05
    ? "#ffffff"
    : "#000000";
}
export function bookStyle(book, index = 0) {
  const design = templates[book.template];
  if (index > 0) {
    const paper = artDirections[book.template].paper;
    return { ...design, color: paper, ink: readableInk(paper), accent: readableInk(paper) };
  }
  if (!/^#[0-9a-f]{6}$/i.test(book.color || "")) return design;
  const ink = readableInk(book.color);
  return { ...design, color: book.color, ink, accent: ink };
}
export function bookFormat(book) {
  return formats[book.format] || formats.square;
}
export function bookCover(book) {
  if (book.coverStyle && book.coverStyle === templates[book.template]?.coverStyle)
    return designedCovers[book.template];
  return coverStyles[book.coverStyle] || coverStyles.classic;
}
export const layouts = {
  story: { name: "Words only", areas: [] },
  offset: {
    name: "Offset pair",
    areas: [
      [0, 0, 58, 70],
      [63, 30, 37, 70],
    ],
  },
  columns: {
    name: "Three stacked",
    areas: [
      [12, 0, 76, 30],
      [12, 35, 76, 30],
      [12, 70, 76, 30],
    ],
  },
  hero: {
    name: "Hero + details",
    areas: [
      [0, 0, 100, 64],
      [0, 69, 30, 31],
      [35, 69, 30, 31],
      [70, 69, 30, 31],
    ],
  },
  contact: {
    name: "Contact sheet",
    areas: Array.from({ length: 9 }, (_, i) => [
      (i % 3) * 35,
      Math.floor(i / 3) * 35,
      30,
      30,
    ]),
  },
  single: { name: "Classic", areas: [[0, 0, 100, 100]] },
  portrait: { name: "Portrait", areas: [[20, 0, 60, 100]] },
  wide: { name: "Panorama", areas: [[0, 20, 100, 60]] },
  pair: {
    name: "Side by side",
    areas: [
      [0, 0, 49, 100],
      [51, 0, 49, 100],
    ],
  },
  stacked: {
    name: "Stacked",
    areas: [
      [0, 0, 100, 48],
      [0, 52, 100, 48],
    ],
  },
  triptych: {
    name: "Three across",
    areas: [
      [0, 10, 32, 80],
      [34, 10, 32, 80],
      [68, 10, 32, 80],
    ],
  },
  feature: {
    name: "One + two",
    areas: [
      [0, 0, 64, 100],
      [66, 0, 34, 48],
      [66, 52, 34, 48],
    ],
  },
  grid: {
    name: "Four square",
    areas: [
      [0, 0, 49, 48],
      [51, 0, 49, 48],
      [0, 52, 49, 48],
      [51, 52, 49, 48],
    ],
  },
  mosaic: {
    name: "Six moments",
    areas: [
      [0, 0, 32, 48],
      [34, 0, 32, 48],
      [68, 0, 32, 48],
      [0, 52, 32, 48],
      [34, 52, 32, 48],
      [68, 52, 32, 48],
    ],
  },
};
export const capacity = Object.fromEntries(
  Object.entries(layouts).map(([key, value]) => [key, value.areas.length]),
);
export function page(layout = "single", heading = "", text = "") {
  return {
    id: crypto.randomUUID(),
    layout,
    photos: Array(capacity[layout]).fill(null),
    heading,
    caption: "",
    text,
  };
}
export function autoFill(photos, template, order = "date") {
  const unique = [
    ...new Map(
      photos.filter((p) => p.mediaType === "image").map((p) => [p.id, p]),
    ).values(),
  ];
  if (order === "date")
    unique.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0) || a.id - b.id);
  const design = templates[template],
    // Auto-fill produces a complete photo book; writing pages are opt-in in manual mode.
    entries = design.sequence.filter((p) => capacity[p.layout] > 0),
    pages = [];
  let offset = 0;
  while (offset < unique.length) {
    const index = pages.length;
    const entry =
      entries[
        index < entries.length
          ? index
          : 1 + ((index - 1) % (entries.length - 1))
      ];
    let layout = entry.layout;
    if (index === 0 && unique[offset].width > unique[offset].height * 1.5)
      layout = "single";
    if (capacity[layout] > unique.length - offset)
      layout =
        unique.length - offset >= 4
          ? "grid"
          : unique.length - offset === 3
            ? "feature"
            : unique.length - offset === 2
              ? "pair"
              : "single";
    const p = page(layout, index < entries.length ? entry.heading : "");
    p.photos = p.photos.map(() => ({ ...unique[offset++], fit: "fill" }));
    pages.push(p);
  }
  return pages.length ? pages : [page()];
}
export function newBook(template, photos = [], order = "date") {
  return {
    id: crypto.randomUUID(),
    version: 2,
    format: templates[template].format,
    coverStyle: templates[template].coverStyle,
    color: templates[template].defaultColor || templates[template].color,
    template,
    title: templates[template].title,
    pages: photos.length
      ? autoFill(photos, template, order)
      : templates[template].sequence.map((p) =>
          page(p.layout, p.heading, p.text),
        ),
  };
}
export function changeLayout(p, layout) {
  const occupied = p.photos.filter(Boolean);
  if (occupied.length > capacity[layout])
    throw new Error(
      "Clear the extra photo spaces before choosing a smaller layout.",
    );
  return {
    ...p,
    layout,
    photos: Array.from(
      { length: capacity[layout] },
      (_, i) => occupied[i] || null,
    ),
  };
}
export function photoURL(photo, size = 700) {
  return `/api/items/${Number(photo.id)}/thumbnail?size=${size}`;
}
export function boxes(
  layout,
  template = "album",
  cover = false,
  hasHeading = false,
  coverStyle = "classic",
) {
  if (cover && template === "yearbook" && coverStyle === templates.yearbook.coverStyle && layout === "pair")
    return [[25, 29, 69, 39], [58, 72, 36, 23]];
  const [x, y, w, h] = cover
    ? bookCover({ template, coverStyle }).area
    : (() => {
        const frame = interiorFrames[template] || [6, 13, 88, 64];
        return hasHeading ? frame : [6, 6, 88, 72];
      })();
  const areas = cover && capacity[layout] === 1 ? [[0, 0, 100, 100]] : layouts[layout].areas;
  return areas.map(([xx, yy, ww, hh]) => [
    x + (xx * w) / 100,
    y + (yy * h) / 100,
    (ww * w) / 100,
    (hh * h) / 100,
  ]);
}
// Shared decoration coordinates keep editor and PDF output in sync.
export function ornaments(template, cover) {
  const t = templates[template];
  if (!cover) return [];
  if (t.motif === "frame") return [{ x: 4, y: 4, w: 92, h: 92, outline: true }];
  if (t.motif === "dots")
    return [];
  if (t.motif === "heart") return [{ x: 48, y: 10, w: 4, h: 4, heart: true }];
  return [];
}

export function cropPercent(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : 50;
}
export function imagePlacement(
  photo,
  imageWidth,
  imageHeight,
  x,
  y,
  width,
  height,
) {
  const fill = photo.fit === "fill";
  const scale = (fill ? Math.max : Math.min)(
    width / imageWidth,
    height / imageHeight,
  );
  const w = imageWidth * scale,
    h = imageHeight * scale;
  return [
    x + (width - w) * (fill ? cropPercent(photo.cropX) / 100 : 0.5),
    y + (height - h) * (fill ? cropPercent(photo.cropY) / 100 : 0.5),
    w,
    h,
  ];
}
export function duplicatePage(book, index) {
  if (book.pages.length >= 200)
    throw new Error("A book can have up to 200 pages.");
  const copy = structuredClone(book.pages[index]);
  copy.id = crypto.randomUUID();
  return {
    ...book,
    pages: [
      ...book.pages.slice(0, index + 1),
      copy,
      ...book.pages.slice(index + 1),
    ],
  };
}
export function reorderPages(book, from, to) {
  if (
    from < 0 ||
    to < 0 ||
    from >= book.pages.length ||
    to >= book.pages.length
  )
    return book;
  const pages = [...book.pages],
    [moved] = pages.splice(from, 1);
  pages.splice(to, 0, moved);
  return { ...book, pages };
}

export function duplicateBook(book) {
  const copy = structuredClone(book);
  copy.id = crypto.randomUUID();
  copy.title = `${book.title.slice(0, 73)} (copy)`;
  copy.pages = copy.pages.map((p) => ({ ...p, id: crypto.randomUUID() }));
  return copy;
}
