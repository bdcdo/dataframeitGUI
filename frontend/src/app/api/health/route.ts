import { NextResponse } from "next/server";

// Health check para o Fly.io. Endpoint leve, sem auth nem DB, sempre 200.
// Necessario porque "/" redireciona (307) via Clerk e o check do Fly falharia.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
