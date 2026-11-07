import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Runs before every rendered route: refreshes the Supabase session and gates
 * the app.
 *
 * (In Next 16 this file convention is `proxy`, not `middleware`. A
 * `middleware.ts` here would be silently ignored — the app would simply have no
 * auth gate, and every page would render as signed out.)
 *
 * Auth tokens are short-lived. Without a refresh here a Server Component would
 * intermittently read an expired token and render the app as logged out —
 * which looks exactly like a bug and is impossible to reproduce on demand.
 *
 * This gate is a convenience, not the security boundary. Row Level Security is
 * the boundary. If this file were deleted, an unauthenticated visitor would
 * reach a page that renders nothing, because the database would return nothing.
 *
 * Deliberately self-contained: proxy code can be deployed to the CDN edge
 * separately from the render path, so it reads `process.env` directly rather
 * than importing application modules.
 */

const PUBLIC_PATHS = ["/login", "/auth", "/no-access"];

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );

  // Unconfigured install: send everything to /login, which renders setup
  // instructions. Letting requests through instead would reach a layout that
  // needs a database and throw — a stack trace is a poor first screen.
  if (!url || !anonKey) {
    if (isPublic) return NextResponse.next();

    const setupUrl = request.nextUrl.clone();
    setupUrl.pathname = "/login";
    setupUrl.search = "";
    return NextResponse.redirect(setupUrl);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser(), not getSession(): it revalidates the token against the auth
  // server, so a forged or stale cookie cannot pass the gate below.
  let {
    data: { user },
  } = await supabase.auth.getUser();

  // ---------------------------------------------------------------------
  // Development auto-session
  // ---------------------------------------------------------------------
  // Signs in as a fixed user so there is no login screen during development.
  //
  // NOTHING ABOUT AUTHORISATION IS WEAKENED BY THIS. The session it creates
  // is an ordinary one: the same anon key, the same `authenticated` role, the
  // same row-level security. It skips the login FORM, not the login. A real
  // deployment simply does not set the flag, and the login page it already
  // has takes over.
  //
  // Gated on an explicit `DEV_AUTO_LOGIN=1` rather than on NODE_ENV: that
  // comparison is replaced at compile time and has already misfired once in
  // this project, and a guard whose state you cannot see is worse than one
  // you set on purpose. The flag lives in `.env.local`, which is gitignored
  // and never deployed.
  if (!user && process.env.DEV_AUTO_LOGIN === "1") {
    const email = process.env.DEV_AUTO_LOGIN_EMAIL;
    const password = process.env.DEV_AUTO_LOGIN_PASSWORD;

    if (email && password) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        // Do not retry on every request and do not loop: send them to the
        // login page, which explains what to fix. /login is public, so this
        // terminates.
        if (isPublic) return response;

        const failed = request.nextUrl.clone();
        failed.pathname = "/login";
        failed.search = "";
        failed.searchParams.set("error", "dev_login_failed");
        return NextResponse.redirect(failed);
      }

      user = data.user;

      // A redirect is needed, not a fall-through: the Server Components in
      // THIS request build their own client from the request's cookies, which
      // do not yet carry the session that was just created. They would render
      // as signed out.
      //
      // And the cookies must be copied across by hand. `NextResponse.redirect`
      // makes a fresh response, so the auth cookies the sign-in wrote onto
      // `response` via the setAll handler above would be thrown away — the
      // session would never persist and this would redirect forever.
      if (!isPublic) {
        const authed = NextResponse.redirect(request.nextUrl);
        for (const cookie of response.cookies.getAll()) {
          authed.cookies.set(cookie);
        }
        return authed;
      }
    }
  }

  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    // Preserve where they were headed so login can return them there.
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user && pathname === "/login") {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimisation — running the auth
     * round-trip on every icon request would add latency for nothing.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
