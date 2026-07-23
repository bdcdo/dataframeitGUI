import type { User } from "@clerk/nextjs/server";

type RuntimeEmailAddress = User["emailAddresses"][number];
type VerificationStatus = NonNullable<
  RuntimeEmailAddress["verification"]
>["status"];

type RuntimeUserEmailIdentity = Pick<User, "primaryEmailAddressId"> & {
  readonly emailAddresses: readonly (Pick<
    RuntimeEmailAddress,
    "id" | "emailAddress"
  > & {
    readonly verification:
      | Pick<NonNullable<RuntimeEmailAddress["verification"]>, "status">
      | null;
  })[];
};

interface CanonicalEmailAddress {
  id: string;
  email: string;
  verificationStatus: VerificationStatus | null;
}

export interface VerifiedClerkEmailIdentity {
  primaryEmail: string;
  verifiedEmails: readonly string[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function selectVerifiedEmailIdentity(
  primaryEmailAddressId: string | null,
  emailAddresses: readonly CanonicalEmailAddress[],
): VerifiedClerkEmailIdentity | null {
  if (!primaryEmailAddressId) return null;

  const primaryEmail = emailAddresses.find(
    (address) => address.id === primaryEmailAddressId,
  );
  if (primaryEmail?.verificationStatus !== "verified") return null;

  const normalizedPrimaryEmail = normalizeEmail(primaryEmail.email);
  if (!normalizedPrimaryEmail) return null;

  // Uma passada só: filtrar por verificação, normalizar e descartar o vazio
  // eram três varreduras do mesmo array.
  const verifiedEmails = Array.from(
    new Set(
      emailAddresses.flatMap((address) => {
        if (address.verificationStatus !== "verified") return [];
        const normalized = normalizeEmail(address.email);
        return normalized ? [normalized] : [];
      }),
    ),
  );

  return {
    primaryEmail: normalizedPrimaryEmail,
    verifiedEmails,
  };
}

/**
 * Resolve a identidade de e-mail da sessão Clerk: o primário verificado cria
 * a identidade Supabase; todos os endereços verificados podem resolver aliases
 * pendentes da mesma conta.
 */
export function getVerifiedEmailIdentity(
  user: RuntimeUserEmailIdentity,
): VerifiedClerkEmailIdentity | null {
  return selectVerifiedEmailIdentity(
    user.primaryEmailAddressId,
    user.emailAddresses.map((address) => ({
      id: address.id,
      email: address.emailAddress,
      verificationStatus: address.verification?.status ?? null,
    })),
  );
}

/** E-mail canônico usado pelo caminho read-only de autenticação. */
export function getVerifiedPrimaryEmail(
  user: RuntimeUserEmailIdentity,
): string | null {
  return getVerifiedEmailIdentity(user)?.primaryEmail ?? null;
}
