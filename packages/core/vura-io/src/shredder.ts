import * as crypto from 'crypto';

export interface TableMeta {
    table_name: string;
    parent_table: string | null;
    field_name: string | null;
    node_type: 'object' | 'array' | 'primitive_array';
    field_order: string[];
    field_types: Record<string, string>;
    children: Record<string, string>;
}

export interface Manifest {
    dataset_name: string;
    root_table: string;
    is_root_array: boolean;
    tables: Record<string, TableMeta>;
}

export interface ShredResult {
    tables: Record<string, any[]>;
    manifest: Manifest;
    tableNames: string[];
}

export function shredJson(datasetName: string, obj: any): ShredResult {
    const tables: Record<string, any[]> = {};
    const manifest: Manifest = {
        dataset_name: datasetName,
        root_table: datasetName,
        is_root_array: Array.isArray(obj),
        tables: {}
    };

    function uuid(): string {
        return crypto.randomUUID();
    }

    function processNode(
        node: any,
        tableName: string,
        parentTable: string | null,
        fieldName: string | null,
        parentId: string | null,
        indexInParent: number
    ) {
        if (!manifest.tables[tableName]) {
            manifest.tables[tableName] = {
                table_name: tableName,
                parent_table: parentTable,
                field_name: fieldName,
                node_type: Array.isArray(node) ? 'array' : 'object',
                field_order: [],
                field_types: {},
                children: {}
            };
        }
        const meta = manifest.tables[tableName];
        if (!tables[tableName]) {
            tables[tableName] = [];
        }

        if (Array.isArray(node)) {
            if (node.length === 0) {
                if (!meta.node_type) meta.node_type = 'array';
                return;
            }
            const isPrimitiveArray = node.some(item => item === null || typeof item !== 'object');
            if (isPrimitiveArray) {
                meta.node_type = 'primitive_array';
                for (let i = 0; i < node.length; i++) {
                    const rowId = uuid();
                    tables[tableName].push({
                        _vura_id: rowId,
                        _vura_parent_id: parentId,
                        _vura_index: i,
                        _vura_value: node[i]
                    });
                }
                return;
            }

            if (meta.node_type !== 'primitive_array') {
                meta.node_type = 'array';
            }
            for (let i = 0; i < node.length; i++) {
                processObjectItem(node[i], tableName, parentId, i);
            }
        } else if (node && typeof node === 'object') {
            meta.node_type = 'object';
            processObjectItem(node, tableName, parentId, indexInParent);
        }
    }

    function processObjectItem(
        item: Record<string, any>,
        tableName: string,
        parentId: string | null,
        index: number
    ) {
        const meta = manifest.tables[tableName];
        const rowId = uuid();
        const row: Record<string, any> = {
            _vura_id: rowId,
            _vura_parent_id: parentId,
            _vura_index: index
        };

        if (item && typeof item === 'object' && !Array.isArray(item)) {
            for (const [key, value] of Object.entries(item)) {
                if (!meta.field_order.includes(key)) {
                    meta.field_order.push(key);
                }

                if (value === null || value === undefined) {
                    meta.field_types[key] = 'null';
                    row[key] = null;
                } else if (typeof value === 'object') {
                    const childTableName = `${tableName}_${key}`;
                    meta.field_types[key] = Array.isArray(value) ? 'array' : 'object';
                    meta.children[key] = childTableName;
                    processNode(value, childTableName, tableName, key, rowId, 0);
                } else {
                    meta.field_types[key] = typeof value;
                    row[key] = value;
                }
            }
        }

        tables[tableName].push(row);
    }

    processNode(obj, datasetName, null, null, null, 0);

    const tableNames = Object.keys(manifest.tables);

    return { tables, manifest, tableNames };
}

export function unshredJson(manifest: Manifest, tables: Record<string, any[]>): any {
    const rowIndexes = new Map<string, Map<string | null, any[]>>();
    for (const [tName, rows] of Object.entries(tables)) {
        const byParent = new Map<string | null, any[]>();
        for (const r of (rows || [])) {
            const pId = (!r._vura_parent_id || r._vura_parent_id === 'null') ? null : String(r._vura_parent_id);
            if (!byParent.has(pId)) byParent.set(pId, []);
            byParent.get(pId)!.push(r);
        }
        rowIndexes.set(tName, byParent);
    }

    function reconstructNode(tableName: string, parentId: string | null): any {
        const meta = manifest.tables[tableName];
        if (!meta) return null;

        const pKey = parentId === null ? null : String(parentId);
        const tableRows = rowIndexes.get(tableName)?.get(pKey) || [];
        tableRows.sort((a, b) => (a._vura_index ?? 0) - (b._vura_index ?? 0));

        if (meta.node_type === 'primitive_array') {
            return tableRows.map(r => r._vura_value);
        }

        if (meta.node_type === 'array') {
            return tableRows.map(r => reconstructItem(r, meta));
        }

        if (tableRows.length === 0) {
            return null;
        }

        return reconstructItem(tableRows[0], meta);
    }

    function reconstructItem(row: Record<string, any>, meta: TableMeta): Record<string, any> {
        const item: Record<string, any> = {};

        for (const key of meta.field_order) {
            if (meta.children[key]) {
                const childTableName = meta.children[key];
                const childMeta = manifest.tables[childTableName];
                const childVal = reconstructNode(childTableName, row._vura_id);
                if (childVal === null && childMeta?.node_type === 'array') {
                    item[key] = [];
                } else {
                    item[key] = childVal;
                }
            } else if (key in row) {
                item[key] = row[key];
            } else {
                item[key] = null;
            }
        }
        return item;
    }

    return reconstructNode(manifest.root_table, null);
}
