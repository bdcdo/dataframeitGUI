"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { GabaritoByDocument } from "./GabaritoByDocument";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { RespondentProfile } from "./RespondentProfile";
import { HardestDocuments } from "./HardestDocuments";
import type { PydanticField } from "@/lib/types";
import type {
  ReviewedDocument,
  ConfusionData,
  RespondentProfileData,
  HardestDocumentData,
} from "@/app/(app)/projects/[id]/reviews/page";

interface ReviewsViewProps {
  projectId: string;
  isCoordinator: boolean;
  reviewedDocuments: ReviewedDocument[];
  confusionDataList: ConfusionData[];
  respondentProfiles: RespondentProfileData[];
  hardestDocuments: HardestDocumentData[];
  fields: PydanticField[];
}

export function ReviewsView({
  projectId,
  isCoordinator,
  reviewedDocuments,
  confusionDataList,
  respondentProfiles,
  hardestDocuments,
  fields,
}: ReviewsViewProps) {
  const [includeStale, setIncludeStale] = useState(true);

  const hasData = reviewedDocuments.length > 0;

  if (!hasData) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhuma revisão encontrada. Comece revisando documentos na aba Comparar.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Switch
          id="include-stale"
          checked={includeStale}
          onCheckedChange={setIncludeStale}
        />
        <Label htmlFor="include-stale" className="text-sm">
          Incluir respostas desatualizadas
        </Label>
      </div>

      <Tabs defaultValue="gabarito">
        <TabsList>
          <TabsTrigger value="gabarito">Gabarito</TabsTrigger>
          <TabsTrigger value="confusion">Matriz de Confusão</TabsTrigger>
          {isCoordinator && (
            <TabsTrigger value="respondents">Respondentes</TabsTrigger>
          )}
          <TabsTrigger value="difficulty">Docs Difíceis</TabsTrigger>
        </TabsList>

        <TabsContent value="gabarito" className="space-y-4">
          <GabaritoByDocument
            reviewedDocuments={reviewedDocuments}
            fields={fields}
            includeStale={includeStale}
            projectId={projectId}
          />
        </TabsContent>

        <TabsContent value="confusion" className="space-y-4">
          <ConfusionMatrix confusionDataList={confusionDataList} />
        </TabsContent>

        {isCoordinator && (
          <TabsContent value="respondents" className="space-y-4">
            <RespondentProfile
              respondentProfiles={respondentProfiles}
              fields={fields}
            />
          </TabsContent>
        )}

        <TabsContent value="difficulty" className="space-y-4">
          <HardestDocuments
            hardestDocuments={hardestDocuments}
            projectId={projectId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
