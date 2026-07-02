// M4.7 Creation — Jace makes real files: PDFs, Word docs, spreadsheets, CSVs, images.
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import * as XLSX from "xlsx";

export function filesDb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } });
}

export async function storeFile(db: SupabaseClient, name: string, buf: Buffer, contentType: string): Promise<string | null> {
  const path = `made/${Date.now()}-${name.replace(/[^\w.\-() ]+/g, "_")}`;
  const { error } = await db.storage.from("files").upload(path, buf, { contentType, upsert: true });
  if (error) return null;
  const { data } = await db.storage.from("files").createSignedUrl(path, 604800); // 7 days
  return data?.signedUrl ?? null;
}

// ---------- PDF (clean text layout, wrapped, paged) ----------
export async function renderPdf(title: string, body: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 64, LH = 16, SIZE = 11;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const write = (text: string, f = font, size = SIZE, lh = LH) => {
    const words = text.split(/\s+/);
    let line = "";
    const flush = () => {
      if (!line) return;
      if (y < M) newPage();
      page.drawText(line, { x: M, y, size, font: f, color: rgb(0.08, 0.09, 0.11) });
      y -= lh; line = "";
    };
    for (const w of words) {
      const probe = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(probe, size) > W - 2 * M) flush();
      line = line ? line + " " + w : w;
    }
    flush();
  };
  if (title) { write(title, bold, 17, 24); y -= 8; }
  for (const para of body.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (/^#{1,3}\s/.test(p)) { y -= 6; write(p.replace(/^#{1,3}\s/, ""), bold, 13, 19); y -= 2; }
    else { for (const ln of p.split("\n")) write(ln.trim()); y -= 8; }
  }
  return Buffer.from(await doc.save());
}

// ---------- DOCX ----------
export async function renderDocx(title: string, body: string): Promise<Buffer> {
  const children: Paragraph[] = [];
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }));
  for (const para of body.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    const h = /^(#{1,3})\s+(.*)/.exec(p);
    if (h) {
      const lvl = h[1].length === 1 ? HeadingLevel.HEADING_1 : h[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: lvl, children: [new TextRun(h[2])] }));
    } else if (/^[-*]\s/.test(p)) {
      for (const li of p.split("\n")) children.push(new Paragraph({ text: li.replace(/^[-*]\s+/, ""), bullet: { level: 0 } }));
    } else {
      children.push(new Paragraph({ children: [new TextRun(p.replace(/\n/g, " "))] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ---------- XLSX ----------
export type SheetSpec = { name?: string; rows: unknown[][] | Record<string, unknown>[] };
export function renderXlsx(sheets: SheetSpec[]): Buffer {
  const wb = XLSX.utils.book_new();
  sheets.forEach((s, i) => {
    const rows = s.rows ?? [];
    const ws = Array.isArray(rows[0])
      ? XLSX.utils.aoa_to_sheet(rows as unknown[][])
      : XLSX.utils.json_to_sheet(rows as Record<string, unknown>[]);
    XLSX.utils.book_append_sheet(wb, ws, (s.name ?? `Sheet${i + 1}`).slice(0, 31));
  });
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

// ---------- Images (OpenAI gpt-image-1; key-gated) ----------
export async function renderImage(prompt: string, size = "1024x1024"): Promise<Buffer | { error: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: "no_key" };
  const models = [process.env.OPENAI_IMAGE_MODEL, "gpt-image-1", "dall-e-3"].filter(Boolean) as string[];
  let lastErr = "";
  for (const model of models) {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, size, n: 1, ...(model === "dall-e-3" ? { response_format: "b64_json" } : {}) }),
    });
    if (!res.ok) { lastErr = `${model}: ${res.status} ${(await res.text()).slice(0, 200)}`; continue; }
    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (b64) return Buffer.from(b64, "base64");
    const url = data.data?.[0]?.url;
    if (url) { const ir = await fetch(url); if (ir.ok) return Buffer.from(await ir.arrayBuffer()); }
  }
  return { error: lastErr || "image generation failed" };
}
