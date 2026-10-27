// Preview-only artwork. These URLs are never inserted into book project data.
export const sampleSets = {
  album: {
    url: new URL("./assets/books/album-samples.png", import.meta.url).href,
    scenes: [
      "Dog at home",
      "Morning coffee",
      "Cooking together",
      "Beach sunset",
    ],
    pages: [0, 1, 2, 2, 3, 0],
  },
  travel: {
    url: new URL("./assets/books/travel-samples.png", import.meta.url).href,
    scenes: [
      "Coastal village",
      "Village street",
      "Coastal road",
      "Lunch by the sea",
    ],
    pages: [0, 0, 1, 3, 2, 3, 2],
  },
  wedding: {
    url: new URL("./assets/books/wedding-samples.png", import.meta.url).href,
    scenes: [
      "Wedding couple",
      "Bouquet and rings",
      "Wedding ceremony",
      "Candlelit reception",
    ],
    pages: [0, 1, 0, 2, 0, 2, 1, 3, 0],
  },
  valentine: {
    url: new URL("./assets/books/valentine-samples.png", import.meta.url).href,
    scenes: [
      "Couple on a city weekend",
      "Flowers at a cafe",
      "Sunset walk together",
      "Flowers and a note",
    ],
    pages: [0, 0, 1, 1, 3, 2, 0],
  },
  baby: {
    url: new URL("./assets/books/baby-samples.png", import.meta.url).href,
    scenes: [
      "Sleeping baby",
      "Tiny hand",
      "Baby with a parent",
      "Booties and a rattle",
    ],
    pages: [0, 0, 1, 3, 2, 2, 2],
  },
  yearbook: {
    url: new URL("./assets/books/yearbook-samples.png", import.meta.url).href,
    scenes: [
      "Family picnic",
      "Autumn walk",
      "Baking together",
      "Spring blossoms",
    ],
    pages: [0, 2, 3, 0, 1, 0, 2, 0],
  },
  birthday: {
    url: new URL("./assets/books/birthday-samples.png", import.meta.url).href,
    scenes: [
      "Birthday cake",
      "Family celebration",
      "Wrapped gifts",
      "Birthday table",
    ],
    pages: [0, 1, 2, 1, 0, 3, 1],
  },
  portfolio: {
    url: new URL("./assets/books/portfolio-samples.png", import.meta.url).href,
    scenes: [
      "Sculptural architecture",
      "Mountain landscape",
      "Ceramic still life",
      "Desert dunes",
    ],
    pages: [0, 1, 2, 3, 0, 2, 3],
  },
};
sampleSets.coast = sampleSets.travel;
sampleSets.vows = sampleSets.wedding;
sampleSets.journal = sampleSets.yearbook;
sampleSets.monograph = sampleSets.portfolio;
export function samplePhoto(template, pageIndex, slotIndex, width, height) {
  const set = sampleSets[template];
  const tile = ((set.pages[pageIndex] ?? pageIndex) + slotIndex) % 4;
  const edge = Math.max(width, height);
  return {
    url: set.url,
    description: set.scenes[tile],
    tile,
    width: `${(edge / width) * 100}%`,
    height: `${(edge / height) * 100}%`,
    position: `${(tile % 2) * 100}% ${Math.floor(tile / 2) * 100}%`,
  };
}
