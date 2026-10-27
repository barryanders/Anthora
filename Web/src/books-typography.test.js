import test from "node:test";
import assert from "node:assert/strict";
import { templates, newBook, formats, bookCover, boxes, bookStyle } from "./books-model.js";
import { textBlocks, fitText } from "./books-render.js";
import { typography } from "./books-typography.js";

test("every design has distinct typography and a title clear of its cover photograph", () => {
  assert.equal(new Set(Object.values(typography).map(t => JSON.stringify(t))).size, 12);
  for (const template of Object.keys(templates)) {
    const b = newBook(template);
    const blocks = textBlocks(b, 0);
    assert.ok(blocks.every(b => b.size >= 60), "no tiny decorative overline headings");
    for (const block of blocks) {
    const [x,y,w,h] = block.box;
    assert.ok(x >= 0 && y >= 0 && x+w <=100 && y+h <=100);
    assert.deepEqual(boxes("single", template, true, false, b.coverStyle)[0], bookCover(b).area);
    if (b.coverStyle !== "full") {
      for (const [px,py,pw,ph] of boxes(b.pages[0].layout, template, true, false, b.coverStyle))
        assert.ok(x+w <= px || px+pw <= x || y+h <= py || py+ph <= y, template);
    }
    }
  }
});

test("all design titles fit every trim size, including long unbroken titles", () => {
  for (const template of Object.keys(templates)) for (const format of Object.values(formats)) {
    const b = newBook(template), height = 1000 * format.height / format.width;
    for (const t of textBlocks(b,0)) for (const text of [t.text, "Our summer together in the mountains and by the sea", "W".repeat(80)]) {
      const width = t.box[2]*10, maxHeight = t.box[3]*height/100;
      const fitted = fitText(text, (s,size) => s.length*size*0.65, width, maxHeight, t.size, t.leading);
      assert.ok(fitted.lines.length*fitted.lineHeight <= maxHeight);
      assert.ok(fitted.lines.every(l => l.length*fitted.size*0.65 <= width));
    }
  }
});

test("cover colors do not flood interior pages and personal titles retain their words", () => {
  for (const template of Object.keys(templates)) {
    const b = { ...newBook(template), color: "#193b53", title: "Our own title" };
    assert.equal(bookStyle(b, 0).color, "#193b53");
    assert.notEqual(bookStyle(b, 1).color, "#193b53");
    assert.equal(textBlocks(b,0).map(t=>t.text).join(" ").toLowerCase(), "our own title");
  }
});

test("display type shrinks enough to keep ordinary words whole", () => {
  const result = fitText("SOME\nWHERE\nNEW", (text, size)=>text.length*size*.6, 420, 1100, 228, 1.04);
  assert.deepEqual(result.lines, ["SOME", "WHERE", "NEW"]);
});

test("yearbook title retains every word when its cover layout changes", () => {
  for (const layout of ["single", "pair", "grid"]) for (const coverStyle of ["editorial", "full", "classic"]) {
    const b = newBook("yearbook");
    b.pages[0].layout = layout; b.coverStyle = coverStyle;
    assert.equal(textBlocks(b,0).map(t=>t.text).join(" ").toLowerCase(), "our year together");
  }
});

test("interior headings leave the photo frames clear", () => {
  for (const template of Object.keys(templates)) {
    const b = newBook(template);
    b.pages[1].layout = "single"; b.pages[1].heading = "A day to remember";
    const [x,y,w,h] = textBlocks(b,1)[0].box;
    for (const [px,py,pw,ph] of boxes("single",template,false,true))
      assert.ok(x+w <= px || px+pw <= x || y+h <= py || py+ph <= y, template);
  }
});
