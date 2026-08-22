import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { FlownbCell } from '../interfaces';
import { parseFlownbContent } from '../utils/flownbLoader';

export async function generateSwaggerDoc(notebooksDir: string): Promise<any> {
    const doc: any = {
        openapi: '3.0.0',
        info: {
            title: 'VURA API',
            version: '1.0.0',
            description: 'API documentation dynamically generated from VURA notebooks'
        },
        servers: [
            { url: '/' }
        ],
        paths: {}
    };

    async function scanDirectory(dir: string, baseDir: string) {
        try {
            const stat = await fs.stat(dir);
            if (stat.isFile()) {
                if (dir.endsWith('.flownb')) {
                    const relPath = path.basename(dir);
                    await processNotebook(dir, relPath, doc);
                }
                return;
            }
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out') continue;
                    await scanDirectory(fullPath, baseDir);
                } else if (entry.isFile() && entry.name.endsWith('.flownb')) {
                    await processNotebook(fullPath, relPath, doc);
                }
            }
        } catch {}
    }

    await scanDirectory(notebooksDir, notebooksDir);

    return doc;
}

async function processNotebook(fullPath: string, relPath: string, doc: any) {
    try {
        const content = await fs.readFile(fullPath, 'utf8');
        const cells = parseFlownbContent(content);

        let summary = path.basename(fullPath);
        let description = '';
        let inputSchema: any = null;

        for (const cell of cells) {
            if (cell.language === 'markdown' && !summary.includes(' ')) {
                // Heuristics: extract first heading as summary
                const lines = cell.value.split('\n');
                const firstHeading = lines.find(l => l.trim().startsWith('#'));
                if (firstHeading) {
                    summary = firstHeading.replace(/^#+\s*/, '').trim();
                    description = cell.value;
                }
            } else if (cell.language === 'http-input') {
                try {
                    inputSchema = JSON.parse(cell.value);
                } catch (e) {
                    console.error(`Invalid http-input JSON in ${fullPath}`, e);
                }
            }
        }

        const tag = path.dirname(relPath) === '.' ? 'Root' : path.dirname(relPath).replace(/\\/g, '/');

        const parameters: any[] = [];
        let requestBody: any = undefined;
        let httpMethod = 'post';

        if (inputSchema) {
            if (typeof inputSchema['x-http-method'] === 'string') {
                httpMethod = inputSchema['x-http-method'].toLowerCase();
            }
            
            if (inputSchema.properties) {
            if (inputSchema.properties.query) {
                const querySchema = inputSchema.properties.query;
                if (querySchema.properties) {
                    for (const [key, propSchema] of Object.entries(querySchema.properties)) {
                        parameters.push({
                            name: key,
                            in: 'query',
                            required: querySchema.required?.includes(key) || false,
                            schema: propSchema
                        });
                    }
                }
            }

            if (inputSchema.properties.body) {
                const bodySchema = inputSchema.properties.body;
                requestBody = {
                    content: {
                        'application/json': {
                            schema: bodySchema
                        }
                    }
                };
            }
        }
        }

        // The notebook is triggered via POST /flow/trigger/{relPath}
        // Normalize the path for the API route
        const apiPath = `/flow/trigger/${relPath.replace(/\\/g, '/')}`;

        doc.paths[apiPath] = {
            [httpMethod]: {
                tags: [tag],
                summary: summary,
                description: description,
                parameters: parameters,
                requestBody: requestBody,
                responses: {
                    '200': {
                        description: 'Successful Execution'
                    }
                }
            }
        };

    } catch (err) {
        console.error(`Failed to process notebook for Swagger: ${fullPath}`, err);
    }
}
