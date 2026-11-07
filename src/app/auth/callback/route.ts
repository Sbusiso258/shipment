import { NextResponse, type NextRequest } from "next/server";

import { supabaseServer } from "@/services/supabase/server";

/**
 * PKCE callback.
 *
 * Invitation and password-recovery emails from Supabase land here with a
 * `code` to exchange for a session. Access to this platform is granted by
 * invitation, so this route is how every single user first gets in — it is not
 * an optional extra.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Expired or already-used links are the common case, not an attack.
    return NextResponse.redirect(`${origin}/login?error=link_expired`);
  }

  // Same open-redirect guard as the login action.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(`${origin}${safeNext}`);
}
