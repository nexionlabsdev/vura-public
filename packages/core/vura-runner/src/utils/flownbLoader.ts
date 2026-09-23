import * as yaml from 'yaml';
import { FlownbCell } from '../interfaces';

export const FLOWNB_FORMAT_VERSION = 1;

export interface FlownbDocument {
    version: number;
    cells: FlownbCell[];
    // npm package names of Add-on plugins this notebook needs (e.g. for
    // magic commands like !sync_dataverse). The CLI loads these at startup in
    // addition to whatever the global `vura.plugins` config declares.
    requiredPlugins?: string[];
}

/**
 * Parse .flownb file content into an array of cells.
 * Supports two formats:
 *   - Legacy (v0): YAML array of cells at root
 *   - Versioned: { version: N, cells: [...], requiredPlugins?: [...] }
 */
export function parseFlownbContent(content: string): FlownbCell[] {
    return parseFlownbDocument(content).cells;
}

/** Same as parseFlownbContent, but also returns notebook-level metadata like requiredPlugins. */
export function parseFlownbDocument(content: string): FlownbDocument {
    const parsed = yaml.parse(content);

    if (Array.isArray(parsed)) {
        return { version: 0, cells: parsed as FlownbCell[] };
    }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cells)) {
        return parsed as FlownbDocument;
    }

    throw new Error(
        'Invalid .flownb format: expected an array of cells or a { version, cells } document'
    );
}

export function serializeFlownbDocument(cells: FlownbCell[], requiredPlugins?: string[]): string {
    const doc: FlownbDocument = { version: FLOWNB_FORMAT_VERSION, cells };
    if (requiredPlugins && requiredPlugins.length > 0) {
        doc.requiredPlugins = requiredPlugins;
    }
    return yaml.stringify(doc);
}
