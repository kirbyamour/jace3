// M4.6 Read & Listen — text extraction: PDFs and web articles into raw text.

import { extractText, getDocumentProxy } from "unpdf";

export async function extractPdfText(buf: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n\n") : text).trim();
}

// Lightweight article extraction: pull the main content of an HTML page.
// The LLM cleanup pass downstream forgives what heuristics miss.
export async function extractUrlText(url: string): Promise<{ title: string; text: string; isPdf?: boolean; pdfBuf?: Uint8Array }> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; JaceReader/1.0)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = await extractPdfText(buf);
    return { title: decodeURIComponent(url.split("/").pop() ?? "PDF"), text, isPdf: true, pdfBuf: buf };
  }
  const html = await res.text();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || url;
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const main = /<article[\s\S]*?<\/article>/i.exec(body)?.[0] ?? /<main[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (main && main.length > 800) body = main;
  const text = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title.replace(/\s+/g, " "), text };
}
