import { describe, expect, it } from "vitest";
import type { User } from "@clerk/nextjs/server";
import {
  getVerifiedEmailIdentity,
  getVerifiedPrimaryEmail,
} from "@/lib/clerk-primary-email";

type RuntimeUserEmailIdentity = Pick<User, "primaryEmailAddressId"> & {
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification: { status: "verified" | "unverified" } | null;
  }>;
};

describe("e-mail primário canônico do Clerk", () => {
  it("seleciona o primário verificado pelo ID, independentemente da ordem", () => {
    const user: RuntimeUserEmailIdentity = {
      primaryEmailAddressId: "email_primary",
      emailAddresses: [
        {
          id: "email_secondary",
          emailAddress: "secundario@exemplo.com",
          verification: { status: "verified" },
        },
        {
          id: "email_primary",
          emailAddress: "principal@exemplo.com",
          verification: { status: "verified" },
        },
      ],
    };

    expect(getVerifiedEmailIdentity(user)).toEqual({
      primaryEmail: "principal@exemplo.com",
      verifiedEmails: ["secundario@exemplo.com", "principal@exemplo.com"],
    });
    expect(getVerifiedPrimaryEmail(user)).toBe("principal@exemplo.com");
  });

  it("não substitui um primário não verificado por um secundário verificado", () => {
    const user: RuntimeUserEmailIdentity = {
      primaryEmailAddressId: "email_primary",
      emailAddresses: [
        {
          id: "email_secondary",
          emailAddress: "secundario@exemplo.com",
          verification: { status: "verified" },
        },
        {
          id: "email_primary",
          emailAddress: "principal@exemplo.com",
          verification: { status: "unverified" },
        },
      ],
    };

    expect(getVerifiedPrimaryEmail(user)).toBeNull();
  });

  it("falha fechado quando o Clerk não declara um e-mail primário", () => {
    const user: RuntimeUserEmailIdentity = {
      primaryEmailAddressId: null,
      emailAddresses: [
        {
          id: "email_only",
          emailAddress: "unico@exemplo.com",
          verification: { status: "verified" },
        },
      ],
    };

    expect(getVerifiedPrimaryEmail(user)).toBeNull();
  });

  it("normaliza, deduplica e ignora endereços não verificados", () => {
    const user: RuntimeUserEmailIdentity = {
      primaryEmailAddressId: "email_primary",
      emailAddresses: [
        {
          id: "email_primary",
          emailAddress: " Principal@Exemplo.COM ",
          verification: { status: "verified" },
        },
        {
          id: "email_duplicate",
          emailAddress: "principal@exemplo.com",
          verification: { status: "verified" },
        },
        {
          id: "email_unverified",
          emailAddress: "nao-verificado@exemplo.com",
          verification: { status: "unverified" },
        },
      ],
    };

    expect(getVerifiedEmailIdentity(user)).toEqual({
      primaryEmail: "principal@exemplo.com",
      verifiedEmails: ["principal@exemplo.com"],
    });
  });
});
