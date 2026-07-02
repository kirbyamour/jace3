import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/reading/extract";

export const runtime = "nodejs";
export const maxDuration = 300;

// Migration door: fetches Jace 2.0's export-library JSON (folders, queue rows,
// signed file URLs), copies every file into OUR storage, maps rows into
// reading_folders / reading_items. Idempotent via legacy_id — run it twice, no dupes.

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } });
}

type LegacyRow = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { exportUrl } = await req.json();
  if (!exportUrl) return Response.json({ ok: false, error: "exportUrl required" });

  const res = await fetch(exportUrl);
  if (!res.ok) return Response.json({ ok: false, error: `export fetch failed: ${res.status}` });
  const dump = await res.json();

  const db = admin();
  const report = { folders: 0, items: 0, files: 0, skipped: 0, errors: [] as string[] };

  // ---- folders (accept a few likely shapes) ----
  const folderRows: LegacyRow[] = dump.folders ?? dump.reading_folders ?? dump.reading_queue_folders ?? dump.chat_folders ?? [];
  const folderMap = new Map<string, string>(); // legacy id -> our id
  const registerFolder = async (legacy: string, name: string, emoji: string | null, aliases: string[]) => {
    const { data: existing } = await db.from("reading_folders").select("id").eq("legacy_id", legacy).maybeSingle();
    let id = existing?.id as string | undefined;
    if (!id) {
      const { data, error } = await db.from("reading_folders")
        .insert({ name, emoji, legacy_id: legacy }).select("id").single();
      if (error) { report.errors.push(`folder ${name}: ${error.message}`); return; }
      id = data.id; report.folders++;
    }
    for (const a of [legacy, name, ...aliases]) if (a) folderMap.set(a.toLowerCase(), id!);
  };
  for (const f of folderRows) {
    const legacy = String(f.id ?? f.folder_id ?? f.slug ?? f.name ?? "");
    const name = s(f.name) ?? s(f.title) ?? s(f.slug) ?? "Folder";
    if (!legacy) continue;
    await registerFolder(legacy, name, s(f.emoji), [s(f.slug) ?? ""]);
  }

  // ---- items ----
  const itemRows: LegacyRow[] = dump.items ?? dump.reading_queue ?? dump.queue ?? [];
  for (const r of itemRows) {
    const legacy = String(r.id ?? "");
    if (!legacy) continue;
    const { data: existing } = await db.from("reading_items").select("id").eq("legacy_id", legacy).maybeSingle();
    if (existing) { report.skipped++; continue; }

    const title = s(r.title) ?? s(r.name) ?? s(r.file_name) ?? "Untitled";
    const url = s(r.url) ?? s(r.link) ?? s(r.source_url);
    const fileUrl = s(r.signed_url) ?? s(r.file_url) ?? s(r.download_url);
    const legacyFolder = (s(r.folder_id) ?? s(r.folder))?.toLowerCase() ?? null;
    // 2.0's cleanup output lived in edited_paragraphs — the gold we're rescuing
    const paras = Array.isArray(r.edited_paragraphs) ? (r.edited_paragraphs as unknown[]).filter((p) => typeof p === "string") as string[] : [];
    const cleaned: string | null = paras.length ? paras.join("\n\n") : s(r.cleaned_text);
    let storagePath: string | null = null;
    let rawText: string | null = s(r.content) ?? s(r.text) ?? s(r.extracted_text);

    if (fileUrl) {
      try {
        const fres = await fetch(fileUrl);
        if (fres.ok) {
          const buf = Buffer.from(await fres.arrayBuffer());
          const isPdf = (fres.headers.get("content-type") ?? "").includes("pdf") || buf.subarray(0, 4).toString() === "%PDF";
          const ext = isPdf ? "pdf" : (s(r.file_name)?.split(".").pop() ?? "bin");
          storagePath = `legacy/${legacy}.${ext}`;
          await db.storage.from("reading").upload(storagePath, buf, {
            contentType: fres.headers.get("content-type") ?? "application/octet-stream", upsert: true,
          });
          report.files++;
          if (isPdf && !rawText) {
            try { rawText = await extractPdfText(new Uint8Array(buf)); } catch { /* extract later on demand */ }
          }
        } else report.errors.push(`${title}: file download ${fres.status}`);
      } catch (e) { report.errors.push(`${title}: ${e instanceof Error ? e.message : "file error"}`); }
    }

    if (legacyFolder && !folderMap.has(legacyFolder)) {
      const pretty = legacyFolder === "ai" ? "AI" : legacyFolder.charAt(0).toUpperCase() + legacyFolder.slice(1);
      await registerFolder(legacyFolder, pretty, null, []);
    }
    const st = s(r.status);
    const done = r.done === true || r.is_done === true || st === "done" || st === "completed" || st === "read";
    const { error } = await db.from("reading_items").insert({
      title,
      source_kind: storagePath ? "pdf" : url ? "url" : "text",
      source_url: url,
      storage_path: storagePath,
      raw_text: rawText ?? cleaned,
      // 2.0's cleaned paragraphs were already listenable — nothing needs re-cleaning to play
      listen_text: cleaned,
      clean_mode: cleaned ? "standard" : null,
      status: done ? "done" : st === "reading" || Number(r.last_paragraph) > 0 ? "listening" : cleaned || rawText ? "ready" : "new",
      progress_seconds: Number(r.last_paragraph) > 0 ? Number(r.last_paragraph) : 0,
      notes: s(r.notes),
      folder_id: legacyFolder ? folderMap.get(legacyFolder) ?? null : null,
      legacy_id: legacy,
      legacy_meta: r,
      added_at: s(r.created_at) ?? s(r.added_at) ?? new Date().toISOString(),
    });
    if (error) report.errors.push(`${title}: ${error.message}`);
    else report.items++;
  }

  return Response.json({ ok: true, ...report });
}
