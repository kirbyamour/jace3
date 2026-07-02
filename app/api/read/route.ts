import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { extractPdfText, extractUrlText } from "@/lib/reading/extract";
import { cleanForListening, splitForSpeech } from "@/lib/reading/clean";
import { generateText } from "@/lib/gateway";

export const runtime = "nodejs";
export const maxDuration = 300; // cleaning a long study takes real time

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } });
}
async function requireUser() {
  const { data: { user } } = await supabaseServer().auth.getUser();
  return user;
}

export async function GET() {
  if (!(await requireUser())) return new Response("unauthorized", { status: 401 });
  const db = admin();
  const [{ data: folders }, { data: items }] = await Promise.all([
    db.from("reading_folders").select("*").order("sort_order").order("name"),
    db.from("reading_items")
      .select("id, folder_id, title, author, source_kind, source_url, storage_path, cover_path, status, clean_mode, progress_seconds, duration_seconds, notes, added_at, listen_text")
      .order("added_at", { ascending: false }),
  ]);
  // Signed cover URLs, one batch call
  const coverPaths = (items ?? []).map((i) => i.cover_path).filter(Boolean) as string[];
  const coverMap = new Map<string, string>();
  if (coverPaths.length) {
    const { data: signed } = await db.storage.from("reading").createSignedUrls(coverPaths, 3600);
    (signed ?? []).forEach((s2, i2) => { if (s2.signedUrl) coverMap.set(coverPaths[i2], s2.signedUrl); });
  }
  // Don't ship megabytes of text in the list — just readiness + a size hint.
  const slim = (items ?? []).map((i) => ({
    ...i,
    has_text: !!i.listen_text,
    has_file: !!i.storage_path,
    duration_seconds: i.duration_seconds ?? (i.listen_text ? Math.round((i.listen_text.split(/\s+/).length / 155) * 60) : null),
    cover_url: i.cover_path ? coverMap.get(i.cover_path) ?? null : null,
    words: i.listen_text ? i.listen_text.split(/\s+/).length : 0,
    listen_text: undefined, storage_path: undefined, cover_path: undefined,
  }));
  return Response.json({ folders: folders ?? [], items: slim });
}

