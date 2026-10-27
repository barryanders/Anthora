import { bookStyle, bookFormat, bookCover, templates } from "./books-model.js";
import { typography, starterTitles, fontDeclaration, interiorFrames } from "./books-typography.js";

// Coordinates are percentages of the physical page, shared by the editor and PDF.
export function textBlocks(book, index) {
  const p = book.pages[index],
    t = bookStyle(book, index),
    type = typography[book.template] || typography.album;
  if (index === 0) {
    const cover = bookCover(book),
      ink = book.coverStyle === "full" ? "#ffffff" : t.ink;
    const starter = book.title === templates[book.template].title;
    if (starter && book.template === "vows" && book.coverStyle === templates.vows.coverStyle) {
      return [
        { text: "After", box: [6, 2, 88, 23], size: 275, font: type.font, weight: 400, leading: 1, ink },
        { text: "the vows", box: [6, 25, 88, 23], size: 205, font: type.font, weight: 400, italic: true, leading: 1, ink },
      ];
    }
    let title = starter ? starterTitles[book.template] || book.title : book.title;
    if (book.template === "yearbook" && !(p.layout === "pair" && book.coverStyle === templates.yearbook.coverStyle))
      title = book.title;
    if (type.uppercase) title = title.toLocaleUpperCase();
    return [
      {
        text: title,
        box: cover.title,
        size: type.size,
        font: type.font,
        weight: type.weight,
        italic: type.italic,
        widthScale: type.widthScale,
        leading: type.leading,
        align: cover.align,
        ink,
      },
      ...(starter && book.template === "yearbook" && p.layout === "pair" && book.coverStyle === templates.yearbook.coverStyle
        ? [{ text: "together", box: [6, 81, 45, 11], size: 72, font: '"Book Bodoni"', italic: true, leading: 1.1, ink }]
        : []),
    ];
  }
  const story = p.layout === "story";
  const frame = interiorFrames[book.template];
  const headingBox = story ? [10, 9, 80, 23]
    : book.template === "travel" ? [6, 9, 21, 55]
    : [frame[0] || 6, 5, Math.min(frame[2], 88), Math.max(7, frame[1] - 8)];
  return [
    {
      text: p.heading || "",
      box: headingBox,
      size: story ? 100 : book.template === "travel" ? 62 : 58,
      font: type.font,
      weight: type.weight,
      italic: type.italic,
      leading: 1.1,
      align: ["wedding", "baby"].includes(book.template) ? "center" : "left",
      ink: t.ink,
    },
    ...(story
      ? [
          {
            text: p.text || "",
            box: [25, 39, 65, 42],
            size: 29,
            font: '"Book Outfit"',
            leading: 1.55,
            ink: t.ink,
          },
        ]
      : []),
    {
      text: p.caption || "",
      box: [8, 83, 84, 10],
      size: 20,
      font: '"Book Outfit"',
      ink: t.ink,
    },
    {
      text: String(index + 1),
      box: [86, 95, 6, 3],
      size: 13,
      font: '"Book Mono"',
      align: "right",
      ink: t.ink,
    },
  ];
}
export function fitText(text, measure, maxWidth, maxHeight, startSize, leading = 1.25) {
  let size = startSize,
    lines = [];
  // Keep normal words whole before wrapping; only unusually long tokens need
  // character-level breaks. Otherwise a large display face could leave a lone
  // final letter on its own line even though a slightly smaller size would fit.
  const words = text.split(/\s+/).filter(word => word.length <= 24);
  while (size > 2 && words.some(word => measure(word, size) > maxWidth)) size *= .95;
  do {
    lines = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const char of paragraph) {
        if (line && measure(line + char, size) > maxWidth) {
          // Prefer word boundaries, but also handle long words and non-Latin text.
          const split = line.lastIndexOf(" ");
          if (split > line.length / 2) {
            lines.push(line.slice(0, split));
            line = line.slice(split + 1) + char;
          } else {
            lines.push(line);
            line = char;
          }
        } else line += char;
      }
      lines.push(line);
    }
    if (lines.length * size * leading <= maxHeight) break;
    size *= 0.95;
  } while (size > 2);
  return { size, lines, lineHeight: size * leading };
}
let measuringContext;
export function preparedText(book, index, width = 1000) {
  if (!measuringContext)
    measuringContext = document.createElement("canvas").getContext("2d");
  const f = bookFormat(book),
    height = (width * f.height) / f.width;
  return textBlocks(book, index)
    .filter((b) => b.text)
    .map((b) => {
      const [x, y, w, h] = b.box.map(
        (v, i) => (v * (i % 2 ? height : width)) / 100,
      );
      const fit = fitText(
        b.text,
        (text, size) => {
          measuringContext.font = fontDeclaration(b, size);
          return measuringContext.measureText(text).width * (b.widthScale || 1);
        },
        w,
        h,
        (b.size * Math.min(width, height)) / 1000,
        b.leading || 1.25,
      );
      return { ...b, ...fit, x, y, w, h };
    });
}
