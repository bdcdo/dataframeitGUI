import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export async function GET() {
  const { getToken, userId } = await auth();

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

  return NextResponse.json({
    clerkUserId: userId,
    tokenExists: !!token,
    tokenPrefix: token?.substring(0, 50) + "...",
    claims,
  });
}
