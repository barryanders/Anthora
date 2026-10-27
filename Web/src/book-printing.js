export const printProvider = {
  name: "PrestoPhoto",
  url: "https://www.prestophoto.com/create/pdf-book-printing",
  specifications: "https://www.prestophoto.com/help/Printing+Specifications",
};

// This is a public, account-issued referral URL, never an API key. No customer
// photo, book title, local path, or library identifier is added to the link.
export function printingLink(affiliateURL = "") {
  try {
    const url = new URL(affiliateURL.trim());
    if (url.protocol === "https:" && ["prestophoto.com", "www.prestophoto.com"].includes(url.hostname) && !url.username && !url.password && !url.port) {
      return {href:url.href,affiliate:true};
    }
  } catch { /* Missing or invalid configuration uses the ordinary printer link. */ }
  return {href:printProvider.url,affiliate:false};
}

export function exportedBookKey(book, quality, bleed) {
  return JSON.stringify([book,quality,bleed]);
}
