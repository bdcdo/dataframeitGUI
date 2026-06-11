import { Webhook } from "svix";
import { headers } from "next/headers";
import { syncClerkUserToSupabase } from "@/lib/clerk-sync";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

interface ClerkWebhookEvent {
  type: string;
  data: {
    id: string;
    email_addresses: { email_address: string }[];
    first_name: string | null;
    last_name: string | null;
  };
}

export async function POST(request: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const headerPayload = await headers();
  const svixId = headerPayload.get("svix-id");
  const svixTimestamp = headerPayload.get("svix-timestamp");
  const svixSignature = headerPayload.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing svix headers", { status: 400 });
  }

  const body = await request.text();

  const wh = new Webhook(secret);
  let event: ClerkWebhookEvent;

  try {
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "user.created") {
    const { id, email_addresses, first_name, last_name } = event.data;
    const email = email_addresses[0]?.email_address;
    if (email) {
      const supabaseUid = await syncClerkUserToSupabase(
        id,
        email,
        first_name,
        last_name
      );

      // Pré-registro (spec 002): primeiro acesso autenticado transiciona o
      // membro de pendente para ativo (FR-004/SC-005). Transição única — o
      // filtro IS NULL evita sobrescrever ativações anteriores.
      const admin = createSupabaseAdmin();
      await admin
        .from("profiles")
        .update({ activated_at: new Date().toISOString() })
        .eq("id", supabaseUid)
        .is("activated_at", null);
    }
  }

  return new Response("OK", { status: 200 });
}
