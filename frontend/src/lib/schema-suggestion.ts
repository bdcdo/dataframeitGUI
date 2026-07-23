import { z } from "zod";

export const schemaSuggestionChangesSchema = z.strictObject({
  description: z.string().optional(),
  help_text: z.string().optional(),
  options: z.array(z.string()).nullable().optional(),
}).refine((changes) => Object.keys(changes).length > 0, {
  message: "A sugestão precisa conter ao menos uma alteração.",
});

export type SchemaSuggestionChanges = z.infer<
  typeof schemaSuggestionChangesSchema
>;
