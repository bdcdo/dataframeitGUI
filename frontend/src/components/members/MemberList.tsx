"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useMemberListState } from "@/hooks/useMemberListState";
import {
  removeMember,
  changeRole,
  setCanArbitrate,
  setCanResolve,
  setCanCompare,
  updatePendingMemberEmail,
  unlinkMemberEmail,
} from "@/actions/members";
import { LinkEmailDialog } from "@/components/members/LinkEmailDialog";
import { UnifyMembersDialog } from "@/components/members/UnifyMembersDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { MemberEmailLink, ProjectMember, Profile } from "@/lib/types";

interface MemberListProps {
  projectId: string;
  members: (ProjectMember & { profiles: Profile | null })[];
  emailLinks: MemberEmailLink[];
  currentUserId: string;
}

type MemberRow = ProjectMember & { profiles: Profile | null };

// Correção de e-mail digitado errado num pré-registro (FR-005). Só aparece
// para membros pendentes; depois da ativação a correção é via vínculo (US2).
function EditPendingEmailDialog({
  projectId,
  member,
  open,
  onOpenChange,
}: {
  projectId: string;
  member: MemberRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState(member.profiles?.email ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const result = await updatePendingMemberEmail(projectId, member.user_id, email);
    setSaving(false);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    if (result.otherProjectsCount && result.otherProjectsCount > 0) {
      toast.success(
        `E-mail corrigido. A correção também vale para ${result.otherProjectsCount} outro(s) projeto(s) em que este membro está pré-registrado.`,
      );
    } else {
      toast.success("E-mail corrigido.");
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Corrigir e-mail do membro pendente</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            O membro ainda não criou conta. O novo e-mail passa a valer para o
            pré-registro — em todos os projetos em que ele foi adicionado.
          </p>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="novo-email@exemplo.com"
          />
          <Button
            onClick={handleSave}
            disabled={saving || !email}
            className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function memberDisplayName(m: MemberRow): string {
  return m.profiles?.first_name || m.profiles?.email || "Sem perfil";
}

export function MemberList({
  projectId,
  members,
  emailLinks,
  currentUserId,
}: MemberListProps) {
  // Per-row + per-switch pending: o Switch tocado fica disabled até o server
  // action retornar, mas o outro Switch da mesma linha e os Switches das demais
  // linhas continuam interativos. Coordenador habilitando 4 membros em
  // sequência não precisa esperar serializar.
  // Vínculo de e-mails (US2): um único par de dialogs no root, dirigido pelo
  // membro selecionado / preview de unificação retornado pela action.
  const {
    pendingArbitrateId,
    setPendingArbitrateId,
    pendingResolveId,
    setPendingResolveId,
    pendingCompareId,
    setPendingCompareId,
    editingEmailMemberId,
    setEditingEmailMemberId,
    linkingMember,
    setLinkingMember,
    unify,
    setUnify,
  } = useMemberListState();
  const [, startTransition] = useTransition();

  const linksByMember = new Map<string, MemberEmailLink[]>();
  for (const link of emailLinks) {
    const list = linksByMember.get(link.member_user_id) ?? [];
    list.push(link);
    linksByMember.set(link.member_user_id, list);
  }

  const handleUnlink = async (linkId: string) => {
    const result = await unlinkMemberEmail(projectId, linkId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("E-mail desvinculado. Acessos futuros por ele cessam; o histórico permanece.");
    }
  };

  // useOptimistic: o Switch reflete imediatamente o valor escolhido enquanto o
  // server action roda. Sem isso, o `checked` permanece no valor antigo até o
  // revalidatePath devolver — em conexão lenta parece que o clique não pegou.
  const [optimisticMembers, applyOptimistic] = useOptimistic<
    MemberRow[],
    { memberId: string; patch: Partial<Pick<MemberRow, "can_arbitrate" | "can_resolve" | "can_compare">> }
  >(members, (current, update) =>
    current.map((m) =>
      m.id === update.memberId ? { ...m, ...update.patch } : m,
    ),
  );

  const handleRemove = async (memberId: string) => {
    const result = await removeMember(projectId, memberId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("Membro removido");
    }
  };

  const handleChangeRole = async (memberId: string, newRole: "coordenador" | "pesquisador") => {
    const result = await changeRole(memberId, newRole, projectId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("Papel atualizado");
    }
  };

  const handleToggleArbitrate = (memberId: string, value: boolean) => {
    setPendingArbitrateId(memberId);
    startTransition(async () => {
      applyOptimistic({ memberId, patch: { can_arbitrate: value } });
      try {
        const result = await setCanArbitrate(memberId, value, projectId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        const verb = value ? "habilitada" : "desabilitada";
        const retried = result.retried;
        if (retried && retried.assigned > 0 && retried.stillNoPool > 0) {
          toast.success(
            `Arbitragem ${verb}. ${retried.assigned} caso(s) realocado(s); ${retried.stillNoPool} ainda sem árbitro elegível.`,
          );
        } else if (retried && retried.assigned > 0) {
          toast.success(
            `Arbitragem ${verb}. ${retried.assigned} caso(s) realocado(s).`,
          );
        } else {
          toast.success(`Arbitragem ${verb}.`);
        }
      } finally {
        setPendingArbitrateId(null);
      }
    });
  };

  const handleToggleResolve = (memberId: string, value: boolean) => {
    setPendingResolveId(memberId);
    startTransition(async () => {
      applyOptimistic({ memberId, patch: { can_resolve: value } });
      try {
        const result = await setCanResolve(memberId, value, projectId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success(
          value
            ? "Permissão para resolver habilitada."
            : "Permissão para resolver desabilitada.",
        );
      } finally {
        setPendingResolveId(null);
      }
    });
  };

  const handleToggleCompare = (memberId: string, value: boolean) => {
    setPendingCompareId(memberId);
    startTransition(async () => {
      applyOptimistic({ memberId, patch: { can_compare: value } });
      try {
        const result = await setCanCompare(memberId, value, projectId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        const verb = value ? "habilitada" : "desabilitada";
        const retried = result.retried;
        if (retried && retried.assigned > 0 && retried.stillNoPool > 0) {
          toast.success(
            `Comparação ${verb}. ${retried.assigned} caso(s) realocado(s); ${retried.stillNoPool} ainda sem revisor elegível.`,
          );
        } else if (retried && retried.assigned > 0) {
          toast.success(
            `Comparação ${verb}. ${retried.assigned} caso(s) realocado(s).`,
          );
        } else {
          toast.success(`Comparação ${verb}.`);
        }
      } finally {
        setPendingCompareId(null);
      }
    });
  };

  return (
    <div className="space-y-2">
      {optimisticMembers.map((m) => (
        <div key={m.id} className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              {memberDisplayName(m)}
              {m.profiles && m.profiles.activated_at === null && (
                <Badge
                  variant="secondary"
                  title="Pré-registrado: ainda não criou conta. Entra no projeto no primeiro acesso."
                >
                  Pendente
                </Badge>
              )}
            </p>
            <p className="text-xs text-muted-foreground">{m.profiles?.email}</p>
            {(linksByMember.get(m.user_id) ?? []).map((link) => (
              <p
                key={link.id}
                className="flex items-center gap-1 text-xs text-muted-foreground"
                title={
                  link.linked_user_id
                    ? "E-mail vinculado: a conta acessa o projeto como este membro."
                    : "E-mail vinculado aguardando criação da conta."
                }
              >
                <span>↳ {link.email}</span>
                {!link.linked_user_id && <span className="italic">(sem conta)</span>}
                <button
                  type="button"
                  onClick={() => handleUnlink(link.id)}
                  className="ml-1 text-destructive hover:underline"
                >
                  desvincular
                </button>
              </p>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLinkingMember(m)}
            >
              Vincular e-mail
            </Button>
            {m.profiles && m.profiles.activated_at === null && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingEmailMemberId(m.id)}
                >
                  Corrigir e-mail
                </Button>
                <EditPendingEmailDialog
                  projectId={projectId}
                  member={m}
                  open={editingEmailMemberId === m.id}
                  onOpenChange={(open) =>
                    setEditingEmailMemberId(open ? m.id : null)
                  }
                />
              </>
            )}
            <span
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title="Pode marcar dificuldades LLM e comentários de outros pesquisadores como resolvidos"
            >
              <Switch
                checked={m.can_resolve}
                onCheckedChange={(v) => handleToggleResolve(m.id, v)}
                disabled={pendingResolveId === m.id}
                aria-label="Pode resolver pendências"
              />
              Resolve
            </span>
            <span
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title="Recebe casos contestados para arbitrar"
            >
              <Switch
                checked={m.can_arbitrate}
                onCheckedChange={(v) => handleToggleArbitrate(m.id, v)}
                disabled={pendingArbitrateId === m.id}
                aria-label="Elegível para arbitrar"
              />
              Arbitra
            </span>
            <span
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title="Recebe documentos divergentes para comparar"
            >
              <Switch
                checked={m.can_compare}
                onCheckedChange={(v) => handleToggleCompare(m.id, v)}
                disabled={pendingCompareId === m.id}
                aria-label="Elegível para comparar"
              />
              Compara
            </span>
            <Select
              value={m.role}
              onValueChange={(v) => handleChangeRole(m.id, v as "coordenador" | "pesquisador")}
              disabled={m.user_id === currentUserId}
            >
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="coordenador">Coordenador</SelectItem>
                <SelectItem value="pesquisador">Pesquisador</SelectItem>
              </SelectContent>
            </Select>
            {m.user_id !== currentUserId && (
              <Button variant="ghost" size="sm" onClick={() => handleRemove(m.id)} className="text-destructive">
                Remover
              </Button>
            )}
          </div>
        </div>
      ))}
      {linkingMember && (
        <LinkEmailDialog
          projectId={projectId}
          memberUserId={linkingMember.user_id}
          memberName={memberDisplayName(linkingMember)}
          open={true}
          onOpenChange={(open) => {
            if (!open) setLinkingMember(null);
          }}
          onRequiresUnification={(preview) => {
            setUnify({ preview, targetName: memberDisplayName(linkingMember) });
            setLinkingMember(null);
          }}
        />
      )}
      <UnifyMembersDialog
        projectId={projectId}
        preview={unify?.preview ?? null}
        targetName={unify?.targetName ?? ""}
        onClose={() => setUnify(null)}
      />
    </div>
  );
}
