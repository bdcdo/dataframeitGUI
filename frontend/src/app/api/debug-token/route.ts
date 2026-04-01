import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const { getToken, userId } = await auth();
    const user = await currentUser();

    const token = await getToken({ template: "supabase" });

    // Decode JWT payload without verification (just to inspect claims)
    let claims = null;
    if (token) {
      try {
        const parts = token.split(".");
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      } catch {
        claims = "failed to decode";
      }
    }

    const metadataSupabaseUid =
      (user?.publicMetadata?.supabase_uid as string | undefined) ?? null;
    const tokenSupabaseUid =
      claims && typeof claims === "object" && "supabase_uid" in claims
        ? ((claims as Record<string, unknown>).supabase_uid as string | null)
        : null;

    return NextResponse.json({
      clerkUserId: userId,
      clerkPrimaryEmail: user?.emailAddresses[0]?.emailAddress ?? null,
      metadataSupabaseUid,
      tokenSupabaseUid,
      uidMatch:
        metadataSupabaseUid && tokenSupabaseUid
          ? metadataSupabaseUid === tokenSupabaseUid
          : null,
      tokenExists: !!token,
      tokenPrefix: token?.substring(0, 50) + "...",
      claims,
      hints: {
        tokenTemplate: "supabase",
        missingMetadata:
          !!userId && !metadataSupabaseUid
            ? "publicMetadata.supabase_uid ausente"
            : null,
        missingTokenClaim:
          !!token && !tokenSupabaseUid
            ? "claim supabase_uid ausente no JWT"
            : null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: "debug-token-failed",
        message,
      },
      { status: 500 }
    );
  }
}
