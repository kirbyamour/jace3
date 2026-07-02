import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } });
}
export async function POST(req: NextRequest) {
  const { data: { user } } = await supabaseServer().auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { subscription } = await req.json();
  if (!subscription?.endpoint) return Response.json({ ok: false });
  const { error } = await admin().from("push_subscriptions")
    .upsert({ endpoint: subscription.endpoint, sub: subscription }, { onConflict: "endpoint" });
  return Response.json({ ok: !error });
}
