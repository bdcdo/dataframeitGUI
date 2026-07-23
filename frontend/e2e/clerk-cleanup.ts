import type { Page } from "@playwright/test";
import { clerk } from "@clerk/testing/playwright";

const SIGN_OUT_TIMEOUT_MS = 5_000;

function isMissingSession(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const clerkError = error as {
    errors?: Array<{ code?: unknown; message?: unknown }>;
  };

  if (
    clerkError.errors?.some(
      ({ code, message }) =>
        code === "resource_not_found" &&
        typeof message === "string" &&
        message.includes("Session not found"),
    )
  ) {
    return true;
  }

  return error instanceof Error && error.message.includes("Session not found");
}

async function signOutWithTimeout(page: Page, context: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      clerk.signOut({ page }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `clerk.signOut não concluiu em ${SIGN_OUT_TIMEOUT_MS / 1_000}s durante cleanup (${context})`,
              ),
            ),
          SIGN_OUT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    // O ticket pode invalidar a sessão antes do cleanup. Nesse estado o objetivo
    // do sign-out já foi alcançado, então repetir ou falhar criaria um falso erro.
    if (isMissingSession(error)) return;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface WithClerkCleanupOptions<T> {
  page: Page;
  context: string;
  run: () => Promise<T>;
  prepareSignOut?: () => Promise<void>;
}

export async function withClerkCleanup<T>({
  page,
  context,
  run,
  prepareSignOut,
}: WithClerkCleanupOptions<T>): Promise<T> {
  let runFailed = false;

  try {
    return await run();
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];

    try {
      await prepareSignOut?.();
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      await signOutWithTimeout(page, context);
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length > 0) {
      const cleanupError =
        cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(
              cleanupErrors,
              `Múltiplas falhas no cleanup Clerk (${context})`,
            );
      if (!runFailed) throw cleanupError;
      console.warn(
        `Cleanup Clerk falhou após erro anterior do teste (${context}):`,
        cleanupError,
      );
    }
  }
}
