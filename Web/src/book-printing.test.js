import {test} from "node:test";
import assert from "node:assert/strict";
import {printingLink, printProvider, exportedBookKey} from "./book-printing.js";

test("unconfigured affiliate links never claim attribution",()=>{
  assert.deepEqual(printingLink(),{href:printProvider.url,affiliate:false});
});
test("an issued printer URL is preserved without attaching customer data",()=>{
  const url="https://www.prestophoto.com/?ref=example-account";
  assert.deepEqual(printingLink(url),{href:url,affiliate:true});
});
test("unsafe, credential-bearing, and unrelated URLs fall back to the printer",()=>{
  for(const url of ["javascript:alert(1)","http://prestophoto.com","https://prestophoto.com.evil.test","https://user:secret@prestophoto.com/","https://prestophoto.com:444/","https://example.test/?next=prestophoto.com"]) assert.equal(printingLink(url).affiliate,false);
});
test("any book or export-setting edit invalidates the export-complete state",()=>{
  const book={title:"Trip",pages:[{photos:[{id:1,cropX:50}]}]};
  const original=exportedBookKey(book,"print",false);
  assert.notEqual(original,exportedBookKey(book,"share",false));
  assert.notEqual(original,exportedBookKey(book,"print",true));
  book.pages[0].photos[0].cropX=20;
  assert.notEqual(original,exportedBookKey(book,"print",false));
});
