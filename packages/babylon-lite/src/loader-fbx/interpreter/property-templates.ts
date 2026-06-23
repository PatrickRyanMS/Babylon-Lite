import type { FBXDocument, FBXNode, FBXPropertyValue } from "../types/fbx-types.js";
import { findChildByName, findDocumentNode, getPropertyValue } from "../types/fbx-types.js";

/** A single property entry parsed from a Definitions PropertyTemplate. */
export interface FBXTemplateProperty {
    /** Property name (e.g. "DiffuseColor"). */
    name: string;
    /** FBX property type string (e.g. "Color", "double"). */
    propertyType: string;
    /** Property label/sub-type string. */
    label: string;
    /** Property flags string. */
    flags: string;
    /** Default values declared by the template. */
    values: FBXPropertyValue[];
}

/** A resolved property template for an object type. */
export interface FBXPropertyTemplate {
    /** Object type the template applies to (e.g. "Material"). */
    objectType: string;
    /** Template name (e.g. "FbxSurfacePhong"). */
    templateName: string;
    /** Default properties keyed by property name. */
    properties: Map<string, FBXTemplateProperty>;
}

/** All property templates keyed by object type, then template name. */
export type FBXPropertyTemplateMap = Map<string, Map<string, FBXPropertyTemplate>>;

/** Extract all property templates from a document's Definitions section. */
export function extractPropertyTemplates(doc: FBXDocument): FBXPropertyTemplateMap {
    const templates: FBXPropertyTemplateMap = new Map();
    const definitions = findDocumentNode(doc, "Definitions");
    if (!definitions) {
        return templates;
    }

    for (const objectTypeNode of definitions.children) {
        if (objectTypeNode.name !== "ObjectType") {
            continue;
        }

        const objectType = getPropertyValue<string>(objectTypeNode, 0);
        if (!objectType) {
            continue;
        }

        for (const templateNode of objectTypeNode.children) {
            if (templateNode.name !== "PropertyTemplate") {
                continue;
            }

            const templateName = getPropertyValue<string>(templateNode, 0);
            if (!templateName) {
                continue;
            }

            const template = extractPropertyTemplate(objectType, templateName, templateNode);
            let templatesByName = templates.get(objectType);
            if (!templatesByName) {
                templatesByName = new Map();
                templates.set(objectType, templatesByName);
            }
            templatesByName.set(templateName, template);
        }
    }

    return templates;
}

/** Resolve a property template by object type and optional template name. */
export function getPropertyTemplate(templates: FBXPropertyTemplateMap, objectType: string, templateName?: string): FBXPropertyTemplate | undefined {
    const templatesByName = templates.get(objectType);
    if (!templatesByName) {
        return undefined;
    }
    if (templateName) {
        return templatesByName.get(templateName);
    }
    return templatesByName.values().next().value;
}

/** Read a default value directly from a template. */
export function getTemplatePropertyValue<T extends FBXPropertyValue>(template: FBXPropertyTemplate | undefined, propertyName: string, valueIndex = 0): T | undefined {
    return template?.properties.get(propertyName)?.values[valueIndex] as T | undefined;
}

/** Resolve a property value from a node, falling back to its template default. */
export function resolvePropertyValue<T extends FBXPropertyValue>(node: FBXNode, template: FBXPropertyTemplate | undefined, propertyName: string, valueIndex = 0): T | undefined {
    return resolvePropertyValues(node, template, propertyName)?.[valueIndex] as T | undefined;
}

/** Resolve a numeric property with a fallback. */
export function resolveNumberProperty(node: FBXNode, template: FBXPropertyTemplate | undefined, propertyName: string, fallback: number): number {
    return toNumber(resolvePropertyValue(node, template, propertyName)) ?? fallback;
}

/** Resolve a 2-component property with a fallback. */
export function resolveVector2Property(node: FBXNode, template: FBXPropertyTemplate | undefined, propertyName: string, fallback: [number, number]): [number, number] {
    const values = resolvePropertyValues(node, template, propertyName);
    if (!values) {
        return fallback;
    }
    const x = toNumber(values[0]);
    const y = toNumber(values[1]);
    return x !== undefined && y !== undefined ? [x, y] : fallback;
}

/** Resolve a 3-component property with a fallback. */
export function resolveVector3Property(
    node: FBXNode,
    template: FBXPropertyTemplate | undefined,
    propertyName: string,
    fallback: [number, number, number]
): [number, number, number] {
    const values = resolvePropertyValues(node, template, propertyName);
    if (!values) {
        return fallback;
    }
    const x = toNumber(values[0]);
    const y = toNumber(values[1]);
    const z = toNumber(values[2]);
    return x !== undefined && y !== undefined && z !== undefined ? [x, y, z] : fallback;
}

/** Resolve the raw value list for a property, local node values taking precedence over template defaults. */
export function resolvePropertyValues(node: FBXNode, template: FBXPropertyTemplate | undefined, propertyName: string): FBXPropertyValue[] | undefined {
    return findLocalPropertyValues(node, propertyName) ?? template?.properties.get(propertyName)?.values;
}

function toNumber(value: FBXPropertyValue | undefined): number | undefined {
    if (typeof value === "number") {
        return value;
    }
    return undefined;
}

function extractPropertyTemplate(objectType: string, templateName: string, templateNode: FBXNode): FBXPropertyTemplate {
    const properties = new Map<string, FBXTemplateProperty>();
    const properties70 = findChildByName(templateNode, "Properties70");

    for (const propertyNode of properties70?.children ?? []) {
        if (propertyNode.name !== "P") {
            continue;
        }

        const property = extractPropertyNode(propertyNode);
        if (property) {
            properties.set(property.name, property);
        }
    }

    return { objectType, templateName, properties };
}

function findLocalPropertyValues(node: FBXNode, propertyName: string): FBXPropertyValue[] | undefined {
    const propertyContainers = [findChildByName(node, "Properties70"), findChildByName(node, "Properties60")].filter((child): child is FBXNode => child !== undefined);

    for (const container of propertyContainers) {
        for (const propertyNode of container.children) {
            if (propertyNode.name !== "P" && propertyNode.name !== "Property") {
                continue;
            }
            if (getPropertyValue<string>(propertyNode, 0) !== propertyName) {
                continue;
            }
            return propertyNode.properties.slice(propertyNode.name === "Property" ? 3 : 4).map((property) => property.value);
        }
    }

    return undefined;
}

function extractPropertyNode(node: FBXNode): FBXTemplateProperty | null {
    const name = getPropertyValue<string>(node, 0);
    if (!name) {
        return null;
    }

    return {
        name,
        propertyType: getPropertyValue<string>(node, 1) ?? "",
        label: getPropertyValue<string>(node, 2) ?? "",
        flags: getPropertyValue<string>(node, 3) ?? "",
        values: node.properties.slice(4).map((property) => property.value),
    };
}
