interface StepDef {
    id: string;
    name: string;
    description: string;
    handler: string;
    config: Record<string, string>;
    dependsOn: string[];
}
interface WFDef {
    id: string;
    name: string;
    description: string;
    steps: StepDef[];
    createdAt: number;
    updatedAt: number;
}
interface Props {
    initial?: WFDef | null;
    onBack: () => void;
    onSaved: () => void;
}
export declare function WorkflowEditor({ initial, onBack, onSaved }: Props): import("react/jsx-runtime").JSX.Element;
export {};
