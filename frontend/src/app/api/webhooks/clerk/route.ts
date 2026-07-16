import { Webhook } from "svix";
import { headers } from "next/headers";
import type { WebhookEvent } from "@clerk/nextjs/server";
import {
  reconcileClerkUserAccess,
  revokeClerkUserAccess,
} from "@/lib/clerk-sync";

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
  let event: WebhookEvent;

  try {
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (
    event.type !== "user.created" &&
    event.type !== "user.updated" &&
    event.type !== "user.deleted"
  ) {
    return new Response("OK", { status: 200 });
  }

  const clerkUserId = event.data.id;
  if (!clerkUserId) {
    return new Response("Missing user id", { status: 400 });
  }
  try {
    if (event.type === "user.deleted") {
      await revokeClerkUserAccess(clerkUserId);
    } else {
      // O evento assinado autoriza apenas o ID. O estado de e-mails e metadata
      // é relido do Clerk para que um webhook atrasado não recupere um alias que
      // a conta já removeu.
      await reconcileClerkUserAccess(clerkUserId);
    }
  } catch (error) {
    console.error("[clerk-webhook] access reconciliation failed", {
      clerkUserId,
      eventType: event.type,
      error,
    });
    return new Response("Access reconciliation failed", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
