import type { FBXNode } from "../types/fbx-types.js";
import { cleanFBXName, getPropertyValue } from "../types/fbx-types.js";

import type { FBXObjectMap } from "./connections.js";

/** Category of scene-level unsupported-feature diagnostic. */
export type FBXSceneDiagnosticType =
    | "unsupported-constraint"
    | "unsupported-helper"
    | "unsupported-deformer"
    | "unsupported-node-attribute"
    | "unsupported-pose"
    | "unsupported-layered-texture"
    | "connection-graph";

/** A recoverable scene-level diagnostic emitted while interpreting an FBX document. */
export interface FBXSceneDiagnostic {
    /** Diagnostic category. */
    type: FBXSceneDiagnosticType;
    /** Human-readable diagnostic message. */
    message: string;
    /** Source object ID, when known. */
    objectId?: number;
    /** Source object name, when known. */
    objectName?: string;
    /** Source node name, when known. */
    nodeName?: string;
    /** Object sub-type string, when known. */
    subType?: string;
    /** Number of accepted parent graph edges for objectId, when objectId is known. */
    parentCount?: number;
    /** Number of accepted child graph edges for objectId, when objectId is known. */
    childCount?: number;
}

/** Collect scene-level diagnostics for features preserved as data but not evaluated at runtime. */
export function extractSceneDiagnostics(objectMap: FBXObjectMap): FBXSceneDiagnostic[] {
    const helperNodeNames = new Set(["Character", "CharacterPose", "ControlSet", "ControlSetPlug", "SelectionSet", "CollectionExclusive"]);

    const diagnostics: FBXSceneDiagnostic[] = objectMap.diagnostics.map((diagnostic) => ({
        type: "connection-graph",
        message: diagnostic.message,
        objectId: diagnostic.childId,
        subType: diagnostic.reason,
        parentCount: diagnostic.childId === undefined ? undefined : objectMap.connections.filter((connection) => connection.childId === diagnostic.childId).length,
    }));

    for (const [id, node] of Array.from(objectMap.objects)) {
        const subType = getPropertyValue<string>(node, 2) ?? "";
        if (node.name === "Constraint") {
            diagnostics.push(
                createObjectDiagnostic(
                    objectMap,
                    id,
                    node,
                    "unsupported-constraint",
                    `Constraint '${subType || cleanFBXName(getPropertyValue<string>(node, 1) ?? "")}' is preserved as diagnostic data but not evaluated at runtime.`
                )
            );
            continue;
        }

        if (helperNodeNames.has(node.name)) {
            diagnostics.push(
                createObjectDiagnostic(objectMap, id, node, "unsupported-helper", `${node.name} helper data is preserved as diagnostic data but not evaluated at runtime.`)
            );
            continue;
        }

        if (node.name === "LayeredTexture") {
            diagnostics.push(
                createObjectDiagnostic(
                    objectMap,
                    id,
                    node,
                    "unsupported-layered-texture",
                    "LayeredTexture is preserved as diagnostic data; runtime texture layer blending is not implemented."
                )
            );
            continue;
        }

        if (node.name === "Pose" && subType !== "BindPose") {
            diagnostics.push(
                createObjectDiagnostic(objectMap, id, node, "unsupported-pose", `Pose subtype '${subType}' is preserved as diagnostic data but not evaluated at runtime.`)
            );
            continue;
        }

        if (node.name === "Deformer" && !isSupportedDeformer(subType)) {
            diagnostics.push(
                createObjectDiagnostic(objectMap, id, node, "unsupported-deformer", `Deformer subtype '${subType}' is preserved as diagnostic data but not evaluated at runtime.`)
            );
            continue;
        }

        if (node.name === "NodeAttribute" && subType && subType !== "Camera" && subType !== "Light") {
            diagnostics.push(
                createObjectDiagnostic(
                    objectMap,
                    id,
                    node,
                    "unsupported-node-attribute",
                    `NodeAttribute subtype '${subType}' is preserved as diagnostic data but not converted to a Babylon object.`
                )
            );
        }
    }

    return diagnostics;
}

function isSupportedDeformer(subType: string): boolean {
    return subType === "Skin" || subType === "Cluster" || subType === "BlendShape" || subType === "BlendShapeChannel";
}

function createObjectDiagnostic(objectMap: FBXObjectMap, id: number, node: FBXNode, type: FBXSceneDiagnosticType, message: string): FBXSceneDiagnostic {
    return {
        type,
        message,
        objectId: id,
        objectName: cleanFBXName(getPropertyValue<string>(node, 1) ?? node.name),
        nodeName: node.name,
        subType: getPropertyValue<string>(node, 2) ?? "",
        parentCount: objectMap.connections.filter((connection) => connection.childId === id).length,
        childCount: objectMap.childrenOf.get(id)?.length ?? 0,
    };
}
