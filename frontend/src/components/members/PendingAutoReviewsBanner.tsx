import Link from "next/link";
import {
  breakDownPendingAutoReviews,
  type PendingAutoReviewsResult,
} from "@/lib/auto-review-pending";
import { memberDisplayName, type MemberRow } from "./member-list-utils";

interface PendingAutoReviewsBannerProps {
  projectId: string;
  // Promessa, e não o valor: a contagem pagina a fila do projeto inteiro e
  // chega por streaming, sem segurar a lista de membros.
  pending: Promise<PendingAutoReviewsResult>;
  members: readonly MemberRow[];
}

// Nome completo, como o seletor da fila de auto-revisão: só o primeiro nome
// deixaria dois membros homônimos com o mesmo link.
function reviewerLabel(member: MemberRow): string {
  const fullName = [member.profiles?.first_name, member.profiles?.last_name]
    .filter(Boolean)
    .join(" ");
  return fullName || memberDisplayName(member);
}

// Contador da fila de auto-revisão do projeto, com a distribuição por revisor
// (#681). É informativo, e não um pedido de ação como os avisos de órfãos ao
// lado, daí a cor neutra. Cada nome abre a fila daquele revisor.
export async function PendingAutoReviewsBanner({
  projectId,
  pending,
  members,
}: PendingAutoReviewsBannerProps) {
  const { data, error } = await pending;
  if (error) {
    // A falha da contagem não derruba a gestão de membros, mas também não vira
    // um "zero pendências" silencioso.
    console.error(
      "PendingAutoReviewsBanner: contagem de auto-revisões pendentes falhou",
      error.message,
    );
    return (
      <div role="alert" className="rounded-md border bg-muted/40 p-3 text-sm">
        Não foi possível contar as auto-revisões pendentes. Recarregue a página
        para tentar de novo.
      </div>
    );
  }
  if (data.fields === 0) return null;

  const { reviewers, outsideMemberList } = breakDownPendingAutoReviews(
    data,
    members,
  );

  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm">
      <p>
        {data.fields} campo(s) com auto-revisão pendente, em {data.documents}{" "}
        documento(s).
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        {reviewers.map(({ member, load }) => (
          <li key={member.user_id}>
            <Link
              href={`/projects/${projectId}/analyze/auto-revisao?viewAs=${member.user_id}`}
              className="underline underline-offset-2 hover:text-foreground"
            >
              {reviewerLabel(member)}
            </Link>
            : {load.fields} em {load.documents} doc(s)
          </li>
        ))}
        {outsideMemberList > 0 ? (
          <li>Fora da lista de membros: {outsideMemberList}</li>
        ) : null}
      </ul>
    </div>
  );
}