export async function POST(req: NextRequest) {
  if (!(await requireUser())) return new Response("unauthorized", { status: 401 });
  const db = admin();
  const body = await req.json();
  const act = body.action as string;

  if (act === "add_url") {
    const { title, text, isPdf, pdfBuf } = await extractUrlText(body.url);
    let storagePath: string | null = null;
    if (isPdf && pdfBuf) {
      storagePath = `imports/${crypto.randomUUID()}.pdf`;
      await db.storage.from("reading").upload(storagePath, Buffer.from(pdfBuf), { contentType: "application/pdf" });
    }
    const { data, error } = await db.from("reading_items").insert({
      title: body.title || title, source_kind: isPdf ? "pdf" : "url", source_url: body.url,
      storage_path: storagePath, raw_text: text, folder_id: body.folderId ?? null,
    }).select("id").single();
    if (error) return Response.json({ ok: false, error: error.message });
    return Response.json({ ok: true, id: data.id });
  }

  if (act === "add_pdf") { // base64 body (client-side uploads)
    const buf = Buffer.from(body.base64, "base64");
    const text = await extractPdfText(new Uint8Array(buf));
    const storagePath = `uploads/${crypto.randomUUID()}.pdf`;
    await db.storage.from("reading").upload(storagePath, buf, { contentType: "application/pdf" });
    const { data, error } = await db.from("reading_items").insert({
      title: body.title || "Untitled PDF", source_kind: "pdf", storage_path: storagePath,
      raw_text: text, folder_id: body.folderId ?? null,
    }).select("id").single();
    if (error) return Response.json({ ok: false, error: error.message });
    return Response.json({ ok: true, id: data.id });
  }

  if (act === "add_text") {
    const { data, error } = await db.from("reading_items").insert({
      title: body.title || "Pasted text", source_kind: "text", raw_text: body.text,
      folder_id: body.folderId ?? null,
    }).select("id").single();
    if (error) return Response.json({ ok: false, error: error.message });
    return Response.json({ ok: true, id: data.id });
  }

  if (act === "prepare") { // extract (if needed) + clean → ready to listen
    const { data: item } = await db.from("reading_items").select("*").eq("id", body.id).single();
    if (!item) return Response.json({ ok: false, error: "not found" });
    let raw = item.raw_text as string | null;
    if (!raw && item.storage_path) {
      const { data: file } = await db.storage.from("reading").download(item.storage_path);
      if (file) raw = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
    }
    if (!raw && item.source_url) raw = (await extractUrlText(item.source_url)).text;
    if (!raw?.trim()) return Response.json({ ok: false, error: "no text could be extracted" });
    const mode = (body.mode as "standard" | "clinical") ?? "standard";
    const listen = await cleanForListening(raw, mode);
    const paras = splitForSpeech(listen);
    // rough duration estimate: ~155 wpm spoken
    const words = listen.split(/\s+/).length;
    await db.from("reading_items").update({
      raw_text: raw, listen_text: listen, clean_mode: mode, status: "ready",
      duration_seconds: Math.round((words / 155) * 60), audio_path: null,
      updated_at: new Date().toISOString(),
    }).eq("id", body.id);
    return Response.json({ ok: true, paragraphs: paras.length, words });
  }

  if (act === "get_text") {
    const { data: item } = await db.from("reading_items").select("listen_text, raw_text, title, clean_mode").eq("id", body.id).single();
    if (!item) return Response.json({ ok: false });
    const text = item.listen_text ?? item.raw_text ?? "";
    return Response.json({ ok: true, title: item.title, mode: item.clean_mode, paragraphs: splitForSpeech(text) });
  }

  if (act === "file_url") { // short-lived signed URL so the browser can render a cover
    const { data: item } = await db.from("reading_items").select("storage_path").eq("id", body.id).single();
    if (!item?.storage_path) return Response.json({ ok: false });
    const { data: signed } = await db.storage.from("reading").createSignedUrl(item.storage_path, 3600);
    return Response.json({ ok: !!signed?.signedUrl, url: signed?.signedUrl });
  }

  if (act === "set_cover") { // browser-rendered first page, cached forever
    const buf = Buffer.from(body.base64, "base64");
    if (buf.length > 400_000) return Response.json({ ok: false, error: "cover too large" });
    const path = `covers/${body.id}.jpg`;
    await db.storage.from("reading").upload(path, buf, { contentType: "image/jpeg", upsert: true });
    await db.from("reading_items").update({ cover_path: path }).eq("id", body.id);
    return Response.json({ ok: true });
  }

  if (act === "fix_titles") { // rename filename-looking titles to the piece's real title
    const { data: all } = await db.from("reading_items").select("id, title, listen_text, raw_text").limit(300);
    const looksLikeFile = (t: string) => /\.(pdf|docx?|txt|epub)$/i.test(t) || (/[_-]/.test(t) && !/\s/.test(t));
    const suspects = (all ?? []).filter((i) => looksLikeFile(i.title)).slice(0, 10);
    let fixed = 0;
    for (const it of suspects) {
      const text = (it.listen_text ?? it.raw_text ?? "").slice(0, 1800);
      if (!text.trim()) continue;
      try {
        const { text: out } = await generateText(
          "You extract the true title of a written piece from its opening text. Reply with ONLY the title — no quotes, no commentary, no trailing period. If it is clearly by an organization or named author, you may append ' — Author'. Maximum 90 characters.",
          [{ role: "user", content: `Filename: ${it.title}\n\nOpening of the document:\n${text}` }],
          { maxTokens: 60 }
        );
        const t = out.trim().split("\n")[0].replace(/^["'“]+|["'”]+$/g, "").trim();
        if (t.length > 3 && t.length <= 120 && !looksLikeFile(t)) {
          await db.from("reading_items").update({ title: t }).eq("id", it.id);
          fixed++;
        }
      } catch { /* try again next pass */ }
    }
    return Response.json({ ok: true, fixed, more: suspects.length === 10 });
  }

  if (act === "update") {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of ["title", "folder_id", "status", "progress_seconds", "notes"]) {
      if (k in body) patch[k] = body[k];
    }
    await db.from("reading_items").update(patch).eq("id", body.id);
    return Response.json({ ok: true });
  }

  if (act === "delete") {
    const { data: item } = await db.from("reading_items").select("storage_path").eq("id", body.id).single();
    if (item?.storage_path) await db.storage.from("reading").remove([item.storage_path]);
    await db.from("reading_items").delete().eq("id", body.id);
    return Response.json({ ok: true });
  }

  if (act === "folder_add") {
    const { data, error } = await db.from("reading_folders").insert({ name: body.name, emoji: body.emoji ?? null }).select("id").single();
    return Response.json({ ok: !error, id: data?.id, error: error?.message });
  }
  if (act === "folder_rename") {
    await db.from("reading_folders").update({ name: body.name }).eq("id", body.id);
    return Response.json({ ok: true });
  }
  if (act === "folder_delete") {
    await db.from("reading_items").update({ folder_id: null }).eq("folder_id", body.id);
    await db.from("reading_folders").delete().eq("id", body.id);
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "unknown action" });
}
