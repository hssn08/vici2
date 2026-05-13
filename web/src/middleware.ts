import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PREFIXES = [
  "/login",
  "/forgot-password",
  "/unauthorized",
  "/_next",
  "/favicon",
  "/api/health",
  "/api/metrics",
  "/api/auth",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  // Presence-only check today. F05 will sign sx_user; once the secret /
  // JWKS are published we'll switch to jose.jwtVerify here. The deep
  // verification happens server-side anyway via the API.
  const cookie = req.cookies.get("sx_user");
  if (!cookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
