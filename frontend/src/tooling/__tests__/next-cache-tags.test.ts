import { describe, expect, it } from "vitest";

import { frontendEslint, ruleLinter } from "@/test-utils/eslint-rule";

// O frontend não tem cache com tag, e invalidar tag sem produtor é no-op que
// sugere uma garantia de frescor inexistente (#668). A regra que barra as APIs
// de tag mora em eslint.config.mjs, no mesmo bloco do portão do Clerk.
const eslint = frontendEslint("eslint.config.mjs");
const file = "src/actions/example.ts";
const imports = ruleLinter(eslint, "no-restricted-imports", file);
const syntax = ruleLinter(eslint, "no-restricted-syntax", file);
imports.warmUp();

describe("cache com tag do Next", () => {
  it.each(["revalidateTag", "updateTag", "unstable_cache", "cacheTag"])(
    "barra o import de %s",
    async (api) => {
      const messages = await imports.messagesFor(
        `import { ${api} } from "next/cache";\nvoid ${api};`,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.message).toContain("#668");
    },
  );

  it("barra o import com alias e o de namespace", async () => {
    const messages = await imports.messagesFor(
      `import { revalidateTag as invalidate } from "next/cache";
import * as cache from "next/cache";
void invalidate; void cache;`,
    );
    expect(messages).toHaveLength(2);
  });

  it("deixa o revalidatePath passar", async () => {
    expect(
      await imports.messagesFor(
        `import { revalidatePath } from "next/cache";\nrevalidatePath("/");`,
      ),
    ).toEqual([]);
  });

  it("barra fetch com next.tags, e não o next.revalidate", async () => {
    const messages = await syntax.messagesFor(
      `void fetch("/a", { next: { tags: ["t"] } });
void fetch("/b", { next: { revalidate: 60 } });`,
    );
    expect(messages.map((m) => m.line)).toEqual([1]);
  });

  // Um segundo bloco com `no-restricted-imports` nos mesmos arquivos trocaria
  // as opções do portão do Clerk pelas do cache, em vez de somá-las.
  it("o portão do Clerk segue de pé no mesmo bloco", async () => {
    const messages = await imports.messagesFor(
      `import { SignIn } from "@clerk/nextjs";\nvoid SignIn;`,
    );
    expect(messages).toHaveLength(1);
  });
});
