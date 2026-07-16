import { projectIdentityAuthModuleMock } from "@/test-utils/auth-mock";
import { createSupabaseMockState, type TableResults } from "./supabase-mock";

export function createProjectIdentityActionHarness(
  resolveMemberUserId: (projectId: string) => Promise<string>,
) {
  const supabase = createSupabaseMockState();
  return {
    authModule: projectIdentityAuthModuleMock(resolveMemberUserId),
    supabase,
    supabaseServerModule: {
      createSupabaseServer: async () => supabase.createClient(),
    },
    reset: (tableResults: TableResults) => supabase.reset(tableResults),
  };
}
