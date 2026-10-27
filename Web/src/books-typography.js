// Locally bundled, SIL Open Font Licensed type. Screen and print share this art direction.
export const typography = {
  album: { font: '"Book Fraunces"', weight: 850, size: 238, leading: .88 },
  travel: { font: '"Book Anton"', weight: 400, size: 300, leading: 1.04, uppercase: true, widthScale: .68 },
  wedding: { font: '"Book Bodoni"', weight: 400, size: 134, leading: 1.05 },
  valentine: { font: '"Book Bodoni"', weight: 500, size: 242, leading: .98, italic: true },
  baby: { font: '"Book Fraunces"', weight: 750, size: 196, leading: .93 },
  yearbook: { font: '"Book Anton"', weight: 400, size: 218, leading: 1.05, uppercase: true },
  birthday: { font: '"Book Outfit"', weight: 850, size: 200, leading: .95 },
  portfolio: { font: '"Book Mono"', weight: 400, size: 70, leading: 1.15 },
  coast: { font: '"Book Bodoni"', weight: 500, size: 180, leading: 1.03, italic: true },
  vows: { font: '"Book Bodoni"', weight: 400, size: 230, leading: 1.05 },
  journal: { font: '"Book Fraunces"', weight: 650, size: 142, leading: 1 },
  monograph: { font: '"Book Outfit"', weight: 300, size: 76, leading: 1.12 },
};

// Intentional line breaks are confined to starter titles. Personal titles stay editable.
export const starterTitles = {
  album: "Life\nlately", travel: "Some\nwhere\nnew", wedding: "Our\nwedding",
  valentine: "You\n& me", baby: "Hello,\nlittle\none", yearbook: "Our year",
  birthday: "Happy\nbirthday", coast: "The long\nweekend", journal: "Little\nfamily\nstories",
  monograph: "A study\nin light", portfolio: "Selected\nworks",
};

export const designedCovers = {
  album: { area: [7, 48, 86, 46], title: [7, 3, 86, 42], align: "left" },
  travel: { area: [51, 4, 45, 92], title: [6, 4, 42, 85], align: "left" },
  wedding: { area: [22, 42, 56, 49], title: [8, 5, 84, 33], align: "center" },
  valentine: { area: [46, 54, 47, 39], title: [8, 5, 84, 45], align: "left" },
  baby: { area: [22, 50, 70, 44], title: [7, 3, 86, 45], align: "left" },
  yearbook: { area: [25, 29, 69, 65], title: [5, 3, 90, 23], align: "left" },
  birthday: { area: [8, 44, 84, 50], title: [7, 4, 86, 35], align: "center" },
  portfolio: { area: [4, 4, 92, 72], title: [5, 82, 90, 15], align: "left" },
  coast: { area: [0, 0, 100, 100], title: [7, 63, 86, 30], align: "left" },
  vows: { area: [43, 52, 51, 43], title: [6, 3, 88, 44], align: "left" },
  journal: { area: [12, 51, 76, 42], title: [12, 5, 76, 42], align: "left" },
  monograph: { area: [0, 0, 100, 100], title: [8, 78, 65, 16], align: "left" },
};

export const artDirections = {
  album: { format: "portrait", coverStyle: "editorial", color: "#f6f2e9", paper: "#faf8f3" },
  travel: { format: "portrait", coverStyle: "band", color: "#ef4829", paper: "#faf8f3" },
  wedding: { format: "portrait", coverStyle: "inset", color: "#f6f2e9", paper: "#fcfaf6" },
  valentine: { format: "pocket", coverStyle: "editorial", color: "#edc6c6", paper: "#fff8f5" },
  baby: { format: "portrait", coverStyle: "editorial", color: "#f7e5a0", paper: "#fcf8ed" },
  yearbook: { format: "magazine", coverStyle: "editorial", color: "#f9f8f3", paper: "#f9f8f3" },
  birthday: { format: "square", coverStyle: "editorial", color: "#b8d5ed", paper: "#faf8f3" },
  portfolio: { format: "panorama", coverStyle: "classic", color: "#24252a", paper: "#24252a" },
  coast: { format: "landscape", coverStyle: "full", color: "#286677", paper: "#f6f4eb" },
  vows: { format: "magazine", coverStyle: "editorial", color: "#f7f5ee", paper: "#fcfaf5" },
  journal: { format: "pocket", coverStyle: "editorial", color: "#b8c4a8", paper: "#f6f4e9" },
  monograph: { format: "portrait", coverStyle: "full", color: "#24252a", paper: "#f7f7f4" },
};

export const interiorFrames = {
  album: [8, 19, 84, 59], travel: [30, 8, 64, 69],
  wedding: [16, 19, 68, 59], valentine: [14, 19, 72, 59],
  baby: [14, 22, 78, 56], yearbook: [7, 19, 86, 59],
  birthday: [6, 21, 88, 57], portfolio: [6, 14, 88, 64],
  coast: [0, 19, 100, 59], vows: [20, 22, 74, 56],
  journal: [12, 23, 76, 55], monograph: [14, 17, 72, 61],
};

export function fontDeclaration(block, size = block.size) {
  return `${block.italic ? "italic" : "normal"} ${block.weight || 400} ${size}px ${block.font}`;
}
let ready;
export function loadBookFonts() {
  return ready ||= Promise.all([
    ...Object.values(typography).map(t => document.fonts.load(fontDeclaration(t, 24))),
    document.fonts.load('italic 400 24px "Book Bodoni"'),
    document.fonts.load('400 24px "Book Outfit"'),
    document.fonts.load('400 24px "Book Fraunces"'),
  ]);
}
