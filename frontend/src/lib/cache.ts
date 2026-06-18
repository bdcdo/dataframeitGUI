// Tags e perfis de cache compartilhados entre Server Actions e RSC.
// Fonte única para evitar drift entre quem invalida (revalidateTag) e quem
// define o cache (unstable_cache na página).

/**
 * Perfil do revalidateTag (Next 16) para o cache de membros — espelha o
 * `revalidate: 300` do getCachedMembers na página de atribuições.
 */
export const MEMBERS_TAG_PROFILE = Object.freeze({ expire: 300 });

/** Tag de cache da lista de membros de um projeto. */
export function membersTag(projectId: string): string {
  return `project-${projectId}-members`;
}
