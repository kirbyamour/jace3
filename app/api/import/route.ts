import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import { supabaseServer } from "@/lib/supabase/server";
import { parseExportFile, type ParsedConversation } from "@/lib/import/parser";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST multipart/form-data with .txt and/or .zip files.
// Imports each conversation with original timestamps; idempotent via import_hash.
export async function POST(req: NextRequest) {
  const cookieClient = supabaseServer();
  const [{ data: { user } }, { data: { session } }] = await Promise.all([
    cookieClient.auth.getUser(), cookieClient.auth.getSession(),
  ]);
  if (!user || !session?.access_token) return new Response("unauthorized", { status: 401 });

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false } }
  );

  const form = await req.formData();
  const files = form.getAll("files") as File[];
  const texts: { name: string; text: string }[] = [];
  for (const f of files) {
    if (f.name.toLowerCase().endsWith(".zip")) {
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir && entry.name.toLowerCase().endsWith(".txt") && !entry.name.startsWith("__MACOSX")) {
          texts.push({ name: entry.name, text: await entry.async("string") });
        }
      }
    } else if (f.name.toLowerCase().endsWith(".txt")) {
      texts.push({ name: f.name, text: await f.text() });
    }
  }

  let imported = 0, skipped = 0, unparsed = 0, messages = 0;
  const errors: string[] = [];
  for (const t of texts) {
    let conv: ParsedConversation | null = null;
    try { conv = await parseExportFile(t.name, t.text); } catch { /* fallthrough */ }
    if (!conv) { unparsed++; continue; }

    const { data: convRow, error: convErr } = await db
      .from("conversations")
      .insert({
        user_id: user.id, title: conv.title, origin: "imported",
        import_hash: conv.hash, created_at: conv.tsISO, updated_at: conv.tsISO,
      })
      .select("id").single();
    if (convErr) {
      if (convErr.code === "23505") { skipped++; continue; } // already imported
      errors.push(`${conv.source}: ${convErr.message}`); continue;
    }

    const base = new Date(conv.tsISO).getTime();
    const rows = conv.messages.map((m, i) => ({
      conversation_id: convRow.id, user_id: user.id, role: m.role, content: m.content,
      import_source: conv!.source, created_at: new Date(base + i * 30000).toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error: msgErr } = await db.from("messages").insert(rows.slice(i, i + 200));
      if (msgErr) { errors.push(`${conv.source} msgs: ${msgErr.message}`); break; }
    }
    imported++; messages += rows.length;
  }

  return Response.json({ imported, skipped, unparsed, messages, files: texts.length, errors: errors.slice(0, 10) });
}
