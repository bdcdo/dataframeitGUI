import { projectIdentityAuthModuleMock } from "@/test-utils/auth-mock";
import {
  makeFilterAwareSupabaseMock,
  makeSupabaseServerModuleMock,
  type QueryError,
  type ReadCall,
  type WriteCall,
} from "@/test-utils/supabase-mock";

export function createFilterAwareProjectIdentityActionHarness(
  resolveMemberUserId: (projectId: string) => Promise<string>,
) {
  const supabase = {
    tableData: {} as Record<string, unknown[]>,
    writeCalls: [] as WriteCall[],
    readCalls: [] as ReadCall[],
    queryErrors: {} as Record<string, QueryError | null>,
    projectColumns: true,
  };
  return {
    authModule: projectIdentityAuthModuleMock(resolveMemberUserId),
    supabase,
    supabaseServerModule: makeSupabaseServerModuleMock(() => makeFilterAwareSupabaseMock(supabase)),
    reset: (tableData: Record<string, unknown[]> = {}) => {
      supabase.tableData = tableData;
      supabase.writeCalls.length = 0;
      supabase.readCalls.length = 0;
      supabase.queryErrors = {};
    },
  };
}
