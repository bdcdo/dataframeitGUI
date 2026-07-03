import { useCallback } from "react";
import { reorderFullList } from "@/lib/field-order";
import type { PydanticField } from "@/lib/types";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/** Sensores, disponibilidade e handler de drag-and-drop das perguntas. */
export function useQuestionReorder(
  fields: PydanticField[],
  visibleFields: PydanticField[],
  onReorder: ((newOrder: string[]) => void) | undefined,
  readOnly: boolean,
): {
  dragEnabled: boolean;
  sensors: SensorDescriptor<SensorOptions>[];
  handleDragEnd: (event: DragEndEvent) => void;
} {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dragEnabled = !!onReorder && !readOnly;

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!onReorder) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const visibleNamesArr = visibleFields.map((f) => f.name);
      const from = visibleNamesArr.indexOf(String(active.id));
      const to = visibleNamesArr.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      const newOrder = reorderFullList(
        fields.map((f) => f.name),
        visibleNamesArr,
        from,
        to,
      );
      onReorder(newOrder);
    },
    [fields, visibleFields, onReorder],
  );

  return { dragEnabled, sensors, handleDragEnd };
}
