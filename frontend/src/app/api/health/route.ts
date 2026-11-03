import { NextResponse } from "next/server";

// Health check para o Fly.io. Endpoint leve, sem auth nem DB, sempre 200.
// Necessario porque "/" redireciona (307) via Clerk e o check do Fly falharia.
export const dynamic = "force-dynamic";

// `server_time` (segundos Unix) é o relógio da Machine, que o vigia
// (.github/scripts/fly-vigia.sh) compara com o do runner: Machine retomada de
// pausa já voltou com o relógio horas atrás, e o Clerk passou a recusar a sessão.
export function GET() {
  return NextResponse.json({
    status: "ok",
    server_time: Math.floor(Date.now() / 1000),
  });
}
