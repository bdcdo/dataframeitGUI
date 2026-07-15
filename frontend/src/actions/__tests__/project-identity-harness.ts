import { projectIdentityAuthModuleMock } from "@/test-utils/auth-mock";
import { createSupabaseMockState, type TableResults } from "./supabase-mock";

export function createProjectIdentityActionHarness(
  getEffectiveMemberId: (projectId: string) => Promise<string>,
) {
  const supabase = createSupabaseMockState();
  return {
    authModule: projectIdentityAuthModuleMock(getEffectiveMemberId),
    supabase,
    supabaseServerModule: {
      createSupabaseServer: async () => supabase.createClient(),
    },
    reset: (tableResults: TableResults) => supabase.reset(tableResults),
  };
}
