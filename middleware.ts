import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  if (process.env.NODE_ENV !== "production" && process.env.DEMO_NO_AUTH === "1") return NextResponse.next();
  const pathname = req.nextUrl.pathname;
  const method = req.method;
  const telegramWebhook = method === "POST" && (pathname === "/api/telegram/webhook" || pathname === "/api/telegram/webhook/");
  console.log("[middleware] request:", pathname, method);
  console.log("[middleware] telegram webhook bypass matched:", telegramWebhook ? "yes" : "no");
  if (telegramWebhook) return NextResponse.next();
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (all: { name: string; value: string; options?: import("@supabase/ssr").CookieOptions }[]) => {
          all.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          all.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  const isLogin = req.nextUrl.pathname.startsWith("/login");
  if (!user && !isLogin) return NextResponse.redirect(new URL("/login", req.url));
  if (user && isLogin) return NextResponse.redirect(new URL("/", req.url));
  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.json|icons/|api/).*)",
    "/api/telegram/webhook/:path*",
  ],
};
