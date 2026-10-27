import React, { useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Printer } from "lucide-react";
import { bookFormat } from "./books-model";
import { printProvider, printingLink } from "./book-printing";

const providerLink = printingLink(import.meta.env.VITE_PRESTOPHOTO_AFFILIATE_URL);
export default function BookPrinting({book, saved, busy}) {
  const [expanded, setExpanded] = useState(false);
  return <section className="bk-printing" aria-label="Print a copy of your book">
    <button className="bk-printing-toggle" aria-expanded={expanded} aria-controls="book-printing-options" disabled={busy} onClick={()=>setExpanded(v=>!v)}><Printer size={21}/><span><strong>Want a printed copy?</strong><small>Save your PDF, then choose paper and binding at the printer.</small></span><ChevronDown size={19}/></button>
    {expanded && <div id="book-printing-options" className="bk-printing-body">
      <ol>
        <li><span>{saved ? <Check size={16}/> : "1"}</span><div><strong>{saved ? "PDF export complete" : "Save your PDF above"}</strong><p>{bookFormat(book).detail} · {book.pages.length} pages. Use high quality for printing.</p></div></li>
        <li><span>2</span><div><strong>Check size and covers</strong><p>Choose a matching size and review the printer’s preview. Your PDF includes the front cover as page 1; set up the back cover and spine with the printer. Some formats need resizing.</p></div></li>
        <li><span>3</span><div><strong>Upload and order at {printProvider.name}</strong><p>You choose the file to upload. Printing, payment, and shipping happen on their website.</p></div></li>
      </ol>
      <div className="bk-printer-links"><a className="bk-primary" href={providerLink.href} target="_blank" rel={providerLink.affiliate ? "sponsored noopener noreferrer" : "noopener noreferrer"}>Explore {printProvider.name} <ArrowUpRight size={16}/></a><a href={printProvider.specifications} target="_blank" rel="noopener noreferrer">Size and cover guide <ArrowUpRight size={13}/></a></div>
      {providerLink.affiliate && <p className="bk-affiliate-disclosure">Barry Anders may earn a commission if you order through this link.</p>}
      <p className="bk-printer-choice">You can also take your PDF to another printer. Check their file requirements before ordering.</p>
    </div>}
  </section>;
}
